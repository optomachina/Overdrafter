import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TradeoffStatement, TradeoffSummary } from "@/features/quotes/tradeoffs";

type ClientTradeoffSummaryProps = {
  summary: TradeoffSummary;
  className?: string;
};

export function ClientTradeoffSummary({ summary, className }: ClientTradeoffSummaryProps) {
  const [showAlternatives, setShowAlternatives] = useState(false);

  return (
    <div className={cn("rounded-surface-lg border border-white/10 bg-black/30 p-4", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Star className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-white/90">Routing Recommendation</h3>
      </div>

      <p className="mb-4 text-xs text-white/60">{summary.comparisonText}</p>

      <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Badge
            variant="default"
            className="bg-amber-400/20 text-amber-300 hover:bg-amber-400/20"
          >
            Recommended
          </Badge>
          <span className="text-sm font-medium text-white/90">{summary.topPick.vendorName}</span>
          <span className="ml-auto text-xs text-white/50">
            {Math.round(summary.topPick.overallScore ?? 0)}/100
          </span>
        </div>
        <p className="text-xs text-white/70">{summary.topPick.statement}</p>
        {summary.topPick.strengths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {summary.topPick.strengths.map((s) => (
              <span
                key={s}
                className="rounded-full border border-emerald-400/20 bg-emerald-400/5 px-2 py-0.5 text-[10px] text-emerald-300"
              >
                {s}
              </span>
            ))}
          </div>
        )}
        {summary.topPick.weaknesses.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {summary.topPick.weaknesses.map((w) => (
              <span
                key={w}
                className="rounded-full border border-red-400/20 bg-red-400/5 px-2 py-0.5 text-[10px] text-red-300"
              >
                {w}
              </span>
            ))}
          </div>
        )}
      </div>

      {summary.alternatives.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            className="flex w-full items-center gap-1 text-xs text-white/50 hover:text-white/70"
            onClick={() => setShowAlternatives(!showAlternatives)}
          >
            {showAlternatives ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {summary.alternatives.length} alternative{summary.alternatives.length > 1 ? "s" : ""}
          </button>

          {showAlternatives && (
            <div className="mt-2 space-y-2">
              {summary.alternatives.map((alt) => (
                <AlternativeCard key={alt.vendorName} statement={alt} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AlternativeCard({ statement }: { statement: TradeoffStatement }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium text-white/80">{statement.vendorName}</span>
        <span className="ml-auto text-xs text-white/40">
          {Math.round(statement.overallScore ?? 0)}/100
        </span>
      </div>
      <p className="text-xs text-white/60">{statement.statement}</p>
      {statement.strengths.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {statement.strengths.map((s) => (
            <span
              key={s}
              className="rounded-full border border-emerald-400/15 bg-emerald-400/5 px-2 py-0.5 text-[10px] text-emerald-300/80"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
