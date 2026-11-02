import { test, expect } from "../test";

// OVD-1028: the fixture gateway does not implement package reads/selections.
// Run against the seeded local stack with the normal client storageState.
// This replaces the seeded package's selection through the UI; no provider or
// order action is performed. Re-running is safe: choose Lowest cost, then Fastest.
const PACKAGE_ROUTE = "/client/packages/00000000-0000-4000-8000-000000000900";
const PART_REVIEW_ROUTE = "/parts/00000000-0000-4000-8000-000000000103/review";

test.describe("published package selection", () => {
  test.use({ storageState: "playwright/.auth/client.json", viewport: { width: 375, height: 812 } });

  test("replaces the choice and keeps the receipt, review, and quotes list consistent", async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    await page.goto(PACKAGE_ROUTE);
    const lowest = page.locator(".border").filter({ has: page.getByRole("heading", { name: "Lowest cost", exact: true }) }).last();
    const fastest = page.locator(".border").filter({ has: page.getByRole("heading", { name: "Fastest delivery", exact: true }) }).last();
    await expect(lowest).toBeVisible({ timeout: 30_000 });
    // The selected option offers Save decision note only after a changed, non-empty note is typed.
    if (await lowest.getByRole("button", { name: "Save decision note", exact: true }).count() === 0) {
      await lowest.getByRole("button", { name: /Select (this|another) option/ }).click();
    }
    await expect(lowest.getByRole("button", { name: "Save decision note", exact: true })).toHaveAttribute("aria-pressed", "true");
    await fastest.getByRole("button", { name: "Select another option" }).click();
    await expect(fastest.getByRole("button", { name: "Save decision note", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Decision notes" }).fill("Deliver to dock B");
    await expect(fastest.getByRole("button", { name: "Save decision note", exact: true })).toBeEnabled();
    await expect(fastest.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    await expect(fastest.getByText("Selected", { exact: true }).first()).toBeVisible();
    await expect(lowest.getByRole("button", { name: "Select another option" })).toBeEnabled();

    const receipt = page.locator(".border").filter({ has: page.getByRole("heading", { name: "Selection received" }) }).last();
    for (const theme of ["light", "dark"]) {
      // Apply the same root class used by next-themes without changing the selected data.
      await page.evaluate((value) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(value);
      }, theme);
      await expect(receipt).toContainText("Fastest delivery · $402.50 · Qty 25");
      await expect(receipt.getByRole("heading")).toHaveClass(/text-foreground/);
      await receipt.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await testInfo.attach(`selection-receipt-${theme}-375px`, { body: await page.screenshot(), contentType: "image/png" });
    }

    await page.reload();
    await expect(fastest.getByRole("button", { name: "Save decision note", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goto(PART_REVIEW_ROUTE);
    await expect(page.getByText("Protolabs", { exact: true })).toBeVisible();
    await expect(page.getByText("$402.50", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review handoff" })).toBeEnabled();
    await page.goto("/quotes");
    await expect(page.getByText("Selected: Fastest delivery · $402.50", { exact: true })).toBeVisible();
  });
});
