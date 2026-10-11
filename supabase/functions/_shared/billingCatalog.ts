/**
 * OverDrafter Stripe tier catalog (OVD-725).
 *
 * Amounts stay null until Blaine approves them. This module is the single
 * source for lookup keys, metadata, entitlement mapping, the server price
 * guard, and webhook catalog evaluation. Free stays on the existing free
 * quote meter and is not a Stripe product.
 */

export const BILLING_CATALOG_VERSION = 1;
export const BILLING_CATALOG_CURRENCY = "usd";
export const FOUNDING_TEAM_MAX_SLOTS = 12;
export const PLACEHOLDER_AMOUNT_CENTS = 100;
export const DEFAULT_CHECKOUT_LOOKUP_KEY = "od_pro_month_v1";

export const BILLING_SELF_SERVICE_FLAG = "BILLING_SELF_SERVICE_ENABLED";
export const BILLING_TIER_CATALOG_FLAG = "BILLING_TIER_CATALOG_ENABLED";

export type BillingTier = "pro" | "team" | "founding_team";
export type BillingInterval = "month" | "year";
export type CatalogPriceKind = "plan" | "extra_seat";

export type CatalogPrice = {
  interval: BillingInterval;
  kind: CatalogPriceKind;
  lookupKey: string;
  nickname: string;
  productName: string;
  seatsIncluded: number | null;
  tier: BillingTier;
  /** Approved Stripe unit amount in cents. Null means TBD. */
  amountCents: number | null;
};

export type CatalogPriceLike = {
  active?: boolean;
  currency?: string | null;
  id?: string;
  livemode?: boolean;
  lookup_key?: string | null;
  metadata?: Record<string, string> | null;
  product?: unknown;
  recurring?: {
    interval?: string;
    interval_count?: number;
  } | null;
  type?: string;
  unit_amount?: number | null;
};

function isExpandedProduct(
  product: unknown,
): product is { active?: boolean; deleted?: boolean } {
  return product !== null && typeof product === "object" && !Array.isArray(product);
}

export type TierEntitlements = {
  automaticQuoteCollection: boolean;
  extraSeatsMetered: boolean;
  foundingBadge: boolean;
  plan: "free" | BillingTier;
  seatsIncluded: number | null;
};

export type CatalogWebhookDecision = {
  action: "disable_key" | "noop" | "ok";
  entitlementsChanged: false;
  lookupKey?: string;
  reason?: string;
};

export const BILLING_CATALOG_PRICES: readonly CatalogPrice[] = [
  {
    amountCents: null,
    interval: "month",
    kind: "plan",
    lookupKey: "od_pro_month_v1",
    nickname: "Pro monthly",
    productName: "OverDrafter Pro",
    seatsIncluded: 1,
    tier: "pro",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_pro_year_v1",
    nickname: "Pro annual",
    productName: "OverDrafter Pro",
    seatsIncluded: 1,
    tier: "pro",
  },
  {
    amountCents: null,
    interval: "month",
    kind: "plan",
    lookupKey: "od_team_month_v1",
    nickname: "Team monthly",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_team_year_v1",
    nickname: "Team annual",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "month",
    kind: "extra_seat",
    lookupKey: "od_team_seat_month_v1",
    nickname: "Team extra seat monthly",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "extra_seat",
    lookupKey: "od_team_seat_year_v1",
    nickname: "Team extra seat annual",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_founding_team_year_v1",
    nickname: "Founding Team 12-month",
    productName: "OverDrafter Founding Team",
    seatsIncluded: null,
    tier: "founding_team",
  },
];

export function isBillingFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isCheckoutCatalogEnabled(
  selfServiceEnabled: string | undefined,
  tierCatalogEnabled: string | undefined,
): boolean {
  return isBillingFlagEnabled(selfServiceEnabled) &&
    isBillingFlagEnabled(tierCatalogEnabled);
}

export function isLiveStripeSecret(secret: string | undefined): boolean {
  const value = secret?.trim() ?? "";
  return value.startsWith("sk_live_") || value.startsWith("rk_live_");
}

export function getCatalogPrice(
  lookupKey: string,
  catalog: readonly CatalogPrice[] = BILLING_CATALOG_PRICES,
): CatalogPrice | undefined {
  return catalog.find((entry) => entry.lookupKey === lookupKey);
}

export function catalogAmountsAreTbd(
  catalog: readonly CatalogPrice[] = BILLING_CATALOG_PRICES,
): boolean {
  return catalog.some((entry) => entry.amountCents == null);
}

export function catalogPriceMetadata(entry: CatalogPrice, placeholder: boolean) {
  return {
    od_catalog_version: String(BILLING_CATALOG_VERSION),
    od_interval: entry.interval,
    od_kind: entry.kind,
    od_tier: entry.tier,
    placeholder: placeholder ? "true" : "false",
  };
}

export function mapTierToEntitlements(
  tier: BillingTier | "free",
  catalog: readonly CatalogPrice[] = BILLING_CATALOG_PRICES,
): TierEntitlements {
  if (tier === "free") {
    return {
      automaticQuoteCollection: false,
      extraSeatsMetered: false,
      foundingBadge: false,
      plan: "free",
      seatsIncluded: 0,
    };
  }

  const planEntry = catalog.find((entry) =>
    entry.tier === (tier === "founding_team" ? "team" : tier) &&
    entry.kind === "plan"
  );
  const teamSeats = catalog.find((entry) =>
    entry.tier === "team" && entry.kind === "plan"
  )?.seatsIncluded ?? null;

  if (tier === "pro") {
    return {
      automaticQuoteCollection: true,
      extraSeatsMetered: false,
      foundingBadge: false,
      plan: "pro",
      seatsIncluded: planEntry?.seatsIncluded ?? 1,
    };
  }

  if (tier === "team") {
    return {
      automaticQuoteCollection: true,
      extraSeatsMetered: true,
      foundingBadge: false,
      plan: "team",
      seatsIncluded: teamSeats,
    };
  }

  return {
    automaticQuoteCollection: true,
    extraSeatsMetered: true,
    foundingBadge: true,
    plan: "founding_team",
    seatsIncluded: teamSeats,
  };
}

