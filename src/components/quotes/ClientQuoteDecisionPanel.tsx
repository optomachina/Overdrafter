import type { ReactNode } from "react";
import { BadgeCheck, CircleOff, SlidersHorizontal } from "lucide-react";
import { ClientQuoteComparisonChart } from "@/components/quotes/ClientQuoteComparisonChart";
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
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

type ClientQuoteDecisionPanelProps = {
  title?: string;
  description?: string;
  options: readonly ClientQuoteSelectionOption[];
  selectedOption: ClientQuoteSelectionOption | null;
  onSelect: (option: ClientQuoteSelectionOption) => void;
  requestedByDate: string | null;
  activePreset?: QuotePreset | null;
  onPresetSelect?: (preset: QuotePreset) => void;
  onToggleVendorExclusion?: (vendorKey: ClientQuoteSelectionOption["vendorKey"], nextExcluded: boolean) => void;
  headerActions?: ReactNode;
  emptyState?: string;
  className?: string;
};

const PRESET_OPTIONS: Array<{ key: QuotePreset; label: string }> = [
  { key: "cheapest", label: "Cheapest" },
  { key: "fastest", label: "Fastest" },
  { key: "domestic", label: "Domestic" },
];

export function ClientQuoteDecisionPanel({
  title = "Quote intelligence",
  description = "Compare price and lead time as one decision surface, then commit the selected option from the same workspace.",
  options,
  selectedOption,
  onSelect,
  requestedByDate,
  activePreset = null,
  onPresetSelect,
  onToggleVendorExclusion,
  headerActions = null,
  emptyState = "No quote options are available yet.",
  className,
}: ClientQuoteDecisionPanelProps) {
  return (
    <section className={cn("rounded-[30px] border border-white/8 bg-[#262626] p-5", className)}>
      <div className="flex flex-col gap-4 border-b border-white/8 pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">{title}</p>
            <p className="mt-2 max-w-3xl text-sm text-white/55">{description}</p>
          </div>
          {headerActions}
        </div>

        {onPresetSelect ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/55">
              <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
              Decision presets
            </div>
            {PRESET_OPTIONS.map((preset) => (
              <Button
                key={preset.key}
                type="button"
                variant={activePreset === preset.key ? "default" : "outline"}
                className={cn(
                  "rounded-full border-white/10",
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

        {selectedOption ? (
          <div className="rounded-[22px] border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Current selection</p>
            <div className="mt-2 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-lg font-semibold text-white">{selectedOption.vendorLabel}</p>
                <p className="text-sm text-emerald-100/85">
                  {formatCurrency(selectedOption.totalPriceUsd)} total ·{" "}
                  {selectedOption.resolvedDeliveryDate ?? formatLeadTime(selectedOption.leadTimeBusinessDays)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge className="border border-emerald-400/20 bg-black/20 text-emerald-100">
                  Qty {selectedOption.requestedQuantity}
                </Badge>
                {selectedOption.expedite ? (
                  <Badge className="border border-fuchsia-400/20 bg-fuchsia-500/10 text-fuchsia-100">
                    Expedite
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {options.length === 0 ? (
        <div className="mt-4 rounded-[24px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
          <CircleOff className="mx-auto h-5 w-5 text-white/35" />
          <p className="mt-3 text-sm text-white/55">{emptyState}</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
          <div className="rounded-[24px] border border-white/8 bg-black/20 p-4">
            <ClientQuoteComparisonChart
              options={options}
              selectedKey={selectedOption?.key ?? null}
              onSelect={onSelect}
            />
          </div>

          <div className="rounded-[24px] border border-white/8 bg-black/20 p-2">
            <Table className="text-white">
              <TableHeader>
                <TableRow className="border-white/8 hover:bg-transparent">
                  <TableHead className="text-white/45">Option</TableHead>
                  <TableHead className="text-white/45">Delivery</TableHead>
                  <TableHead className="text-right text-white/45">Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {options.map((option) => {
                  const selected = selectedOption?.key === option.key;
                  const reasons = getClientQuoteOptionStateReasons({
                    option,
                    requestedByDate,
                    preset: activePreset ?? null,
                  });

                  return (
                    <TableRow
                      key={option.key}
                      className={cn(
                        "cursor-pointer border-white/8 hover:bg-white/4",
                        selected && "bg-emerald-500/10 hover:bg-emerald-500/10",
                        !option.isSelectable && "cursor-not-allowed opacity-70",
                      )}
                      onClick={() => {
                        if (!option.isSelectable) {
                          return;
                        }

                        onSelect(option);
                      }}
                    >
                      <TableCell className="py-4">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-white">{option.vendorLabel}</p>
                            <Badge className="border border-white/10 bg-white/6 text-white/70">
                              Qty {option.requestedQuantity}
                            </Badge>
                            {selected ? (
                              <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                                <BadgeCheck className="mr-1 h-3 w-3" />
                                Selected
                              </Badge>
                            ) : null}
                            {option.excluded ? (
                              <Badge className="border border-white/10 bg-white/6 text-white/70">
                                Excluded
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-xs text-white/45">
                            {option.laneLabel ?? option.tier ?? "Standard lane"}
                            {option.process ? ` · ${option.process}` : ""}
                            {option.material ? ` · ${option.material}` : ""}
                          </p>
                          {reasons.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {reasons.map((reason) => (
                                <ClientWorkspaceToneBadge
                                  key={`${option.key}:${reason.id}`}
                                  tone={reason.tone}
                                  label={reason.label}
                                  className="tracking-normal normal-case"
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="py-4 text-sm text-white/65">
                        {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                      </TableCell>
                      <TableCell className="py-4 text-right">
                        <p className="text-sm font-semibold text-white">
                          {formatCurrency(option.totalPriceUsd)}
                        </p>
                        {onToggleVendorExclusion ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="mt-1 h-auto p-0 text-xs text-white/50 hover:bg-transparent hover:text-white"
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggleVendorExclusion(option.vendorKey, !option.excluded);
                            }}
                          >
                            {option.excluded ? "Include vendor" : "Exclude vendor"}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}
