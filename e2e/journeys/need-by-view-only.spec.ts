import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../test";

// OVD-991: the Need by filter on the quote comparison is view state. Fixture mode
// cannot answer the quote access check, and an unverified access state must fail
// closed: the filter stays view only, says so, and the saved Need by date stays
// visible with its Remove action. Set NEED_BY_SCREENSHOT_DIR to also save a screenshot.
const PART_ROUTE = "/parts/fx-job-published?fixture=client-published&debug=1";
const APP_ENTRY_TIMEOUT_MS = 30_000;
// A date far from the fixture's saved Need by date, so the two cannot be confused.
const FILTER_DATE = "2031-01-05";

test.describe("Need by display filter while quote access is unverified", { tag: "@fixture" }, () => {
  test("stays view only, says so, and keeps the saved date notice", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto(PART_ROUTE);
    await page.locator("[data-client-shell]").waitFor();

    const notice = page.getByRole("region", { name: "Need by date on the request" });
    await expect(notice).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(notice).toContainText("This request has a Need by date of");
    await expect(notice).toContainText("The Need by filter changes this view only.");
    await expect(notice.getByRole("button", { name: "Remove Need by from request" })).toBeEnabled();
    const savedNotice = await notice.textContent();
    expect(savedNotice).toContain("Need by date of");

    const needBy = page.getByLabel("Need by date", { exact: true });
    await needBy.fill(FILTER_DATE);
    await expect(needBy).toHaveValue(FILTER_DATE);
    // The notice keeps the date saved on the request, not the date the filter shows.
    await expect(notice).toHaveText(savedNotice);
    await expect(notice).not.toContainText("2031");

    await page.getByText("Need by date", { exact: true }).hover();
    await expect(page.getByRole("tooltip")).toContainText("in this view only");
    await expect(page.getByRole("tooltip")).toContainText("not saved to the request");

    const screenshotDir = process.env.NEED_BY_SCREENSHOT_DIR;
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDir, "need-by-view-only.png") });
    }
  });
});
