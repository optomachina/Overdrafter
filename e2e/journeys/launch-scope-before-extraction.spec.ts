import { test, expect } from "../test";

// OVD-1029: exercise the real part page with the STEP-only metadata shape
// returned by the live RPC: succeeded with no drawing and placeholder material.
const PART_ROUTE = "/parts/fx-job-needs-attention?fixture=client-uploaded-step&debug=1";

test.describe("Launch scope before extraction", { tag: "@fixture" }, () => {
  test("asks for material on a STEP-only upload without a stale drawing notice", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto(PART_ROUTE);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      await page.reload();
      await page.locator("[data-client-shell]").waitFor();
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));

      const guidance = page.getByRole("region", { name: "Quote information", exact: true });
      const heading = guidance.getByRole("heading", { name: "Confirm the material", exact: true });
      await expect(heading).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Waiting for drawing metadata", { exact: true })).toHaveCount(0);
      await heading.scrollIntoViewIfNeeded();
      await expect(guidance).toContainText("Provider fit cannot be reviewed until the material is known.");
      await expect(guidance).toContainText("Set the material to the required aluminum alloy in the request details.");
      await expect(page.getByRole("heading", {
        name: "This material is outside the launch scope", exact: true,
      })).toHaveCount(0);
      const bounds = await heading.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    }
  });
});
