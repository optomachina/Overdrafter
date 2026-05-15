import type { VendorName, VendorStatus } from "@/integrations/supabase/types";
import type { VendorQuoteAggregate } from "@/features/quotes/types";

export type PricingCurvePointStatus = "quoted" | "manual_review" | "failed" | "pending";
export type PricingCurveTrend = "decreasing" | "flat" | "increasing" | "mixed" | "insufficient_data";

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
  const quotedPrices = points
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
