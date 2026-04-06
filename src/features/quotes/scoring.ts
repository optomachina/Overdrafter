/**
 * Weighted vendor scoring engine (OVD-138).
 *
 * Computes multi-dimensional scores for vendors based on capability profiles,
 * prices, lead times, and configurable weights. This is additive to the existing
 * preset-based sorting logic in selection.ts — it provides a capability-aware
 * scoring layer rather than replacing it.
 */

/**
 * A vendor's capability profile as stored in vendor_capability_profiles.
 */
export interface VendorCapabilityProfile {
  vendorName: string;
  processTypes: string[];
  materials: string[];
  toleranceMinMm: number | null;
  toleranceMaxMm: number | null;
  maxPartSizeMm: number | null;
  minQuantity: number;
  maxQuantity: number | null;
  geographicRegion: string | null;
  certifications: string[];
  qualityScore: number | null;
  leadTimeReliability: number | null;
  costCompetitiveness: number | null;
  domesticUs: boolean;
}

/**
 * The context of a quote request used to score vendor fit.
 */
export interface QuoteContext {
  processType: string;
  materials: string[];
  quantity: number;
  toleranceRequiredMm?: number;
  partSizeMm?: number;
  requireDomestic?: boolean;
  requiredCertifications?: string[];
}

/**
 * The scored result for a single vendor across all dimensions.
 */
export interface VendorScore {
  vendorName: string;
  overallScore: number;
  priceScore: number;
  leadTimeScore: number;
  qualityScore: number;
  capabilityMatchScore: number;
  domesticScore: number;
  breakdown: Record<string, number>;
}

/**
 * Weights applied to each dimension when computing the overall score.
 * All weights should sum to 1.0 for predictable results.
 */
export interface ScoringWeights {
  price: number;
  leadTime: number;
  quality: number;
  capabilityMatch: number;
  domestic: number;
}

/** Default weights: price is most important, followed by lead time and quality. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  price: 0.30,
  leadTime: 0.25,
  quality: 0.20,
  capabilityMatch: 0.15,
  domestic: 0.10,
};

const CAPABILITY_SUB_WEIGHTS = {
  process: 0.40,
  materials: 0.25,
  tolerance: 0.15,
  quantity: 0.10,
  certifications: 0.10,
} as const;

/**
 * Scores how well a vendor's capabilities match the quote request.
 *
 * Returns a value from 0 to 100. A score of 0 means the vendor cannot
 * fulfill the request at all (e.g. wrong process type).
 *
 * Sub-factor weights: process (40%), materials (25%), tolerance (15%),
 * quantity (10%), certifications (10%).
 */
export function scoreCapabilityMatch(
  profile: VendorCapabilityProfile,
  context: QuoteContext,
): number {
  const processScore = scoreProcessMatch(profile.processTypes, context.processType);

  if (processScore === 0) {
    return 0;
  }

  const quantityScore = scoreQuantityMatch(profile, context.quantity);

  if (quantityScore === 0) {
    return 0;
  }

  const materialScore = scoreMaterialMatch(profile.materials, context.materials);
  const toleranceScore = scoreToleranceMatch(profile, context);
  const certificationScore = scoreCertificationMatch(
    profile.certifications,
    context.requiredCertifications,
  );

  const overall =
    processScore * CAPABILITY_SUB_WEIGHTS.process +
    materialScore * CAPABILITY_SUB_WEIGHTS.materials +
    toleranceScore * CAPABILITY_SUB_WEIGHTS.tolerance +
    quantityScore * CAPABILITY_SUB_WEIGHTS.quantity +
    certificationScore * CAPABILITY_SUB_WEIGHTS.certifications;

  return clamp(overall, 0, 100);
}

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
 * are equal, everyone gets 100. If there are no lead times or a single vendor,
 * returns 100.
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
 * Combines capability match, price, lead time, quality, and domestic status
 * into a weighted overall score. Returns the full breakdown for transparency.
 *
 * @param profile - The vendor's capability profile
 * @param context - The quote request context
 * @param prices - Map of vendor name to total price
 * @param leadTimes - Map of vendor name to lead time in business days
 * @param weights - Optional custom weights (defaults to DEFAULT_WEIGHTS)
 */
