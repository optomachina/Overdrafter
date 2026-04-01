import type { VendorName } from "@/integrations/supabase/types";
import type { ScoredVendorOption } from "@/features/quotes/vendor-scoring";

export type TradeoffDimension = {
  key: string;
  label: string;
  vendorValue: string;
  isBestInSet: boolean;
};

export type VendorTradeoffEntry = {
  vendor: VendorName;
  displayName: string;
  rank: number;
  totalScore: number;
  strengths: string[];
  weaknesses: string[];
  dimensions: TradeoffDimension[];
  summary: string;
};

export type VendorTradeoffSummary = {
  scoredVendors: ScoredVendorOption[];
  tradeoffs: VendorTradeoffEntry[];
  topPick: VendorTradeoffEntry | null;
  summaryNarrative: string;
};

type DimensionCandidate = {
  vendor: VendorName;
  displayName: string;
  score: number;
  value: string;
};

function buildDimensionEntries(
  scored: ScoredVendorOption[],
): Map<string, DimensionCandidate[]> {
  const dimensions = new Map<string, DimensionCandidate[]>();

  const addDimension = (key: string, _label: string, getValue: (s: ScoredVendorOption) => { value: string; score: number }) => {
    const entries: DimensionCandidate[] = scored.map((s) => {
      const { value, score } = getValue(s);
      return { vendor: s.vendor, displayName: s.profile?.displayName ?? s.vendor, score, value };
    });

    dimensions.set(key, entries);
  };

  addDimension("price", "Price", (s) => ({
    value: s.unitPriceUsd != null ? `$${s.unitPriceUsd.toFixed(2)}` : "N/A",
    score: s.breakdown.price,
  }));

  addDimension("leadTime", "Lead Time", (s) => ({
    value: s.leadTimeBusinessDays != null ? `${s.leadTimeBusinessDays} business days` : "N/A",
    score: s.breakdown.leadTime,
  }));

  addDimension("capabilityFit", "Capability Match", (s) => ({
    value: s.profile?.displayName ?? s.vendor,
    score: s.breakdown.capabilityFit,
  }));

  addDimension("instantQuote", "Instant Quote", (s) => ({
    value: s.profile?.supportsInstantQuote ? "Yes" : "No",
    score: s.breakdown.instantQuote,
  }));

  addDimension("toleranceFit", "Tolerance Capability", (s) => ({
    value: s.profile?.minToleranceInch != null ? `±${s.profile.minToleranceInch}"` : "N/A",
    score: s.breakdown.toleranceFit,
  }));

  return dimensions;
}

function identifyStrengthsAndWeaknesses(
  entry: ScoredVendorOption,
  dimensions: Map<string, DimensionCandidate[]>,
): { strengths: string[]; weaknesses: string[] } {
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  for (const [key, candidates] of dimensions) {
    const bestScore = Math.max(...candidates.map((c) => c.score));
    const worstScore = Math.min(...candidates.map((c) => c.score));
    const entryCandidate = candidates.find((c) => c.vendor === entry.vendor);

    if (!entryCandidate) continue;

    if (entryCandidate.score === bestScore && bestScore > 0) {
      if (key === "price") {
        strengths.push(`Lowest price (${entryCandidate.value})`);
      } else if (key === "leadTime") {
        strengths.push(`Fastest delivery (${entryCandidate.value})`);
      } else if (key === "capabilityFit") {
        strengths.push(`Strongest capability match`);
      } else if (key === "instantQuote") {
        strengths.push(`Supports instant quoting`);
      } else if (key === "toleranceFit") {
        strengths.push(`Best tolerance capability (${entryCandidate.value})`);
      }
    }

    if (entryCandidate.score === worstScore && worstScore < 0.5 * bestScore) {
      if (key === "price") {
        weaknesses.push(`Highest price (${entryCandidate.value})`);
      } else if (key === "leadTime") {
        weaknesses.push(`Longest lead time (${entryCandidate.value})`);
      } else if (key === "capabilityFit") {
        weaknesses.push(`Limited capability match for requirements`);
      } else if (key === "instantQuote") {
        weaknesses.push(`No instant quote support`);
      } else if (key === "toleranceFit") {
        weaknesses.push(`Tightest tolerance limit (${entryCandidate.value})`);
      }
    }
  }

  return { strengths, weaknesses };
}

