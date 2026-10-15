import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLING_CATALOG_PRICES,
  BILLING_TIERS,
  BILLING_USAGE_POLICY,
  canPurchaseFoundingTeam,
  catalogAmountsAreTbd,
  FOUNDING_TEAM_MAX_SLOTS,
  isCheckoutCatalogEnabled,
  mapTierToEntitlements,
} from "./billing-catalog";

const catalogSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/_shared/billingCatalog.ts"),
  "utf8",
);
const catalogPricesSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/_shared/billingCatalogPrices.json"),
  "utf8",
);
const spendCapSource = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260731010001_add_spend_caps_and_ledger.sql"),
  "utf8",
);
const entitlementTestSource = readFileSync(
  resolve(process.cwd(), "supabase/tests/organization_entitlements.sql"),
  "utf8",
);
const webhookSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/stripe-webhook/index.ts"),
  "utf8",
);
const subscriptionWebhookSource = readFileSync(
  resolve(process.cwd(), "supabase/functions/stripe-events/index.ts"),
  "utf8",
);

describe("OVD-725 billing catalog contract", () => {
  // Locked in docs/business/business-model.md. Change only with that document.
  it("matches the locked tier prices and caps", () => {
    expect(catalogAmountsAreTbd()).toBe(false);
    expect(BILLING_TIERS).toEqual({
      free: expect.objectContaining({
        automation: false,
        manualRunsPerMonth: 3,
        priceCentsPerMonth: 0,
        seatsIncluded: 1,
      }),
      pro: expect.objectContaining({
        automation: true,
        priceCentsPerMonth: 9_900,
        providerAttemptsPerMonth: 300,
        seatsIncluded: 1,
        successfulRunsPerMonth: 40,
      }),
      team: expect.objectContaining({
        extraSeatCentsPerMonth: 4_000,
        pooledRuns: true,
        priceCentsPerMonth: 34_900,
        providerAttemptsPerMonth: 900,
        seatsIncluded: 5,
        successfulRunsPerMonth: 120,
      }),
      founding_team: expect.objectContaining({
        chargeAfterFirstSourcingSuccess: true,
        maxTeams: 8,
        pooledRuns: true,
        priceCentsPerMonth: 19_900,
        providerAttemptsPerMonth: 900,
        rateHoldMonths: 12,
        seatsIncluded: 5,
        successfulRunsPerMonth: 120,
      }),
      jarvis: expect.objectContaining({
        modelSpendCapCentsPerSeat: 1_000,
        priceCentsPerMonth: 0,
        separateProduct: true,
      }),
    });
    expect(
      Object.fromEntries(BILLING_CATALOG_PRICES.map((entry) => [entry.lookupKey, entry.amountCents])),
    ).toEqual({
      od_founding_team_month_v1: 19_900,
      od_jarvis_seat_month_v1: 0,
      od_pro_month_v1: 9_900,
      od_team_month_v1: 34_900,
      od_team_seat_month_v1: 4_000,
    });
    expect(BILLING_USAGE_POLICY).toEqual({
      failedRunsCount: false,
      notifyAtPercent: 80,
      overage: false,
      pauseAutomationAtPercent: 100,
      providerOffErrorsCount: false,
    });
    expect(catalogSource).not.toMatch(/(?<![\d_])4_?900(?!\d)/);
    expect(catalogPricesSource).not.toMatch(/(?<![\d_])4_?900(?!\d)/);
  });

  it("has no annual price at launch", () => {
    expect(BILLING_CATALOG_PRICES.every((entry) => entry.interval === "month")).toBe(true);
    expect(catalogPricesSource).not.toMatch(/"year"|annual/i);
    expect(JSON.parse(catalogPricesSource).billingIntervals).toEqual(["month"]);
  });

  it("maps Pro, Team, and Founding Team without touching the free quote meter", () => {
    expect(mapTierToEntitlements("free").automaticQuoteCollection).toBe(false);
    expect(mapTierToEntitlements("pro")).toMatchObject({
      extraSeatsMetered: false,
      foundingBadge: false,
      plan: "pro",
      seatsIncluded: 1,
      successfulRunsPerMonth: 40,
    });
    expect(mapTierToEntitlements("team").extraSeatsMetered).toBe(true);
    expect(mapTierToEntitlements("founding_team").foundingBadge).toBe(true);
    expect(canPurchaseFoundingTeam(7)).toBe(true);
    expect(canPurchaseFoundingTeam(8)).toBe(false);
    expect(FOUNDING_TEAM_MAX_SLOTS).toBe(8);
  });

  it("requires both flags before checkout or pricing UI can enable", () => {
    expect(isCheckoutCatalogEnabled("true", "false")).toBe(false);
    expect(isCheckoutCatalogEnabled("true", "true")).toBe(true);
  });

  it("records the plan's assumed files and the actual subscription webhook", () => {
    expect(webhookSource).toContain("legacy_project_payments_disabled");
    expect(webhookSource).not.toContain("price.updated");
    expect(subscriptionWebhookSource).toContain("evaluateCatalogWebhookEvent");
    expect(entitlementTestSource).toContain("private.resolve_organization_entitlements_at");
    expect(spendCapSource).toContain("spend");
  });
});