export function canPurchaseFoundingTeam(slotsUsed: number): boolean {
  return Number.isInteger(slotsUsed) &&
    slotsUsed >= 0 &&
    slotsUsed < FOUNDING_TEAM_MAX_SLOTS;
}

export function assertCatalogPrice(
  price: CatalogPriceLike,
  expected: CatalogPrice,
  options: {
    allowPlaceholder?: boolean;
    expectedLivemode: boolean;
  },
): { ok: true } | { ok: false; reason: string } {
  if (expected.amountCents == null && options.allowPlaceholder !== true) {
    return { ok: false, reason: "catalog_amount_tbd" };
  }

  if (!price.id || !/^price_[A-Za-z0-9]+$/.test(price.id)) {
    return { ok: false, reason: "price_id_invalid" };
  }
  if (price.lookup_key !== expected.lookupKey) {
    return { ok: false, reason: "lookup_key_mismatch" };
  }
  if (price.active !== true) {
    return { ok: false, reason: "price_inactive" };
  }
  if (price.livemode !== options.expectedLivemode) {
    return { ok: false, reason: "livemode_mismatch" };
  }
  if ((price.currency ?? "").toLowerCase() !== BILLING_CATALOG_CURRENCY) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (price.type !== "recurring") {
    return { ok: false, reason: "price_not_recurring" };
  }
  if (
    price.recurring?.interval !== expected.interval ||
    price.recurring.interval_count !== 1
  ) {
    return { ok: false, reason: "interval_mismatch" };
  }

  const expectedAmount = expected.amountCents ??
    (options.allowPlaceholder === true ? PLACEHOLDER_AMOUNT_CENTS : null);
  if (expectedAmount == null || price.unit_amount !== expectedAmount) {
    return { ok: false, reason: "amount_mismatch" };
  }

  const product = price.product;
  if (!isExpandedProduct(product)) {
    return { ok: false, reason: "product_not_expanded" };
  }
  if (product.deleted === true) {
    return { ok: false, reason: "product_deleted" };
  }
  if (product.active !== true) {
    return { ok: false, reason: "product_inactive" };
  }

  const metadata = price.metadata ?? {};
  if (metadata.od_tier !== expected.tier) {
    return { ok: false, reason: "tier_metadata_mismatch" };
  }
  if (metadata.od_interval !== expected.interval) {
    return { ok: false, reason: "interval_metadata_mismatch" };
  }
  if (metadata.od_catalog_version !== String(BILLING_CATALOG_VERSION)) {
    return { ok: false, reason: "catalog_version_mismatch" };
  }
  if (
    options.allowPlaceholder === true &&
    metadata.placeholder !== "true"
  ) {
    return { ok: false, reason: "placeholder_metadata_missing" };
  }

  return { ok: true };
}

function readWebhookEvent(event: unknown): {
  livemode?: boolean;
  object?: CatalogPriceLike;
  type?: string;
} {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {};
  }
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : null;
  return {
    livemode: typeof record.livemode === "boolean" ? record.livemode : undefined,
    object: data && typeof data.object === "object" && data.object
      ? data.object as CatalogPriceLike
      : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
  };
}

export function evaluateCatalogWebhookEvent(
  event: unknown,
  options: {
    catalog?: readonly CatalogPrice[];
    expectedLivemode: boolean;
    replayed: boolean;
  },
): CatalogWebhookDecision {
  if (options.replayed) {
    return { action: "noop", entitlementsChanged: false, reason: "replayed" };
  }

  const parsed = readWebhookEvent(event);
  if (parsed.type !== "price.updated" && parsed.type !== "product.updated") {
    return {
      action: "noop",
      entitlementsChanged: false,
      reason: "unhandled_event",
    };
  }

  const price = parsed.object;
  if (!price || typeof price !== "object") {
    return { action: "noop", entitlementsChanged: false, reason: "object_missing" };
  }

  if (parsed.type === "product.updated") {
    return {
      action: "noop",
      entitlementsChanged: false,
      reason: "product_updated_requires_price",
    };
  }

  const lookupKey = price.lookup_key ?? undefined;
  if (!lookupKey) {
    return {
      action: "noop",
      entitlementsChanged: false,
      reason: "unknown_lookup_key",
    };
  }

  const expected = getCatalogPrice(lookupKey, options.catalog);
  if (!expected) {
    return {
      action: "noop",
      entitlementsChanged: false,
      lookupKey,
      reason: "not_catalog_price",
    };
  }

  const verdict = assertCatalogPrice(price, expected, {
    expectedLivemode: options.expectedLivemode,
  });
  if (verdict.ok && parsed.livemode === options.expectedLivemode) {
    return { action: "ok", entitlementsChanged: false, lookupKey };
  }

  return {
    action: "disable_key",
    entitlementsChanged: false,
    lookupKey,
    reason: "reason" in verdict ? verdict.reason : "livemode_mismatch",
  };
}

export function withApprovedTestAmounts(
  amountCents: number,
  catalog: readonly CatalogPrice[] = BILLING_CATALOG_PRICES,
): CatalogPrice[] {
  return catalog.map((entry) => ({ ...entry, amountCents }));
}
