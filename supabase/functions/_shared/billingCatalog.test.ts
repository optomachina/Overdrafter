import { assertEquals } from "@std/assert";
import {
  assertCatalogPrice,
  BILLING_CATALOG_PRICES,
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
  PLACEHOLDER_AMOUNT_CENTS,
  withApprovedTestAmounts,
} from "./billingCatalog.ts";

const APPROVED = withApprovedTestAmounts(PLACEHOLDER_AMOUNT_CENTS);

function approvedPrice(
  lookupKey = DEFAULT_CHECKOUT_LOOKUP_KEY,
  overrides: Record<string, unknown> = {},
) {
  const entry = getCatalogPrice(lookupKey, APPROVED)!;
  return {
    active: true,
    currency: "usd",
    id: "price_OVD725",
    livemode: false,
    lookup_key: lookupKey,
    metadata: catalogPriceMetadata(entry, false),
    product: { active: true },
    recurring: { interval: entry.interval, interval_count: 1 },
    type: "recurring",
    unit_amount: PLACEHOLDER_AMOUNT_CENTS,
    ...overrides,
  };
}

Deno.test("catalog amounts stay TBD and use the approved lookup keys", () => {
  assertEquals(catalogAmountsAreTbd(), true);
  assertEquals(
    BILLING_CATALOG_PRICES.map((entry) => entry.lookupKey),
    [
      "od_pro_month_v1",
      "od_pro_year_v1",
      "od_team_month_v1",
      "od_team_year_v1",
      "od_team_seat_month_v1",
      "od_team_seat_year_v1",
      "od_founding_team_year_v1",
    ],
  );
  assertEquals(
    BILLING_CATALOG_PRICES.every((entry) => entry.amountCents === null),
    true,
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

Deno.test("maps each paid tier and leaves free on the existing meter", () => {
  assertEquals(mapTierToEntitlements("free"), {
    automaticQuoteCollection: false,
    extraSeatsMetered: false,
    foundingBadge: false,
    plan: "free",
    seatsIncluded: 0,
  });
  assertEquals(mapTierToEntitlements("pro").seatsIncluded, 1);
  assertEquals(mapTierToEntitlements("pro").extraSeatsMetered, false);
  assertEquals(mapTierToEntitlements("team").extraSeatsMetered, true);
  assertEquals(mapTierToEntitlements("team").foundingBadge, false);
  assertEquals(mapTierToEntitlements("founding_team"), {
    automaticQuoteCollection: true,
    extraSeatsMetered: true,
    foundingBadge: true,
    plan: "founding_team",
    seatsIncluded: null,
  });
});

Deno.test("founding checkout is refused at the 13th slot", () => {
  assertEquals(canPurchaseFoundingTeam(0), true);
  assertEquals(canPurchaseFoundingTeam(11), true);
  assertEquals(canPurchaseFoundingTeam(FOUNDING_TEAM_MAX_SLOTS), false);
  assertEquals(canPurchaseFoundingTeam(13), false);
});

Deno.test("price guard rejects TBD, unknown keys, and livemode mismatches", () => {
  const entry = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY)!;
  assertEquals(
    assertCatalogPrice(approvedPrice(), entry, { expectedLivemode: false }).ok,
    false,
  );
  assertEquals(
    assertCatalogPrice(approvedPrice(), entry, { expectedLivemode: false }),
    { ok: false, reason: "catalog_amount_tbd" },
  );

  const approvedEntry = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, APPROVED)!;
  assertEquals(
    assertCatalogPrice(approvedPrice(), approvedEntry, { expectedLivemode: false }),
    { ok: true },
  );
  assertEquals(
    assertCatalogPrice(
      approvedPrice(DEFAULT_CHECKOUT_LOOKUP_KEY, { lookup_key: "od_unknown_v1" }),
      approvedEntry,
      { expectedLivemode: false },
    ),
    { ok: false, reason: "lookup_key_mismatch" },
  );
  assertEquals(
    assertCatalogPrice(approvedPrice(), approvedEntry, { expectedLivemode: true }),
    { ok: false, reason: "livemode_mismatch" },
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
    catalog: APPROVED,
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
    catalog: APPROVED,
    expectedLivemode: false,
    replayed: true,
  });
  assertEquals(replay, {
    action: "noop",
    entitlementsChanged: false,
    reason: "replayed",
  });
});
