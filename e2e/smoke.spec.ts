import type { Page } from "@playwright/test";
import { test, expect } from "./test";

test("anonymous landing opens the auth dialog", async ({ page }) => {
  await page.goto("/?auth=signin&debug=1");

  await expect(page.locator("#auth-email")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Log in$/ })).toBeVisible();
});

test.describe("client session", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("shows the client workspace shell", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
  });

  test("keeps the client session after a home page reload", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
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
    await expect(page.getByText("Q1 Brackets")).toBeVisible();

    await page.getByRole("button", { name: /open account menu/i }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.getByRole("button", { name: "Log out" }).click();

    await expect(page.locator("#auth-email")).toBeVisible();

    await page.locator("#auth-email").fill("client.demo@overdrafter.local");
    await page.locator("#auth-password").fill("Overdrafter123!");
    await page.getByRole("button", { name: /^Log in$/ }).click();

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
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

test("fixture mode renders without a signed-in backend session", async ({ page }) => {
  await page.goto("/projects/fx-project-quoted?fixture=client-quoted&debug=1");

  await expect(page.getByText("Q1 Brackets")).toBeVisible();
  await expect(page.getByRole("button", { name: /fixtures/i })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Full client payment flow — upload → quote → pay
//
// Prerequisites:
//   - STRIPE_SECRET_KEY (Stripe test mode) must be set in the environment
//   - STRIPE_WEBHOOK_SECRET (Stripe test mode) must be set in the environment
//   - Run with WORKER_MODE=simulate (default) — no real vendor calls or charges
//
// These tests are skipped when the Stripe secrets are absent so that CI
// passes without the secrets being provisioned.
// ---------------------------------------------------------------------------

// Seeded quoted project: uuid(21) from scripts/seed-dev.mjs
const QUOTED_PROJECT_ID = "00000000-0000-4000-8000-000000000021";

async function gotoQuotedProjectReview(page: Page) {
  await page.goto(`/projects/${QUOTED_PROJECT_ID}/review?debug=1`);
  await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
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
  await expect(page.getByText(/ready for overdrafter follow-up/i)).toBeVisible();
}

async function openPaymentStep(page: Page) {
  await bringHandoffToReady(page);
  await page.getByRole("button", { name: /proceed to payment/i }).click();
  await expect(page.getByText(/payment/i)).toBeVisible();
}

async function fillStripeCard(page: Page, cardNumber: string) {
  const cardFrame = page.frameLocator('iframe[title="Secure card payment input frame"]');
  await cardFrame.locator('[placeholder="Card number"]').fill(cardNumber);
  await cardFrame.locator('[placeholder="MM / YY"]').fill("1230");
  await cardFrame.locator('[placeholder="CVC"]').fill("123");
  await page.getByRole("button", { name: /pay now|submit payment|pay/i }).click();
}

test.describe("full client payment flow", () => {
  // Skip the entire block when Stripe test secrets are absent.
  test.skip(
    !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET,
    "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (Stripe test mode) to enable payment flow tests",
  );

  test.use({ storageState: "playwright/.auth/client.json" });

  test("navigates to the quoted project review page and loads the handoff form", async ({ page }) => {
    await gotoQuotedProjectReview(page);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText(/procurement handoff/i)).toBeVisible();
  });

  test("fills the handoff form and the release-check shows ready", async ({ page }) => {
    await gotoQuotedProjectReview(page);
    await fillHandoffForm(page);
    await expect(page.getByText("Ready for follow-up")).toBeVisible();

    await page.getByRole("button", { name: /review handoff/i }).click();
    await expect(page.getByText(/ready for overdrafter follow-up/i)).toBeVisible();
  });

  test("payment step appears after the handoff is complete", async ({ page }) => {
    // After OVD-187 lands, a "Proceed to payment" button and a payment section
    // should appear once the handoff is marked ready.
    await bringHandoffToReady(page);
    await expect(page.getByRole("button", { name: /proceed to payment/i })).toBeVisible();
  });

  test("completes payment with Stripe success card 4242 4242 4242 4242 and shows confirmation", async ({ page }) => {
    await openPaymentStep(page);
    await fillStripeCard(page, "4242424242424242");

    // The webhook fires in WORKER_MODE=simulate — wait for the confirmation UI.
    await expect(
      page.getByText(/payment confirmed|order placed|payment successful/i),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("shows a declined-card error for Stripe test card 4000 0000 0000 0002", async ({ page }) => {
    await openPaymentStep(page);
    await fillStripeCard(page, "4000000000000002");

    // Stripe should surface a card-declined error in the UI.
    await expect(page.getByText(/card.*declined|your card was declined/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
