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
  const vendorPrice = prices[vendorName];

  if (vendorPrice === undefined || vendorPrice === null || Number.isNaN(vendorPrice)) {
    return 0;
  }

  if (vendorPrice <= 0) {
    return 0;
  }

  const allPrices = Object.values(prices).filter(
    (p) => p !== null && p !== undefined && !Number.isNaN(p) && p > 0,
  );

  if (allPrices.length === 0) {
    return 0;
  }

  if (allPrices.length === 1) {
    return 100;
  }

  const minPrice = Math.min(...allPrices);
  const ratio = minPrice / vendorPrice;
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
  const vendorLeadTime = leadTimes[vendorName];

  if (vendorLeadTime === undefined || vendorLeadTime === null || Number.isNaN(vendorLeadTime)) {
    return 0;
  }

  const allLeadTimes = Object.values(leadTimes).filter(
    (lt) => lt !== null && lt !== undefined && !Number.isNaN(lt) && lt >= 0,
  );

  if (allLeadTimes.length === 0) {
    return 0;
  }

  if (allLeadTimes.length === 1) {
    return 100;
  }

  const minLeadTime = Math.min(...allLeadTimes);

  if (minLeadTime === 0) {
    if (vendorLeadTime === 0) {
      return 100;
    }
    return 0;
  }

  const ratio = minLeadTime / vendorLeadTime;
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
  // Default weights
  const priceWeight = 0.30;
  const leadTimeWeight = 0.25;
  const qualityWeight = 0.20;
  const capabilityMatchWeight = 0.15;
  const domesticWeight = 0.10;

  const priceScore = normalizePriceScore(input.prices, input.vendorName);
  const leadTimeScore = normalizeLeadTimeScore(input.leadTimes, input.vendorName);
  const qualityScore = input.qualityScore;
  const domesticScore = input.domesticUs ? 100 : 50;

  // Capability match is 100 for all live vendors since they are already
  // filtered by the quote run (they responded with a quote).
  const capabilityMatchScore = 100;

  const overallScore =
    priceScore * priceWeight +
    leadTimeScore * leadTimeWeight +
    qualityScore * qualityWeight +
    capabilityMatchScore * capabilityMatchWeight +
    domesticScore * domesticWeight;

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
