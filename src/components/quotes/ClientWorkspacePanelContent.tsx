import { MessageSquareLock, Sparkles } from "lucide-react";
import { ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ClientQuoteRequestStatus,
  DrawingExtractionData,
  JobPartSummary,
  PartAggregate,
  QuoteRequestRecord,
  QuoteRunRecord,
} from "@/features/quotes/types";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

type ClientQuoteRequestStatusCardProps = {
  status: ClientQuoteRequestStatus;
  tone: "ready" | "warning" | "danger" | "blocked";
  label: string;
  detail: string;
  actionLabel?: string | null;
  actionDisabled?: boolean;
  blockerReasons?: string[];
  isBusy?: boolean;
  onAction?: (() => void) | null;
  className?: string;
};

type MetadataValue = {
  label: string;
  value: string;
  tone?: "default" | "muted";
};

function MetadataGroup({
  title,
  values,
}: {
  title: string;
  values: MetadataValue[];
}) {
  return (
    <div className="rounded-[22px] border border-white/8 bg-black/20 p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">{title}</p>
      <dl className="mt-3 space-y-3">
        {values.map((entry) => (
          <div key={entry.label} className="flex items-start justify-between gap-4">
            <dt className="text-xs text-white/45">{entry.label}</dt>
            <dd className={cn("max-w-[60%] text-right text-sm text-white", entry.tone === "muted" && "text-white/45")}>
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatMaybeString(value: string | null | undefined, fallback = "Not available") {
  return value && value.trim().length > 0 ? value : fallback;
}

function formatMaybeNumber(value: number | null | undefined, fallback = "Not available") {
  return value === null || value === undefined || Number.isNaN(value) ? fallback : String(value);
}

export function ClientQuoteRequestStatusCard({
  status,
  tone,
  label,
  detail,
  actionLabel,
  actionDisabled = false,
  blockerReasons = [],
  isBusy = false,
  onAction,
  className,
}: ClientQuoteRequestStatusCardProps) {
  const isActionUnavailable = isBusy || actionDisabled;

  return (
    <section
      className={cn(
        "rounded-[24px] border p-4",
        tone === "ready"
          ? "border-emerald-400/20 bg-emerald-500/8"
          : tone === "warning"
            ? "border-amber-400/20 bg-amber-500/8"
            : "border-rose-400/20 bg-rose-500/8",
        className,
      )}
    >
      <div className="flex flex-col gap-3">
        <div aria-live="polite" aria-atomic="true" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ClientWorkspaceToneBadge
              tone={tone === "danger" ? "blocked" : tone}
              label={`Quote ${label}`}
              className="tracking-normal normal-case"
            />
            <p className="text-sm font-medium text-white">Xometry request status</p>
          </div>
          {status === "failed" ? (
            <p role="alert" className="text-sm text-white/75">{detail}</p>
          ) : (
            <p className="text-sm text-white/75">{detail}</p>
          )}
        </div>
        {onAction && actionLabel ? (
          <div>
            <Button
              type="button"
              className="rounded-full"
              disabled={isActionUnavailable}
              aria-disabled={isActionUnavailable ? "true" : undefined}
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
      {blockerReasons.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {blockerReasons.map((reason) => (
            <Badge key={reason} className="border border-white/10 bg-black/20 text-white/75">
              {reason}
            </Badge>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ClientMetadataPanel({
  summary,
  part,
  extraction,
  quoteOptions,
}: {
  summary: JobPartSummary | null;
  part: PartAggregate | null;
  extraction: DrawingExtractionData | null;
  quoteOptions: readonly ClientQuoteSelectionOption[];
}) {
  const approved = part?.approvedRequirement ?? null;
  const liveDfmSignalCount = quoteOptions.reduce((count, option) => count + (option.notes ? 1 : 0), 0);

  return (
    <div className="space-y-4">
      <MetadataGroup
        title="Part definition"
        values={[
          { label: "Part number", value: formatMaybeString(summary?.partNumber ?? approved?.part_number) },
          { label: "Revision", value: formatMaybeString(summary?.revision ?? approved?.revision) },
          { label: "Description", value: formatMaybeString(summary?.description ?? approved?.description) },
          { label: "Quantity", value: formatMaybeNumber(summary?.quantity ?? approved?.quantity) },
          {
            label: "Quote quantities",
            value: (summary?.requestedQuoteQuantities ?? approved?.quote_quantities ?? []).length > 0
              ? (summary?.requestedQuoteQuantities ?? approved?.quote_quantities ?? []).join(", ")
              : "Not available",
          },
          {
            label: "Need by",
            value: formatMaybeString(summary?.requestedByDate ?? approved?.requested_by_date),
          },
        ]}
      />

      <MetadataGroup
        title="Manufacturing details"
        values={[
          { label: "Material", value: formatMaybeString(approved?.material ?? extraction?.material.normalized ?? extraction?.material.raw) },
          { label: "Finish", value: formatMaybeString(approved?.finish ?? extraction?.finish.normalized ?? extraction?.finish.raw) },
          {
            label: "Process",
            value: formatMaybeString(
              typeof approved?.spec_snapshot === "object" && approved?.spec_snapshot && "process" in approved.spec_snapshot
                ? String((approved.spec_snapshot as Record<string, unknown>).process ?? "")
                : null,
            ),
          },
          {
            label: "Tightest tolerance",
            value: approved?.tightest_tolerance_inch !== null && approved?.tightest_tolerance_inch !== undefined
              ? `${approved.tightest_tolerance_inch} in`
              : extraction?.tightestTolerance.raw ?? "Not available",
          },
          { label: "CAD file", value: part?.cadFile?.original_name ?? "Missing", tone: part?.cadFile ? "default" : "muted" },
          { label: "Drawing file", value: part?.drawingFile?.original_name ?? "Missing", tone: part?.drawingFile ? "default" : "muted" },
        ]}
      />

      <MetadataGroup
        title="Extraction signals"
        values={[
          { label: "Extraction status", value: extraction ? formatStatusLabel(extraction.status) : "Pending extraction" },
          { label: "Warnings", value: extraction?.warnings.length ? String(extraction.warnings.length) : "0" },
          { label: "Evidence snippets", value: extraction?.evidence.length ? String(extraction.evidence.length) : "0" },
          { label: "Live DFM notes", value: String(liveDfmSignalCount) },
          {
            label: "Future metadata",
            value: "Placeholder for revision-control and release-gate signals",
            tone: "muted",
          },
        ]}
      />
    </div>
  );
}

export function ClientDfmPanel({
  quoteOptions,
}: {
  quoteOptions: readonly ClientQuoteSelectionOption[];
}) {
  const dfmNotes = quoteOptions
    .flatMap((option) =>
      (option.notes ?? "")
        .split("\n")
        .map((note) => note.trim())
        .filter(Boolean)
        .map((note) => ({ option, note })),
    )
    .slice(0, 6);

  return (
    <div className="space-y-4">
      <section className="rounded-[22px] border border-white/8 bg-black/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-white">Design-for-manufacturing signals</p>
            <p className="mt-2 text-sm text-white/55">
              Future vendor and internal DFM summaries can drop into this panel without changing the surrounding workspace.
            </p>
          </div>
          <Sparkles className="h-4 w-4 text-white/45" />
        </div>
      </section>

      {dfmNotes.length > 0 ? (
        <div className="space-y-3">
          {dfmNotes.map(({ option, note }, index) => (
            <section key={`${option.key}:${index}`} className="rounded-[22px] border border-white/8 bg-black/20 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-white/10 bg-white/6 text-white/70">{option.vendorLabel}</Badge>
                <Badge className="border border-white/10 bg-white/6 text-white/70">Qty {option.requestedQuantity}</Badge>
              </div>
              <p className="mt-3 text-sm text-white/70">{note}</p>
            </section>
          ))}
        </div>
      ) : (
        <section className="rounded-[22px] border border-dashed border-white/10 bg-black/20 p-5">
          <p className="text-sm font-medium text-white">No DFM issues surfaced yet</p>
          <p className="mt-2 text-sm text-white/50">
            TODO: drop normalized vendor DFM findings and internal review cues into this card when those client-safe signals are available.
          </p>
        </section>
      )}
    </div>
  );
}

export function ClientReadOnlyChatPanel({
  partLabel,
  latestQuoteRequest,
  latestQuoteRun,
}: {
  partLabel: string;
  latestQuoteRequest: QuoteRequestRecord | null;
  latestQuoteRun: QuoteRunRecord | null;
}) {
  const prompts = [
    `Summarize the current quote status for ${partLabel}.`,
    `What artifact is still missing for ${partLabel}?`,
    `Explain the current revision and requested quantities.`,
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-[22px] border border-white/8 bg-black/20 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-white">Ask about this part</p>
            <p className="mt-2 text-sm text-white/55">
              Chat is contextual here, not the primary workspace. This read-only tab shows the kinds of questions the future assistant surface should answer.
            </p>
          </div>
          <MessageSquareLock className="h-4 w-4 text-white/45" />
        </div>
      </section>

      <section className="rounded-[22px] border border-white/8 bg-black/20 p-4">
        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Suggested prompts</p>
        <div className="mt-3 space-y-2">
          {prompts.map((prompt) => (
            <div key={prompt} className="rounded-2xl border border-white/8 bg-[#202020] px-4 py-3 text-sm text-white/70">
              {prompt}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[22px] border border-white/8 bg-black/20 p-4">
        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Current context</p>
        <div className="mt-3 space-y-2 text-sm text-white/60">
          <p>Latest request: {latestQuoteRequest ? formatStatusLabel(latestQuoteRequest.status) : "Not requested"}</p>
          <p>Latest run: {latestQuoteRun ? formatStatusLabel(latestQuoteRun.status) : "No run yet"}</p>
        </div>
      </section>
    </div>
  );
}
