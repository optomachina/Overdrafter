import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleOff,
  Clock,
  Loader2,
  SlidersHorizontal,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";

const ClientQuoteComparisonChart = lazy(() =>
  import("@/components/quotes/ClientQuoteComparisonChart").then((m) => ({
    default: m.ClientQuoteComparisonChart,
  })),
);
import { ProviderNotes } from "@/components/quotes/ProviderNotes";
import { isQuoteProviderNotesEnabled } from "@/lib/quote-provider-notes-flag";
import { QuoteStatsBar } from "@/components/quotes/QuoteStatsBar";
import { VendorPurchasingLinkButton } from "@/components/quotes/VendorPurchasingLinkButton";
import { ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getClientQuoteOptionStateReasons,
} from "@/features/quotes/client-workspace-state";
import {
  buildDeliveredComparisonModel,
  countDeadlineStatuses,
  type DeadlineStatusCounts,
  formatCivilDate,
  formatUnknownCostComponents,
  getDeadlineStatus,
  resolveQuoteRequestCompletion,
  sortDeliveredComparisonRows,
  type DeadlineStatus,
  type DeliveredComparisonMode,
  type DeliveredComparisonRow,
  type QuoteRequestCompletionInput,
  type QuoteRequestCompletionNotice,
} from "@/features/quotes/delivered-comparison";
import type { PartDeadlineState } from "@/features/quotes/api/part-deadline-api";
import type {
  ClientQuoteSelectionOption,
  QuotePreset,
  QuotePresetScope,
} from "@/features/quotes/selection";
import {
  formatQuotePlotExclusionReason,
  filterQuoteOptionsForScope,
  getPresetScope,
  getPresetMode,
} from "@/features/quotes/selection";
import { getVendorColor } from "@/features/quotes/vendor-colors";
import type { QuoteDataStatus, QuoteDiagnostics } from "@/features/quotes/types";
import { formatCurrency } from "@/features/quotes/utils";
import { resolveVendorPurchasingLink } from "@/features/quotes/vendor-purchasing-links";
import { cn } from "@/lib/utils";

type ClientQuoteDecisionPanelProps = {
  title?: string;
  description?: string;
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  /** The stored choice no longer resolves to a selectable option, so nothing is selected. */
  previousSelectionUnavailable?: boolean;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  requestedByDate: string | null;
  quoteDataStatus?: QuoteDataStatus;
  quoteDataMessage?: string | null;
  quoteDiagnostics?: QuoteDiagnostics | null;
  partId?: string | null;
  organizationId?: string | null;
  activePreset?: QuotePreset | null;
  onPresetSelect?: (preset: QuotePreset) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
  controls?: ReactNode | ((counts: DeadlineStatusCounts, deadline: string | null) => ReactNode);
  onScopeChange?: (scope: QuotePresetScope) => void;
  layout?: "full" | "compact";
  headerActions?: ReactNode;
  emptyState?: string;
  className?: string;
  /** Persisted part deadline intent (OVD-570); falls back to `requestedByDate` when absent. */
  deadline?: { date: string | null; state: PartDeadlineState } | null;
  /** Active request and run context for the bounded completion notice. */
  requestCompletion?: QuoteRequestCompletionInput | null;
  /** Hypothetical order instant and calendar zone for delivered-date projection. */
  now?: Date;
  timeZone?: string;
};

function formatGeographicOrigin(origin: ClientQuoteSelectionOption["geographicOrigin"]) {
  if (origin === "domestic") return "US";
  if (origin === "foreign") return "International";
  return "Unknown";
}

function getVendorStatusDisplay(status: string | undefined) {
  if (!status) return null;

  switch (status) {
    case "queued":
      return { icon: Clock, label: "Pending", color: "text-muted-foreground", bg: "bg-accent" };
    case "running":
      return { icon: Loader2, label: "Fetching...", color: "text-amber-400", bg: "bg-amber-500/10", animate: true };
    case "instant_quote_received":
    case "official_quote_received":
      return null; // Normal state, no indicator needed
    case "failed":
      return { icon: XCircle, label: "Failed", color: "text-red-400", bg: "bg-red-500/10" };
    case "manual_review_pending":
      return { icon: AlertCircle, label: "Review", color: "text-amber-400", bg: "bg-amber-500/10" };
    case "manual_vendor_followup":
      return { icon: AlertCircle, label: "Follow-up", color: "text-orange-400", bg: "bg-orange-500/10" };
    case "stale":
      return { icon: Clock, label: "Stale", color: "text-muted-foreground", bg: "bg-accent" };
    default:
      return null;
  }
}

