import { test, expect } from "../test";

// OVD-1030: Settings loads organization addresses through real RPCs, not the
// client workspace fixtures. Run against the disposable seeded local stack,
// using the same client session as e2e/sourcing-destination.spec.ts.
test.describe("shipping address validation", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("saves an incomplete address without offering confirmation and guides the member to repair it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/parts?debug=1");
    await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /open account menu/i }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByText("Shipping Address", { exact: true })).toBeVisible();

    let confirmations = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/rpc/api_confirm_sourcing_destination")) confirmations += 1;
    });
    const confirm = settings.getByRole("button", { name: "Confirm this shipping address for supplier quotes" });
    const shippingCard = settings.getByText("Shipping Address", { exact: true }).locator("../..");
    await shippingCard.getByRole("button", { name: "Edit", exact: true }).click();
    await settings.getByRole("button", { name: "Different address" }).click();
    await settings.getByLabel("Street", { exact: true }).fill("");
    await settings.getByLabel("City", { exact: true }).fill("Tucson");
    await settings.getByLabel("State", { exact: true }).fill("AZ");
    await settings.getByLabel("ZIP", { exact: true }).fill("85701");
    await settings.getByLabel("Country", { exact: true }).fill("US");
    const save = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/rpc/api_update_organization_addresses") && response.request().method() === "POST",
    );
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    expect((await save).ok()).toBe(true);
    await expect(settings.getByText("Edit Shipping Address", { exact: true })).toHaveCount(0);
    await expect(shippingCard.locator("dt").filter({ hasText: /^Street$/ }).locator("..").locator("dd")).toHaveText("—");

    const note = shippingCard.getByText("Shipping address is incomplete and cannot be confirmed yet.");
    await expect(note).toBeVisible();
    await expect(shippingCard.getByText("Add street before confirming.")).toBeVisible();
    await expect(confirm).toHaveCount(0);
    expect(confirmations).toBe(0);

    // Exercise the same wrapping layout with both theme token sets at 375 px.
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(value);
      }, theme);
      await note.scrollIntoViewIfNeeded();
      await expect(note).toBeVisible();
      const bounds = await note.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    }

    await shippingCard.getByRole("button", { name: "Edit shipping address", exact: true }).click();
    await expect(settings.getByText("Edit Shipping Address", { exact: true })).toBeVisible();
    await settings.getByLabel("Street", { exact: true }).fill("123 Journey Test Ave");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Edit Shipping Address", { exact: true })).toHaveCount(0);
    await expect(confirm).toBeVisible();
    await expect(note).toHaveCount(0);
    expect(confirmations).toBe(0);
  });
});
