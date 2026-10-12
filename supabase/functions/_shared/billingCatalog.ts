/**
 * OverDrafter Stripe tier catalog (OVD-725).
 *
 * Amounts and caps match docs/business/business-model.md (locked October 11,
 * 2026). This module is the single source for lookup keys, prices, caps,
 * entitlement mapping, the server price guard, and webhook catalog
 * evaluation. Monthly billing only at launch; the loader rejects any other
 * interval. Free is not a Stripe product. Jarvis is a separate free product.
 */

import catalogData from "./billingCatalogPrices.json" with { type: "json" };

export const BILLING_CATALOG_VERSION = catalogData.version;
export const BILLING_CATALOG_CURRENCY = catalogData.currency;
export const DEFAULT_CHECKOUT_LOOKUP_KEY = catalogData.defaultCheckoutLookupKey;

export const BILLING_SELF_SERVICE_FLAG = "BILLING_SELF_SERVICE_ENABLED";
export const BILLING_TIER_CATALOG_FLAG = "BILLING_TIER_CATALOG_ENABLED";

export type SourcingTier = "pro" | "team" | "founding_team";
export type BillingTier = SourcingTier | "jarvis";
export type CatalogTier = BillingTier | "free";
export type BillingInterval = "month";
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

export type TierLimits = {
  automation: boolean;
  chargeAfterFirstSourcingSuccess: boolean;
  extraSeatCentsPerMonth: number | null;
  manualRunsPerMonth: number | null;
  maxTeams: number | null;
  modelSpendCapCentsPerSeat: number | null;
  pooledRuns: boolean;
  priceCentsPerMonth: number;
  providerAttemptsPerMonth: number | null;
  rateHoldMonths: number | null;
  seatsIncluded: number;
  separateProduct: boolean;
  successfulRunsPerMonth: number | null;
};

export type UsagePolicy = {
  failedRunsCount: boolean;
  notifyAtPercent: number;
  overage: boolean;
  pauseAutomationAtPercent: number;
  providerOffErrorsCount: boolean;
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
  manualRunsPerMonth: number | null;
  plan: "free" | SourcingTier;
  providerAttemptsPerMonth: number | null;
  seatsIncluded: number;
  successfulRunsPerMonth: number | null;
};

export type CatalogWebhookDecision = {
  action: "disable_key" | "noop" | "ok";
  entitlementsChanged: false;
  lookupKey?: string;
  reason?: string;
};

const CATALOG_TIERS: readonly CatalogTier[] = [
  "free",
  "pro",
  "team",
  "founding_team",
  "jarvis",
];

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function loadTierLimits(
  tiers: Record<string, Record<string, unknown>>,
): Readonly<Record<CatalogTier, TierLimits>> {
  const entries = CATALOG_TIERS.map((tier): [CatalogTier, TierLimits] => {
    const raw = tiers[tier];
    if (!raw || typeof raw.priceCentsPerMonth !== "number" ||
      typeof raw.seatsIncluded !== "number") {
      throw new Error(`catalog_tier_missing:${tier}`);
    }
    return [tier, {
      automation: raw.automation === true,
      chargeAfterFirstSourcingSuccess: raw.chargeAfterFirstSourcingSuccess === true,
      extraSeatCentsPerMonth: optionalNumber(raw.extraSeatCentsPerMonth),
      manualRunsPerMonth: optionalNumber(raw.manualRunsPerMonth),
      maxTeams: optionalNumber(raw.maxTeams),
      modelSpendCapCentsPerSeat: optionalNumber(raw.modelSpendCapCentsPerSeat),
      pooledRuns: raw.pooledRuns === true,
      priceCentsPerMonth: raw.priceCentsPerMonth,
      providerAttemptsPerMonth: optionalNumber(raw.providerAttemptsPerMonth),
      rateHoldMonths: optionalNumber(raw.rateHoldMonths),
      seatsIncluded: raw.seatsIncluded,
      separateProduct: raw.separateProduct === true,
      successfulRunsPerMonth: optionalNumber(raw.successfulRunsPerMonth),
    }];
  });
  return Object.freeze(Object.fromEntries(entries) as Record<CatalogTier, TierLimits>);
}

export const BILLING_TIERS = loadTierLimits(catalogData.tiers);
export const BILLING_USAGE_POLICY: Readonly<UsagePolicy> = Object.freeze({
  ...catalogData.usagePolicy,
});
export const FOUNDING_TEAM_MAX_SLOTS = BILLING_TIERS.founding_team.maxTeams ?? 0;

function isBillingTier(value: string): value is BillingTier {
  return value === "pro" || value === "team" || value === "founding_team" ||
    value === "jarvis";
}

function expectedTierAmount(tier: BillingTier, kind: CatalogPriceKind): number | null {
  const limits = BILLING_TIERS[tier];
  return kind === "plan" ? limits.priceCentsPerMonth : limits.extraSeatCentsPerMonth;
}

