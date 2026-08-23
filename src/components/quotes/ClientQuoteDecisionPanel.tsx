import { lazy, Suspense, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleOff,
  Clock,
  Loader2,
  SlidersHorizontal,
  TriangleAlert,
  XCircle,
} from "lucide-react";

const ClientQuoteComparisonChart = lazy(() =>
  import("@/components/quotes/ClientQuoteComparisonChart").then((m) => ({
    default: m.ClientQuoteComparisonChart,
  })),
);
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
import type {
  ClientQuoteSelectionOption,
  QuotePreset,
  QuotePresetMode,
} from "@/features/quotes/selection";
import {
  formatQuotePlotExclusionReason,
  filterQuoteOptionsForScope,
  getPresetScope,
  getPresetMode,
  getTopRankedQuoteOptionKeys,
  sortQuoteOptionsForPreset,
} from "@/features/quotes/selection";
import type { QuoteDataStatus, QuoteDiagnostics } from "@/features/quotes/types";
import { formatCurrency } from "@/features/quotes/utils";
import { resolveVendorPurchasingLink } from "@/features/quotes/vendor-purchasing-links";
import { cn } from "@/lib/utils";

type ClientQuoteDecisionPanelProps = {
  title?: string;
  description?: string;
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
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
  controls?: ReactNode;
  layout?: "full" | "compact";
  headerActions?: ReactNode;
  emptyState?: string;
  className?: string;
};

function formatEstimatedDeliveryDays(
  leadTimeBusinessDays: number | null | undefined,
  resolvedDeliveryDate: string | null | undefined,
): string {
  if (leadTimeBusinessDays || leadTimeBusinessDays === 0) {
    return `${leadTimeBusinessDays} day${leadTimeBusinessDays === 1 ? "" : "s"}`;
  }

  return resolvedDeliveryDate ?? "Pending";
}

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

function getPresetModeBadgeCopy(mode: QuotePresetMode) {
  if (mode === "fastest") {
    return {
      indicatorLabel: "Fast mode: fastest delivery first",
      indicatorDetail: "Rows are sorted by lead time ascending. The fastest vendor gets the Fast pick badge.",
      rowBadge: "Fast pick",
    };
  }

  if (mode === "balanced") {
    return {
      indicatorLabel: "Balanced mode: best price-speed tradeoff",
      indicatorDetail: "Rows surface the strongest existing price-speed tradeoff first. The leading option gets the Balanced pick badge.",
      rowBadge: "Balanced pick",
    };
  }

  return {
    indicatorLabel: "Cheap mode: lowest unit price first",
    indicatorDetail: "Rows are sorted by unit price ascending. The cheapest vendor gets the Cheap pick badge.",
    rowBadge: "Cheap pick",
  };
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
  isRecommendation,
}: Readonly<{ option: ClientQuoteSelectionOption; isRecommendation: boolean }>) {
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
        {isRecommendation ? "Recommended starting point" : "Current selection"}
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-6">
        <SummaryFact label="Vendor" value={option.vendorLabel} />
        <SummaryFact label="Quoted total" value={formatCurrency(option.totalPriceUsd)} />
        <SummaryFact
          label="Ready to ship"
          value={formatEstimatedDeliveryDays(option.leadTimeBusinessDays, option.resolvedDeliveryDate)}
        />
        <SummaryFact label="Quantity" value={String(option.requestedQuantity)} />
        <SummaryFact label="Sourcing" value={formatGeographicOrigin(option.geographicOrigin)} />
        <SummaryFact
          label="Quote status"
          value={`${collectedRecently ? "Recently collected" : "Previously collected"} · ${validityLabel}`}
        />
      </dl>
      <details className="mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Response source facts
        </summary>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryFact label="Quote date" value={formatDate(option.quoteDateIso)} />
          <SummaryFact label="Valid through" value={formatDate(option.validUntil)} />
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

function RecommendationSummary({ mode, rankedCount }: Readonly<{ mode: QuotePresetMode; rankedCount: number }>) {
  const copy = getPresetModeBadgeCopy(mode);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 text-xs">
      <p className="text-foreground">
        <span className="font-medium">{copy.indicatorLabel}</span>
        <span className="ml-2 text-muted-foreground">{copy.indicatorDetail}</span>
      </p>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {rankedCount} {rankedCount === 1 ? "leader" : "leaders"}
      </span>
    </div>
  );
}

