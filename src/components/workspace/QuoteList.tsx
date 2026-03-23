import type { ReactNode } from "react";
import { CircleOff, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuotePreset, ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDataStatus, QuoteDiagnostics } from "@/features/quotes/types";
import type { VendorName } from "@/integrations/supabase/types";
import { getVendorColor } from "@/features/quotes/vendor-colors";
import { formatCurrency } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

type QuoteListProps = {
  quotes: ClientQuoteSelectionOption[];
  selectedOfferId: string | null;
  onSelect: (offerId: string | null) => void;
  requestedByDate?: string | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage?: string | null;
  quoteDiagnostics: QuoteDiagnostics;
  activePreset: QuotePreset | null;
  onPresetSelect: (preset: QuotePreset | null) => void;
  onToggleVendorExclusion: (vendorKey: VendorName, excluded: boolean) => void;
};

const PRESET_OPTIONS: Array<{ key: QuotePreset; label: string }> = [
  { key: "cheapest", label: "Cheapest" },
  { key: "fastest", label: "Fastest" },
  { key: "domestic", label: "Domestic" },
];

function QuoteStatusCard({
  title,
  body,
  tone = "neutral",
}: {
  title: string;
  body: string;
  tone?: "neutral" | "warning";
}) {
  const Icon = tone === "warning" ? TriangleAlert : CircleOff;

  return (
    <div className="rounded border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
      <Icon className="mx-auto h-5 w-5 text-white/35" />
      <p className="mt-3 text-sm font-medium text-white/80">{title}</p>
      <p className="mt-2 text-sm text-white/55">{body}</p>
    </div>
  );
}

function sortQuotes(quotes: ClientQuoteSelectionOption[]) {
  return [...quotes].sort((left, right) => {
    if (left.excluded !== right.excluded) {
      return left.excluded ? 1 : -1;
    }

    if (left.unitPriceUsd !== right.unitPriceUsd) {
      return left.unitPriceUsd - right.unitPriceUsd;
    }

    const leftLead = left.leadTimeBusinessDays ?? Number.POSITIVE_INFINITY;
    const rightLead = right.leadTimeBusinessDays ?? Number.POSITIVE_INFINITY;

    if (leftLead !== rightLead) {
      return leftLead - rightLead;
    }

    return left.vendorLabel.localeCompare(right.vendorLabel);
  });
}

export function QuoteList({
  quotes,
  selectedOfferId,
  onSelect,
  requestedByDate = null,
  quoteDataStatus,
  quoteDataMessage = null,
  quoteDiagnostics,
  activePreset,
  onPresetSelect,
  onToggleVendorExclusion,
}: QuoteListProps) {
  const sortedQuotes = sortQuotes(quotes);
  const visibleQuotes = sortedQuotes.filter((quote) => !quote.excluded);
  const comparisonQuotes = visibleQuotes.length > 0 ? visibleQuotes : sortedQuotes;
  const bestPrice =
    comparisonQuotes.length > 0 ? Math.min(...comparisonQuotes.map((quote) => quote.unitPriceUsd)) : null;
  const fastestLeadCandidates = comparisonQuotes
    .map((quote) => quote.leadTimeBusinessDays)
    .filter((value): value is number => value !== null);
  const fastestLead =
    fastestLeadCandidates.length > 0 ? Math.min(...fastestLeadCandidates) : null;

  let content: ReactNode;

  if (quoteDataStatus === "schema_unavailable") {
    content = (
      <QuoteStatusCard
        title="Quote comparison is unavailable"
        body={quoteDataMessage ?? "The quote workspace projection is unavailable in this environment."}
        tone="warning"
      />
    );
  } else if (quoteDataStatus === "invalid_for_plotting") {
    const reasonPreview = quoteDiagnostics.excludedReasonCounts
      .slice(0, 2)
      .map((entry) => `${entry.reason.replace(/_/g, " ")} (${entry.count})`)
      .join(", ");
    const statusBody = quoteDataMessage ?? (reasonPreview || "Quote rows were loaded but could not be plotted.");
    content = (
      <QuoteStatusCard
        title="Quote rows were loaded but need review"
        body={statusBody}
        tone="warning"
      />
    );
  } else if (sortedQuotes.length === 0) {
    content = (
      <QuoteStatusCard
        title="No quote options yet"
        body="Quote options will appear here once vendor offers are available."
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-2">
        {sortedQuotes.map((quote) => {
          const isSelected = quote.offerId === selectedOfferId;
          const isBestPrice = bestPrice !== null && quote.unitPriceUsd === bestPrice;
          const isFastest = fastestLead !== null && quote.leadTimeBusinessDays === fastestLead;

          return (
            <div
              key={quote.offerId}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${quote.vendorLabel} ${quote.offerId}`}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded border px-4 py-3.5 transition",
                isSelected
                  ? "border-white/25 bg-white/5"
                  : "border-ws-border-subtle bg-ws-card hover:border-white/12",
                quote.excluded && "opacity-55",
              )}
              onClick={() => onSelect(isSelected ? null : quote.offerId)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return;
                }

                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(isSelected ? null : quote.offerId);
                }
              }}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: getVendorColor(quote.vendorKey) }}
              />

              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-white">{quote.vendorLabel}</p>
                <p className="truncate text-[11px] text-white/45">
                  {[quote.tier, quote.sourcing].filter(Boolean).join(" · ") || "Standard"}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {isBestPrice ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                    Best {formatCurrency(quote.unitPriceUsd)}
                  </span>
                ) : null}
                {isFastest && quote.leadTimeBusinessDays !== null ? (
                  <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                    Fastest {quote.leadTimeBusinessDays} bd
                  </span>
                ) : null}
              </div>

              <div className="shrink-0 text-right">
                <p className="text-[20px] font-bold leading-none text-white">{formatCurrency(quote.unitPriceUsd)}</p>
                <p className="mt-0.5 text-[11px] text-white/45">
                  {quote.leadTimeBusinessDays !== null ? `${quote.leadTimeBusinessDays} bd` : "—"}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/55 hover:bg-transparent hover:text-white/80"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleVendorExclusion(quote.vendorKey, !quote.excluded);
                  }}
                >
                  {quote.excluded ? "Include" : "Exclude"}
                </Button>

                {isSelected ? (
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
                    Selected ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-medium text-white/55 transition hover:border-white/30 hover:text-white/80"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(quote.offerId);
                    }}
                  >
                    Select
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded border border-ws-border-subtle bg-ws-card p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/55">
          <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
          Presets
        </span>
        {PRESET_OPTIONS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            variant={activePreset === preset.key ? "default" : "outline"}
            className={cn(
              "h-7 rounded-full border-white/10 px-3 text-xs",
              activePreset === preset.key
                ? "bg-white text-black hover:bg-white/90"
                : "bg-transparent text-white hover:bg-white/6",
            )}
            onClick={() => onPresetSelect(activePreset === preset.key ? null : preset.key)}
          >
            {preset.label}
          </Button>
        ))}
        {requestedByDate ? (
          <span className="ml-auto text-[11px] text-white/40">Need-by {requestedByDate}</span>
        ) : null}
      </div>

      {content}
    </div>
  );
}

export type { QuoteListProps };
