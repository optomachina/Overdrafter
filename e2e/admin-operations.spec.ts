import { expect, test } from "@playwright/test";
import { OPERATIONS_CATEGORIES, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES, parseOperationsSnapshot } from "../src/features/operations/contract";

// The ordinary fixture server has no synthetic admin module interception.
test.skip(({ baseURL }) => baseURL !== "http://127.0.0.1:4174", "Requires e2e/admin-operations.config.ts; this is not a browser pass.");

function snapshot() {
  const now = Date.now();
  return parseOperationsSnapshot({
    schema: OPERATIONS_SCHEMA, generatedAt: new Date(now).toISOString(), refreshAfterMs: 30_000,
    items: OPERATIONS_CATEGORIES.map((category, index) => ({
      key: `${category}:database`, category, severity: index === 0 ? "healthy" : index === 3 ? "blocked" : index === 4 ? "attention" : "unknown", subsystem: "database", provider: null,
      context: { build: null, model: null, runtime: null, adapterVersion: null, sessionEvidenceAgeDays: null, sessionEvidenceKind: null, taskType: null, taskStartedAt: null, taskCompletedAt: null, taskFailedAt: null },
      reasonCode: index === 0 ? "worker_ready" : index === 3 ? "task_stuck" : index === 4 ? "repeated_failures" : "source_unavailable",
      summary: index === 0 ? OPERATIONS_SUMMARIES.worker_ready : index === 3 ? OPERATIONS_SUMMARIES.task_stuck : index === 4 ? OPERATIONS_SUMMARIES.repeated_failures : OPERATIONS_SUMMARIES.source_unavailable,
      firstSeenAt: null, lastSeenAt: new Date(now).toISOString(), changedAt: null, lastCheckedAt: new Date(now).toISOString(),
      freshness: { state: "fresh", ageMs: 0, maxAgeMs: 60_000, expiresAt: new Date(now + 60_000).toISOString() },
      occurrenceCount: null, action: category === "spend" ? { kind: "spend_control", href: "/internal/admin#spend-controls" } : null,
    })), counts: { healthy: 1, attention: 1, blocked: 1, unknown: 6 },
  });
}

