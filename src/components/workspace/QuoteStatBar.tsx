import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { buildQuoteStats } from "./quote-stat-bar";

type QuoteStatBarProps = {
  quotes: ClientQuoteSelectionOption[];
};

export function QuoteStatBar({ quotes }: QuoteStatBarProps) {
  const stats = buildQuoteStats(quotes);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {stats.map((stat) => (
        <section
          key={stat.label}
          className="rounded-[10px] border border-ws-border-subtle bg-ws-card px-[14px] py-[10px]"
        >
          <p className="mb-[3px] text-[10px] uppercase tracking-[0.08em] text-white/35">{stat.label}</p>
          <p className={`text-[18px] font-bold tracking-[-0.02em] ${stat.valueClassName}`}>{stat.value}</p>
          <p className="text-[10px] text-white/30">{stat.detail || "\u00a0"}</p>
        </section>
      ))}
    </div>
  );
}

export type { QuoteStatBarProps };
