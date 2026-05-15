import type { VendorName, VendorStatus } from "@/integrations/supabase/types";
import type { VendorQuoteAggregate } from "@/features/quotes/types";

/**
 * Curve point status normalized from vendor automation status.
 *
 * `quoted` means price data can be plotted. `manual_review` means the vendor
 * requires manual follow-up or review at that quantity. `failed` means
 * automation failed, and `pending` covers queued/running/stale rows that have
 * not produced final pricing.
 */
export type PricingCurvePointStatus = "quoted" | "manual_review" | "failed" | "pending";

/**
 * Classifies how quoted unit prices move as requested quantity increases.
 *
 * `decreasing`, `flat`, and `increasing` mean every adjacent quoted point moves
 * in that direction after sorting by quantity. `mixed` means both increases and
 * decreases exist. `insufficient_data` means fewer than two quoted unit prices
 * are available after excluding gap points.
 */
export type PricingCurveTrend = "decreasing" | "flat" | "increasing" | "mixed" | "insufficient_data";

/**
 * A single vendor/quantity point in a pricing curve.
 *
 * `quoted` points have a usable unit price. `manual_review`, `failed`, and
 * `pending` points represent visible pricing-curve gaps where vendor automation
 * could not provide plottable pricing yet. Prices are USD amounts when present,
 * lead times are business days, and `vendorQuoteResultId` links the point back
 * to the persisted `vendor_quote_results` row.
 */
export type VendorPricingCurvePoint = {
  vendor: VendorName;
  requestedQuantity: number;
  status: PricingCurvePointStatus;
  vendorStatus: VendorStatus;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  vendorQuoteResultId: string;
};

/**
 * Grouped pricing curve for one vendor.
 *
 * `points` contains every quantity row sorted by `requestedQuantity`.
 * `quotedPoints` is the subset with plottable pricing, while `gapPoints`
 * preserves manual-review, failed, queued, and running rows so the UI can show
 * holes in the curve. `trend` is derived from `quotedPoints` only.
 */
export type VendorPricingCurve = {
  vendor: VendorName;
  points: VendorPricingCurvePoint[];
  quotedPoints: VendorPricingCurvePoint[];
  gapPoints: VendorPricingCurvePoint[];
  trend: PricingCurveTrend;
};

function pointStatusForVendorStatus(status: VendorStatus): PricingCurvePointStatus {
  if (status === "instant_quote_received" || status === "official_quote_received") {
    return "quoted";
  }

  if (status === "manual_review_pending" || status === "manual_vendor_followup") {
    return "manual_review";
  }

  if (status === "failed") {
    return "failed";
  }

  return "pending";
}

function priceForTrend(point: VendorPricingCurvePoint): number | null {
  if (point.status !== "quoted") {
    return null;
  }

  return point.unitPriceUsd;
}

export function classifyPricingCurveTrend(points: readonly VendorPricingCurvePoint[]): PricingCurveTrend {
  const quotedPrices = [...points]
    .sort((left, right) => left.requestedQuantity - right.requestedQuantity)
    .map((point) => priceForTrend(point))
    .filter((price): price is number => typeof price === "number" && Number.isFinite(price));

  if (quotedPrices.length < 2) {
    return "insufficient_data";
  }

  let hasIncrease = false;
  let hasDecrease = false;

  for (let index = 1; index < quotedPrices.length; index += 1) {
    const previous = quotedPrices[index - 1];
    const current = quotedPrices[index];

    if (current > previous) {
      hasIncrease = true;
    } else if (current < previous) {
      hasDecrease = true;
    }
  }

  if (hasIncrease && hasDecrease) {
    return "mixed";
  }

  if (hasIncrease) {
    return "increasing";
  }

  if (hasDecrease) {
    return "decreasing";
  }

  return "flat";
}

export function buildVendorPricingCurves(quotes: readonly VendorQuoteAggregate[]): VendorPricingCurve[] {
  const byVendor = new Map<VendorName, VendorPricingCurvePoint[]>();

  quotes.forEach((quote) => {
    const point: VendorPricingCurvePoint = {
      vendor: quote.vendor,
      requestedQuantity: Math.max(1, Math.trunc(quote.requested_quantity || 1)),
      status: pointStatusForVendorStatus(quote.status),
      vendorStatus: quote.status,
      unitPriceUsd: quote.unit_price_usd,
      totalPriceUsd: quote.total_price_usd,
      leadTimeBusinessDays: quote.lead_time_business_days,
      vendorQuoteResultId: quote.id,
    };
    const points = byVendor.get(quote.vendor) ?? [];
    points.push(point);
    byVendor.set(quote.vendor, points);
  });

  return [...byVendor.entries()]
    .map(([vendor, points]) => {
      const sortedPoints = [...points].sort((left, right) => left.requestedQuantity - right.requestedQuantity);
      return {
        vendor,
        points: sortedPoints,
        quotedPoints: sortedPoints.filter((point) => point.status === "quoted"),
        gapPoints: sortedPoints.filter((point) => point.status !== "quoted"),
        trend: classifyPricingCurveTrend(sortedPoints),
      } satisfies VendorPricingCurve;
    })
    .sort((left, right) => left.vendor.localeCompare(right.vendor));
}
