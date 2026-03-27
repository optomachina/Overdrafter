import { CircleOff, TriangleAlert, X } from "lucide-react";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { Button } from "@/components/ui/button";
import { QuoteChart } from "@/components/workspace/QuoteChart";
import { filterVisibleQuoteOptions } from "@/features/quotes/selection";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { DrawingPreviewData, JobFileRecord, QuoteDataStatus } from "@/features/quotes/types";
import { cn } from "@/lib/utils";

function propertyValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "Not set";
  }

  return String(value);
}

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
    <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-4 py-5 text-sm text-white/55">
      <Icon className="h-4 w-4 text-white/35" />
      <p className="mt-3 font-medium text-white/80">{title}</p>
      <p className="mt-2">{body}</p>
    </div>
  );
}

type ProjectInspectorPanelProps = {
  className?: string;
  mode: "empty" | "detail";
  emptyTitle?: string;
  emptyBody?: string;
  title?: string;
  description?: string | null;
  partNumber?: string | number | null;
  revision?: string | number | null;
  material?: string | number | null;
  finish?: string | number | null;
  quantity?: string | number | null;
  statusLabel?: string;
  createdLabel?: string;
  projectName?: string;
  selectedQuoteLabel?: string;
  leadTimeLabel?: string;
  drawingFile?: JobFileRecord | null;
  drawingPreview?: DrawingPreviewData | null;
  cadFile?: JobFileRecord | null;
  quoteDataStatus?: QuoteDataStatus;
  quoteDataMessage?: string | null;
  quoteOptions?: ClientQuoteSelectionOption[];
  requestedByDate?: string | null;
  selectedOfferId?: string | null;
  quoteEmptyStateTitle?: string;
  quoteEmptyStateBody?: string;
  onSelectQuote?: (offerId: string | null) => void;
  onClear?: () => void;
};

export function ProjectInspectorPanel({
  className,
  mode,
  emptyTitle = "Project inspector",
  emptyBody = "Single-click a part row to inspect it here. Double-click opens the full part workspace, and `Escape` clears the selection.",
  title,
  description,
  partNumber,
  revision,
  material,
  finish,
  quantity,
  statusLabel,
  createdLabel,
  projectName = "Project",
  selectedQuoteLabel = "—",
  leadTimeLabel = "—",
  drawingFile = null,
  drawingPreview = null,
  cadFile = null,
  quoteDataStatus = "available",
  quoteDataMessage = null,
  quoteOptions = [],
  requestedByDate = null,
  selectedOfferId = null,
  quoteEmptyStateTitle = "No plottable quote offers are available for this part yet.",
  quoteEmptyStateBody = "",
  onSelectQuote,
  onClear,
}: ProjectInspectorPanelProps) {
  const visibleQuoteOptions = filterVisibleQuoteOptions(quoteOptions, requestedByDate);
  const deadlineFiltered = Boolean(requestedByDate) && quoteOptions.length > 0 && visibleQuoteOptions.length === 0;

  if (mode === "empty") {
    return (
      <div className={cn("space-y-4", className)}>
        <div className="rounded-lg border border-white/10 bg-black/20 p-5">
          <h2 className="text-lg font-semibold text-white">{emptyTitle}</h2>
          <p className="mt-2 text-sm text-white/55">{emptyBody}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="rounded-lg border border-white/10 bg-black/20 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-white">{title}</h2>
            {description ? (
              <p className="mt-1 line-clamp-2 text-xs text-white/45">{description}</p>
            ) : null}
          </div>
          {onClear ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full text-white/40 hover:bg-white/8 hover:text-white"
              onClick={onClear}
              aria-label="Clear selected part"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/8 bg-white/8">
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Part no.</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(partNumber)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Rev</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(revision)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Material</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(material)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Finish</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(finish)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Qty</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(quantity)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Status</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(statusLabel)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Created</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(createdLabel)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Project</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(projectName)}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Selected quote</p>
            <p className="mt-1 text-sm font-semibold text-white">{selectedQuoteLabel}</p>
          </div>
          <div className="bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Lead time</p>
            <p className="mt-1 text-sm font-semibold text-white">{leadTimeLabel}</p>
          </div>
          <div className="col-span-2 bg-black/40 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Due by</p>
            <p className="mt-1 text-sm font-medium text-white">{propertyValue(requestedByDate)}</p>
          </div>
        </div>
      </div>

      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
        className="rounded-lg"
      />

      <ClientCadPreviewPanel cadFile={cadFile} className="rounded-lg" />

      <section className="rounded-lg border border-white/10 bg-black/20 p-5">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quotes</p>
          <p className="mt-2 text-sm text-white/55">
            Compare vendor offers here and select the quote to keep without leaving the project ledger.
          </p>
        </div>
        <div className="mt-4">
          {quoteDataStatus === "schema_unavailable" ? (
            <QuoteStatusCard
              title="Quote comparison is unavailable"
              body={quoteDataMessage ?? "The quote workspace projection is unavailable in this environment."}
              tone="warning"
            />
          ) : quoteDataStatus === "invalid_for_plotting" ? (
            <QuoteStatusCard
              title="Quote rows were loaded but need review"
              body={quoteDataMessage ?? "Quote rows were loaded but could not be plotted."}
              tone="warning"
            />
          ) : visibleQuoteOptions.length > 0 ? (
            <QuoteChart
              quotes={visibleQuoteOptions}
              selectedOfferId={selectedOfferId}
              onSelect={onSelectQuote ?? (() => {})}
            />
          ) : deadlineFiltered ? (
            <div className="rounded-lg border border-white/8 bg-white/[0.03] px-4 py-5 text-sm text-white/45">
              <p className="font-medium text-white/80">No quotes meet the due date</p>
              <p className="mt-2">
                All current quote options arrive after {requestedByDate}. Adjust the project Due by date or use a
                part-level override if this line item can ship later.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-white/8 bg-white/[0.03] px-4 py-5 text-sm text-white/45">
              {quoteEmptyStateTitle}
              {quoteEmptyStateBody ? <p className="mt-2">{quoteEmptyStateBody}</p> : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
