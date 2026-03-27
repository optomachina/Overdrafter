import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { BadgeCheck, CircleOff, SlidersHorizontal, TriangleAlert } from "lucide-react";

const ClientQuoteComparisonChart = lazy(() =>
  import("@/components/quotes/ClientQuoteComparisonChart").then((m) => ({
    default: m.ClientQuoteComparisonChart,
  })),
);
import { QuoteStatsBar } from "@/components/quotes/QuoteStatsBar";
import { QuoteSupplierLegend } from "@/components/quotes/QuoteSupplierLegend";
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
} from "@/features/quotes/selection";
import { formatQuotePlotExclusionReason } from "@/features/quotes/selection";
import type { QuoteDataStatus, QuoteDiagnostics } from "@/features/quotes/types";
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";
import { getVendorColor } from "@/features/quotes/vendor-colors";
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
    <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
      <Icon className="mx-auto h-5 w-5 text-white/35" />
      <p className="mt-3 text-sm font-medium text-white/80">{title}</p>
      <p className="mt-2 text-sm text-white/55">{body}</p>
      {diagnostics && diagnostics.excludedReasonCounts.length > 0 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {diagnostics.excludedReasonCounts.slice(0, 3).map((entry) => (
            <span
              key={entry.reason}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-white/60"
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
  vendorKeys,
}: {
  title: string;
  description: string;
  headerActions: ReactNode;
  controls: ReactNode;
  activePreset: QuotePreset | null;
  onPresetSelect?: (preset: QuotePreset) => void;
  vendorKeys: readonly ClientQuoteSelectionOption["vendorKey"][];
}) {
  const showLegacyPresets = !controls && onPresetSelect;

  return (
    <div className="flex flex-col gap-3 border-b border-white/8 pb-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">{title}</p>
          <p className="mt-1.5 max-w-3xl text-sm text-white/55">{description}</p>
        </div>
        {headerActions}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {controls ? (
          <div className="min-w-0 flex-1">{controls}</div>
        ) : null}

        {showLegacyPresets ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/55">
              <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
              Presets
            </div>
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
                onClick={() => onPresetSelect(preset.key)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        ) : null}

        <div className={cn((controls || showLegacyPresets) && "ml-auto")}>
          <QuoteSupplierLegend vendorKeys={vendorKeys} />
        </div>
      </div>
    </div>
  );
}

function SelectedOptionBanner({ option }: { option: ClientQuoteSelectionOption }) {
  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Current selection</p>
      <div className="mt-1.5 flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: getVendorColor(option.vendorKey) }}
          />
          <p className="text-base font-semibold text-white">{option.vendorLabel}</p>
          <p className="text-sm text-emerald-100/85">
            {formatCurrency(option.totalPriceUsd)} total · {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge className="border border-emerald-400/20 bg-black/20 text-emerald-100">
            Qty {option.requestedQuantity}
          </Badge>
          {option.expedite ? (
            <Badge className="border border-fuchsia-400/20 bg-fuchsia-500/10 text-fuchsia-100">
              Expedite
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QuoteComparisonTable({
  options,
  selectedOption,
  hoveredKey,
  onSelect,
  onHover,
  requestedByDate,
  activePreset,
  onToggleVendorExclusion,
}: {
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  hoveredKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  requestedByDate: string | null;
  activePreset: QuotePreset | null;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/20 p-2">
      <Table className="text-white">
        <TableHeader>
          <TableRow className="border-white/8 hover:bg-transparent">
            <TableHead className="text-[11px] text-white/45">Vendor</TableHead>
            <TableHead className="text-[11px] text-white/45">Lane / Sourcing</TableHead>
            <TableHead className="text-right text-[11px] text-white/45">Unit</TableHead>
            <TableHead className="text-right text-[11px] text-white/45">Total</TableHead>
            <TableHead className="text-right text-[11px] text-white/45">Lead</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {options.map((option) => {
            const selected = selectedOption?.key === option.key;
            const hovered = hoveredKey === option.key;
            const reasons = getClientQuoteOptionStateReasons({
              option,
              requestedByDate,
              preset: activePreset,
            });

            return (
              <TableRow
                key={option.key}
                className={cn(
                  "cursor-pointer border-white/6 transition-colors",
                  selected && "bg-emerald-500/10 hover:bg-emerald-500/12",
                  !selected && hovered && "bg-white/[0.04]",
                  !selected && !hovered && "hover:bg-white/[0.03]",
                  !option.isSelectable && "cursor-not-allowed opacity-60",
                )}
                onClick={() => {
                  if (option.isSelectable) {
                    onSelect(option);
                  }
                }}
                onMouseEnter={() => onHover(option.key)}
                onMouseLeave={() => onHover(null)}
              >
                <TableCell className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: getVendorColor(option.vendorKey) }}
                    />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-white">{option.vendorLabel}</span>
                        {selected ? (
                          <BadgeCheck className="h-3.5 w-3.5 text-emerald-400" />
                        ) : null}
                        {option.excluded ? (
                          <Badge className="h-4 border border-white/10 bg-white/6 px-1 text-[9px] text-white/50">
                            Excl
                          </Badge>
                        ) : null}
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
                <TableCell className="py-2.5 text-xs text-white/50">
                  <p>{option.laneLabel ?? option.tier ?? "Standard"}</p>
                  {option.sourcing ? (
                    <p className="text-[10px] text-white/35">{option.sourcing}</p>
                  ) : null}
                </TableCell>
                <TableCell className="py-2.5 text-right text-sm tabular-nums text-white/75">
                  {formatCurrency(option.unitPriceUsd)}
                </TableCell>
                <TableCell className="py-2.5 text-right text-sm font-semibold tabular-nums text-white">
                  {formatCurrency(option.totalPriceUsd)}
                  {onToggleVendorExclusion ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-0.5 block h-auto p-0 text-[10px] text-white/40 hover:bg-transparent hover:text-white"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleVendorExclusion(option.vendorKey, !option.excluded);
                      }}
                    >
                      {option.excluded ? "Include" : "Exclude"}
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell className="py-2.5 text-right text-sm tabular-nums text-white/65">
                  {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function QuoteComparisonCards({
  options,
  selectedOption,
  hoveredKey,
  onSelect,
  onHover,
  requestedByDate,
  activePreset,
  onToggleVendorExclusion,
}: {
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  hoveredKey: string | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  onHover: (key: string | null) => void;
  requestedByDate: string | null;
  activePreset: QuotePreset | null;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      {options.map((option) => {
        const selected = selectedOption?.key === option.key;
        const hovered = hoveredKey === option.key;
        const reasons = getClientQuoteOptionStateReasons({
          option,
          requestedByDate,
          preset: activePreset,
        });

        return (
          <article
            key={option.key}
            className={cn(
              "rounded-2xl border border-white/8 bg-black/20 p-4 transition-colors",
              option.isSelectable && "cursor-pointer",
              selected && "border-emerald-400/20 bg-emerald-500/10",
              !selected && hovered && "bg-white/[0.05]",
              !selected && !hovered && option.isSelectable && "hover:bg-white/[0.03]",
              !option.isSelectable && "cursor-not-allowed opacity-60",
            )}
            onClick={() => {
              if (option.isSelectable) {
                onSelect(option);
              }
            }}
            onMouseEnter={() => onHover(option.key)}
            onMouseLeave={() => onHover(null)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: getVendorColor(option.vendorKey) }}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-white">{option.vendorLabel}</span>
                      {selected ? <BadgeCheck className="h-3.5 w-3.5 text-emerald-400" /> : null}
                      {option.excluded ? (
                        <Badge className="h-4 border border-white/10 bg-white/6 px-1 text-[9px] text-white/50">
                          Excl
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-white/45">
                      {[option.laneLabel ?? option.tier ?? "Standard", option.sourcing].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                {reasons.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
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

              <div className="shrink-0 text-right">
                <p className="text-base font-semibold text-white">{formatCurrency(option.totalPriceUsd)}</p>
                <p className="mt-1 text-xs text-white/55">{option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}</p>
                <p className="mt-1 text-[11px] text-white/40">Unit {formatCurrency(option.unitPriceUsd)}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onToggleVendorExclusion ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-7 rounded-full border border-white/10 px-2.5 text-[11px] text-white/55 hover:bg-white/6 hover:text-white"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleVendorExclusion(option.vendorKey, !option.excluded);
                  }}
                >
                  {option.excluded ? "Include" : "Exclude"}
                </Button>
              ) : null}
              {selected ? (
                <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                  Selected
                </Badge>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

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
}: ClientQuoteDecisionPanelProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const vendorKeys = [...new Set(options.map((o) => o.vendorKey))];

  return (
    <section className={cn("rounded-[28px] border border-ws-border bg-ws-card p-5", className)}>
      <PanelHeader
        title={title}
        description={description}
        headerActions={headerActions}
        controls={controls}
        activePreset={activePreset ?? null}
        onPresetSelect={onPresetSelect}
        vendorKeys={vendorKeys}
      />

      {quoteDataStatus === "schema_unavailable" ? (
        <QuoteDataStatusCard
          icon={TriangleAlert}
          title="Quote comparison is unavailable"
          body={quoteDataMessage ?? "The quote workspace projection is unavailable in this environment."}
        />
      ) : quoteDataStatus === "invalid_for_plotting" ? (
        <QuoteDataStatusCard
          icon={TriangleAlert}
          title="Quote rows were loaded but could not be plotted"
          body={quoteDataMessage ?? "The quote rows for this part are missing required plotting fields."}
          diagnostics={quoteDiagnostics}
        />
      ) : options.length === 0 ? (
        <QuoteDataStatusCard icon={CircleOff} title="No quote options yet" body={emptyState} />
      ) : (
        <div className="mt-4 space-y-4">
          <QuoteStatsBar options={options} />

          {selectedOption ? <SelectedOptionBanner option={selectedOption} /> : null}

          <div className="rounded-[24px] border border-white/8 bg-black/20 p-4">
            <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-white/5" />}>
              <ClientQuoteComparisonChart
                options={options}
                selectedKey={selectedOption?.key ?? null}
                hoveredKey={hoveredKey}
                partId={partId}
                organizationId={organizationId}
                onSelect={onSelect}
                onHover={setHoveredKey}
              />
            </Suspense>
          </div>

          {layout === "compact" ? (
            <QuoteComparisonCards
              options={options}
              selectedOption={selectedOption}
              hoveredKey={hoveredKey}
              onSelect={onSelect}
              onHover={setHoveredKey}
              requestedByDate={requestedByDate}
              activePreset={activePreset ?? null}
              onToggleVendorExclusion={onToggleVendorExclusion}
            />
          ) : (
            <QuoteComparisonTable
              options={options}
              selectedOption={selectedOption}
              hoveredKey={hoveredKey}
              onSelect={onSelect}
              onHover={setHoveredKey}
              requestedByDate={requestedByDate}
              activePreset={activePreset ?? null}
              onToggleVendorExclusion={onToggleVendorExclusion}
            />
          )}
        </div>
      )}
    </section>
  );
}
