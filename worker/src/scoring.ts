/**
 * Worker-side vendor scoring utilities (OVD-138).
 *
 * Mirrors the frontend scoring engine in src/features/quotes/scoring.ts
 * but is self-contained so the worker does not depend on frontend modules.
 */

/**
 * Normalizes a vendor's price into a 0-100 score relative to the cheapest vendor.
 *
 * The cheapest vendor receives 100. Other vendors receive a score proportional
 * to their price ratio against the cheapest. If all prices are equal, everyone
 * gets 100. If there are no prices or a single vendor, returns 100.
 */
export function normalizePriceScore(
  prices: Record<string, number>,
  vendorName: string,
): number {
  const vendorPrice = readVendorValue(prices, vendorName);
  if (vendorPrice === null || vendorPrice <= 0) {
    return 0;
  }

  const { count, minimum } = collectMinimum(prices, (value) => value > 0);
  if (count === 0) {
    return 0;
  }

  if (count === 1) {
    return 100;
  }

  const ratio = minimum / vendorPrice;
  return clamp(ratio * 100, 0, 100);
}

/**
 * Normalizes a vendor's lead time into a 0-100 score relative to the fastest vendor.
 *
 * The fastest vendor receives 100. Other vendors receive a score proportional
 * to the inverse ratio of their lead time against the fastest. If all lead times
 * are equal, everyone gets 100.
 */
export function normalizeLeadTimeScore(
  leadTimes: Record<string, number>,
  vendorName: string,
): number {
  const vendorLeadTime = readVendorValue(leadTimes, vendorName);
  if (vendorLeadTime === null || vendorLeadTime < 0) {
    return 0;
  }

  const { count, minimum } = collectMinimum(leadTimes, (value) => value >= 0);
  if (count === 0) {
    return 0;
  }

  if (count === 1) {
    return 100;
  }

  if (minimum === 0) {
    if (vendorLeadTime === 0) {
      return 100;
    }
    return 0;
  }

  const ratio = minimum / vendorLeadTime;
  return clamp(ratio * 100, 0, 100);
}

/**
 * Computes a full multi-dimensional score for a single vendor.
 *
 * Uses default weights: price (30%), lead time (25%), quality (20%),
 * capability match (15%), domestic (10%).
 */
export function scoreVendor(input: {
  vendorName: string;
  qualityScore: number;
  domesticUs: boolean;
  prices: Record<string, number>;
  leadTimes: Record<string, number>;
}): {
  vendorName: string;
  overallScore: number;
  priceScore: number;
  leadTimeScore: number;
  qualityScore: number;
  capabilityMatchScore: number;
  domesticScore: number;
} {
  const defaultWeights = {
    pricePercent: 30,
    leadTimePercent: 25,
    qualityPercent: 20,
    capabilityMatchPercent: 15,
    domesticPercent: 10,
  } as const;

  const priceScore = normalizePriceScore(input.prices, input.vendorName);
  const leadTimeScore = normalizeLeadTimeScore(input.leadTimes, input.vendorName);
  const qualityScore = input.qualityScore;
  const domesticScore = input.domesticUs ? 100 : 50;

  // Capability match is 100 for all live vendors since they are already
  // filtered by the quote run (they responded with a quote).
  const capabilityMatchScore = 100;

  const overallScore =
    (priceScore * defaultWeights.pricePercent +
      leadTimeScore * defaultWeights.leadTimePercent +
      qualityScore * defaultWeights.qualityPercent +
      capabilityMatchScore * defaultWeights.capabilityMatchPercent +
      domesticScore * defaultWeights.domesticPercent) /
    100;

  return {
    vendorName: input.vendorName,
    overallScore: clamp(overallScore, 0, 100),
    priceScore,
    leadTimeScore,
    qualityScore,
    capabilityMatchScore,
    domesticScore,
  };
}

/**
 * Scores all vendors and returns them sorted by overallScore descending.
 */
export function rankVendors(
  vendors: Array<{
    vendorName: string;
    qualityScore: number;
    domesticUs: boolean;
  }>,
  prices: Record<string, number>,
  leadTimes: Record<string, number>,
): Array<{
  vendorName: string;
  overallScore: number;
  priceScore: number;
  leadTimeScore: number;
  qualityScore: number;
  capabilityMatchScore: number;
  domesticScore: number;
}> {
  const scored = vendors.map((v) =>
    scoreVendor({
      vendorName: v.vendorName,
      qualityScore: v.qualityScore,
      domesticUs: v.domesticUs,
      prices,
      leadTimes,
    }),
  );

  return scored.sort((a, b) => b.overallScore - a.overallScore);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readVendorValue(values: Record<string, number>, vendorName: string): number | null {
  const value = values[vendorName];
  if (isFiniteNumber(value)) {
    return value;
  }
  return null;
}

function collectMinimum(
  values: Record<string, number>,
  include: (value: number) => boolean,
): { count: number; minimum: number } {
  let count = 0;
  let minimum = Number.POSITIVE_INFINITY;

  for (const value of Object.values(values)) {
    if (!isFiniteNumber(value)) {
      continue;
    }
    if (!include(value)) {
      continue;
    }

    count += 1;
    if (value < minimum) {
      minimum = value;
    }
  }

  return { count, minimum };
}

function isFiniteNumber(value: unknown): value is number {
  if (typeof value !== "number") {
    return false;
  }
  return Number.isFinite(value);
}