for (const width of [320, 390, 768, 1280]) {
  test(`@fixture actual admin operations keyboard and width ${width}`, async ({ page }) => {
    let requests = 0;
    let finishRefresh: (() => void) | undefined;
    const external: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4174") { external.push(url.origin); return route.abort(); }
      if (url.pathname === "/api/admin-operations") {
        expect(route.request().method()).toBe("GET");
        expect(route.request().headers().authorization).toBe("Bearer synthetic-admin-token");
        requests++;
        if (requests === 2) await new Promise<void>(resolve => { finishRefresh = resolve; });
        return route.fulfill({ json: snapshot(), headers: { "cache-control": "no-store" } });
      }
      return route.continue();
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/internal/admin");
    await expect(page.getByRole("heading", { name: "Operations", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh operations", exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.focus();
    await expect(refresh).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => requests).toBe(2);
    try {
      const pendingRefresh = page.getByRole("button", { name: "Refreshing operations…", exact: true });
      await expect(pendingRefresh).toBeFocused();
      await expect(pendingRefresh).toHaveAttribute("aria-disabled", "true");
      await expect(pendingRefresh).toHaveAttribute("aria-busy", "true");
      await expect(pendingRefresh).not.toHaveAttribute("disabled");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      // Bypass Playwright's aria-disabled actionability check to exercise a real
      // pointer click reaching the application's duplicate-activation guard.
      await pendingRefresh.click({ force: true });
      await expect(pendingRefresh).toBeFocused();
      expect(requests).toBe(2);
    } finally { finishRefresh!(); }
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(requests).toBe(2);
    await expect(page.getByRole("link", { name: "Open spend controls" })).toHaveAttribute("href", "/internal/admin#spend-controls");
    const operations = page.locator("section", { has: page.getByRole("heading", { name: "Operations", exact: true }) });
    await expect(operations.locator("dl").first()).toContainText("Blocked1");
    await expect(operations.locator("dl").first()).toContainText("Unknown6");
    const observations = page.getByRole("list", { name: "Operational observations" });
    await expect(observations).toBeVisible();
    await expect(observations.getByRole("listitem").first()).toContainText("Blocked");
    await expect(observations.getByRole("listitem").last()).toContainText("Healthy");
    for (const name of ["Severity", "Category", "Provider or subsystem"]) {
      await expect(page.getByLabel(name, { exact: true })).toHaveCount(1);
      await expect(page.getByLabel(name, { exact: true })).toHaveAccessibleName(name);
    }
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Severity", { exact: true })).toBeFocused();
    // ArrowDown commits a closed native select; Enter opens the Linux Chromium popup and traps the next Tab.
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown");
    await expect(page.getByText("Showing 1 of 9 observations.")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Category", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Provider or subsystem", { exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByLabel("Category", { exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByLabel("Severity", { exact: true })).toBeFocused();
    await page.getByLabel("Category", { exact: true }).selectOption("worker");
    await page.getByLabel("Provider or subsystem", { exact: true }).selectOption("database");
    await expect(page.getByText("No items match these filters.")).toBeVisible();
    const order = await page.getByRole("heading").allTextContents();
    expect(order.indexOf("Operations")).toBeLessThan(order.indexOf("Synthetic manual inbox"));
    await expect(page.getByRole("heading", { name: "Synthetic spend" })).toBeVisible();
    await page.getByLabel("Category", { exact: true }).focus();
    await expect(page.getByLabel("Category", { exact: true })).toBeFocused();
    await expect(observations).toBeAttached();
    await expect(observations.getByRole("listitem")).toHaveCount(0);
    await expect(page.getByText("No items match these filters.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(external).toEqual([]);
    expect(pageErrors).toEqual([]);
    await expect(page.locator("body")).not.toContainText("synthetic-admin-token");
  });
}

test("@fixture non-platform session makes no operations request", async ({ page }) => {
  let requests = 0;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin-operations") { requests++; return route.abort(); }
    return url.origin === "http://127.0.0.1:4174" ? route.continue() : route.abort();
  });
  await page.goto("/internal/admin?role=client");
  await expect(page.getByRole("heading", { name: "Platform Admin God Mode" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations", exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});

// OVD-829 (OVD-828 S1): the per-supplier daily quote cap next to the on/off
// switch. The "database" is an in-memory row set behind synthetic RPC routes.
// There is no default cap: both suppliers start unlimited (null).
test("@fixture supplier settings: set a cap, see it persist, set unlimited, switch the supplier off", async ({ page }) => {
  const rows = new Map([
    ["fictiv", { engaged: false, reason: null as string | null, version: 3, dailyQuoteCap: null as number | null, usedToday: 4 }],
    ["xometry", { engaged: false, reason: null as string | null, version: 1, dailyQuoteCap: null as number | null, usedToday: 0 }],
  ]);
  const writes: Record<string, unknown>[] = [];
  const external: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4174") { external.push(url.origin); return route.abort(); }
    if (url.pathname === "/api/admin-operations") return route.fulfill({ json: snapshot(), headers: { "cache-control": "no-store" } });
    if (url.pathname === "/synthetic-rpc/api_admin_list_provider_kill_switches") {
      return route.fulfill({ json: {
        schema: "provider-kill-switch-admin.v1",
        global: { engaged: false, reason: null, changedBy: null, changedAt: null, version: 0 },
        providers: [...rows].map(([provider, row]) => ({ provider, changedBy: null, changedAt: null, ...row })),
      } });
    }
    if (url.pathname === "/synthetic-rpc/api_admin_set_provider_settings") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      const row = rows.get(body.p_provider as string)!;
      const cap = body.p_daily_quote_cap as number | null;
      if (cap !== null && !(Number.isInteger(cap) && cap > 0)) return route.fulfill({ status: 400, json: { message: "daily_quote_cap_must_be_positive" } });
      const versionless = body.p_expected_version === undefined;
      if (versionless ? body.p_engaged !== true : body.p_expected_version !== row.version) {
        return route.fulfill({ status: 400, json: { message: "kill_switch_version_conflict" } });
      }
      Object.assign(row, { engaged: body.p_engaged, reason: body.p_reason, version: row.version + 1, ...(versionless ? {} : { dailyQuoteCap: cap }) });
      return route.fulfill({ json: { provider: body.p_provider, ...row } });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/internal/admin");

  const confirm = async (provider: string, reason: string) => {
    await page.getByLabel(/^Reason/).fill(reason);
    await page.getByLabel(/to confirm/).fill(provider);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
  };
  const fictivCap = page.getByLabel("Daily quote cap for fictiv", { exact: true });

  // Uncapped by default; an admin sets a cap of 50.
  await expect(fictivCap).toBeDisabled();
  await expect(page.getByText("4 used today (unlimited)")).toBeVisible();
  await page.locator("#daily-cap-unlimited-fictiv").click();
  await expect(fictivCap).toHaveValue("");
  await fictivCap.fill("50");
  await page.getByRole("button", { name: "Save daily cap for fictiv" }).click();
  await expect(page.getByText("Set the daily quote cap for fictiv to 50")).toBeVisible();
  await confirm("fictiv", "raise fictiv for the pilot week");
  await expect(page.getByText("4 used today of 50")).toBeVisible();
  expect(writes.at(-1)).toEqual({
    p_provider: "fictiv", p_engaged: false, p_daily_quote_cap: 50, p_reason: "raise fictiv for the pilot week", p_expected_version: 3,
  });

  // It persists across a reload.
  await page.reload();
  await expect(fictivCap).toHaveValue("50");
  await expect(page.getByText("4 used today of 50")).toBeVisible();

  // Unlimited.
  await page.locator("#daily-cap-unlimited-fictiv").click();
  await expect(fictivCap).toBeDisabled();
  await page.getByRole("button", { name: "Save daily cap for fictiv" }).click();
  await expect(page.getByText("Set the daily quote cap for fictiv to unlimited")).toBeVisible();
  await confirm("fictiv", "fictiv unlimited for the pilot");
  await expect(page.getByText("4 used today (unlimited)")).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ p_provider: "fictiv", p_daily_quote_cap: null, p_expected_version: 4 });

  // Switch the supplier off: an emergency engage, no version, the cap kept.
  const fictivRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "fictiv", exact: true }) });
  await expect(fictivRow.getByText("ALLOWED")).toBeVisible();
  await page.getByRole("button", { name: "Stop fictiv" }).click();
  await confirm("fictiv", "cease and desist received today");
  await expect(fictivRow.getByText("STOPPED")).toBeVisible();
  expect(writes.at(-1)).toEqual({
    p_provider: "fictiv", p_engaged: true, p_daily_quote_cap: null, p_reason: "cease and desist received today",
  });
  expect(rows.get("fictiv")).toMatchObject({ engaged: true, dailyQuoteCap: null });
  await expect(page.getByText("4 used today (unlimited)")).toBeVisible();

  expect(external).toEqual([]);
  expect(pageErrors).toEqual([]);
});
