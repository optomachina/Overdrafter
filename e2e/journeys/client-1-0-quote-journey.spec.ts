import { fileURLToPath } from "node:url";
import { test, expect } from "../test";

// 1.0 client journey, end to end on the seeded local stack (authenticated lane, no @fixture):
// sign in through the auth dialog -> upload a STEP -> see multi-provider quotes on a
// quoted part -> compare and choose one -> request it through the procurement handoff.
// No worker or vendor runs here: the uploaded part stops at intake, and the quotes are the
// ones scripts/seed-dev.mjs publishes for FX-200. Nothing is sent to any provider.
const SAMPLE_STEP = fileURLToPath(new URL("../../test-fixtures/quoted-sample/1093-05589-02.STEP", import.meta.url));
const PART_URL = /\/parts\/[\da-f-]{36}(?:[?#]|$)/;
const QUOTED_PART = "/parts/00000000-0000-4000-8000-000000000103";
const PACKAGE_ROUTE = "/client/packages/00000000-0000-4000-8000-000000000900";
const QUOTED_PROJECT_REVIEW = "/projects/00000000-0000-4000-8000-000000000021/review?debug=1";

test.describe("1.0 client journey", () => {
  test.describe.configure({ timeout: 180_000 });

  test("sign in -> upload -> multi-provider quotes -> compare -> request", async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const shot = async (name: string) =>
      testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    try {
      await test.step("sign in", async () => {
        await page.goto("/?auth=signin&debug=1");
        await page.locator("#auth-email").fill("client.demo@overdrafter.local");
        await page.locator("#auth-password").fill("Overdrafter123!");
        await page.locator("form").getByRole("button", { name: /^Log in$/ }).click();
        await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
        await shot("1-signed-in");
      });

      await test.step("upload a STEP", async () => {
        await page.getByLabel("Choose part files to upload").setInputFiles(SAMPLE_STEP);
        const dialog = page.getByRole("dialog", { name: /export-controlled\?/i });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        await dialog.getByRole("radio", { name: /^Not export-controlled/ }).check();
        await dialog.getByRole("button", { name: "Continue upload" }).click();
        await expect(page).toHaveURL(PART_URL, { timeout: 60_000 });
        await expect(page.getByRole("heading", { level: 1, name: /^1093-05589 rev 02$/i })).toBeVisible();
        await shot("2-uploaded");
      });

      await test.step("multi-provider quotes", async () => {
        await page.goto(QUOTED_PART);
        const comparison = page.getByRole("region", { name: "Quote comparison", exact: true });
        await expect(comparison).toBeVisible({ timeout: 30_000 });
        const showAll = comparison.getByRole("button", { name: "Show all sourcing", exact: true });
        if (await showAll.count()) await showAll.click();
        const rows = comparison.locator("tr[data-quote-key]");
        await expect(rows).toHaveCount(3);
        // Two providers back the three options (seed: Xometry and Protolabs).
        // Two providers back the three options (seed: Xometry and Protolabs).
        const rowText = (await rows.allTextContents()).join(" | ");
        expect(rowText).toMatch(/xometry/i);
        expect(rowText).toMatch(/proto ?labs/i);
        await shot("3-quotes");
      });

      await test.step("compare and choose", async () => {
        await page.goto(PACKAGE_ROUTE);
        const card = (name: string) =>
          page.locator(".border").filter({ has: page.getByRole("heading", { name, exact: true }) }).last();
        for (const name of ["Lowest cost", "Fastest delivery", "Balanced"]) await expect(card(name)).toBeVisible({ timeout: 30_000 });
        const lowest = card("Lowest cost");
        if (await lowest.getByRole("button", { name: "Save decision note", exact: true }).count() === 0) {
          await lowest.getByRole("button", { name: /Select (this|another) option/ }).click();
        }
        await expect(lowest.getByRole("button", { name: "Save decision note", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("heading", { name: "Selection received" }).last()).toBeVisible();
        await shot("4-chosen");
      });

      await test.step("request", async () => {
        await page.goto(QUOTED_PROJECT_REVIEW);
        await expect(page.getByText("Procurement handoff", { exact: true })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Standard shipping" }).click();
        await page.getByRole("button", { name: "Invoice after approval" }).click();
        await page.getByLabel("Ship-to contact").fill("Receiving Team");
        await page.getByLabel("Ship-to location").fill("Austin, TX");
        await page.getByLabel("Billing contact name").fill("Test Buyer");
        await page.getByLabel("Billing contact email").fill("buyer@ci.example");
        await page.getByRole("button", { name: /review handoff/i }).click();
        await expect(page.getByRole("heading", { name: "Ready for OverDrafter follow-up" })).toBeVisible();
        await expect(page.getByRole("button", { name: /proceed to payment/i })).toHaveCount(0);
        await shot("5-requested");
      });
    } finally {
      await context.close();
    }
  });
});
