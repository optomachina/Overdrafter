import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../test";
import { FLAG_ON_SERVER_START_TIMEOUT_MS, createFlagOnServer } from "./flag-on-dev-server";

// OVD-969 journey: a signed-in client opens a part page and reads the provider
// notes on the selected quote, only when VITE_ENABLE_QUOTE_PROVIDER_NOTES=1.
// Fixture mode only: the part and its offers come from `?fixture=client-comparison`,
// no Supabase. The flag is read from import.meta.env (src/lib/quote-provider-notes-flag.ts),
// so it is fixed when a Vite dev server starts. The default Playwright web server
// leaves it unset (flag OFF); this spec starts one extra dev server of the same
// app with the flag set to "1" (flag ON) and stops it afterwards.
//
// Set PROVIDER_NOTES_SCREENSHOT_DIR to also save the flag-ON screenshot there.

const flagOnServer = createFlagOnServer(4174, { VITE_ENABLE_QUOTE_PROVIDER_NOTES: "1" });
const PART_ROUTE = "/parts/fx-job-comparison?fixture=client-comparison&debug=1";
const APP_ENTRY_TIMEOUT_MS = 30_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
// The fixture's selected offer ("US Economy") carries its lane label as its provider note.
const SELECTED_LANE = "US Economy";

function decisionPanel(page: Page): Locator {
  return page
    .getByRole("region", { name: "Quote information" })
    .locator("section")
    .filter({ has: page.getByText("Quote comparison", { exact: true }) });
}

async function openPartPage(page: Page, origin?: string) {
  await page.goto(origin ? `${origin}${PART_ROUTE}` : PART_ROUTE);
  const panel = decisionPanel(page);
  await expect(panel.getByRole("button", { name: "US-only sourcing" })).toBeVisible({
    timeout: APP_ENTRY_TIMEOUT_MS,
  });
  // The selected-quote summary renders its source facts disclosure whether or not the flag is on.
  await expect(panel.getByText("Response source facts")).toBeVisible();
  await expect(panel.getByRole("row", { selected: true })).toContainText(SELECTED_LANE);
  return panel;
}

test.describe("part-page quote provider notes", { tag: "@fixture" }, () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: DESKTOP_VIEWPORT });

  test.beforeAll(async () => {
    test.setTimeout(FLAG_ON_SERVER_START_TIMEOUT_MS + 10_000);
    await flagOnServer.start();
  });

  test.afterAll(() => {
    flagOnServer.stop();
  });

  test("flag OFF (default): the selected quote shows no provider notes", async ({ page }) => {
    const panel = await openPartPage(page);

    await expect(page.getByTestId("provider-notes")).toHaveCount(0);
    await expect(panel.getByText("Provider notes", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("No provider notes")).toHaveCount(0);
  });

  test("flag ON: the selected quote shows its provider notes", async ({ page }, testInfo) => {
    const panel = await openPartPage(page, flagOnServer.origin);

    const notes = panel.getByTestId("provider-notes");
    await expect(notes).toHaveCount(1);
    await expect(notes).toBeVisible();
    await expect(notes.getByText("Provider notes", { exact: true })).toBeVisible();
    await expect(notes).toContainText(SELECTED_LANE);
    await expect(notes.getByText("No provider notes")).toHaveCount(0);

    await notes.scrollIntoViewIfNeeded();
    const screenshot = await page.screenshot({ fullPage: false });
    await testInfo.attach("provider-notes-flag-on", { body: screenshot, contentType: "image/png" });
    const screenshotDir = process.env.PROVIDER_NOTES_SCREENSHOT_DIR;
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDir, "quote-provider-notes-flag-on.png") });
    }
  });
});
