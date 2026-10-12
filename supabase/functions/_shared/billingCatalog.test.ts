import { assertEquals } from "@std/assert";
import {
  assertCatalogPrice,
  BILLING_CATALOG_PRICES,
  BILLING_TIERS,
  BILLING_USAGE_POLICY,
  canPurchaseFoundingTeam,
  catalogAmountsAreTbd,
  catalogPriceMetadata,
  DEFAULT_CHECKOUT_LOOKUP_KEY,
  evaluateCatalogWebhookEvent,
  FOUNDING_TEAM_MAX_SLOTS,
  getCatalogPrice,
  isCheckoutCatalogEnabled,
  isLiveStripeSecret,
  mapTierToEntitlements,
} from "./billingCatalog.ts";

function approvedPrice(
  lookupKey = DEFAULT_CHECKOUT_LOOKUP_KEY,
  overrides: Record<string, unknown> = {},
) {
  const entry = getCatalogPrice(lookupKey)!;
  return {
    active: true,
    currency: "usd",
    id: "price_OVD725",
    livemode: false,
    lookup_key: lookupKey,
    metadata: catalogPriceMetadata(entry),
    product: { active: true },
    recurring: { interval: entry.interval, interval_count: 1 },
    type: "recurring",
    unit_amount: entry.amountCents,
    ...overrides,
  };
}

// Locked in docs/business/business-model.md. Change only with that document.
Deno.test("catalog matches the locked prices and lookup keys", () => {
  assertEquals(catalogAmountsAreTbd(), false);
  assertEquals(
    BILLING_CATALOG_PRICES.map((entry) => [entry.lookupKey, entry.amountCents]),
    [
      ["od_pro_month_v1", 9_900],
      ["od_team_month_v1", 34_900],
      ["od_team_seat_month_v1", 4_000],
      ["od_founding_team_month_v1", 19_900],
      ["od_jarvis_seat_month_v1", 0],
    ],
  );
  assertEquals(getCatalogPrice("od_jarvis_seat_month_v1")?.productName, "OverDrafter Jarvis");
  assertEquals(BILLING_TIERS.jarvis.separateProduct, true);
  assertEquals(BILLING_TIERS.jarvis.modelSpendCapCentsPerSeat, 1_000);
  assertEquals(FOUNDING_TEAM_MAX_SLOTS, 8);
  assertEquals(BILLING_TIERS.founding_team.rateHoldMonths, 12);
  assertEquals(BILLING_TIERS.founding_team.chargeAfterFirstSourcingSuccess, true);
  assertEquals(BILLING_USAGE_POLICY, {
    failedRunsCount: false,
    notifyAtPercent: 80,
    overage: false,
    pauseAutomationAtPercent: 100,
    providerOffErrorsCount: false,
  });
});

Deno.test("catalog has no annual price", () => {
  assertEquals(BILLING_CATALOG_PRICES.every((entry) => entry.interval === "month"), true);
  assertEquals(
    BILLING_CATALOG_PRICES.some((entry) => /year|annual/i.test(entry.lookupKey + entry.nickname)),
    false,
  );
});

Deno.test("checkout stays disabled unless both flags are explicitly true", () => {
  assertEquals(isCheckoutCatalogEnabled(undefined, undefined), false);
  assertEquals(isCheckoutCatalogEnabled("true", undefined), false);
  assertEquals(isCheckoutCatalogEnabled("true", "false"), false);
  assertEquals(isCheckoutCatalogEnabled("true", "true"), true);
});

Deno.test("live Stripe secrets are refused", () => {
  assertEquals(isLiveStripeSecret("sk_test_123"), false);
  assertEquals(isLiveStripeSecret("sk_live_123"), true);
  assertEquals(isLiveStripeSecret("rk_live_123"), true);
  assertEquals(isLiveStripeSecret('  "SK_LIVE_123"  '), true);
  assertEquals(isLiveStripeSecret("  'RK_LIVE_123'  "), true);
});

