import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

// OVD-679: a verified client-role member (seeded client.demo) edits the org
// shipping address in Settings and confirms it as the quote destination.

async function openSettings(page: Page): Promise<Locator> {
  await page.goto("/?debug=1");
  await page.getByRole("button", { name: /open account menu/i }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByText("Shipping Address", { exact: true })).toBeVisible();
  return settings;
}

function shippingEditButton(settings: Locator) {
  return settings
    .getByText("Shipping Address", { exact: true })
    .locator("xpath=following-sibling::button[normalize-space()='Edit']");
}

test.describe("client sourcing destination", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("a client-role member edits and confirms the quote shipping destination", async ({ page }) => {
    // A unique street guarantees the save changes the address and revokes any
    // confirmation left by an earlier run against the same seeded organization.
    const street = `${Date.now()} Member Way`;
    let settings = await openSettings(page);

    await shippingEditButton(settings).click();
    await expect(settings.getByText("Edit Shipping Address")).toBeVisible();
    await settings.getByRole("button", { name: "Different address" }).click();
    await settings.locator("#shipping-street").fill(street);
    await settings.locator("#shipping-city").fill("Tucson");
    await settings.locator("#shipping-state").fill("AZ");
    await settings.locator("#shipping-zip").fill("85701");
    await settings.locator("#shipping-country").fill("US");
    await settings.getByRole("button", { name: "Save" }).click();

    await expect(settings.getByText("Edit Shipping Address")).toHaveCount(0);
    await expect(settings.getByText("Quote shipping destination: Needs confirmation")).toBeVisible();
    await expect(settings.getByText(`${street}, Tucson, AZ 85701, US`)).toBeVisible();

    await settings.getByRole("button", { name: "Confirm this shipping address for supplier quotes" }).click();
    await expect(settings.getByText("Quote shipping destination: Confirmed")).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Confirm this shipping address for supplier quotes" }),
    ).toHaveCount(0);
    await expect(settings.getByRole("alert")).toHaveCount(0);

    // The confirmation is persisted server-side, not just held in panel state.
    settings = await openSettings(page);
    await expect(settings.getByText("Quote shipping destination: Confirmed")).toBeVisible();
    await expect(settings.getByText(`${street}, Tucson, AZ 85701, US`)).toBeVisible();
  });
});
