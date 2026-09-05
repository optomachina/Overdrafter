import type { Page } from "@playwright/test";
import { test, expect } from "./test";

test("anonymous landing opens the auth dialog", async ({ page }) => {
  await page.goto("/?auth=signin&debug=1");

  await expect(page.locator("#auth-email")).toBeVisible();
  await expect(page.locator("form").getByRole("button", { name: /^Log in$/ })).toBeVisible();
});

test.describe("client session", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("shows the client workspace shell", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
  });

  test("keeps the client session after a home page reload", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Parts" })).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
  });

  test("keeps the client session after reloading a protected part route", async ({ page }) => {
    await page.goto("/parts/job-1?debug=1");

    await expect(page).toHaveURL(/\/parts\/job-1/);
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/parts\/job-1/);
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
  });

  test("restores the homepage workspace after logging out, logging back in, and reloading", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Parts" })).toBeVisible();

    await page.getByRole("button", { name: /open account menu/i }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.getByRole("button", { name: "Log out" }).click();

    await expect(page.getByRole("button", { name: /open account menu/i })).toHaveCount(0);
    await page.goto("/?auth=signin&debug=1");
    await expect(page.locator("#auth-email")).toBeVisible();

    await page.locator("#auth-email").fill("client.demo@overdrafter.local");
    await page.locator("#auth-password").fill("Overdrafter123!");
    await page.locator("form").getByRole("button", { name: /^Log in$/ }).click();

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
  });
});

test.describe("internal session", () => {
  test.use({ storageState: "playwright/.auth/internal.json" });

  test("shows the operations dashboard", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByText("Operations Dashboard")).toBeVisible();
    await expect(page.getByText("Total jobs")).toBeVisible();
  });
});

test(
  "fixture mode renders without a signed-in backend session",
  { tag: "@fixture" },
  async ({ page }) => {
    await page.goto("/projects/fx-project-quoted?fixture=client-quoted&debug=1");

    await expect(page.getByRole("heading", { name: "Synthetic quote comparison" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Fixture controls" })).toBeVisible();
  },
);

// Seeded quoted project: uuid(21) from scripts/seed-dev.mjs
const QUOTED_PROJECT_ID = "00000000-0000-4000-8000-000000000021";

async function gotoQuotedProjectReview(page: Page) {
  await page.goto(`/projects/${QUOTED_PROJECT_ID}/review?debug=1`);
  await expect(page.getByRole("heading", { name: "Synthetic quote comparison" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to project" })).toBeVisible();
}

async function fillHandoffForm(page: Page) {
  await page.getByRole("button", { name: "Standard shipping" }).click();
  await page.getByRole("button", { name: "Invoice after approval" }).click();
  await page.getByLabel("Ship-to contact").fill("Receiving Team");
  await page.getByLabel("Ship-to location").fill("Austin, TX");
  await page.getByLabel("Billing contact name").fill("Test Buyer");
  await page.getByLabel("Billing contact email").fill("buyer@ci.example");
}

async function bringHandoffToReady(page: Page) {
  await gotoQuotedProjectReview(page);
  await fillHandoffForm(page);
  await page.getByRole("button", { name: /review handoff/i }).click();
  await expect(page.getByRole("heading", { name: "Ready for OverDrafter follow-up" })).toBeVisible();
}

test.describe("client procurement handoff flow", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("navigates to the quoted project review page and loads the handoff form", async ({ page }) => {
    await gotoQuotedProjectReview(page);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Procurement handoff", { exact: true })).toBeVisible();
  });

  test("fills the handoff form and the release-check shows ready", async ({ page }) => {
    await gotoQuotedProjectReview(page);
    await fillHandoffForm(page);
    await expect(page.getByText("Ready for follow-up")).toBeVisible();

    await page.getByRole("button", { name: /review handoff/i }).click();
    await expect(page.getByRole("heading", { name: "Ready for OverDrafter follow-up" })).toBeVisible();
  });

  test("keeps manufacturing payment UI out of the completed handoff", async ({ page }) => {
    await bringHandoffToReady(page);
    await expect(page.getByText(/ready for manual release coordination/i)).toBeVisible();
    await expect(page.getByText(/no manufacturing payment is collected here/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /proceed to payment/i })).toHaveCount(0);
    await expect(page.locator('iframe[title="Secure card payment input frame"]')).toHaveCount(0);
  });
});