Deno.test("maps each sourcing tier to its locked caps", () => {
  assertEquals(mapTierToEntitlements("free"), {
    automaticQuoteCollection: false,
    extraSeatsMetered: false,
    foundingBadge: false,
    manualRunsPerMonth: 3,
    plan: "free",
    providerAttemptsPerMonth: 0,
    seatsIncluded: 1,
    successfulRunsPerMonth: 0,
  });
  assertEquals(mapTierToEntitlements("pro"), {
    automaticQuoteCollection: true,
    extraSeatsMetered: false,
    foundingBadge: false,
    manualRunsPerMonth: null,
    plan: "pro",
    providerAttemptsPerMonth: 300,
    seatsIncluded: 1,
    successfulRunsPerMonth: 40,
  });
  assertEquals(mapTierToEntitlements("team"), {
    automaticQuoteCollection: true,
    extraSeatsMetered: true,
    foundingBadge: false,
    manualRunsPerMonth: null,
    plan: "team",
    providerAttemptsPerMonth: 900,
    seatsIncluded: 5,
    successfulRunsPerMonth: 120,
  });
  assertEquals(mapTierToEntitlements("founding_team"), {
    automaticQuoteCollection: true,
    extraSeatsMetered: false,
    foundingBadge: true,
    manualRunsPerMonth: null,
    plan: "founding_team",
    providerAttemptsPerMonth: 900,
    seatsIncluded: 5,
    successfulRunsPerMonth: 120,
  });
});

Deno.test("founding checkout is refused at the 9th slot", () => {
  assertEquals(canPurchaseFoundingTeam(0), true);
  assertEquals(canPurchaseFoundingTeam(7), true);
  assertEquals(canPurchaseFoundingTeam(FOUNDING_TEAM_MAX_SLOTS), false);
  assertEquals(canPurchaseFoundingTeam(9), false);
});

Deno.test("price guard rejects TBD, unknown keys, and livemode mismatches", () => {
  const entry = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY)!;
  assertEquals(
    assertCatalogPrice(approvedPrice(), { ...entry, amountCents: null }, {
      expectedLivemode: false,
    }),
    { ok: false, reason: "catalog_amount_tbd" },
  );
  assertEquals(
    assertCatalogPrice(approvedPrice(), entry, { expectedLivemode: false }),
    { ok: true },
  );
  assertEquals(
    assertCatalogPrice(
      approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, { lookup_key: "od_unknown_v1" }),
      entry,
      { expectedLivemode: false },
    ),
    { ok: false, reason: "lookup_key_mismatch" },
  );
  assertEquals(
    assertCatalogPrice(approvedPrice(), entry, { expectedLivemode: true }),
    { ok: false, reason: "livemode_mismatch" },
  );
  assertEquals(
    assertCatalogPrice(
      approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, {
        recurring: { interval: "year", interval_count: 1 },
      }),
      entry,
      { expectedLivemode: false },
    ),
    { ok: false, reason: "interval_mismatch" },
  );
});

Deno.test("price.updated mismatch disables the key and replay is a no-op", () => {
  const mismatch = evaluateCatalogWebhookEvent({
    data: {
      object: approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, { unit_amount: 200 }),
    },
    livemode: false,
    type: "price.updated",
  }, {
    expectedLivemode: false,
    replayed: false,
  });
  assertEquals(mismatch, {
    action: "disable_key",
    entitlementsChanged: false,
    lookupKey: DEFAULT_CHECKOUT_LOOKUP_KEY,
    reason: "amount_mismatch",
  });

  const replay = evaluateCatalogWebhookEvent({
    data: {
      object: approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, { unit_amount: 200 }),
    },
    livemode: false,
    type: "price.updated",
  }, {
    expectedLivemode: false,
    replayed: true,
  });
  assertEquals(replay, {
    action: "noop",
    entitlementsChanged: false,
    reason: "replayed",
  });
});