function loadCatalogPrices(
  prices: typeof catalogData.prices,
  intervals: readonly string[],
): readonly CatalogPrice[] {
  if (intervals.length !== 1 || intervals[0] !== "month") {
    throw new Error("catalog_interval_invalid");
  }
  return prices.map((entry) => {
    if (entry.interval !== "month") {
      throw new Error("catalog_interval_invalid");
    }
    if (entry.kind !== "plan" && entry.kind !== "extra_seat") {
      throw new Error("catalog_kind_invalid");
    }
    if (!isBillingTier(entry.tier)) {
      throw new Error("catalog_tier_invalid");
    }
    if (entry.amountCents !== expectedTierAmount(entry.tier, entry.kind)) {
      throw new Error(`catalog_amount_drift:${entry.lookupKey}`);
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

export const BILLING_CATALOG_PRICES = loadCatalogPrices(
  catalogData.prices,
  catalogData.billingIntervals,
);

/** Strict "true" / "false" parsing. Anything else, including unset, is null. */
export function parseBoolean(value: string | undefined): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

/** Exact match only: the string "true" enables a flag, nothing else does. */
export function isBillingFlagEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function isCheckoutCatalogEnabled(
  selfServiceEnabled: string | undefined,
  tierCatalogEnabled: string | undefined,
): boolean {
  return isBillingFlagEnabled(selfServiceEnabled) &&
    isBillingFlagEnabled(tierCatalogEnabled);
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

export function catalogPriceMetadata(entry: CatalogPrice) {
  return {
    od_catalog_version: String(BILLING_CATALOG_VERSION),
    od_interval: entry.interval,
    od_kind: entry.kind,
    od_tier: entry.tier,
  };
}

export function mapTierToEntitlements(
  tier: SourcingTier | "free",
): TierEntitlements {
  const limits = BILLING_TIERS[tier];
  return {
    automaticQuoteCollection: limits.automation,
    extraSeatsMetered: limits.extraSeatCentsPerMonth !== null,
    foundingBadge: tier === "founding_team",
    manualRunsPerMonth: limits.manualRunsPerMonth,
    plan: tier,
    providerAttemptsPerMonth: limits.providerAttemptsPerMonth,
    seatsIncluded: limits.seatsIncluded,
    successfulRunsPerMonth: limits.successfulRunsPerMonth,
  };
}

/**
 * Pure count helper for display and tests only. Checkout never calls it and it
 * must not gate a Founding sale: only the database function
 * api_claim_founding_team_slot may do that, because it serializes the claim
 * against the cap. A count read outside that function is racy.
 */
export function canPurchaseFoundingTeam(slotsUsed: number): boolean {
  return Number.isInteger(slotsUsed) &&
    slotsUsed >= 0 &&
    slotsUsed < FOUNDING_TEAM_MAX_SLOTS;
}

/**
 * "expanded": Checkout retrieves the Price with `expand: ["product"]`, so the
 * product's own active and deleted state is checked.
 * "id": webhook payloads carry `price.product` as a `prod_` ID string. The
 * product's state is not in the event, so only the ID shape is checked;
 * Checkout re-validates with the expanded product before any sale.
 */
export type CatalogProductMode = "expanded" | "id";

function productFailures(product: unknown, mode: CatalogProductMode): string[] {
  if (isExpandedProduct(product)) {
    if (product.deleted === true) {
      return ["product_deleted"];
    }
    return product.active === true ? [] : ["product_inactive"];
  }
  if (mode === "id") {
    return typeof product === "string" && /^prod_[A-Za-z0-9]+$/.test(product)
      ? []
      : ["product_id_invalid"];
  }
  return ["product_not_expanded"];
}

function catalogGuardFailures(
  price: CatalogPriceLike,
  expected: CatalogPrice,
  options: { expectedLivemode: boolean; productMode?: CatalogProductMode },
): string[] {
  const metadata = price.metadata ?? {};
  const checks: Array<[boolean, string]> = [
    [expected.amountCents == null, "catalog_amount_tbd"],
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
    [price.unit_amount !== expected.amountCents, "amount_mismatch"],
    ...productFailures(price.product, options.productMode ?? "expanded").map(
      (reason): [boolean, string] => [true, reason],
    ),
    [metadata.od_tier !== expected.tier, "tier_metadata_mismatch"],
    [metadata.od_interval !== expected.interval, "interval_metadata_mismatch"],
    [metadata.od_catalog_version !== String(BILLING_CATALOG_VERSION), "catalog_version_mismatch"],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => reason);
}

export function assertCatalogPrice(
  price: CatalogPriceLike,
  expected: CatalogPrice,
  options: { expectedLivemode: boolean; productMode?: CatalogProductMode },
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
    /** Null when STRIPE_EXPECTED_LIVEMODE is unset or malformed. */
    expectedLivemode: boolean | null;
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

  // Without a known expected mode every price would look mismatched, so refuse
  // to disable anything rather than disable on a lost secret.
  if (options.expectedLivemode === null) {
    return {
      action: "noop",
      entitlementsChanged: false,
      lookupKey,
      reason: "expected_livemode_unset",
    };
  }

  const verdict = assertCatalogPrice(price, expected, {
    expectedLivemode: options.expectedLivemode,
    productMode: "id",
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
