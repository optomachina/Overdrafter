import { test as base, expect, type Page } from "@playwright/test";
import { FINGERPRINT } from "./data";
import { QuoteBrowserBackend } from "./network";

// Customer-visible error containment on the real ClientPart page. Every failing RPC body
// carries the same synthetic leak sentinels in message, details and hint. None may reach body
// text, a toast, a dialog or rendered markup, and each failure must still show a finite
// message with a next action. Not named *.spec.ts; there is no skip or browser fallback.
const test = base.extend<{ backend: QuoteBrowserBackend }>({
  backend: async ({ context }, provide) => {
    const backend = new QuoteBrowserBackend();
    await backend.install(context);
    await provide(backend);
  },
  page: async ({ context, backend }, provide) => {
    // Depending on backend installs containment before page creation, including all popups.
    expect(backend.calls, "No RPC may run before the page exists").toEqual([]);
    const page = await context.newPage();
    await provide(page);
    await page.close();
  },
});

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const SENTINELS = [
  // JWT-shaped: three base64url segments starting with eyJ. Synthetic, unsigned claims only.
  [base64Url({ alg: "none", typ: "JWT" }), base64Url({ sub: "synthetic-leak-sentinel" }), base64Url("synthetic")].join("."),
  "service_role",
  "storageState",
  "at fn (https://x.invalid/a.js:1:2)",
  "leak-sentinel@example.invalid",
];
function leakingReply(status: number, code: string) {
  const leak = SENTINELS.join(" ");
  return { status, body: { code, message: `Synthetic failure ${leak}`, details: leak, hint: leak } };
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Confirm Xometry beta quote request" });
const closeDialog = (page: Page) => dialog(page).getByRole("button", { name: "Close", exact: true }).first();
const openPage = (page: Page) => page.goto("/e2e/quote-confirmation/index.html");

async function openConfirmation(page: Page) {
  await openPage(page);
  await page.getByRole("button", { name: "Request quote", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

async function expectNoSentinel(page: Page) {
  const surfaces = await page.evaluate(() => ({
    body: document.body.innerText,
    toasts: Array.from(document.querySelectorAll("[data-sonner-toast]"), node => node.textContent ?? "").join("\n"),
    dialogs: Array.from(document.querySelectorAll("[role=dialog],[role=alertdialog]"), node => node.textContent ?? "").join("\n"),
    markup: document.documentElement.outerHTML,
  }));
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const sentinel of SENTINELS) expect(text, `${surface} must not show "${sentinel}"`).not.toContain(sentinel);
  }
}

test.afterEach(async ({ backend }, testInfo) => {
  await testInfo.attach("synthetic-error-rpc-audit", { contentType: "application/json", body: JSON.stringify({
    calls: backend.calls, syntheticLogicalCreates: backend.committed.size,
    blockedRequests: backend.forbidden, pageErrors: backend.pageErrors,
  }, null, 2) });
  expect(backend.forbidden, "Unexpected calls were blocked before send").toEqual([]);
  expect(backend.pageErrors).toEqual([]);
});

test("scope lookup 400 shows bounded copy and Retry scope check without leaking the server body", async ({ page, backend }) => {
  backend.scopeMode = "error";
  backend.failureReply = leakingReply(400, "P0001");
  await openConfirmation(page);
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  const alert = dialog(page).getByRole("alert");
  await expect(alert).toContainText("This package is not ready for controlled Xometry beta dispatch.");
  // Bounded controller copy: "could not be loaded" for PostgREST objects, "could not be verified" for Error instances.
  await expect(alert).toContainText(/The (?:current )?Xometry confirmation scope could not be (?:loaded|verified)\./);
  await expectNoSentinel(page);
  await expect(closeDialog(page)).toBeEnabled();
  const retry = alert.getByRole("button", { name: "Retry scope check", exact: true });
  await expect(retry).toBeEnabled();
  expect(backend.dispatches).toHaveLength(0);
  backend.scopeMode = "ready";
  backend.failureReply = null;
  await retry.click();
  await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
});

test("dispatch 500 shows the unknown-outcome copy and safe recheck without leaking the server body", async ({ page, backend }) => {
  await openConfirmation(page);
  await dialog(page).getByRole("button", { name: "Inches", exact: true }).click();
  await expect(dialog(page).getByText(FINGERPRINT, { exact: true })).toBeVisible();
  const boxes = dialog(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(3);
  for (let index = 0; index < 3; index++) await boxes.nth(index).check();
  backend.nextReply = "denied";
  backend.failureReply = leakingReply(500, "XX000");
  await dialog(page).getByRole("button", { name: "Confirm & queue Xometry quote", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not confirm whether the request was queued");
  await expect(page.locator("[data-sonner-toast]").filter({
    hasText: "The request status could not be confirmed. Check the previous quote request to retry safely.",
  })).toBeVisible();
  await expectNoSentinel(page);
  expect(backend.dispatches).toHaveLength(1);
  expect(backend.committed.size).toBe(0);
  await expect(closeDialog(page)).toBeEnabled();
  await closeDialog(page).click();
  const recheck = page.getByRole("button", { name: "Check previous quote request", exact: true });
  await expect(recheck).toBeEnabled();
  backend.failureReply = null;
  await recheck.click();
  await dialog(page).getByRole("button", { name: "Confirm & queue Xometry quote", exact: true }).click();
  await expect(dialog(page).getByText("Xometry quote request queued", { exact: true })).toBeVisible();
  expect(backend.dispatches).toHaveLength(2);
  expect(backend.dispatches[1].input).toEqual(backend.dispatches[0].input);
  expect(backend.committed.size).toBe(1);
});

test("quote-access lookup error fails closed with bounded copy without leaking the server body", async ({ page, backend }) => {
  backend.accessMode = "error";
  backend.failureReply = leakingReply(401, "PGRST301");
  await openPage(page);
  await expect.poll(() => backend.calls.filter(call => call.name === "api_get_quote_access").length).toBe(1);
  await expect(page.getByText("Automatic quote access", { exact: true })).toBeVisible();
  await expect(page.getByText(/Automatic quote collection is not enabled for this organization/)).toBeVisible();
  await expectNoSentinel(page);
  await expect(page.getByRole("button", { name: "Request quote", exact: true })).toHaveCount(0);
  // This lookup has no in-page retry control; reloading the page is the existing recovery path.
  backend.accessMode = "eligible";
  backend.failureReply = null;
  await page.reload();
  await expect(page.getByRole("button", { name: "Request quote", exact: true })).toBeEnabled();
  expect(backend.scopes).toHaveLength(0);
  expect(backend.dispatches).toHaveLength(0);
});