function buildDimensionTable(
  entry: ScoredVendorOption,
  dimensions: Map<string, DimensionCandidate[]>,
): TradeoffDimension[] {
  const result: TradeoffDimension[] = [];
  const dimensionLabels: Record<string, string> = {
    price: "Price",
    leadTime: "Lead Time",
    capabilityFit: "Capability Match",
    instantQuote: "Instant Quote",
    toleranceFit: "Tolerance Capability",
  };

  for (const [key, candidates] of dimensions) {
    const bestScore = Math.max(...candidates.map((c) => c.score));
    const entryCandidate = candidates.find((c) => c.vendor === entry.vendor);

    if (!entryCandidate) continue;

    result.push({
      key,
      label: dimensionLabels[key] ?? key,
      vendorValue: entryCandidate.value,
      isBestInSet: entryCandidate.score === bestScore,
    });
  }

  return result;
}

function buildSummaryNarrative(tradeoffs: VendorTradeoffEntry[]): string {
  if (tradeoffs.length === 0) {
    return "No vendors to compare.";
  }

  const topPick = tradeoffs[0];
  const parts: string[] = [];

  parts.push(`Top recommendation: ${topPick.displayName} (rank #${topPick.rank}, score ${topPick.totalScore.toFixed(2)}).`);

  if (topPick.strengths.length > 0) {
    parts.push(`Key strengths: ${topPick.strengths.slice(0, 2).join(", ")}.`);
  }

  if (tradeoffs.length > 1) {
    const runnerUp = tradeoffs[1];
    parts.push(`Runner-up: ${runnerUp.displayName} (rank #${runnerUp.rank}).`);
  }

  return parts.join(" ");
}

export function buildVendorTradeoffSummary(
  scoredVendors: ScoredVendorOption[],
): VendorTradeoffSummary {
  const dimensions = buildDimensionEntries(scoredVendors);

  const tradeoffs: VendorTradeoffEntry[] = scoredVendors.map((entry) => {
    const { strengths, weaknesses } = identifyStrengthsAndWeaknesses(entry, dimensions);
    const dimensionTable = buildDimensionTable(entry, dimensions);

    const summaryParts: string[] = [];
    if (strengths.length > 0) {
      summaryParts.push(`Strengths: ${strengths.join(", ")}.`);
    }
    if (weaknesses.length > 0) {
      summaryParts.push(`Trade-offs: ${weaknesses.join(", ")}.`);
    }

    return {
      vendor: entry.vendor,
      displayName: entry.profile?.displayName ?? entry.vendor,
      rank: entry.rank,
      totalScore: entry.totalScore,
      strengths,
      weaknesses,
      dimensions: dimensionTable,
      summary: summaryParts.join(" ") || "Balanced option with no standout strengths or weaknesses.",
    };
  });

  return {
    scoredVendors,
    tradeoffs,
    topPick: tradeoffs[0] ?? null,
    summaryNarrative: buildSummaryNarrative(tradeoffs),
  };
}

export function formatTradeoffTable(
  summary: VendorTradeoffSummary,
): string {
  if (summary.tradeoffs.length === 0) {
    return "No vendors to display.";
  }

  const header = "| Rank | Vendor | Score | Price | Lead Time | Instant Quote |";
  const separator = "|------|--------|-------|-------|-----------|---------------|";

  const rows = summary.tradeoffs.map((t) => {
    const price = t.dimensions.find((d) => d.key === "price")?.vendorValue ?? "N/A";
    const leadTime = t.dimensions.find((d) => d.key === "leadTime")?.vendorValue ?? "N/A";
    const instantQuote = t.dimensions.find((d) => d.key === "instantQuote")?.vendorValue ?? "N/A";

    return `| #${t.rank} | ${t.displayName} | ${t.totalScore.toFixed(2)} | ${price} | ${leadTime} | ${instantQuote} |`;
  });

  return [header, separator, ...rows].join("\n");
}
