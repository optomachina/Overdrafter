import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { CHANGED_FINGERPRINT, FINGERPRINT, ID, MILLIMETER_FINGERPRINT, POLICY } from "./data";
import { QuoteBrowserBackend } from "./network";

// Not named *.spec.ts: this suite belongs only to its required dedicated config.
// There is deliberately no test.skip or conditional browser availability fallback.
const test = base.extend<{ backend: QuoteBrowserBackend }>({
  backend: async ({ context }, provide) => {
    const backend = new QuoteBrowserBackend();
    await backend.install(context);
    await provide(backend);
  },
  page: async ({ context, backend }, provide) => {
    void backend; // Requires containment before page creation, including all popups.
    const page = await context.newPage();
    await provide(page);
    await page.close();
  },
});

const confirmName = "Confirm & queue Xometry quote";
const dialogName = "Confirm Xometry beta quote request";
const openPage = (page: Page) => page.goto("/e2e/quote-confirmation/index.html");
const dialog = (page: Page) => page.getByRole("dialog", { name: dialogName });
const confirm = (page: Page) => dialog(page).getByRole("button", { name: confirmName, exact: true });

async function openConfirmation(page: Page) {
  await openPage(page);
  await page.getByRole("button", { name: "Request quote", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Inches", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(dialog(page).getByRole("button", { name: "Millimeters", exact: true })).toHaveAttribute("aria-pressed", "false");
}
async function selectScope(page: Page) {
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
}
async function affirm(page: Page) {
  const boxes = dialog(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(boxes.nth(index)).not.toBeChecked();
    await expect(confirm(page)).toBeDisabled();
    await boxes.nth(index).check();
  }
  await expect(confirm(page)).toBeEnabled();
}
async function activateTwice(button: Locator) {
  // Two synchronous native activations exercise the in-flight lock before React rerenders.
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
}
async function expectLockedConsent(page: Page) {
  for (const units of ["Inches", "Millimeters"]) {
    const button = dialog(page).getByRole("button", { name: units, exact: true });
    await expect(button).toBeDisabled();
    await button.evaluate((element: HTMLButtonElement) => element.click());
  }
  const boxes = dialog(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(boxes.nth(index)).toBeDisabled();
    await boxes.nth(index).evaluate((element: HTMLButtonElement) => element.click());
    await expect(boxes.nth(index)).toBeChecked();
  }
  await expect(dialog(page).getByRole("button", { name: "Inches", exact: true })).toHaveAttribute("aria-pressed", "true");
}
function expectedPayload(reference: unknown, fingerprint = FINGERPRINT, units = "inch") {
  return { p_job_id: ID.job, p_declared_model_units: units, p_expected_scope_fingerprint: fingerprint,
    p_policy_revision: POLICY, p_approval_reference: reference,
    p_authority_to_share: true, p_non_export_controlled: true, p_quote_only: true };
}

test.afterEach(async ({ backend }, testInfo) => {
  await testInfo.attach("synthetic-quote-rpc-audit", { contentType: "application/json", body: JSON.stringify({
    calls: backend.calls, syntheticLogicalCreates: backend.committed.size,
    blockedRequests: backend.forbidden, pageErrors: backend.pageErrors,
  }, null, 2) });
  expect(backend.forbidden, "Unexpected calls were blocked before send").toEqual([]);
  expect(backend.pageErrors).toEqual([]);
  expect(backend.calls.some(call => /api_request_quote(?:s|_scoped)?$/.test(call.name))).toBe(false);
});

test("eligible enrolled Free customer must choose units and all affirmations before one queued request", async ({ page, backend }) => {
  await openConfirmation(page);
  expect(backend.scopes).toHaveLength(0);
  await selectScope(page);
  await expect(dialog(page)).toContainText("synthetic-bracket.step");
  await expect(dialog(page)).toContainText("123 Synthetic Avenue");
  await expect(dialog(page)).toContainText("no card charge, order, purchase order, or supplier commitment");
  await affirm(page);
  expect(backend.dispatches).toHaveLength(0);
  const release = backend.holdNextDispatch();
  try {
    await activateTwice(confirm(page));
    await expect.poll(() => backend.dispatches.length).toBe(1);
    await expect(confirm(page)).toBeDisabled();
    await expectLockedConsent(page);
    await expect(dialog(page).getByRole("button", { name: "Close", exact: true }).first()).toBeDisabled();
    await activateTwice(confirm(page));
    expect(backend.dispatches).toHaveLength(1);
  } finally { release(); }
  await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  await activateTwice(confirm(page));
  expect(backend.dispatches).toHaveLength(1);
  expect(backend.committed.size).toBe(1);
  const input = backend.dispatches[0].input;
  expect(input.p_approval_reference).toMatch(/^[0-9a-f-]{36}$/);
  expect(input).toEqual(expectedPayload(input.p_approval_reference));
  expect(backend.calls.some(call => call.name === "api_get_founding_beta_access_state")).toBe(true);
  await expect(dialog(page)).toContainText("Xometry has not yet been confirmed as having received the package");
});

for (const accessMode of ["blocked", "error", "malformed"] as const) {
  test(`quote access ${accessMode} hides dispatch and fails closed`, async ({ page, backend }) => {
    backend.accessMode = accessMode;
    await openPage(page);
    await expect.poll(() => backend.calls.filter(call => call.name === "api_get_quote_access").length).toBe(1);
    await expect(page.getByText("Automatic quote access", { exact: true })).toBeVisible();
    await expect(page.getByText(/Automatic quote collection is not enabled for this organization/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check previous quote request", exact: true })).toHaveCount(0);
    expect(backend.scopes).toHaveLength(0);
    expect(backend.dispatches).toHaveLength(0);
    expect(backend.committed.size).toBe(0);
  });
}

for (const scopeMode of ["error", "malformed"] as const) {
  test(`scope ${scopeMode} has no consent or dispatch and can recover through Retry scope check`, async ({ page, backend }) => {
    backend.scopeMode = scopeMode;
    await openConfirmation(page);
    await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("not ready for controlled Xometry beta dispatch");
    await expect(confirm(page)).toBeDisabled();
    await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
    expect(backend.dispatches).toHaveLength(0);
    backend.scopeMode = "ready";
    await dialog(page).getByRole("button", { name: "Retry scope check", exact: true }).click();
    await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
    await affirm(page);
    await confirm(page).click();
    await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
    expect(backend.committed.size).toBe(1);
  });
}

test("changing units revokes unsubmitted consent and confirms only the new scope", async ({ page, backend }) => {
  await openConfirmation(page); await selectScope(page); await affirm(page);
  await dialog(page).getByRole("button", { name: "Millimeters", exact: true }).click();
  await expect(dialog(page).getByText(MILLIMETER_FINGERPRINT, { exact: true })).toBeVisible();
  await affirm(page);
  expect(backend.dispatches).toHaveLength(0);
  await confirm(page).click();
  await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
  expect(backend.dispatches[0].input).toEqual(expectedPayload(backend.dispatches[0].input.p_approval_reference, MILLIMETER_FINGERPRINT, "millimeter"));
});

for (const refreshedAccess of ["eligible", "blocked"] as const) {
  test(`unknown committed response preserves exact replay through edits, refresh and recovery-only reopen (${refreshedAccess})`, async ({ page, backend }) => {
    await openConfirmation(page); await selectScope(page); await affirm(page);
    backend.nextReply = "lost-after-commit";
    const releaseInitial = backend.holdNextDispatch();
    try {
      await activateTwice(confirm(page));
      await expect.poll(() => backend.dispatches.length).toBe(1);
      await expect(confirm(page)).toBeDisabled();
      await expectLockedConsent(page);
      await expect(page.getByRole("button", { name: "Check previous quote request", exact: true, includeHidden: true })).toHaveCount(0);
    } finally { releaseInitial(); }
    await expect(dialog(page).getByRole("alert")).toContainText("could not confirm whether the request was queued");
    await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toHaveCount(0);
    const attempted = structuredClone(backend.dispatches[0].input);
    expect(backend.committed.size).toBe(1);
    await expectLockedConsent(page);
    backend.changed = true;
    backend.accessMode = refreshedAccess;
    const previousScopes = backend.scopes.length;
    const refreshedScope = page.waitForResponse(response => response.url().endsWith("/rest/v1/rpc/api_get_xometry_beta_dispatch_scope") && response.status() === 200);
    await dialog(page).getByRole("button", { name: "Refresh current scope", exact: true }).click();
    expect((await (await refreshedScope).json()).scopeFingerprint).toBe(CHANGED_FINGERPRINT);
    await expect.poll(() => backend.scopes.length).toBeGreaterThan(previousScopes);
    await expect(confirm(page)).toBeEnabled();
    await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
    await expect(dialog(page).getByText(CHANGED_FINGERPRINT, { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByRole("alert")).toContainText("could not confirm whether the request was queued");
    await expectLockedConsent(page);
    await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog(page)).toHaveCount(0);
    if (refreshedAccess === "blocked") {
      await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Check previous quote request", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("same approval reference");
    await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
    await expectLockedConsent(page);
    const release = backend.holdNextDispatch();
    try {
      await activateTwice(confirm(page));
      await expect.poll(() => backend.dispatches.length).toBe(2);
      await expect(confirm(page)).toBeDisabled();
      expect(backend.dispatches[1].input).toEqual(attempted);
    } finally { release(); }
    await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
    await expect(confirm(page)).toBeDisabled();
    await activateTwice(confirm(page));
    expect(backend.dispatches).toHaveLength(2);
    expect(backend.committed.size).toBe(1);
    await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Check previous quote request", exact: true })).toHaveCount(0);
    if (refreshedAccess === "blocked") {
      await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
    }
  });
}

for (const denialCode of ["xometry_beta_scope_changed", "free_allowance_unavailable"]) {
  test(`explicit ${denialCode} denial resets consent and requires the refreshed scope`, async ({ page, backend }) => {
    await openConfirmation(page); await selectScope(page); await affirm(page);
    const oldScopeReads = backend.scopes.length;
    backend.changed = true;
    backend.nextReply = "denied";
    backend.denialCode = denialCode;
    await confirm(page).click();
    await expect(dialog(page).getByRole("alert").filter({ hasText: "current package was not queued" })).toContainText("current package was not queued");
    await expect.poll(() => backend.scopes.length).toBeGreaterThan(oldScopeReads);
    await expect(dialog(page).getByText(CHANGED_FINGERPRINT, { exact: true })).toBeVisible();
    await expect(confirm(page)).toBeDisabled();
    expect(backend.committed.size).toBe(0);
    const denied = backend.dispatches[0].input;
    expect(denied.p_expected_scope_fingerprint).toBe(FINGERPRINT);
    await affirm(page);
    await confirm(page).click();
    await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
    expect(backend.dispatches).toHaveLength(2);
    expect(backend.dispatches[1].input.p_approval_reference).not.toBe(denied.p_approval_reference);
    expect(backend.dispatches[1].input).toEqual(expectedPayload(backend.dispatches[1].input.p_approval_reference, CHANGED_FINGERPRINT));
    expect(backend.committed.size).toBe(1);
  });
}

test("denied recovery after blocked refresh cannot become a fresh confirmation", async ({ page, backend }) => {
  await openConfirmation(page); await selectScope(page); await affirm(page);
  backend.nextReply = "lost-before-commit";
  await confirm(page).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not confirm whether the request was queued");
  const attempted = structuredClone(backend.dispatches[0].input);
  backend.changed = true;
  backend.accessMode = "blocked";
  const refreshedScope = page.waitForResponse(response => response.url().endsWith("/rest/v1/rpc/api_get_xometry_beta_dispatch_scope"));
  await dialog(page).getByRole("button", { name: "Refresh current scope", exact: true }).click();
  await refreshedScope;
  await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check previous quote request", exact: true }).click();
  backend.nextReply = "denied";
  backend.denialCode = "free_allowance_unavailable";
  await confirm(page).click();
  await expect(dialog(page).getByRole("alert").filter({ hasText: "current package was not queued" })).toContainText("current package was not queued");
  await expect(confirm(page)).toBeDisabled();
  await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
  expect(backend.dispatches).toHaveLength(2);
  expect(backend.dispatches[1].input).toEqual(attempted);
  expect(backend.committed.size).toBe(0);
  await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check previous quote request", exact: true })).toHaveCount(0);
});

test("closing an unsubmitted confirmation discards consent and Escape leaves no stale dialog", async ({ page, backend }) => {
  await openConfirmation(page); await selectScope(page); await affirm(page);
  await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Request quote", exact: true }).click();
  await expect(confirm(page)).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Inches", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(backend.dispatches).toHaveLength(0);
});
