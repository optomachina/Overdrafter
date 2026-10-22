import { test, expect } from "../test";

// OVD-1027: seeded local stack, not the fixture gateway. scripts/seed-dev.mjs
// publishes FX-200's Lowest cost, Fastest delivery, and Balanced options without
// verified origin. A package selection may already exist from the package journey.
const PART_ROUTE = "/parts/00000000-0000-4000-8000-000000000103";
const OPTION_IDS = [910, 911, 912].map((id) => `published:00000000-0000-4000-8000-${String(id).padStart(12, "0")}`);
const HIDDEN_SELECTION_REASON = "Switch to All sourcing to see your selected quote";
const NO_SELECTION_REASON = "Choose a package option to continue";

test.describe("quote comparison sourcing scope", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("reveals unknown-origin options without changing the saved selection", async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PART_ROUTE);
      const comparison = page.getByRole("region", { name: "Quote comparison", exact: true });
      const emptyHeading = comparison.getByText("No US-sourced options", { exact: true });
      const review = page.getByRole("button", { name: "Review order", exact: true });
      const reason = page.locator("#review-order-disabled-reason");
      const rows = comparison.locator("tr[data-quote-key]");
      await expect(emptyHeading).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("No quote options yet", { exact: true })).toHaveCount(0);
      await expect(comparison.getByRole("button", { name: "US-only sourcing", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(0);
      await expect(review).toBeDisabled();
      await expect(reason).toHaveText(new RegExp(`^(${HIDDEN_SELECTION_REASON}|${NO_SELECTION_REASON})$`));
      const initialReason = (await reason.innerText()).trim();
      await expect(review).toHaveAccessibleDescription(initialReason);
      await testInfo.attach(`quote-comparison-us-only-${width}px`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

      await comparison.getByRole("button", { name: "Show all sourcing", exact: true }).click();
      const allScope = comparison.getByRole("button", { name: "All sourcing", exact: true });
      try {
        await expect(allScope).toHaveAttribute("aria-pressed", "false");
        await expect(emptyHeading).toHaveCount(0);
        await expect(page.locator("body")).not.toBeFocused();
        await expect(rows).toHaveCount(OPTION_IDS.length);
        for (const key of OPTION_IDS) {
          await expect(comparison.locator(`tr[data-quote-key="${key}"]`)).toBeVisible();
        }

        const statuses = await rows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-deadline-status")));
        for (const status of statuses) expect(["on_time", "unconfirmed", "late"]).toContain(status);
        const count = (status: string) => statuses.filter((value) => value === status).length;
        const pill = comparison.getByText(/^By .+: \d+ on time · \d+ may miss · \d+ late$/);
        await expect(pill).toBeVisible();
        await expect(pill).toHaveText(new RegExp(
          `^By (Mon|Tue|Wed|Thu|Fri|Sat|Sun), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{1,2}, \\d{4}: ${count("on_time")} on time · ${count("unconfirmed")} may miss · ${count("late")} late$`,
        ));

        const selectedRows = comparison.locator('tr[data-quote-key][aria-selected="true"]');
        if (initialReason === HIDDEN_SELECTION_REASON) {
          await expect(selectedRows).toHaveCount(1);
          await expect(selectedRows).toBeVisible();
          await expect(review).toBeEnabled();
        } else {
          await expect(selectedRows).toHaveCount(0);
          await expect(review).toBeDisabled();
          await expect(review).toHaveAccessibleDescription(NO_SELECTION_REASON);
        }
        await testInfo.attach(`quote-comparison-all-sourcing-${width}px`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      } finally {
        // Only view state changes: never click an option, save a date, or review an order.
        await allScope.click();
        await expect(comparison.getByRole("button", { name: "US-only sourcing", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(emptyHeading).toBeVisible();
        await expect(review).toBeDisabled();
        await expect(review).toHaveAccessibleDescription(initialReason);
      }
    }
  });
});
