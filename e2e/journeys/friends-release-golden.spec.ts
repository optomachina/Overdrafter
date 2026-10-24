import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../test";
import { seedFriendsReleasePart } from "./friends-release-seed.mjs";

// OVD-1011: authenticated real-stack lane, deliberately NOT @fixture. No worker or vendor calls.
// seed:dev supplies the synthetic published-package path; this test gives a copy to its own upload.
const PART_URL = /\/parts\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})(?:[?#]|$)/i;
const commerce = /\b(?:re)?order(?:s|ed|ing)?\b|\bcheck\s*out\b|\bcart\b|\bpay(?:ments?)?\b|\bpurchases?\b|\bbuy\b|\bPO\b/i;

async function noCommerce(page: Page) {
  // Disabled and hidden controls count, including the legacy "Review order" button.
  for (const role of ["button", "link", "menuitem"] as const) {
    await expect.soft(page.getByRole(role, { name: commerce, includeHidden: true })).toHaveCount(0, { timeout: 1_000 });
  }
}

async function saveDetails(page: Page) {
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/rpc/api_update_client_part_request") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save request details" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Request details updated.", { exact: true })).toBeVisible();
}

test.use({
  storageState: "playwright/.auth/client.json",
  viewport: { width: 1440, height: 1000 },
  launchOptions: { chromiumSandbox: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
});

test.describe("friends release golden journey (OVD-1011)", () => {
  test("upload, edit, compare and inspect without ordering", async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    // Refuse hosted targets; this test may only mutate the standard disposable CI stack.
    expect(new URL(baseURL!).origin).toBe("http://127.0.0.1:4173");
    expect(process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321").toBe("http://127.0.0.1:54321");
    const unexpectedRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const local = ["http://127.0.0.1:4173", "http://127.0.0.1:54321"].includes(url.origin);
      const dispatch = /\/functions\/v1\/|\/rpc\/api_request_quote/.test(url.pathname);
      if ((url.protocol.startsWith("http") && !local) || dispatch) {
        unexpectedRequests.push(url.pathname);
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await test.step("1. Upload STEP and drawing, then render the 3D view", async () => {
      await page.goto("/parts");
      await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
      await noCommerce(page);
      await page.getByLabel("Choose part files to upload").setInputFiles([
        fileURLToPath(new URL("../../test-fixtures/quoted-sample/1093-05589-02.STEP", import.meta.url)),
        fileURLToPath(new URL("../../test-fixtures/quoted-sample/1093-05589-02.pdf", import.meta.url)),
      ]);
      const declaration = page.getByRole("dialog", { name: /export-controlled\?/i });
      await declaration.getByRole("radio", { name: /^Not export-controlled/ }).check();
      await declaration.getByRole("button", { name: "Continue upload" }).click();
      await expect(page).toHaveURL(PART_URL, { timeout: 60_000 });
      await expect(page.getByLabel("CAD preview for 1093-05589-02.STEP").locator("canvas")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("tab", { name: "Drawing", exact: true }).click();
      await expect(page.getByTitle("1093-05589-02.pdf PDF preview")).toBeVisible();
      await noCommerce(page);
    });

    const partUrl = page.url();
    const jobId = PART_URL.exec(partUrl)![1];
    // CI has no extraction worker: copy its existing synthetic extraction and published quotes.
    // Real upload/storage, auth, reads, edits and reloads remain on Supabase; no browser API mocks.
    seedFriendsReleasePart(jobId);
    await page.reload();

    await test.step("2. Edit extracted material and finish and persist after reload", async () => {
      const material = page.getByLabel("Material", { exact: true });
      const finish = page.getByLabel("Finish", { exact: true });
      await expect(material).toHaveValue("6061-T6 aluminum");
      await material.fill("7075-T6 aluminum");
      await finish.fill("As machined");
      await expect(page.getByRole("button", { name: "Reset to extracted: 6061-T6 aluminum", exact: true })).toBeVisible();
      await saveDetails(page);
      await page.reload();
      await expect(page).toHaveURL(partUrl);
      await expect(material).toHaveValue("7075-T6 aluminum");
      await expect(finish).toHaveValue("As machined");
      await noCommerce(page);
    });

    await test.step("3. Show quantity and keep Need by display-only", async () => {
      // The CI default build has the single-quantity flag OFF (the ON state has its own journey).
      await expect(page.getByLabel("Qty", { exact: true })).toHaveValue("25");
      const needBy = page.getByLabel("Need by date", { exact: true });
      const savedDate = await page.getByLabel("Need by", { exact: true }).inputValue();
      await needBy.fill("2031-01-05");
      await expect(needBy).toHaveValue("2031-01-05");
      await page.getByText("Need by date", { exact: true }).hover();
      await expect(page.getByRole("tooltip")).toContainText("not saved to the request");
      // Save another request field while the filter differs, then reload the persisted request date.
      await page.getByLabel("Notes", { exact: true }).fill("OVD-1011 synthetic journey");
      await saveDetails(page);
      await page.reload();
      await expect(page.getByLabel("Need by", { exact: true })).toHaveValue(savedDate);
      await expect(page.getByLabel("Qty", { exact: true })).toHaveValue("25");
      await noCommerce(page);
    });

    const panel = page.getByRole("region", { name: "Quote information" });
    const rows = panel.getByRole("row").filter({ has: page.getByRole("cell") });
    await test.step("4. Filter US and international origins", async () => {
      await expect(panel.getByRole("button", { name: "US-only sourcing" })).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText("Fixture US");
      await expect(rows).toContainText("US");
      await panel.getByRole("button", { name: "US-only sourcing" }).click();
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: "Fixture INTL" })).toContainText("International");
      await panel.getByRole("button", { name: "All sourcing" }).click();
      await expect(rows).toHaveCount(1);
      await expect(rows.filter({ hasText: "Fixture INTL" })).toHaveCount(0);
      await panel.getByRole("button", { name: "US-only sourcing" }).click();
    });

    await test.step("5. Plot price versus lead time", async () => {
      const chart = panel.getByRole("group", { name: "Quote comparison by delivered date and expected delivered cost" });
      await expect(chart).toBeVisible();
      await expect(chart.locator("[data-quote-point]")).toHaveCount(2);
      await expect(chart).toContainText("Expected delivered cost");
      await expect(chart).toContainText("Delivered date");
      await chart.locator("[data-quote-point]").first().hover();
      await expect(chart.getByText(/^Quoted total: \$/)).toBeVisible();
    });

    await test.step("6. Inspect quote price and lead time without purchasing controls", async () => {
      await rows.filter({ hasText: "Fixture US" }).getByRole("cell").first().click();
      const detail = panel.getByTestId("selected-option-summary");
      await expect(detail).toBeVisible();
      await detail.getByText("Response source facts", { exact: true }).click();
      await expect(detail.getByText("Quoted total", { exact: true })).toBeVisible();
      // Exact friends-release contract: additional detail facts are a failure, not a skip.
      await expect.soft(detail.getByRole("term")).toHaveText(["Quoted total", "Ready to ship"], { timeout: 1_000 });
      await expect(detail.getByRole("definition").filter({ hasText: /^\$360\.00$/ })).toBeVisible();
      await expect(detail.getByRole("definition").filter({ hasText: /^9 working days$/ })).toBeVisible();
      await expect(detail.getByRole("button")).toHaveCount(0);
      await expect(detail.getByRole("link")).toHaveCount(0);
    });

    await test.step("7. No order or checkout controls anywhere visited", async () => {
      await noCommerce(page);
      await page.getByRole("button", { name: /open account menu/i }).click();
      await noCommerce(page);
      expect(unexpectedRequests, "No vendor, remote backend or quote-dispatch request").toEqual([]);
    });
  });
});
