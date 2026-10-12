import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLING_CATALOG_PRICES,
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
  it("keeps every catalog amount TBD and does not invent prices", () => {
    expect(catalogAmountsAreTbd()).toBe(true);
    expect(BILLING_CATALOG_PRICES.every((entry) => entry.amountCents === null)).toBe(true);
    expect(catalogPricesSource).not.toMatch(/"amountCents": [1-9]/);
    expect(catalogSource).not.toMatch(/amountCents: [1-9]/);
    expect(catalogSource).not.toMatch(/4_900|4900/);
    expect(catalogPricesSource).not.toMatch(/4_900|4900/);
  });

  it("maps Pro, Team, and Founding Team without touching the free quote meter", () => {
    expect(mapTierToEntitlements("free").automaticQuoteCollection).toBe(false);
    expect(mapTierToEntitlements("pro")).toMatchObject({
      extraSeatsMetered: false,
      foundingBadge: false,
      plan: "pro",
      seatsIncluded: 1,
    });
    expect(mapTierToEntitlements("team").extraSeatsMetered).toBe(true);
    expect(mapTierToEntitlements("founding_team").foundingBadge).toBe(true);
    expect(canPurchaseFoundingTeam(12)).toBe(false);
    expect(FOUNDING_TEAM_MAX_SLOTS).toBe(12);
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
