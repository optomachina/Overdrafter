import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { formatCurrency } from "@/features/quotes/utils";

type QuoteStatsBarProps = {
  options: readonly ClientQuoteSelectionOption[];
};

const HIGH_SPREAD_THRESHOLD = 3;

type StatCell = {
  label: string;
  value: string;
  detail: string;
  color: string;
};

type QuoteStatsModel = {
  stats: StatCell[];
  highSpreadGuidance: string | null;
};

function computeStats(options: readonly ClientQuoteSelectionOption[]): QuoteStatsModel {
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
  const spreadRatio = minTotal !== null && maxTotal !== null && minTotal > 0
    ? maxTotal / minTotal
    : null;
  const spread = spreadRatio !== null
    ? `${spreadRatio.toFixed(1)}x spread`
    : "";
  const highSpreadGuidance = spreadRatio !== null && spreadRatio >= HIGH_SPREAD_THRESHOLD
    ? "Large price variation across quotes. Compare supplier notes, lead time, and process fit before selecting. If the range still looks off, request more quotes."
    : null;

  const suppliers = new Set(eligible.map((o) => o.supplier));

  return {
    stats: [
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
    ],
    highSpreadGuidance,
  };
}

export function QuoteStatsBar({ options }: QuoteStatsBarProps) {
  const { stats, highSpreadGuidance } = computeStats(options);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/8 bg-white/8 md:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-ws-inset px-4 py-3">
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

      {highSpreadGuidance ? (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-50">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/90">
            Decision Prompt
          </p>
          <p className="mt-1 leading-6 text-amber-50/90">{highSpreadGuidance}</p>
        </div>
      ) : null}
    </div>
  );
}
