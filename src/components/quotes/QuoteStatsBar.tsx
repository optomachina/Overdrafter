import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { formatCurrency } from "@/features/quotes/utils";

type QuoteStatsBarProps = {
  options: readonly ClientQuoteSelectionOption[];
};

type StatCell = {
  label: string;
  value: string;
  detail: string;
  color: string;
};

function computeStats(options: readonly ClientQuoteSelectionOption[]): StatCell[] {
  const eligible = options.filter((o) => o.eligible);

  const unitPrices = eligible.map((o) => o.unitPriceUsd).filter(Number.isFinite);
  const leadTimes = eligible
    .map((o) => o.leadTimeBusinessDays)
    .filter((v): v is number => v !== null && v > 0);

  const bestPrice = unitPrices.length > 0 ? Math.min(...unitPrices) : null;
  const bestPriceOption = bestPrice !== null
    ? eligible.find((o) => o.unitPriceUsd === bestPrice)
    : null;

  const fastestLead = leadTimes.length > 0 ? Math.min(...leadTimes) : null;
  const fastestOption = fastestLead !== null
    ? eligible.find((o) => o.leadTimeBusinessDays === fastestLead)
    : null;

  const minTotal = unitPrices.length > 0 ? Math.min(...unitPrices) : null;
  const maxTotal = unitPrices.length > 0 ? Math.max(...unitPrices) : null;
  const spread = minTotal && maxTotal && minTotal > 0
    ? `${(maxTotal / minTotal).toFixed(1)}x spread`
    : "";

  const suppliers = new Set(eligible.map((o) => o.supplier));

  return [
    {
      label: "Best Unit Price",
      value: bestPrice !== null ? formatCurrency(bestPrice) : "—",
      detail: bestPriceOption
        ? `${bestPriceOption.supplier} ${bestPriceOption.tier ?? ""}`.trim()
        : "",
      color: "text-emerald-400",
    },
    {
      label: "Fastest Lead",
      value: fastestLead !== null ? `${fastestLead} days` : "—",
      detail: fastestOption
        ? `${fastestOption.supplier} ${fastestOption.tier ?? ""}`.trim()
        : "",
      color: "text-amber-400",
    },
    {
      label: "Options Quoted",
      value: String(eligible.length),
      detail: `${suppliers.size} supplier${suppliers.size === 1 ? "" : "s"}`,
      color: "text-blue-400",
    },
    {
      label: "Price Range",
      value: minTotal !== null && maxTotal !== null
        ? `${formatCurrency(minTotal)}–${formatCurrency(maxTotal)}`
        : "—",
      detail: spread,
      color: "text-white",
    },
  ];
}

export function QuoteStatsBar({ options }: QuoteStatsBarProps) {
  const stats = computeStats(options);

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/8 bg-white/8 md:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-[#1a1a1a] px-4 py-3">
          <p className="text-[10px] uppercase tracking-widest text-white/40">
            {stat.label}
          </p>
          <p className={`mt-1 text-xl font-bold tracking-tight ${stat.color}`}>
            {stat.value}
          </p>
          {stat.detail ? (
            <p className="mt-0.5 text-[10px] text-white/40">{stat.detail}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
