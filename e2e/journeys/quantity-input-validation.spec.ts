import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../test";

// OVD-1023: use the default Playwright web server, with
// VITE_CONTROLLED_BETA_SINGLE_QUANTITY off, to exercise both quantity fields.
// Set QUANTITY_SCREENSHOT_DIR to also save a screenshot.
const PART_ROUTE = "/parts/fx-job-published?fixture=client-published&debug=1";
const APP_ENTRY_TIMEOUT_MS = 30_000;

test.describe("part request quantity input validation", { tag: "@fixture" }, () => {
  test("preserves invalid Qty text, supports replacement, and validates Quote quantities", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto(PART_ROUTE);

    const qty = page.getByLabel("Qty", { exact: true });
    const quoteQuantities = page.getByLabel("Quote quantities", { exact: true });
    const save = page.getByRole("button", { name: "Save request details", exact: true });
    const qtyError = page.getByRole("alert").filter({ hasText: "Enter a whole number" });
    const quoteQuantitiesError = page.getByRole("alert").filter({ hasText: "Enter whole numbers separated by /" });

    await expect(qty).toBeVisible({ timeout: APP_ENTRY_TIMEOUT_MS });
    await expect(quoteQuantities).toBeVisible();
    await expect(page.getByLabel("Quantity", { exact: true })).toHaveCount(0);
    await expect(save).toBeEnabled();

    for (const text of ["1,000", "", "12.5"]) {
      await qty.fill("");
      // Exercise each keystroke: punctuation must survive intermediate renders.
      let typed = "";
      for (const character of text) {
        await qty.pressSequentially(character);
        typed += character;
        await expect(qty).toHaveValue(typed);
      }
      await expect(qty).toHaveValue(text);
      if (text) await expect(qtyError).toBeVisible();
      else await expect(qtyError).toHaveCount(0);
      await expect(save).toBeDisabled();
      await qty.press("Tab");
      await expect(qty).toHaveValue(text);
      await expect(qty).not.toHaveValue(/^(1|12|125)$/);
      await expect(qtyError).toBeVisible();
      await expect(save).toBeDisabled();
    }

    await qty.focus();
    await qty.press("ControlOrMeta+A");
    await qty.pressSequentially("50");
    await expect(qty).toHaveValue("50");
    await expect(qtyError).toHaveCount(0);
    await expect(save).toBeEnabled();

    await quoteQuantities.fill("");
    for (const character of "1,000/2,000") {
      await quoteQuantities.pressSequentially(character);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    await quoteQuantities.press("Tab");
    await expect(quoteQuantities).toHaveValue("1,000/2,000");
    await expect(quoteQuantitiesError).toHaveCount(0);
    await expect(qtyError).toHaveCount(0);
    await expect(save).toBeEnabled();

    await expect(qty).toHaveAccessibleDescription(/the first quote quantity/);
    for (const text of ["250,500", "1,250 2,500", "1,250, 2,500", "2,500 7,500", "100,250 500"]) {
      await quoteQuantities.fill(text);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(save).toBeDisabled();
      await quoteQuantities.press("Tab");
      await expect(page.getByRole("alert")).toHaveText(/Commas are ambiguous here/);
    }

    for (const text of ["1,500,25/50", "1,500, 2,500 / 5,000", "10,25/50"]) {
      await quoteQuantities.fill(text);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(save).toBeDisabled();
      await quoteQuantities.press("Tab");
      await expect(quoteQuantitiesError).toBeVisible();
    }

    for (const text of ["10,25,50", "100, 250, 500"]) {
      await quoteQuantities.fill(text);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(save).toBeEnabled();
    }

    await quoteQuantities.fill("12.5");
    await expect(quoteQuantities).toHaveValue("12.5");
    await expect(quoteQuantitiesError).toHaveCount(0);
    await quoteQuantities.press("Tab");
    await expect(quoteQuantitiesError).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(qty).toHaveValue("50");

    const screenshotDir = process.env.QUANTITY_SCREENSHOT_DIR;
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await qty.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshotDir, "quantity-input-validation.png") });
    }
  });
});
