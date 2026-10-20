import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../test";
import { FLAG_ON_SERVER_START_TIMEOUT_MS, createFlagOnServer } from "./flag-on-dev-server";

// OVD-997 (slice P1 of OVD-987): the part request form shows one Quantity field instead of Qty and
// Quote quantities when VITE_CONTROLLED_BETA_SINGLE_QUANTITY=1, and offers a quantity above 1 only
// when the server scoped it. Fixture mode only, no Supabase. The flag is read from import.meta.env
// (src/lib/single-quantity-flag.ts): the default Playwright web server leaves it unset (flag OFF) and
// this spec starts one extra dev server with it set to "1" (flag ON); see flag-on-dev-server.ts.
//
// Set SINGLE_QUANTITY_SCREENSHOT_DIR to also save screenshots there.

const flagOnServer = createFlagOnServer(4175, { VITE_CONTROLLED_BETA_SINGLE_QUANTITY: "1" });
const PART_ROUTE = "/parts/fx-job-published?fixture=client-published&debug=1";
const APP_ENTRY_TIMEOUT_MS = 30_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
// The fixture's signed-in user and organization; the server read must echo the identity it checked.
const FIXTURE_USER_ID = "fixture-user-client";
const FIXTURE_ORGANIZATION_ID = "fixture-org-1";
// The fixture request is saved with quantities 25 and 50, so its Quantity field starts at 25.
const FIXTURE_SAVED_QUANTITY = "25";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

type ScopeAnswer = { state: "single_only"; grant: null } | { state: "multiple_allowed"; grant: "request" };
const SCOPED_TO_THIS_REQUEST: ScopeAnswer = { state: "multiple_allowed", grant: "request" };
const NOT_SCOPED: ScopeAnswer = { state: "single_only", grant: null };

/** Answers the server read for the fixture job the way the server will, echoing the identity it checked. */
async function answerQuantityScope(page: Page, answer: ScopeAnswer, calls: string[]) {
  await page.route("**/rest/v1/rpc/api_get_quantity_scope", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const { p_job_id: jobId } = route.request().postDataJSON() as { p_job_id: string };
    calls.push(jobId);
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        schema: "quantity-scope.v1",
        jobId,
        organizationId: FIXTURE_ORGANIZATION_ID,
        actorUserId: FIXTURE_USER_ID,
        ...answer,
      }),
    });
  });
}

/** The server read fails the way a transient outage does: the page gets an error, not an answer. */
async function failQuantityScope(page: Page, calls: string[]) {
  await page.route("**/rest/v1/rpc/api_get_quantity_scope", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    calls.push("failed");
    await route.fulfill({
      status: 503,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ message: "temporarily unavailable" }),
    });
  });
}

async function openPartPage(page: Page, origin?: string) {
  await page.goto(origin ? `${origin}${PART_ROUTE}` : PART_ROUTE);
  await page.locator("[data-client-shell]").waitFor();
}

async function attachScreenshot(page: Page, name: string) {
  const screenshotDir = process.env.SINGLE_QUANTITY_SCREENSHOT_DIR;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
  }
}

test.describe("part request single Quantity field", { tag: "@fixture" }, () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: DESKTOP_VIEWPORT });

  test.beforeAll(async () => {
    test.setTimeout(FLAG_ON_SERVER_START_TIMEOUT_MS + 10_000);
    await flagOnServer.start();
  });

  test.afterAll(() => {
    flagOnServer.stop();
  });

  test("flag OFF (default): Qty and Quote quantities stay as they were and nothing is asked of the server", async ({ page }) => {
    const calls: string[] = [];
    await answerQuantityScope(page, SCOPED_TO_THIS_REQUEST, calls);
    await openPartPage(page);

    await expect(page.getByLabel("Qty", { exact: true })).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(page.getByLabel("Quote quantities", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Quantity", { exact: true })).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test("flag ON, server has not scoped a quantity: one Quantity field, fixed at 1, with the reason", async ({ page }, testInfo) => {
    const calls: string[] = [];
    await answerQuantityScope(page, NOT_SCOPED, calls);
    await openPartPage(page, flagOnServer.origin);

    const quantity = page.getByLabel("Quantity", { exact: true });
    await expect(quantity).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(quantity).toHaveValue("1");
    await expect(quantity).toHaveAttribute("readonly", "");
    await expect(page.getByText(/quotes 1 piece per request/i)).toBeVisible();
    await expect(page.getByText(/could not check which quantities/i)).toHaveCount(0);
    await expect(page.getByLabel("Qty", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Quote quantities", { exact: true })).toHaveCount(0);
    expect(calls.length).toBeGreaterThan(0);

    await quantity.scrollIntoViewIfNeeded();
    await testInfo.attach("single-quantity-fixed-at-1", {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
    await attachScreenshot(page, "single-quantity-fixed-at-1");
  });

  test("flag ON, scope read fails: Quantity keeps the saved value, says the check failed, and a save does not write 1", async ({ page }, testInfo) => {
    const calls: string[] = [];
    await failQuantityScope(page, calls);
    await openPartPage(page, flagOnServer.origin);

    const quantity = page.getByLabel("Quantity", { exact: true });
    await expect(quantity).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(page.getByText(/could not check which quantities this request can use/i)).toBeVisible();
    expect(calls.length).toBeGreaterThan(0);
    // The failed read is not the server's policy: no "specific requests only" copy, no value forced to 1.
    await expect(quantity).toHaveAttribute("readonly", "");
    await expect(quantity).toHaveValue(FIXTURE_SAVED_QUANTITY);
    await expect(page.getByText(/turned on for specific requests only/i)).toHaveCount(0);
    await expect(page.getByText(/Saving sets the quantity to 1/)).toHaveCount(0);

    const save = page.getByRole("button", { name: "Save request details" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(quantity).toHaveValue(FIXTURE_SAVED_QUANTITY);

    await quantity.scrollIntoViewIfNeeded();
    await testInfo.attach("single-quantity-unavailable", {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
    await attachScreenshot(page, "single-quantity-unavailable");
  });

  test("flag ON, server scoped the request: Quantity is editable and saves as one quantity", async ({ page }, testInfo) => {
    const calls: string[] = [];
    await answerQuantityScope(page, SCOPED_TO_THIS_REQUEST, calls);
    await openPartPage(page, flagOnServer.origin);

    const quantity = page.getByLabel("Quantity", { exact: true });
    await expect(quantity).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(quantity).not.toHaveAttribute("readonly", "");
    await expect(page.getByText("Each request is quoted at one quantity.")).toBeVisible();
    expect(calls.length).toBeGreaterThan(0);
    await expect(page.getByLabel("Quote quantities", { exact: true })).toHaveCount(0);

    await quantity.fill("250");
    await expect(quantity).toHaveValue("250");
    await expect(page.getByRole("alert").filter({ hasText: "whole number" })).toHaveCount(0);
    await quantity.fill("2.5");
    await expect(page.getByRole("alert").filter({ hasText: "Enter a whole number from 1 to 2,147,483,647." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save request details" })).toBeDisabled();

    await quantity.fill("250");
    const save = page.getByRole("button", { name: "Save request details" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(quantity).toHaveValue("250");
    await expect(page.getByText(/This request is saved with/)).toHaveCount(0);

    await quantity.scrollIntoViewIfNeeded();
    await testInfo.attach("single-quantity-scoped", {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
    await attachScreenshot(page, "single-quantity-scoped");
  });
});
