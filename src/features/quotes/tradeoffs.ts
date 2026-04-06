/**
 * Vendor tradeoff explanation engine (OVD-139).
 *
 * Generates human-readable tradeoff statements comparing vendors
 * across scored dimensions. Uses template-based text, not LLM-generated.
 */

import type { QuoteContext, VendorScore } from "@/features/quotes/scoring";
import { formatCurrency } from "@/features/quotes/utils";

/**
 * A single vendor's tradeoff statement.
 */
export interface TradeoffStatement {
  vendorName: string;
  overallScore: number;
  statement: string;
  strengths: string[];
  weaknesses: string[];
  confidence: number;
}

/**
 * A complete tradeoff summary for a ranked vendor set.
 */
export interface TradeoffSummary {
  topPick: TradeoffStatement;
  alternatives: TradeoffStatement[];
  comparisonText: string;
}

/**
 * Generates a human-readable tradeoff statement for a single vendor,
 * comparing it against all other scored vendors.
 */
export function generateTradeoffStatement(
  score: VendorScore,
  allScores: VendorScore[],
  _context: QuoteContext,
  prices?: Record<string, number>,
  leadTimes?: Record<string, number>,
): TradeoffStatement {
  const others = allScores.filter((s) => s.vendorName !== score.vendorName);

  if (others.length === 0) {
    return {
      vendorName: score.vendorName,
      overallScore: score.overallScore,
      statement: `${score.vendorName} is the only vendor with a quote for this request.`,
      strengths: ["Only available option"],
      weaknesses: [],
      confidence: 30,
    };
  }

  const avgPrice = average(allScores.map((s) => s.priceScore));
  const avgLeadTime = average(allScores.map((s) => s.leadTimeScore));
  const avgQuality = average(allScores.map((s) => s.qualityScore));
  const avgDomestic = average(allScores.map((s) => s.domesticScore));

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (score.priceScore >= avgPrice + 10) {
    strengths.push("competitive pricing");
  } else if (score.priceScore < avgPrice - 10) {
    weaknesses.push("higher than average pricing");
  }

  if (score.leadTimeScore >= avgLeadTime + 10) {
    strengths.push("fast delivery");
  } else if (score.leadTimeScore < avgLeadTime - 10) {
    weaknesses.push("slower delivery than average");
  }

  if (score.qualityScore >= avgQuality + 10) {
    strengths.push("strong quality track record");
  } else if (score.qualityScore < avgQuality - 10) {
    weaknesses.push("below average quality score");
  }

  if (score.domesticScore >= avgDomestic + 10) {
    strengths.push("domestic supplier");
  } else if (score.domesticScore < avgDomestic - 10) {
    weaknesses.push("international supplier");
  }

  if (score.capabilityMatchScore >= 90) {
    strengths.push("excellent capability match");
  } else if (score.capabilityMatchScore < 50) {
    weaknesses.push("limited capability match");
  }

  const statement = buildStatement(score, allScores, strengths, weaknesses, prices, leadTimes);

  const scoreSpread = computeScoreSpread(allScores);
  const confidence = clamp(scoreSpread * 2, 20, 95);

  return {
    vendorName: score.vendorName,
    overallScore: score.overallScore,
    statement,
    strengths,
    weaknesses,
    confidence,
  };
}

/**
 * Generates a full tradeoff summary for a ranked set of vendors.
 */
