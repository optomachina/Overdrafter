import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import type { ClientPartRequestUpdateInput, DrawingExtractionData, JobPartSummary, PartAggregate } from "@/features/quotes/types";

type PartInfoPanelProps = {
  part: PartAggregate | null | undefined;
  summary: JobPartSummary | null | undefined;
  extraction: DrawingExtractionData | null | undefined;
  effectiveRequestDraft: ClientPartRequestUpdateInput | null;
  quoteQuantityInput: string;
  onQuoteQuantityInputChange: (value: string) => void;
  onDraftChange: (next: Partial<ClientPartRequestUpdateInput>) => void;
  onSave: () => void;
  onUploadRevision: () => void;
  isSaving?: boolean;
  drawingFileName?: string | null;
  statusContent?: ReactNode;
  partNumber?: string | null;
  description?: string | null;
};

type InfoRow = {
  label: string;
  value: string;
};

function formatTolerance(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

  return `±${value.toFixed(4)} in`;
}

function formatTextValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildInfoRows(input: {
  part: PartAggregate | null | undefined;
  summary: JobPartSummary | null | undefined;
  extraction: DrawingExtractionData | null | undefined;
  draft: ClientPartRequestUpdateInput | null;
  partNumber?: string | null;
  description?: string | null;
}): InfoRow[] {
  const { part, summary, extraction, draft, partNumber, description } = input;

  return [
    {
      label: "Part Number",
      value: formatTextValue(draft?.partNumber) || formatTextValue(partNumber) || "—",
    },
    {
      label: "Description",
      value: formatTextValue(description) || "—",
    },
    {
      label: "Material",
      value: draft?.material?.trim() || part?.clientRequirement?.material || part?.approvedRequirement?.material || extraction?.material.normalized || extraction?.material.raw || "—",
    },
    {
      label: "Finish",
      value: draft?.finish?.trim() || part?.clientRequirement?.finish || part?.approvedRequirement?.finish || extraction?.quoteFinish || extraction?.finish.normalized || extraction?.finish.raw || "—",
    },
    {
      label: "Tolerance",
      value: formatTolerance(
        draft?.tightestToleranceInch ??
          part?.clientRequirement?.tightestToleranceInch ??
          part?.approvedRequirement?.tightest_tolerance_inch ??
          extraction?.tightestTolerance.valueInch ??
          null,
      ),
    },
    {
      label: "Quantity",
      value:
        draft?.requestedQuoteQuantities.length
          ? draft.requestedQuoteQuantities.join(" / ")
          : draft?.quantity
            ? String(draft.quantity)
            : summary?.quantity
              ? String(summary.quantity)
              : part?.quantity
                ? String(part.quantity)
                : "—",
    },
    {
      label: "Revision",
      value: draft?.revision?.trim() || summary?.revision || part?.approvedRequirement?.revision || extraction?.revision || "—",
    },
    {
      label: "Thread",
      value: "—",
    },
  ];
}

export function PartInfoPanel({
  part,
  summary,
  extraction,
  effectiveRequestDraft,
  quoteQuantityInput,
  onQuoteQuantityInputChange,
  onDraftChange,
  onSave,
  onUploadRevision,
  isSaving = false,
  drawingFileName = null,
  statusContent = null,
  partNumber = null,
  description = null,
}: PartInfoPanelProps) {
  const rows = buildInfoRows({
    part,
    summary,
    extraction,
    draft: effectiveRequestDraft,
    partNumber,
    description,
  });

  return (
    <div>
      <p className="mb-[6px] text-[9px] font-bold uppercase tracking-[0.14em] text-white/20">Part information</p>
      <section className="rounded-[12px] border border-ws-border-subtle bg-ws-card p-4">
        {statusContent ? <div className="mb-4 space-y-4">{statusContent}</div> : null}

        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-start justify-between gap-4 border-b border-white/[0.04] py-[7px] last:border-0">
              <span className="w-[44%] text-[12px] text-white/40">{row.label}</span>
              <span className="w-[56%] text-right text-[12px] font-medium text-white">{row.value}</span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11px] text-white/30">
          <FileText className="h-3.5 w-3.5" />
          <span>Source: drawing title block{drawingFileName ? ` · ${drawingFileName}` : ""}</span>
        </div>

        <div className="mt-5 border-t border-white/[0.06] pt-4">
          {effectiveRequestDraft ? (
            <ClientPartRequestEditor
              draft={effectiveRequestDraft}
              quoteQuantityInput={quoteQuantityInput}
              onQuoteQuantityInputChange={onQuoteQuantityInputChange}
              onChange={onDraftChange}
              onSave={onSave}
              onUploadRevision={onUploadRevision}
              isSaving={isSaving}
            />
          ) : (
            <p className="text-sm text-white/45">Part details are still loading.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type { PartInfoPanelProps };
