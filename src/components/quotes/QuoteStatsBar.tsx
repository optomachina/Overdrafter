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

function getNumericMinimum(values: readonly number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function getNumericMaximum(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function formatOptionDetail(option: ClientQuoteSelectionOption | null): string {
  return option ? `${option.supplier} ${option.tier ?? ""}`.trim() : "";
}

function getPriceSpread(unitPrices: readonly number[]): { range: string; spread: string; spreadRatio: number | null } {
  const minTotal = getNumericMinimum(unitPrices);
  const maxTotal = getNumericMaximum(unitPrices);

  if (minTotal === null || maxTotal === null) {
    return { range: "—", spread: "", spreadRatio: null };
  }

  const range = `${formatCurrency(minTotal)}–${formatCurrency(maxTotal)}`;

  if (minTotal <= 0) {
    return { range, spread: "", spreadRatio: null };
  }

  const spreadRatio = maxTotal / minTotal;

  return {
    range,
    spread: `${spreadRatio.toFixed(1)}x spread`,
    spreadRatio,
  };
}

function getHighSpreadGuidance(spreadRatio: number | null): string | null {
  if (spreadRatio === null || spreadRatio < HIGH_SPREAD_THRESHOLD) {
    return null;
  }

  return "Large price variation across quotes. Compare supplier notes, lead time, and process fit before selecting. If the range still looks off, request more quotes.";
}

function buildStats(options: readonly ClientQuoteSelectionOption[]): StatCell[] {
  const unitPrices = options.map((o) => o.unitPriceUsd).filter(Number.isFinite);
  const leadTimes = options
    .map((o) => o.leadTimeBusinessDays)
    .filter((value): value is number => value !== null && value > 0);

  const bestPrice = getNumericMinimum(unitPrices);
  const fastestLead = getNumericMinimum(leadTimes);
  const bestPriceOption = bestPrice === null
    ? null
    : options.find((o) => o.unitPriceUsd === bestPrice) ?? null;
  const fastestOption = fastestLead === null
    ? null
    : options.find((o) => o.leadTimeBusinessDays === fastestLead) ?? null;
  const suppliers = new Set(options.map((o) => o.supplier));
  const { range, spread } = getPriceSpread(unitPrices);

  return [
    {
      label: "Best Unit Price",
      value: bestPrice === null ? "—" : formatCurrency(bestPrice),
      detail: formatOptionDetail(bestPriceOption),
      color: "text-emerald-400",
    },
    {
      label: "Fastest Lead",
      value: fastestLead === null ? "—" : `${fastestLead} days`,
      detail: formatOptionDetail(fastestOption),
      color: "text-amber-400",
    },
    {
      label: "Options Quoted",
      value: String(options.length),
      detail: `${suppliers.size} supplier${suppliers.size === 1 ? "" : "s"}`,
      color: "text-blue-400",
    },
    {
      label: "Price Range",
      value: range,
      detail: spread,
      color: "text-white",
    },
  ];
}

function computeStats(options: readonly ClientQuoteSelectionOption[]): QuoteStatsModel {
  const eligible = options.filter((o) => o.eligible);
  const unitPrices = eligible.map((o) => o.unitPriceUsd).filter(Number.isFinite);
  const { spreadRatio } = getPriceSpread(unitPrices);

  return {
    stats: buildStats(eligible),
    highSpreadGuidance: getHighSpreadGuidance(spreadRatio),
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
