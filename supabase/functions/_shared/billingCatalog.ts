/**
 * OverDrafter Stripe tier catalog (OVD-725).
 *
 * Amounts stay null until Blaine approves them. This module is the single
 * source for lookup keys, metadata, entitlement mapping, the server price
 * guard, and webhook catalog evaluation. Free stays on the existing free
 * quote meter and is not a Stripe product.
 */

import catalogData from "./billingCatalogPrices.json" with { type: "json" };

export const BILLING_CATALOG_VERSION = catalogData.version;
export const BILLING_CATALOG_CURRENCY = catalogData.currency;
export const FOUNDING_TEAM_MAX_SLOTS = catalogData.foundingTeamMaxSlots;
export const PLACEHOLDER_AMOUNT_CENTS = catalogData.placeholderAmountCents;
export const DEFAULT_CHECKOUT_LOOKUP_KEY = catalogData.defaultCheckoutLookupKey;

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

function loadCatalogPrices(
  prices: typeof catalogData.prices,
): readonly CatalogPrice[] {
  return prices.map((entry) => {
    if (entry.interval !== "month" && entry.interval !== "year") {
      throw new Error("catalog_interval_invalid");
    }
    if (entry.kind !== "plan" && entry.kind !== "extra_seat") {
      throw new Error("catalog_kind_invalid");
    }
    if (entry.tier !== "pro" && entry.tier !== "team" && entry.tier !== "founding_team") {
      throw new Error("catalog_tier_invalid");
    }
    return {
      amountCents: entry.amountCents,
      interval: entry.interval,
      kind: entry.kind,
      lookupKey: entry.lookupKey,
      nickname: entry.nickname,
      productName: entry.productName,
      seatsIncluded: entry.seatsIncluded,
      tier: entry.tier,
    };
  });
}

export const BILLING_CATALOG_PRICES = loadCatalogPrices(catalogData.prices);

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

function catalogGuardFailures(
  price: CatalogPriceLike,
  expected: CatalogPrice,
  options: {
    allowPlaceholder?: boolean;
    expectedLivemode: boolean;
  },
): string[] {
  const expectedAmount = expected.amountCents ??
    (options.allowPlaceholder === true ? PLACEHOLDER_AMOUNT_CENTS : null);
  const product = isExpandedProduct(price.product) ? price.product : null;
  const metadata = price.metadata ?? {};
  const checks: Array<[boolean, string]> = [
    [expected.amountCents == null && options.allowPlaceholder !== true, "catalog_amount_tbd"],
    [!price.id || !/^price_[A-Za-z0-9]+$/.test(price.id), "price_id_invalid"],
    [price.lookup_key !== expected.lookupKey, "lookup_key_mismatch"],
    [price.active !== true, "price_inactive"],
    [price.livemode !== options.expectedLivemode, "livemode_mismatch"],
    [(price.currency ?? "").toLowerCase() !== BILLING_CATALOG_CURRENCY, "currency_mismatch"],
    [price.type !== "recurring", "price_not_recurring"],
    [
      price.recurring?.interval !== expected.interval ||
      price.recurring?.interval_count !== 1,
      "interval_mismatch",
    ],
    [expectedAmount == null || price.unit_amount !== expectedAmount, "amount_mismatch"],
    [product === null, "product_not_expanded"],
    [product?.deleted === true, "product_deleted"],
    [product?.active !== true, "product_inactive"],
    [metadata.od_tier !== expected.tier, "tier_metadata_mismatch"],
    [metadata.od_interval !== expected.interval, "interval_metadata_mismatch"],
    [metadata.od_catalog_version !== String(BILLING_CATALOG_VERSION), "catalog_version_mismatch"],
    [
      options.allowPlaceholder === true && metadata.placeholder !== "true",
      "placeholder_metadata_missing",
    ],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => reason);
}

export function assertCatalogPrice(
  price: CatalogPriceLike,
  expected: CatalogPrice,
  options: {
    allowPlaceholder?: boolean;
    expectedLivemode: boolean;
  },
): { ok: true } | { ok: false; reason: string } {
  const [reason] = catalogGuardFailures(price, expected, options);
  return reason ? { ok: false, reason } : { ok: true };
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
