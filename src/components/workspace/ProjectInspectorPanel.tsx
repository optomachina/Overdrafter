import { useState } from "react";
import { X } from "lucide-react";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { ClientQuoteDecisionPanel } from "@/components/quotes/ClientQuoteDecisionPanel";
import { Button } from "@/components/ui/button";
import { filterVisibleQuoteOptions } from "@/features/quotes/selection";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type {
  DrawingExtractionData,
  DrawingPreviewData,
  JobFileRecord,
  QuoteDataStatus,
} from "@/features/quotes/types";
import { cn } from "@/lib/utils";

function propertyValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "Not set";
  }

  return String(value);
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
  geometryProjection?: DrawingExtractionData["geometryProjection"];
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
  geometryProjection = null,
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
  const [geometryOverlayEnabled, setGeometryOverlayEnabled] = useState(false);
  const [highlightedFeatureIds, setHighlightedFeatureIds] = useState<string[]>([]);
  const visibleQuoteOptions = filterVisibleQuoteOptions(quoteOptions, requestedByDate);
  const deadlineFiltered = Boolean(requestedByDate) && quoteOptions.length > 0 && visibleQuoteOptions.length === 0;
  const selectedOption =
    visibleQuoteOptions.find((option) => option.offerId === selectedOfferId) ??
    visibleQuoteOptions.find((option) => option.persistedOfferId === selectedOfferId) ??
    null;

  if (mode === "empty") {
    return (
      <div className={cn("space-y-4", className)}>
        <div className="rounded-lg border border-border bg-muted p-5">
          <h2 className="text-lg font-semibold text-foreground">{emptyTitle}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{emptyBody}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="rounded-lg border border-border bg-muted p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
            {description ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {onClear ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={onClear}
              aria-label="Clear selected part"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Part no.</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(partNumber)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Rev</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(revision)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Material</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(material)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Finish</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(finish)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Qty</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(quantity)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Status</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(statusLabel)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Created</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(createdLabel)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Project</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(projectName)}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Selected quote</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{selectedQuoteLabel}</p>
          </div>
          <div className="bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Lead time</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{leadTimeLabel}</p>
          </div>
          <div className="col-span-2 bg-ws-inset px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Due by</p>
            <p className="mt-1 text-sm font-medium text-foreground">{propertyValue(requestedByDate)}</p>
          </div>
        </div>
      </div>

      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
        className="rounded-lg"
      />

      <section className="space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Geometry overlay</span>
          <Button
            type="button"
            variant="ghost"
            className="h-7 rounded-full border border-border px-3 text-xs text-foreground hover:bg-accent"
            onClick={() => setGeometryOverlayEnabled((current) => !current)}
          >
            {geometryOverlayEnabled ? "On" : "Off"}
          </Button>
        </div>
        <ClientCadPreviewPanel
          cadFile={cadFile}
          geometryProjection={geometryProjection}
          overlayEnabled={geometryOverlayEnabled}
          selectedFeatureIds={highlightedFeatureIds}
          onSelectFeature={(featureId) => setHighlightedFeatureIds([featureId])}
          className="rounded-lg"
        />
      </section>

      <section className="rounded-lg border border-border bg-muted p-5">
        <ClientQuoteDecisionPanel
          title="Quotes"
          description="Compare vendor offers here and select the quote to keep without leaving the project ledger."
          options={visibleQuoteOptions}
          selectedOption={selectedOption}
          onSelect={onSelectQuote ? (option) => onSelectQuote(option.offerId) : () => {}}
          requestedByDate={requestedByDate}
          quoteDataStatus={quoteDataStatus}
          quoteDataMessage={quoteDataMessage}
          layout="compact"
          emptyState={
            deadlineFiltered
              ? `No quotes meet the due date. All current quote options arrive after ${requestedByDate}. Adjust the project Due by date or use a part-level override if this line item can ship later.`
              : quoteEmptyStateBody
                ? `${quoteEmptyStateTitle} ${quoteEmptyStateBody}`
                : quoteEmptyStateTitle
          }
        />
      </section>
    </div>
  );
}