export function generateTradeoffSummary(
  rankedScores: VendorScore[],
  _context: QuoteContext,
  prices?: Record<string, number>,
  leadTimes?: Record<string, number>,
): TradeoffSummary | null {
  if (rankedScores.length === 0) {
    return null;
  }

  const topPick = generateTradeoffStatement(
    rankedScores[0],
    rankedScores,
    _context,
    prices,
    leadTimes,
  );

  const alternatives = rankedScores
    .slice(1, 4)
    .map((score) =>
      generateTradeoffStatement(score, rankedScores, _context, prices, leadTimes),
    );

  const comparisonText = buildComparisonText(rankedScores, prices, leadTimes);

  return {
    topPick,
    alternatives,
    comparisonText,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

function buildStatement(
  score: VendorScore,
  allScores: VendorScore[],
  strengths: string[],
  weaknesses: string[],
  prices?: Record<string, number>,
  leadTimes?: Record<string, number>,
): string {
  const cheapest = findCheapest(allScores, prices);
  const fastest = findFastest(allScores, leadTimes);
  const isCheapest = cheapest === score.vendorName;
  const isFastest = fastest === score.vendorName;
  const isTopPick = allScores[0]?.vendorName === score.vendorName;

  if (isCheapest && isFastest) {
    return `${score.vendorName} offers the best price and fastest delivery — the clear winner on both cost and speed.`;
  }

  if (isCheapest && prices) {
    const price = prices[score.vendorName];
    const fastestVendor = fastest;
    const fastestLeadTime = leadTimes ? leadTimes[fastestVendor] : null;
    let statement = `${score.vendorName} is the cheapest option`;
    if (price !== undefined) {
      statement += ` at ${formatCurrency(price)}`;
    }
    if (fastestLeadTime !== null && !isFastest) {
      statement += `, but lead time is ${fastestLeadTime} days — slower than the fastest option (${fastestVendor}).`;
    } else {
      statement += ` with a strong overall score of ${Math.round(score.overallScore)}/100.`;
    }
    return statement;
  }

  if (isFastest && leadTimes) {
    const leadTime = leadTimes[score.vendorName];
    const cheapestVendor = cheapest;
    const cheapestPrice = prices ? prices[cheapestVendor] : null;
    let statement = `${score.vendorName} is the fastest at ${leadTime} days`;
    if (cheapestPrice !== null && !isCheapest) {
      const priceDiff = prices && prices[score.vendorName] && prices[cheapestVendor]
        ? Math.round(((prices[score.vendorName] - prices[cheapestVendor]) / prices[cheapestVendor]) * 100)
        : null;
      if (priceDiff !== null && priceDiff > 0) {
        statement += `, but costs ${priceDiff}% more than the cheapest option (${cheapestVendor}).`;
      } else {
        statement += `, with a strong overall score of ${Math.round(score.overallScore)}/100.`;
      }
    } else {
      statement += ` with an overall score of ${Math.round(score.overallScore)}/100.`;
    }
    return statement;
  }

  if (isTopPick) {
    return `${score.vendorName} provides the best balance of price and speed, with an overall score of ${Math.round(score.overallScore)}/100.`;
  }

  if (score.domesticScore >= 100 && allScores[0]?.domesticScore < 100) {
    return `${score.vendorName} is our top domestic option with an overall score of ${Math.round(score.overallScore)}/100.`;
  }

  const strengthText = strengths.length > 0 ? strengths[0] : null;
  const weaknessText = weaknesses.length > 0 ? weaknesses[0] : null;

  if (strengthText && weaknessText) {
    return `${score.vendorName} stands out for ${strengthText} but has ${weaknessText}. Overall score: ${Math.round(score.overallScore)}/100.`;
  }

  if (strengthText) {
    return `${score.vendorName} offers ${strengthText} with an overall score of ${Math.round(score.overallScore)}/100.`;
  }

  if (weaknessText) {
    return `${score.vendorName} has ${weaknessText} but remains a viable option at ${Math.round(score.overallScore)}/100.`;
  }

  return `${score.vendorName} scores ${Math.round(score.overallScore)}/100 overall — a solid middle-ground option.`;
}

function buildComparisonText(
  ranked: VendorScore[],
  prices?: Record<string, number>,
  leadTimes?: Record<string, number>,
): string {
  if (ranked.length < 2) {
    return "Only one vendor returned a quote.";
  }

  const top = ranked[0];
  const cheapest = findCheapest(ranked, prices);
  const fastest = findFastest(ranked, leadTimes);

  const parts: string[] = [];

  parts.push(`${top.vendorName} ranks highest overall (${Math.round(top.overallScore)}/100).`);

  if (cheapest !== top.vendorName) {
    parts.push(`${cheapest} is the cheapest option.`);
  }

  if (fastest !== top.vendorName && fastest !== cheapest) {
    parts.push(`${fastest} has the fastest delivery.`);
  }

  if (ranked.length >= 3) {
    const third = ranked[2];
    parts.push(`${third.vendorName} rounds out the top three at ${Math.round(third.overallScore)}/100.`);
  }

  return parts.join(" ");
}

function findCheapest(scores: VendorScore[], prices?: Record<string, number>): string {
  if (!prices || scores.length === 0) {
    return scores[0]?.vendorName ?? "";
  }

  let cheapest = scores[0].vendorName;
  let minPrice = prices[scores[0].vendorName] ?? Infinity;

  for (const score of scores) {
    const price = prices[score.vendorName];
    if (price !== undefined && price < minPrice) {
      minPrice = price;
      cheapest = score.vendorName;
    }
  }

  return cheapest;
}

function findFastest(scores: VendorScore[], leadTimes?: Record<string, number>): string {
  if (!leadTimes || scores.length === 0) {
    return scores[0]?.vendorName ?? "";
  }

  let fastest = scores[0].vendorName;
  let minLeadTime = leadTimes[scores[0].vendorName] ?? Infinity;

  for (const score of scores) {
    const lt = leadTimes[score.vendorName];
    if (lt !== undefined && lt < minLeadTime) {
      minLeadTime = lt;
      fastest = score.vendorName;
    }
  }

  return fastest;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeScoreSpread(scores: VendorScore[]): number {
  if (scores.length < 2) return 0;
  const overallScores = scores.map((s) => s.overallScore);
  const max = Math.max(...overallScores);
  const min = Math.min(...overallScores);
  return max - min;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
