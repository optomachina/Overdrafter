import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { formatCurrency } from "@/features/quotes/utils";

export type QuoteStat = {
  label: string;
  value: string;
  detail: string;
  valueClassName: string;
};

export function buildQuoteStats(quotes: ClientQuoteSelectionOption[]): QuoteStat[] {
  const eligibleQuotes = quotes.filter((quote) => quote.eligible);
  const comparisonQuotes = eligibleQuotes.filter((quote) => !quote.excluded);
  const activeQuotes = comparisonQuotes.length > 0 ? comparisonQuotes : eligibleQuotes;

  const bestPrice =
    activeQuotes.length > 0 ? Math.min(...activeQuotes.map((quote) => quote.unitPriceUsd)) : null;
  const bestPriceQuote =
    bestPrice !== null ? activeQuotes.find((quote) => quote.unitPriceUsd === bestPrice) ?? null : null;

  const leadTimes = activeQuotes
    .map((quote) => quote.leadTimeBusinessDays)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const fastestLead = leadTimes.length > 0 ? Math.min(...leadTimes) : null;
  const fastestQuote =
    fastestLead !== null
      ? activeQuotes.find((quote) => quote.leadTimeBusinessDays === fastestLead) ?? null
      : null;

  const vendorCount = new Set(activeQuotes.map((quote) => quote.vendorKey)).size;

  return [
    {
      label: "Best price",
      value: bestPrice !== null ? formatCurrency(bestPrice) : "—",
      detail: bestPriceQuote ? [bestPriceQuote.vendorLabel, bestPriceQuote.tier].filter(Boolean).join(" · ") : "",
      valueClassName: "text-emerald-400",
    },
    {
      label: "Fastest",
      value: fastestLead !== null ? `${fastestLead} bd` : "—",
      detail: fastestQuote ? [fastestQuote.vendorLabel, fastestQuote.tier].filter(Boolean).join(" · ") : "",
      valueClassName: "text-blue-400",
    },
    {
      label: "Options",
      value: String(activeQuotes.length),
      detail: `across ${vendorCount} vendor${vendorCount === 1 ? "" : "s"}`,
      valueClassName: "text-white",
    },
  ];
}