function VendorStatusBadge({
  status,
  variant = "dense",
}: Readonly<{
  status: string | undefined;
  variant?: "dense" | "mobile";
}>) {
  const statusInfo = getVendorStatusDisplay(status);

  if (!statusInfo) {
    return null;
  }

  const Icon = statusInfo.icon;
  const badgeClassName =
    variant === "mobile" ? "border px-2 py-1 text-xs" : "h-4 border px-1 text-[9px]";
  const iconClassName = variant === "mobile" ? "mr-1 h-3 w-3" : "mr-0.5 h-3 w-3";

  return (
    <Badge className={cn(badgeClassName, statusInfo.bg, "border-border", statusInfo.color)}>
      <Icon className={cn(iconClassName, statusInfo.animate && "animate-spin")} />
      {statusInfo.label}
    </Badge>
  );
}

function QuoteDataStatusCard({
  icon: Icon,
  title,
  body,
  diagnostics,
}: {
  icon: typeof CircleOff;
  title: string;
  body: string;
  diagnostics?: QuoteDiagnostics | null;
}) {
  return (
    <div className="mt-4 rounded-surface-lg border border-dashed border-border bg-muted px-4 py-8 text-center">
      <Icon className="mx-auto h-5 w-5 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground/80">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {diagnostics && diagnostics.excludedReasonCounts.length > 0 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {diagnostics.excludedReasonCounts.slice(0, 3).map((entry) => (
            <span
              key={entry.reason}
              className="rounded-full border border-border bg-accent px-3 py-1 text-[11px] text-muted-foreground"
            >
              {formatQuotePlotExclusionReason(entry.reason)}: {entry.count}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PRESET_OPTIONS: Array<{ key: QuotePreset; label: string }> = [
  { key: "cheapest", label: "Cheapest" },
  { key: "fastest", label: "Fastest" },
  { key: "domestic", label: "Domestic" },
];

function PanelHeader({
  title,
  description,
  headerActions,
  controls,
  activePreset,
  onPresetSelect,
}: {
  title: string;
  description: string;
  headerActions: ReactNode;
  controls: ReactNode;
  activePreset: QuotePreset | null;
  onPresetSelect?: (preset: QuotePreset) => void;
}) {
  const showLegacyPresets = !controls && onPresetSelect;

  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
          <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
        {headerActions}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {controls ? (
          <div className="min-w-0 flex-1">{controls}</div>
        ) : null}

        {showLegacyPresets ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
              <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
              Presets
            </div>
            {PRESET_OPTIONS.map((preset) => (
              <Button
                key={preset.key}
                type="button"
                variant={activePreset === preset.key ? "default" : "outline"}
                className={cn(
                  "h-7 rounded-full border-border px-3 text-xs",
                  activePreset === preset.key
                    ? "bg-primary text-primary-foreground hover:bg-accent"
                    : "bg-transparent text-foreground hover:bg-accent",
                )}
                onClick={() => onPresetSelect(preset.key)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        ) : null}

      </div>
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "Unavailable";
  }

  const normalizedValue = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00`
    : value;
  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleDateString();
}

function SelectedOptionSummary({
  option,
  row,
}: Readonly<{ option: ClientQuoteSelectionOption; row: DeliveredComparisonRow | null }>) {
  const collectedAt = option.offerCreatedAt ?? option.quoteResultUpdatedAt;
  const collectedRecently = collectedAt
    ? Date.now() - new Date(collectedAt).getTime() <= 14 * 24 * 60 * 60 * 1000
    : false;
  const validityLabel = option.validUntil
    ? `Valid through ${formatDate(option.validUntil)}`
    : "Validity not provided";

  return (
    <div className="border-l-2 border-[var(--accent-red)] bg-ws-inset px-4 py-3" data-testid="selected-option-summary">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Current selection
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-6">
        <SummaryFact label="Vendor" value={option.vendorLabel} />
        <SummaryFact label="Expected delivered cost" value={row ? formatOtdText(row) : formatCurrency(option.totalPriceUsd)} />
        <SummaryFact label="Delivered by" value={row ? formatArrivalText(row) : "Arrival unknown"} />
        <SummaryFact label="Quantity" value={String(option.requestedQuantity)} />
        <SummaryFact label="Sourcing" value={formatGeographicOrigin(option.geographicOrigin)} />
        <SummaryFact
          label="Quote status"
          value={`${collectedRecently ? "Recently collected" : "Previously collected"} · ${validityLabel}`}
        />
      </dl>
      {isQuoteProviderNotesEnabled() ? <ProviderNotes notes={option.providerNotes} /> : null}
      <details className="mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Response source facts
        </summary>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryFact label="Quote date" value={formatDate(option.quoteDateIso)} />
          <SummaryFact label="Valid through" value={formatDate(option.validUntil)} />
          <SummaryFact label="Quoted total" value={formatCurrency(option.totalPriceUsd)} />
          <SummaryFact
            label="Ready to ship"
            value={option.leadTimeBusinessDays === null ? "Not quoted" : `${option.leadTimeBusinessDays} working days`}
          />
          <SummaryFact label="Process" value={option.process ?? "Unavailable"} />
          <SummaryFact label="Material" value={option.material ?? "Unavailable"} />
        </dl>
        <VendorPurchasingLinkButton option={option} className="mt-3" />
      </details>
    </div>
  );
}

function SummaryFact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function formatArrivalText(row: DeliveredComparisonRow): string {
  if (row.arrival.kind === "arrival") {
    return formatCivilDate(row.arrival.date);
  }
  if (row.arrival.kind === "ships_by") {
    return `After ${formatCivilDate(row.arrival.shipDate)}`;
  }
  return "Arrival unknown";
}

function formatOtdText(row: DeliveredComparisonRow): string {
  if (row.otd.kind === "complete") {
    return formatCurrency(row.otd.amountUsd);
  }
  if (row.otd.kind === "partial") {
    return `≥ ${formatCurrency(row.otd.knownAmountUsd)}`;
  }
  return "Unknown";
}

function ProvenanceNote({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="mt-0.5 block font-sans text-[10px] font-normal text-muted-foreground">{children}</span>;
}

function DeliveredArrivalCell({ row }: Readonly<{ row: DeliveredComparisonRow }>) {
  if (row.arrival.kind === "arrival") {
    return (
      <>
        <span>{formatCivilDate(row.arrival.date)}</span>
        <ProvenanceNote>{row.arrival.provenance === "estimated" ? "Estimated" : "Provider date"}</ProvenanceNote>
      </>
    );
  }
  if (row.arrival.kind === "ships_by") {
    return (
      <>
        <span>After {formatCivilDate(row.arrival.shipDate)}</span>
        <ProvenanceNote>Ships then; transit not quoted</ProvenanceNote>
      </>
    );
  }
  return <span className="italic text-muted-foreground">Arrival unknown</span>;
}

function DeliveredOtdCell({ row }: Readonly<{ row: DeliveredComparisonRow }>) {
  if (row.otd.kind === "complete") {
    return (
      <>
        <span>{formatCurrency(row.otd.amountUsd)}</span>
        {row.otd.provenance === "estimated" ? <ProvenanceNote>Estimated</ProvenanceNote> : null}
      </>
    );
  }
  if (row.otd.kind === "partial") {
    return (
      <>
        <span>≥ {formatCurrency(row.otd.knownAmountUsd)}</span>
        <ProvenanceNote>{formatUnknownCostComponents(row.otd.unknownComponents)} not quoted</ProvenanceNote>
      </>
    );
  }
  return <span className="italic text-muted-foreground">Unknown</span>;
}

const DEADLINE_STATUS_LABELS: Partial<Record<DeadlineStatus, string>> = {
  late: "Misses deadline",
  unconfirmed: "May miss deadline",
};

function ProviderSwatch({ option }: Readonly<{ option: ClientQuoteSelectionOption }>) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: getVendorColor(option.vendorKey) }}
    />
  );
}

function QuoteProviderCell({
  option,
  deadlineStatus,
  reasons,
}: Readonly<{
  option: ClientQuoteSelectionOption;
  deadlineStatus: DeadlineStatus;
  reasons: ReturnType<typeof getClientQuoteOptionStateReasons>;
}>) {
  const deadlineLabel = DEADLINE_STATUS_LABELS[deadlineStatus];

  return (
    <TableCell className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderSwatch option={option} />
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{option.vendorLabel}</span>
            {option.excluded ? (
              <Badge className="h-4 border border-border bg-accent px-1 text-[9px] text-muted-foreground">Excl</Badge>
            ) : null}
            <VendorStatusBadge status={option.vendorStatus} />
          </div>
          {deadlineLabel || reasons.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {deadlineLabel ? (
                <span className="rounded-[2px] border border-border px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                  {deadlineLabel}
                </span>
              ) : null}
              {reasons.map((reason) => (
                <ClientWorkspaceToneBadge
                  key={`${option.key}:${reason.id}`}
                  tone={reason.tone}
                  label={reason.label}
                  className="h-4 text-[9px] tracking-normal normal-case"
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </TableCell>
  );
}

function QuoteScopeCell({ option }: Readonly<{ option: ClientQuoteSelectionOption }>) {
  return (
    <TableCell className="px-3 py-2.5 text-xs text-muted-foreground">
      <p>{option.laneLabel ?? option.tier ?? "Standard"}</p>
      <Badge className="mt-1 h-4 border border-border bg-transparent px-1 text-[9px] text-muted-foreground">
        {formatGeographicOrigin(option.geographicOrigin)}
      </Badge>
      {option.geographicOrigin !== "unknown" && option.sourcing ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{option.sourcing}</p>
      ) : null}
    </TableCell>
  );
}

function QuoteComparisonRow({
  row,
  deadlineStatus,
  selected,
  hovered,
  activePreset,
  onSelect,
  onHover,
  onFocusKey,
  onToggleVendorExclusion,
}: Readonly<{
  row: DeliveredComparisonRow;
  deadlineStatus: DeadlineStatus;
  selected: boolean;
  hovered: boolean;
  activePreset: QuotePreset | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  onFocusKey: (key: string | null) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}>) {
  const { option } = row;
  // Deadline fit comes from the delivered projection, not the legacy ready-to-ship estimate.
  const reasons = getClientQuoteOptionStateReasons({ option, requestedByDate: null, preset: activePreset });
  const selectOption = () => {
    if (option.isSelectable) onSelect(option);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (!option.isSelectable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect(option);
  };

  return (
    <TableRow
      tabIndex={0}
      aria-selected={selected}
      aria-disabled={option.isSelectable ? undefined : true}
      data-quote-key={option.key}
      data-deadline-status={deadlineStatus}
      className={cn(
        "border-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
        option.isSelectable && "cursor-pointer",
        selected && "border-l-2 border-l-[var(--accent-red)] bg-ws-inset",
        !selected && hovered && "bg-accent",
        !selected && !hovered && "hover:bg-accent",
        (deadlineStatus === "late" || !option.isSelectable) && "opacity-60",
        !option.isSelectable && "cursor-not-allowed",
      )}
      onClick={selectOption}
      onMouseEnter={() => onHover(option.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => {
        onHover(option.key);
        onFocusKey(option.key);
      }}
      onBlur={() => {
        onHover(null);
        onFocusKey(null);
      }}
      onKeyDown={handleKeyDown}
    >
      <QuoteProviderCell option={option} deadlineStatus={deadlineStatus} reasons={reasons} />
      <QuoteScopeCell option={option} />
      <TableCell className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-foreground/80">
        {formatCurrency(option.unitPriceUsd)}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right font-mono text-xs font-semibold tabular-nums text-foreground">
        <DeliveredOtdCell row={row} />
        {onToggleVendorExclusion ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto mt-0.5 block h-auto p-0 text-[10px] text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggleVendorExclusion(option.vendorKey, !option.excluded);
            }}
          >
            {option.excluded ? "Include" : "Exclude"}
          </Button>
        ) : null}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-foreground/80">
        <DeliveredArrivalCell row={row} />
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right">
        <VendorPurchasingLinkButton option={option} label="Open" />
      </TableCell>
    </TableRow>
  );
}

function findScrollContainer(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement ?? document.documentElement;
}

const TABLE_MODES: ReadonlyArray<{ key: DeliveredComparisonMode; label: string }> = [
  { key: "cheapest", label: "Cheapest" },
  { key: "fastest", label: "Fastest" },
];

function TableModeControl({
  mode,
  onChange,
}: Readonly<{ mode: DeliveredComparisonMode; onChange: (mode: DeliveredComparisonMode) => void }>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  // ARIA radiogroup pattern: the checked radio is the tab stop; arrows move and select.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = mode === "cheapest" ? "fastest" : "cheapest";
    onChange(next);
    buttons.current[TABLE_MODES.findIndex((entry) => entry.key === next)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Table order"
      className="inline-flex w-fit rounded-[2px] border border-border"
    >
      {TABLE_MODES.map((entry, index) => (
        <button
          key={entry.key}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={mode === entry.key}
          tabIndex={mode === entry.key ? 0 : -1}
          className={cn(
            "min-h-8 border-r border-border px-3 text-xs font-medium outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
            mode === entry.key ? "bg-primary text-primary-foreground" : "bg-ws-card text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(entry.key)}
          onKeyDown={handleKeyDown}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function QuoteComparisonTable({
  rows,
  deadline,
  excludedOffers,
  selectedOption,
  hoveredKey,
  onSelect,
  onHover,
  activePreset,
  onToggleVendorExclusion,
  layoutKey = "",
}: Readonly<{
  rows: readonly DeliveredComparisonRow[];
  layoutKey?: string;
  deadline: string | null;
  excludedOffers: QuoteDiagnostics["excludedOffers"];
  selectedOption: ClientQuoteSelectionOption | null;
  hoveredKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  activePreset: QuotePreset | null;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}>) {
  const tableRef = useRef<HTMLDivElement>(null);
  const focusedKeyRef = useRef<string | null>(null);
  const rowOrder = rows.map((row) => row.key).join("|");
  const selectedKey = selectedOption?.key ?? null;

  const findRow = (key: string) =>
    [...(tableRef.current?.querySelectorAll<HTMLElement>("tr[data-quote-key]") ?? [])]
      .find((element) => element.dataset.quoteKey === key) ?? null;

  // Reordering on arrival can detach the focused row; restore focus without scrolling.
  useLayoutEffect(() => {
    const key = focusedKeyRef.current;
    const container = tableRef.current;
    if (!key || !container || container.contains(document.activeElement)) {
      return;
    }
    findRow(key)?.focus({ preventScroll: true });
  }, [rowOrder]);

  // Keep the focused (or selected) row at the same viewport position when an
  // arrival inserts rows or content above it. The position is read during
  // render, before React commits the new DOM, so user scrolling is never undone.
  // Only arrivals re-anchor. Reorders and selection changes the user makes
  // (table order, deadline, picking a row) never scroll the page under them.
  const anchorKey = focusedKeyRef.current ?? selectedKey;
  const preCommitTop = anchorKey ? findRow(anchorKey)?.getBoundingClientRect().top ?? null : null;
  useLayoutEffect(() => {
    const element = anchorKey ? findRow(anchorKey) : null;
    if (!element || preCommitTop === null) {
      return;
    }
    const delta = element.getBoundingClientRect().top - preCommitTop;
    if (Math.abs(delta) >= 1) {
      findScrollContainer(element).scrollBy?.({ top: delta, behavior: "instant" as ScrollBehavior });
    }
    // Only arrivals (new options or the arrival notice above) re-anchor; hover renders never move the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const handleFocusKey = (key: string | null) => {
    if (key !== null) {
      focusedKeyRef.current = key;
      return;
    }
    // Defer clearing so a blur caused by a DOM move does not forget the focused row.
    queueMicrotask(() => {
      if (!tableRef.current?.contains(document.activeElement)) {
        focusedKeyRef.current = null;
      }
    });
  };

  return (
    <div ref={tableRef} className="border border-border bg-ws-card" data-testid="quote-vendor-table">
      <Table className="min-w-[680px] text-foreground">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="h-9 px-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Vendor</TableHead>
            <TableHead className="h-9 px-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Scope</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Unit</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Expected delivered cost</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Delivered by</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <QuoteComparisonRow
              key={row.key}
              row={row}
              deadlineStatus={getDeadlineStatus(row, deadline)}
              selected={selectedOption?.key === row.key}
              hovered={hoveredKey === row.key}
              activePreset={activePreset}
              onSelect={onSelect}
              onHover={onHover}
              onFocusKey={handleFocusKey}
              onToggleVendorExclusion={onToggleVendorExclusion}
            />
          ))}
          {excludedOffers.map((offer, index) => (
            <TableRow
              key={`${offer.vendorQuoteResultId}:${offer.offerId ?? index}`}
              aria-disabled="true"
              className="border-border bg-muted/30 text-muted-foreground"
            >
              <TableCell className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span className="text-sm font-medium text-foreground/80">
                    {offer.supplier ?? offer.vendorKey}
                  </span>
                </div>
              </TableCell>
              <TableCell className="max-w-64 px-3 py-2.5 text-xs text-muted-foreground">
                <p>{offer.laneLabel ?? "Noncomparable response"}</p>
                <p className="mt-0.5 text-[10px]">
                  {offer.reasons.map(formatQuotePlotExclusionReason).join(" · ")}
                </p>
              </TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-xs">Unavailable</TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-xs">Unavailable</TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-xs">Unavailable</TableCell>
              <TableCell className="px-3 py-2.5 text-right font-mono text-xs">Unavailable</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function UnplottedOptionsList({
  rows,
  selectedKey,
  onSelect,
  onHover,
}: Readonly<{
  rows: readonly DeliveredComparisonRow[];
  selectedKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
}>) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 border-t border-dashed border-border px-1 pt-2">
      <p id="quote-unplotted-heading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Not plotted: delivered date or cost unknown ({rows.length})
      </p>
      <ul aria-labelledby="quote-unplotted-heading" className="mt-1.5 flex flex-wrap gap-1.5">
        {rows.map((row) => {
          const reason = row.notPlottedReason === "otd_unknown" ? "cost unknown" : "arrival unknown";
          return (
            <li key={row.key}>
              <button
                type="button"
                aria-pressed={selectedKey === row.key}
                aria-disabled={row.option.isSelectable ? undefined : true}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[2px] border border-dashed border-border px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground",
                  selectedKey === row.key && "border-solid border-[var(--accent-red)]",
                )}
                onClick={() => {
                  if (row.option.isSelectable) onSelect(row.option);
                }}
                onMouseEnter={() => onHover(row.key)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(row.key)}
                onBlur={() => onHover(null)}
              >
                <ProviderSwatch option={row.option} />
                <span>{row.option.vendorLabel}</span>
                <span className="text-muted-foreground">· {row.option.laneLabel ?? row.option.tier ?? "Standard"} · {reason}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const DEADLINE_STATE_LABELS: Record<PartDeadlineState, string> = {
  confirmed: "confirmed",
  inferred: "not confirmed",
  expired: "expired",
};

function DeadlineSummary({
  viewDeadline,
  baseDeadline,
  baseState,
  onReset,
}: Readonly<{
  viewDeadline: string | null;
  baseDeadline: string | null;
  baseState: PartDeadlineState;
  onReset: () => void;
}>) {
  if (!viewDeadline) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="deadline-summary">
        No part deadline set. Set a need-by date to compare on-time delivery.
      </p>
    );
  }
  const adjusted = viewDeadline !== baseDeadline;
  const savedLabel = baseDeadline ? formatCivilDate(baseDeadline) : "not set";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="deadline-summary">
      <span className="text-foreground">
        Deadline: <span className="font-mono">{formatCivilDate(viewDeadline)}</span>
      </span>
      <span className="text-muted-foreground">
        {adjusted
          ? `Adjusted for this view; saved deadline ${savedLabel}`
          : DEADLINE_STATE_LABELS[baseState]}
      </span>
      {adjusted && baseDeadline ? (
        <Button type="button" variant="ghost" className="h-6 px-2 text-xs" onClick={onReset}>
          Reset to {baseState === "confirmed" ? "confirmed" : "saved"} deadline
        </Button>
      ) : null}
    </div>
  );
}

function formatCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function QuoteRequestCompletionBanner({
  notice,
  onDismiss,
}: Readonly<{ notice: QuoteRequestCompletionNotice; onDismiss: () => void }>) {
  const summary = notice.optionCount === 0
    ? "Quote request complete: no comparable options to show."
    : `Quote request complete: ${formatCount(notice.optionCount, "option", "options")} from ${formatCount(notice.providerWithOptionsCount, "provider", "providers")}.`;
  return (
    <output
      data-testid="quote-request-completion-notice"
      className="mt-4 flex items-start justify-between gap-3 border border-border bg-ws-inset px-3 py-2 text-xs text-foreground"
    >
      <span className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>
          {summary}
          {notice.noQuoteProviderCount > 0
            ? ` ${formatCount(notice.noQuoteProviderCount, "provider", "providers")} returned no quote.`
            : ""}
        </span>
      </span>
      <button
        type="button"
        aria-label="Dismiss request completion notice"
        className="-my-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </output>
  );
}

type DecisionPanelContentProps = Readonly<{
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  quoteDiagnostics: QuoteDiagnostics | null;
  emptyState: string;
  scopeHidesOptions: boolean;
  onScopeChange?: (scope: QuotePresetScope) => void;
  hoveredKey: string | null;
  setHoveredKey: (key: string | null) => void;
  partId: string | null;
  organizationId: string | null;
  activePreset: QuotePreset | null;
  tableMode: DeliveredComparisonMode;
  onTableModeChange: (mode: DeliveredComparisonMode) => void;
  viewDeadline: string | null;
  baseDeadline: string | null;
  baseDeadlineState: PartDeadlineState;
  onViewDeadlineChange: (next: string | null) => void;
  now: Date;
  timeZone: string;
  /** Changes when the arrival notice above the panel content appears or disappears. */
  aboveContentKey: string;
  /** Changes only when the set of received options changes (an arrival), never on a reorder or scope toggle. */
  arrivalKey: string;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}>;

function renderDecisionPanelContent({
  options,
  selectedOption,
  quoteDataStatus,
  quoteDataMessage,
  quoteDiagnostics,
  emptyState,
  scopeHidesOptions,
  onScopeChange,
  hoveredKey,
  setHoveredKey,
  partId,
  organizationId,
  activePreset,
  tableMode,
  onTableModeChange,
  viewDeadline,
  baseDeadline,
  baseDeadlineState,
  onViewDeadlineChange,
  now,
  timeZone,
  aboveContentKey,
  arrivalKey,
  onSelect,
  onToggleVendorExclusion,
}: DecisionPanelContentProps) {
  if (quoteDataStatus === "schema_unavailable") {
    return (
      <QuoteDataStatusCard
        icon={TriangleAlert}
        title="Quote comparison is unavailable"
        body={quoteDataMessage ?? "The quote workspace projection is unavailable in this environment."}
      />
    );
  }

  if (quoteDataStatus === "invalid_for_plotting") {
    return (
      <div className="space-y-3">
        <QuoteDataStatusCard
          icon={TriangleAlert}
          title="Quote rows were loaded but could not be plotted"
          body={quoteDataMessage ?? "The quote rows for this part are missing required plotting fields."}
          diagnostics={quoteDiagnostics}
        />
        {quoteDiagnostics?.excludedOffers.length ? (
          <QuoteComparisonTable
            rows={[]}
            deadline={null}
            excludedOffers={quoteDiagnostics.excludedOffers}
            selectedOption={null}
            hoveredKey={null}
            onSelect={onSelect}
            onHover={setHoveredKey}
            activePreset={activePreset}
          />
        ) : null}
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div>
        <QuoteDataStatusCard icon={CircleOff} title={scopeHidesOptions ? "No US-sourced options" : "No quote options yet"} body={emptyState} />
        {scopeHidesOptions && onScopeChange ? (
          <Button type="button" variant="outline" className="mt-3" onClick={() => onScopeChange("global")}>
            Show all sourcing
          </Button>
        ) : null}
      </div>
    );
  }

  const model = buildDeliveredComparisonModel(options, { now, timeZone });
  const sortedRows = sortDeliveredComparisonRows(model.rows, tableMode, viewDeadline);
  const unplottedRows = sortedRows.filter((row) => row.plot === null);
  const selectedKey = selectedOption?.key ?? null;
  const selectedRow = model.rows.find((row) => row.key === selectedKey) ?? null;

  return (
    <div className="mt-4 space-y-3">
      <div className="border border-border bg-ws-inset p-2 sm:p-3" data-testid="quote-decision-chart">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-1 pb-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Decision map</p>
            <p className="mt-1 text-sm text-foreground">Delivered date × expected delivered cost</p>
          </div>
          <p className="max-w-xl text-right text-xs text-muted-foreground">
            Solid points are fully quoted; hollow points are lower bounds. Drag the deadline or use arrow keys.
          </p>
        </div>
        <div className="px-1 pt-2">
          <DeadlineSummary
            viewDeadline={viewDeadline}
            baseDeadline={baseDeadline}
            baseState={baseDeadlineState}
            onReset={() => onViewDeadlineChange(baseDeadline)}
          />
        </div>
        <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-accent" />}>
          <ClientQuoteComparisonChart
            options={options}
            axes="delivered"
            deliveredRows={model.rows}
            orderLocalDate={model.orderLocalDate}
            deadline={viewDeadline}
            onDeadlineChange={(next) => onViewDeadlineChange(next)}
            selectedKey={selectedKey}
            hoveredKey={hoveredKey}
            partId={partId}
            organizationId={organizationId}
            colorMode="vendor"
            onSelect={onSelect}
            onHover={setHoveredKey}
          />
        </Suspense>
        <UnplottedOptionsList rows={unplottedRows} selectedKey={selectedKey} onSelect={onSelect} onHover={setHoveredKey} />
      </div>

      {selectedOption ? <SelectedOptionSummary option={selectedOption} row={selectedRow} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableModeControl mode={tableMode} onChange={onTableModeChange} />
        <p className="text-xs text-muted-foreground">{describeTableOrder(tableMode, viewDeadline)}</p>
      </div>

      <QuoteComparisonTable
        rows={sortedRows}
        layoutKey={[aboveContentKey, arrivalKey].join("|")}
        deadline={viewDeadline}
        excludedOffers={quoteDiagnostics?.excludedOffers ?? []}
        selectedOption={selectedOption}
        hoveredKey={hoveredKey}
        onSelect={onSelect}
        onHover={setHoveredKey}
        activePreset={activePreset}
        onToggleVendorExclusion={onToggleVendorExclusion}
      />

      <QuoteStatsBar options={options} />

      {options.some((option) => resolveVendorPurchasingLink(option)) ? (
        <p className="text-xs text-muted-foreground">
          Vendor quote links open the supplier's purchasing page. Vendor sign-in or a vendor-issued guest link may be
          required.
        </p>
      ) : null}
    </div>
  );
}

function describeTableOrder(mode: DeliveredComparisonMode, deadline: string | null): string {
  if (mode === "fastest") return "Ordered by delivered date.";
  if (deadline) return "On-time options first by expected delivered cost, then options that may miss the deadline, then late.";
  return "Ordered by expected delivered cost.";
}

function presetTableMode(preset: QuotePreset | null): DeliveredComparisonMode {
  return getPresetMode(preset) === "fastest" ? "fastest" : "cheapest";
}

function resolveDefaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Render the client-facing quote comparison experience: delivered-date chart
 * with an adjustable deadline, the selected option, and the Cheapest/Fastest
 * table, all sharing one selection state.
 */
export function ClientQuoteDecisionPanel({
  title = "Quote intelligence",
  description = "Compare delivered date and expected delivered cost as one decision surface, then commit the selected option from the same workspace.",
  options,
  selectedOption,
  previousSelectionUnavailable = false,
  onSelect,
  requestedByDate,
  quoteDataStatus = "available",
  quoteDataMessage = null,
  quoteDiagnostics = null,
  partId = null,
  organizationId = null,
  activePreset = null,
  onPresetSelect,
  onToggleVendorExclusion,
  controls = null,
  onScopeChange,
  layout = "full",
  headerActions = null,
  emptyState = "No quote options are available yet.",
  className,
  deadline = null,
  requestCompletion = null,
  now,
  timeZone,
}: Readonly<ClientQuoteDecisionPanelProps>) {
  const comparisonRef = useRef<HTMLElement>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // One projection instant per mount keeps arrivals from shifting existing points.
  const [mountedAt] = useState(() => new Date());
  const projectionNow = now ?? mountedAt;
  const projectionTimeZone = useMemo(() => timeZone ?? resolveDefaultTimeZone(), [timeZone]);

  const [tableMode, setTableMode] = useState<DeliveredComparisonMode>(() => presetTableMode(activePreset));
  const presetMode = presetTableMode(activePreset);
  useEffect(() => {
    setTableMode(presetMode);
  }, [presetMode]);

  const baseDeadline = deadline?.date ?? requestedByDate ?? null;
  const baseDeadlineState: PartDeadlineState = deadline?.date ? deadline.state : "inferred";
  const [viewDeadline, setViewDeadline] = useState<string | null>(baseDeadline);
  useEffect(() => {
    setViewDeadline(baseDeadline);
  }, [baseDeadline]);

  const sourcingScope = controls || activePreset
    ? getPresetScope(activePreset)
    : "global";
  const visibleOptions = useMemo(
    () => filterQuoteOptionsForScope(options, sourcingScope),
    [options, sourcingScope],
  );
  const visibleSelectedOption = selectedOption && visibleOptions.some((option) => option.key === selectedOption.key)
    ? selectedOption
    : null;
  const scopedEmptyState = sourcingScope === "domestic" && options.length > 0
    ? "No options have verified US sourcing. Switch to All sourcing to include international and unknown-origin variants."
    : emptyState;

  const arrivalKey = useMemo(
    () => options.map((option) => option.key).sort((left, right) => left.localeCompare(right)).join(","),
    [options],
  );

  const completionNotice = useMemo(
    () => (requestCompletion ? resolveQuoteRequestCompletion(requestCompletion, visibleOptions) : null),
    [requestCompletion, visibleOptions],
  );
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null);
  const visibleNotice = completionNotice && completionNotice.requestId !== dismissedRequestId ? completionNotice : null;

  return (
    <section
      ref={comparisonRef}
      tabIndex={-1}
      aria-label={title}
      className={cn("border border-ws-border bg-ws-card p-4 sm:p-5 [overflow-anchor:none]", className)}
      data-layout={layout}
    >
      <PanelHeader
        title={title}
        description={description}
        headerActions={headerActions}
        controls={typeof controls === "function"
          ? controls(countDeadlineStatuses(
              buildDeliveredComparisonModel(visibleOptions, { now: projectionNow, timeZone: projectionTimeZone }).rows,
              viewDeadline,
            ), viewDeadline)
          : controls}
        activePreset={activePreset ?? null}
        onPresetSelect={onPresetSelect}
      />
      {previousSelectionUnavailable && !selectedOption && quoteDataStatus === "available" && options.length > 0 ? (
        <output
          className="mt-4 block border-l-2 border-border bg-ws-inset px-4 py-3 text-sm text-foreground"
          data-testid="previous-selection-unavailable"
        >
          Your previous quote choice is no longer available. Choose a quote to continue.
        </output>
      ) : null}
      {visibleNotice ? (
        <QuoteRequestCompletionBanner
          notice={visibleNotice}
          onDismiss={() => setDismissedRequestId(visibleNotice.requestId)}
        />
      ) : null}
      {renderDecisionPanelContent({
        options: visibleOptions,
        selectedOption: visibleSelectedOption,
        quoteDataStatus,
        quoteDataMessage,
        quoteDiagnostics,
        emptyState: scopedEmptyState,
        scopeHidesOptions: sourcingScope === "domestic" && options.length > 0,
        onScopeChange: onScopeChange ? (scope) => {
          comparisonRef.current?.focus();
          onScopeChange(scope);
        } : undefined,
        hoveredKey,
        setHoveredKey,
        partId,
        organizationId,
        activePreset,
        tableMode,
        onTableModeChange: setTableMode,
        viewDeadline,
        baseDeadline,
        baseDeadlineState,
        onViewDeadlineChange: setViewDeadline,
        now: projectionNow,
        timeZone: projectionTimeZone,
        aboveContentKey: visibleNotice ? `notice:${visibleNotice.requestId}` : "",
        arrivalKey,
        onSelect,
        onToggleVendorExclusion,
      })}
    </section>
  );
}
