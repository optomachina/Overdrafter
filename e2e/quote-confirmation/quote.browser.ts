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

// OVD-1163: a small, plain popup. One consent line carries the three server attestations.
const confirmName = "Send quote request";
const dialogName = "Request a quote";
const consentName = "I can share these files, they aren't export-controlled, and this is a quote request only.";
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
const consent = (page: Page) => dialog(page).getByRole("checkbox", { name: consentName, exact: true });
/** The consent line appears only once a server scope is loaded; the scope itself is never shown. */
async function expectScopeLoaded(page: Page) {
  await expect(consent(page)).toBeVisible();
  await expect(dialog(page)).not.toContainText(/fingerprint|founding|beta|xometry|disclosure|package|dispatch/i);
}
async function selectScope(page: Page) {
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  await expectScopeLoaded(page);
}
async function affirm(page: Page) {
  const boxes = dialog(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(1);
  await expect(consent(page)).not.toBeChecked();
  await expect(confirm(page)).toBeDisabled();
  await consent(page).check();
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
  await expect(boxes).toHaveCount(1);
  await expect(consent(page)).toBeDisabled();
  await consent(page).evaluate((element: HTMLButtonElement) => element.click());
  await expect(consent(page)).toBeChecked();
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

test("eligible enrolled Free customer must choose units and the one consent before one queued request", async ({ page, backend }) => {
  await openConfirmation(page);
  expect(backend.scopes).toHaveLength(0);
  await selectScope(page);
  await expect(dialog(page)).toContainText("What units is this CAD model in?");
  await expect(dialog(page)).not.toContainText(FINGERPRINT);
  await expect(dialog(page)).not.toContainText(POLICY);
  await expect(dialog(page)).not.toContainText("synthetic-bracket.step");
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
  await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  await activateTwice(confirm(page));
  expect(backend.dispatches).toHaveLength(1);
  expect(backend.committed.size).toBe(1);
  const input = backend.dispatches[0].input;
  expect(input.p_approval_reference).toMatch(/^[0-9a-f-]{36}$/);
  expect(input).toEqual(expectedPayload(input.p_approval_reference));
  expect(backend.calls.some(call => call.name === "api_get_founding_beta_access_state")).toBe(true);
  await expect(dialog(page)).toContainText("The supplier hasn't confirmed receipt yet.");
});

for (const accessMode of ["blocked", "error", "malformed"] as const) {
  test(`quote access ${accessMode} hides dispatch and fails closed`, async ({ page, backend }) => {
    backend.accessMode = accessMode;
    await openPage(page);
    await expect.poll(() => backend.calls.filter(call => call.name === "api_get_quote_access").length).toBe(1);
    await expect(page.getByText("Automatic quote access", { exact: true })).toBeVisible();
    // A confirmed denial says collection is not enabled; an unverifiable lookup says so instead (OVD-1033 P2).
    await expect(page.locator("p").filter({ hasText: accessMode === "blocked"
      ? /Automatic quote collection is not enabled for this organization/
      : /automatic quote access could not be verified/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check previous quote request", exact: true })).toHaveCount(0);
    expect(backend.scopes).toHaveLength(0);
    expect(backend.dispatches).toHaveLength(0);
    expect(backend.committed.size).toBe(0);
  });
}

for (const scopeMode of ["error", "malformed"] as const) {
  test(`scope ${scopeMode} has no consent or dispatch and can recover through Check again`, async ({ page, backend }) => {
    backend.scopeMode = scopeMode;
    await openConfirmation(page);
    await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await expect(dialog(page).getByRole("alert")).not.toContainText(/scope|dispatch|package|beta|Xometry/i);
    await expect(confirm(page)).toBeDisabled();
    await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
    expect(backend.dispatches).toHaveLength(0);
    backend.scopeMode = "ready";
    await dialog(page).getByRole("button", { name: "Check again", exact: true }).click();
    await expectScopeLoaded(page);
    await affirm(page);
    await confirm(page).click();
    await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
    expect(backend.committed.size).toBe(1);
  });
}

test("changing units revokes unsubmitted consent and confirms only the new scope", async ({ page, backend }) => {
  await openConfirmation(page); await selectScope(page); await affirm(page);
  await dialog(page).getByRole("button", { name: "Millimeters", exact: true }).click();
  await expect.poll(() => backend.scopes.at(-1)?.input.p_declared_model_units).toBe("millimeter");
  await expectScopeLoaded(page);
  await affirm(page);
  expect(backend.dispatches).toHaveLength(0);
  await confirm(page).click();
  await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
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
    await expect(dialog(page).getByText("Quote request queued", { exact: true })).toHaveCount(0);
    const attempted = structuredClone(backend.dispatches[0].input);
    expect(backend.committed.size).toBe(1);
    await expectLockedConsent(page);
    backend.changed = true;
    backend.accessMode = refreshedAccess;
    const previousScopes = backend.scopes.length;
    const refreshedScope = page.waitForResponse(response => response.url().endsWith("/rest/v1/rpc/api_get_xometry_beta_dispatch_scope") && response.status() === 200);
    await dialog(page).getByRole("button", { name: "Check again", exact: true }).click();
    expect((await (await refreshedScope).json()).scopeFingerprint).toBe(CHANGED_FINGERPRINT);
    await expect.poll(() => backend.scopes.length).toBeGreaterThan(previousScopes);
    await expect(confirm(page)).toBeEnabled();
    // The changed scope is never offered: the replay below sends the original fingerprint.
    await expect(dialog(page)).not.toContainText(CHANGED_FINGERPRINT);
    await expect(dialog(page).getByRole("alert")).toContainText("could not confirm whether the request was queued");
    await expectLockedConsent(page);
    await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog(page)).toHaveCount(0);
    if (refreshedAccess === "blocked") {
      await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Check previous quote request", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("it won't be sent twice");
    expect(attempted.p_expected_scope_fingerprint).toBe(FINGERPRINT);
    await expectLockedConsent(page);
    const release = backend.holdNextDispatch();
    try {
      await activateTwice(confirm(page));
      await expect.poll(() => backend.dispatches.length).toBe(2);
      await expect(confirm(page)).toBeDisabled();
      expect(backend.dispatches[1].input).toEqual(attempted);
    } finally { release(); }
    await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
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
    await expect(dialog(page).getByRole("alert").filter({ hasText: "request was not sent" })).toContainText("request was not sent");
    await expect.poll(() => backend.scopes.length).toBeGreaterThan(oldScopeReads);
    await expect(consent(page)).not.toBeChecked();
    await expect(confirm(page)).toBeDisabled();
    expect(backend.committed.size).toBe(0);
    const denied = backend.dispatches[0].input;
    expect(denied.p_expected_scope_fingerprint).toBe(FINGERPRINT);
    await affirm(page);
    await confirm(page).click();
    await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
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
  await dialog(page).getByRole("button", { name: "Check again", exact: true }).click();
  await refreshedScope;
  await dialog(page).getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check previous quote request", exact: true }).click();
  backend.nextReply = "denied";
  backend.denialCode = "free_allowance_unavailable";
  await confirm(page).click();
  await expect(dialog(page).getByRole("alert").filter({ hasText: "request was not sent" })).toContainText("request was not sent");
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

test("an organization with no shipping address confirms it inside the dialog, and the confirmation survives reload", async ({ page, backend }) => {
  backend.destination = { address: { street: null, city: null, region: null, postalCode: null, country: "US" }, confirmed: false };
  const entered = { street: "100 Example Way", city: "Sampletown", region: "AZ", postalCode: "85001", country: "US" };
  await openConfirmation(page);
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Confirm your organization's shipping address so suppliers can quote.");
  await expect(dialog(page).getByRole("button", { name: "Open Settings to confirm address" })).toHaveCount(0);
  const panel = dialog(page).getByRole("region", { name: "Quote shipping destination" });
  await expect(panel).toContainText("Add street, city, ZIP, state before confirming.");
  const save = panel.getByRole("button", { name: "Save and confirm address", exact: true });
  await expect(save).toBeDisabled();
  await panel.getByLabel("Street").fill(entered.street);
  await panel.getByLabel("City").fill(entered.city);
  await panel.getByLabel("State").fill(entered.region);
  await panel.getByLabel("ZIP").fill(entered.postalCode);
  await save.click();

  // The confirmation re-runs the scope check by itself; no Retry click and no Settings detour.
  await expectScopeLoaded(page);
  await expect(panel).toHaveCount(0);
  expect(backend.scopes).toHaveLength(2);
  const writes = backend.calls.filter(call => call.name === "api_update_organization_addresses");
  expect(writes.map(call => call.input)).toEqual([{ p_organization_id: ID.organization, p_patch: {
    shippingSameAsBilling: false, shippingStreet: entered.street, shippingCity: entered.city,
    shippingState: entered.region, shippingZip: entered.postalCode, shippingCountry: entered.country } }]);
  const confirmations = backend.calls.filter(call => call.name === "api_confirm_sourcing_destination");
  expect(confirmations.map(call => call.input)).toEqual([{ p_organization_id: ID.organization, p_expected_address: entered }]);
  await affirm(page);
  expect(backend.dispatches).toHaveLength(0);

  // A reload reads the confirmed destination from the server; nothing is asked again.
  await page.reload();
  await openConfirmation(page);
  await selectScope(page);
  await expect(dialog(page).getByRole("region", { name: "Quote shipping destination" })).toHaveCount(0);
  expect(backend.calls.filter(call => call.name === "api_confirm_sourcing_destination")).toHaveLength(1);
  expect(backend.dispatches).toHaveLength(0);
});

// OVD-1163: a finished part is refused with plain copy and a one-click, quote-only fix that
// re-runs the check by itself. Screenshots of both states are kept as test output.
test("a finished part is quoted as machined in one click, then asks for the one consent", async ({ page, backend }, testInfo) => {
  backend.drawingFinish = true;
  await page.setViewportSize({ width: 900, height: 760 });
  await openConfirmation(page);
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  const alert = dialog(page).getByRole("alert");
  await expect(alert).toContainText("Finishes can't be quoted yet.");
  await expect(dialog(page)).not.toContainText(/scope|dispatch|package|envelope|beta|Xometry/i);
  await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
  await expect(confirm(page)).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("ovd1163-popup-finish-refusal.png") });
  const scopesBefore = backend.scopes.length;

  await alert.getByRole("button", { name: "Quote as machined (price won't include the finish)", exact: true }).click();

  await expect(consent(page)).toBeVisible();
  expect(backend.calls.filter(call => call.name === "api_set_client_part_quote_as_machined").map(call => call.input))
    .toEqual([{ p_job_id: ID.job, p_quote_as_machined: true }]);
  expect(backend.scopes.length).toBe(scopesBefore + 1);
  expect(backend.calls.some(call => call.name === "api_update_client_part_request")).toBe(false);
  expect(backend.dispatches).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("ovd1163-popup-ready.png") });
  await affirm(page);
  await confirm(page).click();
  await expect(dialog(page).getByText("Quote request queued", { exact: true })).toBeVisible();
  expect(backend.dispatches[0].input).toEqual(expectedPayload(backend.dispatches[0].input.p_approval_reference));
});