function QuoteProviderCell({
  option,
  startsProviderGroup,
  providerGroupSize,
  selected,
  recommended,
  showTopRankBadge,
  rowBadge,
  reasons,
}: Readonly<{
  option: ClientQuoteSelectionOption;
  startsProviderGroup: boolean;
  providerGroupSize: number;
  selected: boolean;
  recommended: boolean;
  showTopRankBadge: boolean;
  rowBadge: string;
  reasons: ReturnType<typeof getClientQuoteOptionStateReasons>;
}>) {
  const optionLabel = startsProviderGroup
    ? option.vendorLabel
    : `↳ ${option.laneLabel ?? option.tier ?? "Variant"}`;

  return (
    <TableCell className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: selected || recommended ? "var(--accent-red)" : "var(--muted-ink)" }}
        />
        <div>
          <div className="flex items-center gap-1.5">
            <span className={cn("text-sm font-medium", startsProviderGroup ? "text-foreground" : "text-muted-foreground")}>{optionLabel}</span>
            {startsProviderGroup && providerGroupSize > 1 ? (
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                {providerGroupSize} variants
              </span>
            ) : null}
            {showTopRankBadge ? (
              <Badge className="h-4 rounded-[2px] border border-border bg-transparent px-1.5 font-mono text-[9px] text-muted-foreground">
                {rowBadge}
              </Badge>
            ) : null}
            {option.excluded ? (
              <Badge className="h-4 border border-border bg-accent px-1 text-[9px] text-muted-foreground">Excl</Badge>
            ) : null}
            <VendorStatusBadge status={option.vendorStatus} />
          </div>
          {reasons.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
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
  option,
  startsProviderGroup,
  providerGroupSize,
  selected,
  hovered,
  recommended,
  missesRequestedDate,
  showTopRankBadge,
  rowBadge,
  requestedByDate,
  activePreset,
  onSelect,
  onHover,
  onToggleVendorExclusion,
}: Readonly<{
  option: ClientQuoteSelectionOption;
  startsProviderGroup: boolean;
  providerGroupSize: number;
  selected: boolean;
  hovered: boolean;
  recommended: boolean;
  missesRequestedDate: boolean;
  showTopRankBadge: boolean;
  rowBadge: string;
  requestedByDate: string | null;
  activePreset: QuotePreset | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}>) {
  const reasons = getClientQuoteOptionStateReasons({ option, requestedByDate, preset: activePreset });
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
      tabIndex={option.isSelectable ? 0 : -1}
      aria-selected={selected}
      data-quote-key={option.key}
      className={cn(
        "border-border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground",
        option.isSelectable && "cursor-pointer",
        (selected || recommended) && "border-l-2 border-l-[var(--accent-red)] bg-ws-inset",
        !selected && hovered && "bg-accent",
        !selected && !hovered && "hover:bg-accent",
        missesRequestedDate && "opacity-45",
        !option.isSelectable && "cursor-not-allowed opacity-60",
      )}
      onClick={selectOption}
      onMouseEnter={() => onHover(option.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(option.key)}
      onBlur={() => onHover(null)}
      onKeyDown={handleKeyDown}
    >
      <QuoteProviderCell
        option={option}
        startsProviderGroup={startsProviderGroup}
        providerGroupSize={providerGroupSize}
        selected={selected}
        recommended={recommended}
        showTopRankBadge={showTopRankBadge}
        rowBadge={rowBadge}
        reasons={reasons}
      />
      <QuoteScopeCell option={option} />
      <TableCell className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-foreground/80">
        {formatCurrency(option.unitPriceUsd)}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right font-mono text-xs font-semibold tabular-nums text-foreground">
        {formatCurrency(option.totalPriceUsd)}
        {onToggleVendorExclusion ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-0.5 block h-auto p-0 text-[10px] text-muted-foreground hover:bg-transparent hover:text-foreground"
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
        {option.leadTimeBusinessDays === null ? "Unavailable" : option.leadTimeBusinessDays}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right">
        <VendorPurchasingLinkButton option={option} label="Open" />
      </TableCell>
    </TableRow>
  );
}

function QuoteComparisonTable({
  options,
  excludedOffers,
  selectedOption,
  hoveredKey,
  onSelect,
  onHover,
  requestedByDate,
  activePreset,
  topRankedKeys,
  onToggleVendorExclusion,
  recommendedKey,
}: Readonly<{
  options: readonly ClientQuoteSelectionOption[];
  excludedOffers: QuoteDiagnostics["excludedOffers"];
  selectedOption: ClientQuoteSelectionOption | null;
  hoveredKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  requestedByDate: string | null;
  activePreset: QuotePreset | null;
  topRankedKeys: ReadonlySet<string>;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
  recommendedKey: string | null;
}>) {
  const badgeCopy = getPresetModeBadgeCopy(getPresetMode(activePreset));
  const [sort, setSort] = useState<{ key: "vendor" | "total" | "lead"; direction: "asc" | "desc" } | null>(null);
  const groupedOptions = useMemo(() => {
    const groups = new Map<ClientQuoteSelectionOption["vendorKey"], ClientQuoteSelectionOption[]>();
    options.forEach((option) => {
      const group = groups.get(option.vendorKey) ?? [];
      group.push(option);
      groups.set(option.vendorKey, group);
    });

    if (!sort) {
      return [...groups.values()].flat();
    }

    const direction = sort.direction === "asc" ? 1 : -1;
    const compareOptions = (left: ClientQuoteSelectionOption, right: ClientQuoteSelectionOption) => {
      if (sort.key === "vendor") {
        return left.vendorLabel.localeCompare(right.vendorLabel) * direction;
      }

      if (sort.key === "total") {
        return (left.totalPriceUsd - right.totalPriceUsd) * direction;
      }

      const leftLead = left.leadTimeBusinessDays ?? Number.POSITIVE_INFINITY;
      const rightLead = right.leadTimeBusinessDays ?? Number.POSITIVE_INFINITY;
      return (leftLead - rightLead) * direction;
    };
    const sortedGroups = [...groups.values()].map((group) => [...group].sort(compareOptions));
    sortedGroups.sort((left, right) => {
      const compared = compareOptions(left[0], right[0]);
      if (compared !== 0) {
        return compared;
      }
      return left[0].vendorLabel.localeCompare(right[0].vendorLabel);
    });
    return sortedGroups.flat();
  }, [options, sort]);
  const providerGroupSizes = useMemo(() => {
    const sizes = new Map<ClientQuoteSelectionOption["vendorKey"], number>();
    groupedOptions.forEach((option) => {
      sizes.set(option.vendorKey, (sizes.get(option.vendorKey) ?? 0) + 1);
    });
    return sizes;
  }, [groupedOptions]);

  const toggleSort = (key: "vendor" | "total" | "lead") => {
    setSort((current) => {
      if (current?.key !== key) {
        return { key, direction: "asc" };
      }
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  };

  const sortIcon = (key: "vendor" | "total" | "lead") => {
    if (sort?.key !== key) {
      return <ArrowUpDown className="h-3 w-3" aria-hidden="true" />;
    }
    return sort.direction === "asc"
      ? <ArrowUp className="h-3 w-3" aria-hidden="true" />
      : <ArrowDown className="h-3 w-3" aria-hidden="true" />;
  };

  const sortLabel = (label: string, key: "vendor" | "total" | "lead") => {
    const direction = sort?.key === key
      ? `, ${sort.direction === "asc" ? "ascending" : "descending"}`
      : "";
    return `Sort providers by ${label}${direction}`;
  };

  return (
    <div className="border border-border bg-ws-card" data-testid="quote-vendor-table">
      <Table className="min-w-[680px] text-foreground">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="h-9 px-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <button type="button" className="inline-flex items-center gap-1.5" onClick={() => toggleSort("vendor")} aria-label={sortLabel("vendor", "vendor")}>
                Vendor {sortIcon("vendor")}
              </button>
            </TableHead>
            <TableHead className="h-9 px-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Scope</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Unit</TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <button type="button" className="ml-auto inline-flex items-center gap-1.5" onClick={() => toggleSort("total")} aria-label={sortLabel("total", "total")}>
                Total {sortIcon("total")}
              </button>
            </TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <button type="button" className="ml-auto inline-flex items-center gap-1.5" onClick={() => toggleSort("lead")} aria-label={sortLabel("working days", "lead")}>
                Working days {sortIcon("lead")}
              </button>
            </TableHead>
            <TableHead className="h-9 px-3 text-right text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupedOptions.map((option, optionIndex) => (
            <QuoteComparisonRow
              key={option.key}
              option={option}
              startsProviderGroup={optionIndex === 0 || groupedOptions[optionIndex - 1]?.vendorKey !== option.vendorKey}
              providerGroupSize={providerGroupSizes.get(option.vendorKey) ?? 0}
              selected={selectedOption?.key === option.key}
              hovered={hoveredKey === option.key}
              recommended={!selectedOption && recommendedKey === option.key}
              missesRequestedDate={Boolean(requestedByDate) && !option.dueDateEligible}
              showTopRankBadge={topRankedKeys.has(option.key)}
              rowBadge={badgeCopy.rowBadge}
              requestedByDate={requestedByDate}
              activePreset={activePreset}
              onSelect={onSelect}
              onHover={onHover}
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

type DecisionPanelContentProps = Readonly<{
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  requestedByDate: string | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  quoteDiagnostics: QuoteDiagnostics | null;
  emptyState: string;
  hoveredKey: string | null;
  setHoveredKey: (key: string | null) => void;
  partId: string | null;
  organizationId: string | null;
  activePreset: QuotePreset | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}>;

function renderDecisionPanelContent({
  options,
  selectedOption,
  requestedByDate,
  quoteDataStatus,
  quoteDataMessage,
  quoteDiagnostics,
  emptyState,
  hoveredKey,
  setHoveredKey,
  partId,
  organizationId,
  activePreset,
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
            options={[]}
            excludedOffers={quoteDiagnostics.excludedOffers}
            selectedOption={null}
            hoveredKey={null}
            onSelect={onSelect}
            onHover={setHoveredKey}
            requestedByDate={requestedByDate}
            activePreset={activePreset}
            topRankedKeys={new Set<string>()}
            recommendedKey={null}
          />
        ) : null}
      </div>
    );
  }

  if (options.length === 0) {
    return <QuoteDataStatusCard icon={CircleOff} title="No quote options yet" body={emptyState} />;
  }

  const activeRankingPreset = activePreset ?? "balanced";
  const rankedOptions = sortQuoteOptionsForPreset(options, activeRankingPreset);
  const topRankedKeys = getTopRankedQuoteOptionKeys(rankedOptions, activeRankingPreset);
  const recommendedOption = rankedOptions.find((option) => topRankedKeys.has(option.key)) ?? null;
  const activeOption = selectedOption ?? recommendedOption;
  const activeKey = activeOption?.key ?? null;

  return (
    <div className="mt-4 space-y-3">
      <div className="border border-border bg-ws-inset p-2 sm:p-3" data-testid="quote-decision-chart">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-1 pb-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Decision map</p>
            <p className="mt-1 text-sm text-foreground">Working days × quoted total</p>
          </div>
          <p className="max-w-xl text-right text-xs text-muted-foreground">
            Select a point or table row. Hover and keyboard focus stay synchronized.
          </p>
        </div>
        <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-accent" />}>
          <ClientQuoteComparisonChart
            options={options}
            selectedKey={activeKey}
            hoveredKey={hoveredKey}
            partId={partId}
            organizationId={organizationId}
            colorMode="monochrome"
            onSelect={onSelect}
            onHover={setHoveredKey}
          />
        </Suspense>
      </div>

      {activeOption ? (
        <SelectedOptionSummary option={activeOption} isRecommendation={!selectedOption} />
      ) : null}

      <QuoteComparisonTable
        options={rankedOptions}
        excludedOffers={quoteDiagnostics?.excludedOffers ?? []}
        selectedOption={selectedOption}
        hoveredKey={hoveredKey}
        onSelect={onSelect}
        onHover={setHoveredKey}
        requestedByDate={requestedByDate}
        activePreset={activePreset}
        topRankedKeys={topRankedKeys}
        onToggleVendorExclusion={onToggleVendorExclusion}
        recommendedKey={recommendedOption?.key ?? null}
      />

      <RecommendationSummary mode={getPresetMode(activePreset)} rankedCount={topRankedKeys.size} />

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

/**
 * Render the client-facing quote comparison experience, including the selected
 * vendor summary, ranking context, filters, and table/chart views.
 */
export function ClientQuoteDecisionPanel({
  title = "Quote intelligence",
  description = "Compare price and lead time as one decision surface, then commit the selected option from the same workspace.",
  options,
  selectedOption,
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
  layout = "full",
  headerActions = null,
  emptyState = "No quote options are available yet.",
  className,
}: Readonly<ClientQuoteDecisionPanelProps>) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
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

  return (
    <section className={cn("border border-ws-border bg-ws-card p-4 sm:p-5", className)} data-layout={layout}>
      <PanelHeader
        title={title}
        description={description}
        headerActions={headerActions}
        controls={controls}
        activePreset={activePreset ?? null}
        onPresetSelect={onPresetSelect}
      />
      {renderDecisionPanelContent({
        options: visibleOptions,
        selectedOption: visibleSelectedOption,
        requestedByDate,
        quoteDataStatus,
        quoteDataMessage,
        quoteDiagnostics,
        emptyState: scopedEmptyState,
        hoveredKey,
        setHoveredKey,
        partId,
        organizationId,
        activePreset,
        onSelect,
        onToggleVendorExclusion,
      })}
    </section>
  );
}
