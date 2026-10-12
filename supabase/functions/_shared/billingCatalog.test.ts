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
  isBillingFlagEnabled,
  isCheckoutCatalogEnabled,
  mapTierToEntitlements,
  parseBoolean,
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
    product: "prod_OVD725",
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

Deno.test("billing flags match the exact string true only", () => {
  assertEquals(isBillingFlagEnabled("true"), true);
  assertEquals(isBillingFlagEnabled("TRUE"), false);
  assertEquals(isBillingFlagEnabled(" true "), false);
  assertEquals(isBillingFlagEnabled("1"), false);
  assertEquals(isBillingFlagEnabled(undefined), false);
  assertEquals(isCheckoutCatalogEnabled(" true", "true"), false);
  assertEquals(isCheckoutCatalogEnabled("true", "True"), false);
});

Deno.test("parseBoolean is strict and returns null when unset", () => {
  assertEquals(parseBoolean("true"), true);
  assertEquals(parseBoolean("false"), false);
  assertEquals(parseBoolean("TRUE"), null);
  assertEquals(parseBoolean(undefined), null);
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

Deno.test("canPurchaseFoundingTeam count helper stops at the cap (display only, not a checkout gate)", () => {
  assertEquals(canPurchaseFoundingTeam(0), true);
  assertEquals(canPurchaseFoundingTeam(7), true);
  assertEquals(canPurchaseFoundingTeam(FOUNDING_TEAM_MAX_SLOTS), false);
  assertEquals(canPurchaseFoundingTeam(9), false);
});

Deno.test("price guard rejects TBD, unknown keys, and livemode mismatches", () => {
  const entry = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY)!;
  const expanded = approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, {
    product: { active: true, id: "prod_OVD725" },
  });
  assertEquals(
    assertCatalogPrice(expanded, { ...entry, amountCents: null }, {
      expectedLivemode: false,
    }),
    { ok: false, reason: "catalog_amount_tbd" },
  );
  assertEquals(
    assertCatalogPrice(expanded, entry, { expectedLivemode: false }),
    { ok: true },
  );
  assertEquals(
    assertCatalogPrice(
      { ...expanded, lookup_key: "od_unknown_v1" },
      entry,
      { expectedLivemode: false },
    ),
    { ok: false, reason: "lookup_key_mismatch" },
  );
  assertEquals(
    assertCatalogPrice(expanded, entry, { expectedLivemode: true }),
    { ok: false, reason: "livemode_mismatch" },
  );
  assertEquals(
    assertCatalogPrice(
      { ...expanded, recurring: { interval: "year", interval_count: 1 } },
      entry,
      { expectedLivemode: false },
    ),
    { ok: false, reason: "interval_mismatch" },
  );
});

Deno.test("checkout requires an expanded active product; webhooks accept the product ID", () => {
  const entry = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY)!;
  const webhookShape = approvedPrice();
  assertEquals(
    assertCatalogPrice(webhookShape, entry, { expectedLivemode: false }),
    { ok: false, reason: "product_not_expanded" },
  );
  assertEquals(
    assertCatalogPrice(webhookShape, entry, { expectedLivemode: false, productMode: "id" }),
    { ok: true },
  );
  assertEquals(
    assertCatalogPrice(
      { ...webhookShape, product: "not_a_product" },
      entry,
      { expectedLivemode: false, productMode: "id" },
    ),
    { ok: false, reason: "product_id_invalid" },
  );
  assertEquals(
    assertCatalogPrice(
      { ...webhookShape, product: { active: false, id: "prod_OVD725" } },
      entry,
      { expectedLivemode: false, productMode: "id" },
    ),
    { ok: false, reason: "product_inactive" },
  );
});

Deno.test("a matching price.updated with a product ID string is ok", () => {
  assertEquals(
    evaluateCatalogWebhookEvent({
      data: { object: approvedPrice() },
      livemode: false,
      type: "price.updated",
    }, { expectedLivemode: false, replayed: false }),
    { action: "ok", entitlementsChanged: false, lookupKey: DEFAULT_CHECKOUT_LOOKUP_KEY },
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

Deno.test("an unknown expected livemode is a no-op, never a disable", () => {
  assertEquals(
    evaluateCatalogWebhookEvent({
      data: { object: approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, { livemode: true }) },
      livemode: true,
      type: "price.updated",
    }, { expectedLivemode: null, replayed: false }),
    {
      action: "noop",
      entitlementsChanged: false,
      lookupKey: DEFAULT_CHECKOUT_LOOKUP_KEY,
      reason: "expected_livemode_unset",
    },
  );
});
