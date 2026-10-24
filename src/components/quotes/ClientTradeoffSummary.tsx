import { STATUS_TONE } from "@/components/quotes/status-tone";
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
    <div className={cn("rounded-surface-lg border border-border bg-muted p-4", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Star className={`h-4 w-4 ${STATUS_TONE.text}`} />
        <h3 className="text-sm font-semibold text-foreground">Routing Recommendation</h3>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">{summary.comparisonText}</p>

      <div className="rounded-lg border border-border bg-card p-3 text-foreground">
        <div className="mb-1 flex items-center gap-2">
          <Badge
            variant="default"
            className={STATUS_TONE.badge}
          >
            Recommended
          </Badge>
          <span className="text-sm font-medium text-foreground">{summary.topPick.vendorName}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {Math.round(summary.topPick.overallScore ?? 0)}/100
          </span>
        </div>
        <p className="text-xs text-foreground">{summary.topPick.statement}</p>
        {summary.topPick.strengths.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {summary.topPick.strengths.map((s) => (
              <span
                key={s}
                className={`px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}`}
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
                className={`px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}`}
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
            className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
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
    <div className="rounded-lg border border-border bg-accent p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{statement.vendorName}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {Math.round(statement.overallScore ?? 0)}/100
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{statement.statement}</p>
      {statement.strengths.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {statement.strengths.map((s) => (
            <span
              key={s}
              className={`px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}`}
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