export function scoreVendor(
  profile: VendorCapabilityProfile,
  context: QuoteContext,
  prices: Record<string, number>,
  leadTimes: Record<string, number>,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): VendorScore {
  const capabilityMatchScore = scoreCapabilityMatch(profile, context);
  const priceScore = normalizePriceScore(prices, profile.vendorName);
  const leadTimeScore = normalizeLeadTimeScore(leadTimes, profile.vendorName);
  const qualityScore = profile.qualityScore ?? 0;
  const domesticScore = computeDomesticScore(profile.domesticUs, context.requireDomestic);

  const overallScore =
    priceScore * weights.price +
    leadTimeScore * weights.leadTime +
    qualityScore * weights.quality +
    capabilityMatchScore * weights.capabilityMatch +
    domesticScore * weights.domestic;

  return {
    vendorName: profile.vendorName,
    overallScore: clamp(overallScore, 0, 100),
    priceScore,
    leadTimeScore,
    qualityScore,
    capabilityMatchScore,
    domesticScore,
    breakdown: {
      process: scoreProcessMatch(profile.processTypes, context.processType),
      materials: scoreMaterialMatch(profile.materials, context.materials),
      tolerance: scoreToleranceMatch(profile, context),
      quantity: scoreQuantityMatch(profile, context.quantity),
      certifications: scoreCertificationMatch(
        profile.certifications,
        context.requiredCertifications,
      ),
    },
  };
}

/**
 * Scores all vendors and returns them sorted by overallScore descending.
 *
 * Vendors with a capability_match_score of 0 are filtered out because they
 * cannot fulfill the request.
 *
 * @param profiles - Array of vendor capability profiles
 * @param context - The quote request context
 * @param prices - Map of vendor name to total price
 * @param leadTimes - Map of vendor name to lead time in business days
 * @param weights - Optional custom weights (defaults to DEFAULT_WEIGHTS)
 */
export function rankVendors(
  profiles: VendorCapabilityProfile[],
  context: QuoteContext,
  prices: Record<string, number>,
  leadTimes: Record<string, number>,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): VendorScore[] {
  const scored = profiles.map((profile) =>
    scoreVendor(profile, context, prices, leadTimes, weights),
  );

  const eligible = scored.filter((s) => s.capabilityMatchScore > 0);

  return eligible.sort((a, b) => b.overallScore - a.overallScore);
}

// ─── Internal helpers ────────────────────────────────────────────────

function scoreProcessMatch(vendorProcesses: string[], requiredProcess: string): number {
  if (vendorProcesses.length === 0) {
    return 0;
  }

  const normalizedRequired = requiredProcess.trim().toLowerCase();

  for (const process of vendorProcesses) {
    if (process.trim().toLowerCase() === normalizedRequired) {
      return 100;
    }
  }

  return 0;
}

function scoreMaterialMatch(vendorMaterials: string[], requiredMaterials: string[]): number {
  if (requiredMaterials.length === 0) {
    return 100;
  }

  if (vendorMaterials.length === 0) {
    return 0;
  }

  const vendorSet = new Set(vendorMaterials.map((m) => m.trim().toLowerCase()));
  let matchCount = 0;

  for (const material of requiredMaterials) {
    if (vendorSet.has(material.trim().toLowerCase())) {
      matchCount += 1;
    }
  }

  return (matchCount / requiredMaterials.length) * 100;
}

function scoreToleranceMatch(profile: VendorCapabilityProfile, context: QuoteContext): number {
  if (context.toleranceRequiredMm === undefined || context.toleranceRequiredMm === null) {
    return 100;
  }

  const toleranceMin = profile.toleranceMinMm;
  const toleranceMax = profile.toleranceMaxMm;
  const required = context.toleranceRequiredMm;

  if (toleranceMin === null && toleranceMax === null) {
    return 50;
  }

  if (toleranceMin !== null && toleranceMax !== null) {
    if (required >= toleranceMin && required <= toleranceMax) {
      return 100;
    }
    return 0;
  }

  if (toleranceMin !== null) {
    if (required >= toleranceMin) {
      return 100;
    }
    return 0;
  }

  if (toleranceMax !== null) {
    if (required <= toleranceMax) {
      return 100;
    }
    return 0;
  }

  return 50;
}

function scoreQuantityMatch(profile: VendorCapabilityProfile, requiredQuantity: number): number {
  const minQty = profile.minQuantity;
  const maxQty = profile.maxQuantity;

  if (requiredQuantity < minQty) {
    return 0;
  }

  if (maxQty !== null && requiredQuantity > maxQty) {
    return 0;
  }

  return 100;
}

function scoreCertificationMatch(
  vendorCerts: string[],
  requiredCerts: string[] | undefined,
): number {
  if (requiredCerts === undefined || requiredCerts.length === 0) {
    return 100;
  }

  if (vendorCerts.length === 0) {
    return 0;
  }

  const vendorSet = new Set(vendorCerts.map((c) => c.trim().toLowerCase()));
  let matchCount = 0;

  for (const cert of requiredCerts) {
    if (vendorSet.has(cert.trim().toLowerCase())) {
      matchCount += 1;
    }
  }

  return (matchCount / requiredCerts.length) * 100;
}

function computeDomesticScore(isDomestic: boolean, requireDomestic?: boolean): number {
  if (requireDomestic === true) {
    return isDomestic ? 100 : 0;
  }

  return isDomestic ? 100 : 50;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
