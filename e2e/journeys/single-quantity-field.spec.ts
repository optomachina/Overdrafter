import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../test";

// OVD-997 (slice P1 of OVD-987): the part request form shows one Quantity field instead of Qty and
// Quote quantities when VITE_CONTROLLED_BETA_SINGLE_QUANTITY=1, and offers a quantity above 1 only
// when the server scoped it. Fixture mode only, no Supabase. The flag is read from import.meta.env
// (src/lib/single-quantity-flag.ts), so it is fixed when a Vite dev server starts. The default
// Playwright web server leaves it unset (flag OFF); this spec starts one extra dev server of the same
// app with the flag set to "1" (flag ON) and stops it afterwards.
//
// Set SINGLE_QUANTITY_SCREENSHOT_DIR to also save screenshots there.

const FLAG_ON_PORT = 4175;
const FLAG_ON_ORIGIN = `http://127.0.0.1:${FLAG_ON_PORT}`;
const PART_ROUTE = "/parts/fx-job-published?fixture=client-published&debug=1";
const APP_ENTRY_TIMEOUT_MS = 30_000;
const SERVER_START_TIMEOUT_MS = 120_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The fixture's signed-in user and organization; the server read must echo the identity it checked.
const FIXTURE_USER_ID = "fixture-user-client";
const FIXTURE_ORGANIZATION_ID = "fixture-org-1";
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

let flagOnServer: ChildProcess | undefined;

async function waitForServer(origin: string) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (flagOnServer?.exitCode !== null && flagOnServer?.exitCode !== undefined) {
      throw new Error(`flag-on dev server exited early with code ${flagOnServer.exitCode}`);
    }
    try {
      if ((await fetch(origin)).ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`flag-on dev server did not answer at ${origin}`);
}

/** Answers the server read for the fixture job the way the server will: scoped to this request. */
async function scopeQuantityToThisRequest(page: Page, calls: string[]) {
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
        state: "multiple_allowed",
        grant: "request",
      }),
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
    test.setTimeout(SERVER_START_TIMEOUT_MS + 10_000);
    flagOnServer = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(FLAG_ON_PORT), "--strictPort"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          VITE_ENABLE_FIXTURE_MODE: "1",
          VITE_ENABLE_ENGINEERING_WORKBENCH: "1",
          VITE_SUPABASE_URL: "http://127.0.0.1:9",
          VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "fixture-unused-publishable-key",
          VITE_CONTROLLED_BETA_SINGLE_QUANTITY: "1",
        },
        stdio: "ignore",
      },
    );
    await waitForServer(FLAG_ON_ORIGIN);
  });

  test.afterAll(() => {
    flagOnServer?.kill("SIGTERM");
    flagOnServer = undefined;
  });

  test("flag OFF (default): Qty and Quote quantities stay as they were and nothing is asked of the server", async ({ page }) => {
    const calls: string[] = [];
    await scopeQuantityToThisRequest(page, calls);
    await openPartPage(page);

    await expect(page.getByLabel("Qty", { exact: true })).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(page.getByLabel("Quote quantities", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Quantity", { exact: true })).toHaveCount(0);
    expect(calls).toEqual([]);
  });

  test("flag ON, server has not scoped a quantity: one Quantity field, fixed at 1, with the reason", async ({ page }, testInfo) => {
    await openPartPage(page, FLAG_ON_ORIGIN);

    const quantity = page.getByLabel("Quantity", { exact: true });
    await expect(quantity).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(quantity).toHaveValue("1");
    await expect(quantity).toHaveAttribute("readonly", "");
    await expect(page.getByText(/quotes 1 piece per request/i)).toBeVisible();
    await expect(page.getByLabel("Qty", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Quote quantities", { exact: true })).toHaveCount(0);

    await quantity.scrollIntoViewIfNeeded();
    await testInfo.attach("single-quantity-fixed-at-1", {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
    await attachScreenshot(page, "single-quantity-fixed-at-1");
  });

  test("flag ON, server scoped the request: Quantity is editable and saves as one quantity", async ({ page }, testInfo) => {
    const calls: string[] = [];
    await scopeQuantityToThisRequest(page, calls);
    await openPartPage(page, FLAG_ON_ORIGIN);

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
