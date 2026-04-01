import type { VendorName } from "@/integrations/supabase/types";
import type { VendorCapabilityProfile } from "@/features/quotes/types";

export type VendorScoreWeight = {
  capabilityFit: number;
  price: number;
  leadTime: number;
  instantQuote: number;
  toleranceFit: number;
};

export const DEFAULT_SCORE_WEIGHTS: VendorScoreWeight = {
  capabilityFit: 0.30,
  price: 0.30,
  leadTime: 0.20,
  instantQuote: 0.10,
  toleranceFit: 0.10,
};

export type VendorScoreInput = {
  profile: VendorCapabilityProfile | null;
  unitPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  requiredProcess: string | null;
  requiredMaterial: string | null;
  toleranceInch: number | null;
  allUnitPrices: (number | null)[];
  allLeadTimes: (number | null)[];
};

export type VendorScoreBreakdown = {
  capabilityFit: number;
  price: number;
  leadTime: number;
  instantQuote: number;
  toleranceFit: number;
};

export type VendorScoreResult = {
  vendor: VendorName;
  totalScore: number;
  breakdown: VendorScoreBreakdown;
  weights: VendorScoreWeight;
  rank: number;
};

function normalizePrice(unitPrice: number | null, allPrices: (number | null)[]): number {
  const validPrices = allPrices.filter((p): p is number => p != null && p > 0);
  if (validPrices.length === 0 || unitPrice == null || unitPrice <= 0) {
    return 0.5;
  }

  const minPrice = Math.min(...validPrices);
  const maxPrice = Math.max(...validPrices);

  if (minPrice === maxPrice) {
    return 1;
  }

  return 1 - (unitPrice - minPrice) / (maxPrice - minPrice);
}

function normalizeLeadTime(leadTime: number | null, allLeadTimes: (number | null)[]): number {
  const validLeadTimes = allLeadTimes.filter((l): l is number => l != null && l >= 0);
  if (validLeadTimes.length === 0 || leadTime == null || leadTime < 0) {
    return 0.5;
  }

  const minLead = Math.min(...validLeadTimes);
  const maxLead = Math.max(...validLeadTimes);

  if (minLead === maxLead) {
    return 1;
  }

  return 1 - (leadTime - minLead) / (maxLead - minLead);
}

function computeCapabilityFit(
  profile: VendorCapabilityProfile | null,
  requiredProcess: string | null,
  requiredMaterial: string | null,
): number {
  if (!profile) {
    return 0.3;
  }

  let score = 0.3;

  if (requiredProcess) {
    const normalizedProcess = requiredProcess.toLowerCase().trim();
    const processMatch =
      profile.supportedProcesses.some((p) => p.toLowerCase() === normalizedProcess) ||
      profile.capabilityTags.some((t) => t.toLowerCase() === normalizedProcess);
    if (processMatch) {
      score += 0.35;
    }
  } else {
    score += 0.35;
  }

  if (requiredMaterial) {
    const normalizedMaterial = requiredMaterial.toLowerCase().trim();
    const materialMatch = profile.supportedMaterials.some((m) =>
      m.toLowerCase().includes(normalizedMaterial),
    );
    if (materialMatch) {
      score += 0.35;
    }
  } else {
    score += 0.35;
  }

  return Math.min(score, 1);
}

function computeToleranceFit(
  profile: VendorCapabilityProfile | null,
  toleranceInch: number | null,
): number {
  if (toleranceInch == null) {
    return 1;
  }

  if (!profile || profile.minToleranceInch == null) {
    return 0.5;
  }

  if (toleranceInch >= profile.minToleranceInch) {
    const headroom = toleranceInch - profile.minToleranceInch;
    const toleranceRange = toleranceInch;
    if (toleranceRange > 0) {
      return Math.min(0.5 + (headroom / toleranceRange) * 0.5, 1);
    }
    return 1;
  }

  return 0;
}

export function scoreVendor(
  input: VendorScoreInput,
  weights: VendorScoreWeight = DEFAULT_SCORE_WEIGHTS,
): VendorScoreBreakdown {
  const capabilityFit = computeCapabilityFit(
    input.profile,
    input.requiredProcess,
    input.requiredMaterial,
  );

  const price = normalizePrice(input.unitPriceUsd, input.allUnitPrices);
  const leadTime = normalizeLeadTime(input.leadTimeBusinessDays, input.allLeadTimes);
  const instantQuote = input.profile?.supportsInstantQuote ? 1 : 0;
  const toleranceFit = computeToleranceFit(input.profile, input.toleranceInch);

  return {
    capabilityFit: capabilityFit * weights.capabilityFit,
    price: price * weights.price,
    leadTime: leadTime * weights.leadTime,
    instantQuote: instantQuote * weights.instantQuote,
    toleranceFit: toleranceFit * weights.toleranceFit,
  };
}

export function computeTotalScore(breakdown: VendorScoreBreakdown): number {
  return (
    breakdown.capabilityFit +
    breakdown.price +
    breakdown.leadTime +
    breakdown.instantQuote +
    breakdown.toleranceFit
  );
}

export type ScoredVendorOption = {
  vendor: VendorName;
  profile: VendorCapabilityProfile | null;
  unitPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  breakdown: VendorScoreBreakdown;
  totalScore: number;
  rank: number;
};

export function rankVendors(
  inputs: Map<VendorName, Omit<VendorScoreInput, "allUnitPrices" | "allLeadTimes">>,
  weights: VendorScoreWeight = DEFAULT_SCORE_WEIGHTS,
): ScoredVendorOption[] {
  const vendorEntries = [...inputs.entries()];
  const allUnitPrices = vendorEntries.map(([, v]) => v.unitPriceUsd);
  const allLeadTimes = vendorEntries.map(([, v]) => v.leadTimeBusinessDays);

  const scored = vendorEntries.map(([vendor, input]) => {
    const fullInput: VendorScoreInput = {
      ...input,
      allUnitPrices,
      allLeadTimes,
    };

    const breakdown = scoreVendor(fullInput, weights);
    const totalScore = computeTotalScore(breakdown);

    return {
      vendor,
      profile: input.profile,
      unitPriceUsd: input.unitPriceUsd,
      leadTimeBusinessDays: input.leadTimeBusinessDays,
      breakdown,
      totalScore,
      rank: 0,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  scored.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return scored;
}

export function formatScoreSummary(scored: ScoredVendorOption[]): string {
  if (scored.length === 0) {
    return "No vendors scored.";
  }

  const lines = scored.map((s) => {
    const price = s.unitPriceUsd != null ? `$${s.unitPriceUsd.toFixed(2)}` : "N/A";
    const lead = s.leadTimeBusinessDays != null ? `${s.leadTimeBusinessDays}d` : "N/A";
    return `#${s.rank} ${s.vendor}: ${s.totalScore.toFixed(2)} (price=${price}, lead=${lead})`;
  });

  return lines.join("\n");
}
