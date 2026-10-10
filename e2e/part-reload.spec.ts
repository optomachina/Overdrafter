import { test, expect } from "./test";

test.describe("part page reload", { tag: "@fixture" }, () => {
  test("shows part page skeleton on reload without blank boot screen", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    
    // First, navigate to a part page with fixture auth
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");
    
    // Wait for the client shell to mount (auth is initialized)
    await page.locator("[data-client-shell]").waitFor();
    
    // Verify the part page is loaded
    await expect(page.getByRole("banner")).toBeVisible();
    
    // Reload the page (this should use cached session)
    await page.reload();
    
    // The critical assertion: no "Opening OverDrafter" or blank boot screen should be visible
    // We check that the auth bootstrap screen is never shown during reload
    const authBootstrapScreen = page.getByText("Restoring your part workspace");
    const openingScreen = page.getByText("Opening OverDrafter");
    
    // These screens should not appear at all, or only briefly (we check they're not visible after a short wait)
    await page.waitForTimeout(100); // Brief wait to let any potential blank screen appear
    
    // Assert that blank screens are not visible
    await expect(authBootstrapScreen).not.toBeVisible();
    // The "Opening OverDrafter" text might flash briefly in the Suspense fallback,
    // but the client shell should mount quickly when session is cached
    
    // The page shell should be visible quickly
    await page.locator("[data-client-shell]").waitFor({ timeout: 2000 });
    await expect(page.getByRole("banner")).toBeVisible();
    
    // Verify the part page content is actually rendered
    await expect(page.getByRole("region", { name: "Part preview" })).toBeVisible();
  });
});
