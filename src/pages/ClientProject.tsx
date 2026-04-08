import { useMemo, useState } from "react";
import {
  ArrowRight,
  Filter as FilterIcon,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  PlusSquare,
  Search as SearchIcon,
} from "lucide-react";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { WorkspaceInlineSearch } from "@/components/workspace/WorkspaceInlineSearch";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildProjectAssigneeBadgeModel } from "@/features/quotes/project-assignee";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { getQuoteRequestStatusBadgeClassName } from "@/features/quotes/quote-request-status-badge";
import { getVendorDisplayName } from "@/features/quotes/vendor-colors";
import type { ClientQuoteRequestStatus } from "@/features/quotes/types";
import {
  clientFilterOptions,
  useClientProjectController,
} from "@/features/quotes/use-client-project-controller";
import { formatStatusLabel } from "@/features/quotes/utils";
import type { VendorName } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

function formatDateLabel(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(parsed));
}

function formatPropertyValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "—";
}

function formatQuoteQuantitiesLabel(values: number[] | null | undefined) {
  return values && values.length > 0 ? values.join(", ") : "—";
}

function formatCurrencyLabel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercentageLabel(value: number) {
  return `${Math.round(value)}%`;
}

function formatToleranceLabel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

  return `±${value.toFixed(4)} in`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readSpecSnapshotString(
  snapshot: Record<string, unknown> | null,
  key: string,
) {
  const value = snapshot?.[key];
  return typeof value === "string" ? value : null;
}

function readSpecSnapshotNumber(
  snapshot: Record<string, unknown> | null,
  key: string,
) {
  const value = snapshot?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type ProjectInspectorItem = {
  label: string;
  value: string;
};

type ProjectSummaryPartRow = {
  jobId: string;
  label: string;
  spendUsd: number;
  sharePercent: number;
  hasSelection: boolean;
  isCriticalPath: boolean;
};

type ProjectSummaryModel = {
  totalSpendUsd: number;
  criticalPathDays: number | null;
  criticalPathLabel: string | null;
  quotedCount: number;
  selectedCount: number;
  totalCount: number;
  unquotedCount: number;
  pendingSelectionCount: number;
  quotedPercent: number;
  selectedPercent: number;
  spendRows: ProjectSummaryPartRow[];
  dominantSpendLabel: string | null;
  dominantSpendPercent: number | null;
};

type ProjectSummaryPanelProps = {
  summary: ProjectSummaryModel;
  isLoading: boolean;
};

function formatPartCountLabel(count: number, suffix = "part") {
  return `${count} ${suffix}${count === 1 ? "" : "s"}`;
}

function buildProjectSummaryStatCards(summary: ProjectSummaryModel) {
  const selectedCountLabel = formatPartCountLabel(summary.selectedCount);
  const totalPartLabel = formatPartCountLabel(summary.totalCount);

  return [
    {
      label: "Total spend",
      value: formatCurrencyLabel(summary.totalSpendUsd),
      caption: summary.selectedCount > 0 ? `${selectedCountLabel} selected` : "No selections yet",
    },
    {
      label: "Critical path",
      value: summary.criticalPathDays === null ? "—" : `${summary.criticalPathDays} bd`,
      caption: summary.criticalPathLabel ? `Driven by ${summary.criticalPathLabel}` : "No selected lead times yet",
    },
    {
      label: "Quoted",
      value: formatPercentageLabel(summary.quotedPercent),
      caption: `${summary.quotedCount} of ${totalPartLabel}`,
    },
    {
      label: "Selections made",
      value: formatPercentageLabel(summary.selectedPercent),
      caption: `${summary.selectedCount} of ${totalPartLabel}`,
    },
  ];
}

function buildProjectSummaryBadgeModel(summary: ProjectSummaryModel, isLoading: boolean) {
  if (isLoading) {
    return {
      quoteCoverage: {
        className: "border border-white/10 bg-white/[0.03] text-white/60",
        label: "Loading quote coverage…",
      },
      selectionCoverage: {
        className: "border border-white/10 bg-white/[0.03] text-white/60",
        label: "Loading selections…",
      },
    };
  }

  const isEmpty = summary.totalCount === 0;

  if (isEmpty) {
    return {
      quoteCoverage: {
        className: "border border-white/10 bg-white/[0.03] text-white/60",
        label: "No parts",
      },
      selectionCoverage: {
        className: "border border-white/10 bg-white/[0.03] text-white/60",
        label: "No selections",
      },
    };
  }

  return {
    quoteCoverage:
      summary.unquotedCount > 0
        ? {
            className: "border border-amber-400/25 bg-amber-500/10 text-amber-100",
            label: `${formatPartCountLabel(summary.unquotedCount)} unquoted`,
          }
        : {
            className: "border border-emerald-400/25 bg-emerald-500/10 text-emerald-100",
            label: "All parts quoted",
          },
    selectionCoverage:
      summary.pendingSelectionCount > 0
        ? {
            className: "border border-white/10 bg-white/6 text-white/75",
            label: `${formatPartCountLabel(summary.pendingSelectionCount, "pending selection")}`,
          }
        : {
            className: "border border-emerald-400/25 bg-emerald-500/10 text-emerald-100",
            label: "All selections made",
          },
  };
}

function buildProjectSummaryCallouts(summary: ProjectSummaryModel) {
  const quoteCallout =
    summary.unquotedCount > 0
      ? `${formatPartCountLabel(summary.unquotedCount)}${summary.unquotedCount === 1 ? " has" : " have"} not been quoted yet.`
      : "Every part in this project has at least one quote.";
  const selectionCallout =
    summary.pendingSelectionCount > 0
      ? `${formatPartCountLabel(summary.pendingSelectionCount, "quoted part")}${summary.pendingSelectionCount === 1 ? " still needs" : " still need"} a selected option.`
      : "A selection has been made for every quoted part.";

  return [
    quoteCallout,
    selectionCallout,
    summary.criticalPathLabel && summary.criticalPathDays !== null
      ? `${summary.criticalPathLabel} sets the schedule at ${summary.criticalPathDays} business days.`
      : "Select at least one quote option to establish the current project critical path.",
  ];
}

function renderSpendDistributionLabel(row: ProjectSummaryPartRow) {
  if (row.isCriticalPath) {
    return "Critical path";
  }

  if (row.hasSelection) {
    return "Selected";
  }

  return "No selection";
}

function ProjectSummaryStatCards({ statCards }: Readonly<{ statCards: ReturnType<typeof buildProjectSummaryStatCards> }>) {
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {statCards.map((card) => (
        <div key={card.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">{card.label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">{card.value}</p>
          <p className="mt-2 text-sm text-white/55">{card.caption}</p>
        </div>
      ))}
    </div>
  );
}

function ProjectSummarySpendDistribution({ summary }: Readonly<{ summary: ProjectSummaryModel }>) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">Spend distribution</p>
          <p className="text-sm text-white/55">Selected quote share by part.</p>
        </div>
        {summary.dominantSpendLabel && summary.dominantSpendPercent !== null ? (
          <p className="text-sm text-white/60">
            {summary.dominantSpendLabel} is {formatPercentageLabel(summary.dominantSpendPercent)} of spend
          </p>
        ) : null}
      </div>

      {summary.spendRows.length > 0 ? (
        <div className="mt-4 space-y-3">
          {summary.spendRows.map((row) => (
            <div key={row.jobId} className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-white">{row.label}</p>
                  <p className="text-xs text-white/45">{renderSpendDistributionLabel(row)}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-white">{formatCurrencyLabel(row.spendUsd)}</p>
                  <p className="text-xs text-white/45">{formatPercentageLabel(row.sharePercent)}</p>
                </div>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className={cn("h-full rounded-full", row.isCriticalPath ? "bg-amber-300" : "bg-white/80")}
                  style={{ width: `${Math.max(row.sharePercent, 4)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm text-white/50">
          Select quote options to unlock spend distribution.
        </div>
      )}
    </div>
  );
}

function ProjectSummaryCallouts({ callouts }: Readonly<{ callouts: string[] }>) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-sm font-medium text-white">Summary callouts</p>
      <div className="mt-4 space-y-3 text-sm text-white/65">
        {callouts.map((callout) => (
          <p key={callout}>{callout}</p>
        ))}
      </div>
    </div>
  );
}

function ProjectSummaryPanel({ summary, isLoading }: Readonly<ProjectSummaryPanelProps>) {
  const statCards = buildProjectSummaryStatCards(summary);
  const badges = buildProjectSummaryBadgeModel(summary, isLoading);
  const callouts = buildProjectSummaryCallouts(summary);

  return (
    <section className="rounded-lg border border-ws-border-subtle bg-ws-card p-4" aria-label="Project summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Project summary</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-white">
            Budget, coverage, and schedule at a glance
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={badges.quoteCoverage.className}>{badges.quoteCoverage.label}</Badge>
          <Badge className={badges.selectionCoverage.className}>{badges.selectionCoverage.label}</Badge>
        </div>
      </div>

      <ProjectSummaryStatCards statCards={statCards} />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
        <ProjectSummarySpendDistribution summary={summary} />
        <ProjectSummaryCallouts callouts={callouts} />
      </div>
    </section>
  );
}

type ProjectInspectorContentProps = Readonly<{
  focusedJobId: string | null;
  focusedWorkspaceItem: ReturnType<typeof useClientProjectController>["focusedWorkspaceItem"];
  focusedInspectorModel: {
    description: string;
    partNumber: string;
    properties: ProjectInspectorItem[];
    project: ProjectInspectorItem[];
    quoteBadge: {
      label: string;
      status: ClientQuoteRequestStatus;
    } | null;
  } | null;
  focusedVendorPreferences: ReturnType<typeof useClientProjectController>["focusedVendorPreferences"];
  focusedVendorPreferencesErrorMessage: string | null;
  isVendorPreferenceLoading: boolean;
  isSavingVendorPreferences: boolean;
  onSetProjectVendorPreferences: (input: {
    jobId: string;
    includedVendors: VendorName[];
    excludedVendors: VendorName[];
  }) => Promise<void>;
  onSetJobVendorPreferences: (input: {
    jobId: string;
    includedVendors: VendorName[];
    excludedVendors: VendorName[];
  }) => Promise<void>;
  onClear: () => void;
  onOpenPartWorkspace: () => void;
}>;

type VendorPreferenceSelection = "default" | "pinned" | "excluded";
type VendorPreferenceScope = "project" | "job";
type VendorPreferenceTone = "default" | "pinned" | "excluded";

type VendorPreferenceState = {
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
};

const vendorPreferenceSelectionOptions: Array<{
  label: string;
  ariaSuffix: string;
  selection: VendorPreferenceSelection;
  tone: VendorPreferenceTone;
}> = [
  { label: "Default", ariaSuffix: "default", selection: "default", tone: "default" },
  { label: "Pin", ariaSuffix: "pin", selection: "pinned", tone: "pinned" },
  { label: "Exclude", ariaSuffix: "exclude", selection: "excluded", tone: "excluded" },
];

function resolveVendorPreferenceSelection(input: {
  vendor: VendorName;
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
}): VendorPreferenceSelection {
  if (input.includedVendors.includes(input.vendor)) {
    return "pinned";
  }

  if (input.excludedVendors.includes(input.vendor)) {
    return "excluded";
  }

  return "default";
}

function applyVendorPreferenceSelection(input: {
  vendor: VendorName;
  nextSelection: VendorPreferenceSelection;
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
}): {
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
} {
  const included = input.includedVendors.filter((vendor) => vendor !== input.vendor);
  const excluded = input.excludedVendors.filter((vendor) => vendor !== input.vendor);

  if (input.nextSelection === "pinned") {
    included.push(input.vendor);
  }

  if (input.nextSelection === "excluded") {
    excluded.push(input.vendor);
  }

  return {
    includedVendors: [...new Set(included)].sort((left, right) => left.localeCompare(right)),
    excludedVendors: [...new Set(excluded)].sort((left, right) => left.localeCompare(right)),
  };
}

function getPreferenceButtonClassName(isActive: boolean, tone: VendorPreferenceTone) {
  if (!isActive) {
    return "h-7 rounded-full border-white/10 bg-transparent px-2.5 text-[11px] text-white/55 hover:bg-white/6 hover:text-white";
  }

  if (tone === "pinned") {
    return "h-7 rounded-full border-emerald-400/40 bg-emerald-500/20 px-2.5 text-[11px] text-emerald-200 hover:bg-emerald-500/25";
  }

  if (tone === "excluded") {
    return "h-7 rounded-full border-rose-400/40 bg-rose-500/20 px-2.5 text-[11px] text-rose-200 hover:bg-rose-500/25";
  }

  return "h-7 rounded-full border-white/20 bg-white/10 px-2.5 text-[11px] text-white hover:bg-white/14";
}

type VendorPreferenceScopeCardProps = Readonly<{
  availableVendors: VendorName[];
  ariaPrefix: "Project" | "Part";
  heading: string;
  isSavingVendorPreferences: boolean;
  preferences: VendorPreferenceState;
  scope: VendorPreferenceScope;
  onUpdateVendorPreferences: (input: {
    scope: VendorPreferenceScope;
    vendor: VendorName;
    selection: VendorPreferenceSelection;
  }) => Promise<void>;
}>;

function VendorPreferenceScopeCard({
  availableVendors,
  ariaPrefix,
  heading,
  isSavingVendorPreferences,
  preferences,
  scope,
  onUpdateVendorPreferences,
}: VendorPreferenceScopeCardProps) {
  return (
    <div className="space-y-2 rounded-lg border border-white/10 bg-black/20 p-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-white/45">{heading}</p>
      {availableVendors.map((vendor) => {
        const selection = resolveVendorPreferenceSelection({
          vendor,
          includedVendors: preferences.includedVendors,
          excludedVendors: preferences.excludedVendors,
        });

        return (
          <div key={`${scope}-${vendor}`} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-white">{getVendorDisplayName(vendor)}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {vendorPreferenceSelectionOptions.map((option) => (
                <Button
                  key={`${scope}-${vendor}-${option.selection}`}
                  type="button"
                  variant="outline"
                  className={getPreferenceButtonClassName(selection === option.selection, option.tone)}
                  disabled={isSavingVendorPreferences}
                  onClick={() => {
                    void onUpdateVendorPreferences({
                      scope,
                      vendor,
                      selection: option.selection,
                    });
                  }}
                  aria-label={`${ariaPrefix} ${getVendorDisplayName(vendor)} ${option.ariaSuffix}`}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type VendorPreferencePanelProps = Readonly<{
  availableVendors: VendorName[];
  errorMessage: string | null;
  isSavingVendorPreferences: boolean;
  isVendorPreferenceLoading: boolean;
  jobVendorPreferences: VendorPreferenceState;
  projectVendorPreferences: VendorPreferenceState;
  onUpdateVendorPreferences: (input: {
    scope: VendorPreferenceScope;
    vendor: VendorName;
    selection: VendorPreferenceSelection;
  }) => Promise<void>;
}>;

function VendorPreferencePanel({
  availableVendors,
  errorMessage,
  isSavingVendorPreferences,
  isVendorPreferenceLoading,
  jobVendorPreferences,
  projectVendorPreferences,
  onUpdateVendorPreferences,
}: VendorPreferencePanelProps) {
  if (isVendorPreferenceLoading) {
    return <p className="text-xs text-white/45">Loading vendor preference controls…</p>;
  }

  if (errorMessage) {
    return <p className="text-xs text-rose-300/90">{errorMessage}</p>;
  }

  if (availableVendors.length === 0) {
    return <p className="text-xs text-white/45">No client quote vendors are enabled for this organization.</p>;
  }

  return (
    <div className="space-y-4">
      <VendorPreferenceScopeCard
        availableVendors={availableVendors}
        ariaPrefix="Project"
        heading="Project defaults"
        isSavingVendorPreferences={isSavingVendorPreferences}
        preferences={projectVendorPreferences}
        scope="project"
        onUpdateVendorPreferences={onUpdateVendorPreferences}
      />
      <VendorPreferenceScopeCard
        availableVendors={availableVendors}
        ariaPrefix="Part"
        heading="This part override"
        isSavingVendorPreferences={isSavingVendorPreferences}
        preferences={jobVendorPreferences}
        scope="job"
        onUpdateVendorPreferences={onUpdateVendorPreferences}
      />
    </div>
  );
}

function ProjectInspectorContent({
  focusedJobId,
  focusedWorkspaceItem,
  focusedInspectorModel,
  focusedVendorPreferences,
  focusedVendorPreferencesErrorMessage,
  isVendorPreferenceLoading,
  isSavingVendorPreferences,
  onSetProjectVendorPreferences,
  onSetJobVendorPreferences,
  onClear,
  onOpenPartWorkspace,
}: ProjectInspectorContentProps) {
  const availableVendors = focusedVendorPreferences?.availableVendors ?? [];
  const projectVendorPreferences = focusedVendorPreferences?.projectVendorPreferences ?? {
    includedVendors: [] as VendorName[],
    excludedVendors: [] as VendorName[],
    updatedAt: null,
  };
  const jobVendorPreferences = focusedVendorPreferences?.jobVendorPreferences ?? {
    includedVendors: [] as VendorName[],
    excludedVendors: [] as VendorName[],
    updatedAt: null,
  };

  const updateVendorPreferences = async (input: {
    scope: VendorPreferenceScope;
    vendor: VendorName;
    selection: VendorPreferenceSelection;
  }) => {
    if (!focusedJobId) {
      return;
    }

    try {
      if (input.scope === "project") {
        const nextState = applyVendorPreferenceSelection({
          vendor: input.vendor,
          nextSelection: input.selection,
          includedVendors: projectVendorPreferences.includedVendors,
          excludedVendors: projectVendorPreferences.excludedVendors,
        });

        await onSetProjectVendorPreferences({
          jobId: focusedJobId,
          includedVendors: nextState.includedVendors,
          excludedVendors: nextState.excludedVendors,
        });
        return;
      }

      const nextState = applyVendorPreferenceSelection({
        vendor: input.vendor,
        nextSelection: input.selection,
        includedVendors: jobVendorPreferences.includedVendors,
        excludedVendors: jobVendorPreferences.excludedVendors,
      });

      await onSetJobVendorPreferences({
        jobId: focusedJobId,
        includedVendors: nextState.includedVendors,
        excludedVendors: nextState.excludedVendors,
      });
    } catch {
      return;
    }
  };

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Inspector</p>
          {focusedJobId && focusedWorkspaceItem ? (
            <>
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-white">
                {focusedInspectorModel?.partNumber ??
                  focusedWorkspaceItem.part?.approvedRequirement?.part_number ??
                  focusedWorkspaceItem.summary?.partNumber ??
                  focusedWorkspaceItem.part?.name ??
                  focusedWorkspaceItem.job.title}
              </h2>
              <p className="text-sm text-white/55">
                {focusedInspectorModel?.description ??
                  focusedWorkspaceItem.part?.approvedRequirement?.description ??
                  focusedWorkspaceItem.summary?.description ??
                  focusedWorkspaceItem.part?.name ??
                  "Quick preview for the selected part."}
              </p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-white">No part selected</h2>
              <p className="text-sm text-white/55">
                Select a row in the ledger to inspect that part without leaving the project workspace.
              </p>
            </>
          )}
        </div>
        {focusedJobId ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 rounded-full px-3 text-white/65 hover:bg-white/6 hover:text-white"
            onClick={onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>

      <div className="mt-4 space-y-3">
        <details open className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-white marker:content-none">
            Properties
          </summary>
          <div className="border-t border-white/10 px-4 py-3 text-sm text-white/55">
            {focusedInspectorModel ? (
              <div className="space-y-2">
                {focusedInspectorModel.properties.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-start justify-between gap-4 border-b border-white/[0.05] pb-2 last:border-0 last:pb-0"
                  >
                    <span className="text-white/45">{item.label}</span>
                    <span className="text-right font-medium text-white">{item.value}</span>
                  </div>
                ))}
              </div>
            ) : (
              "Properties details appear here after you select a part."
            )}
          </div>
        </details>

        <details open className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-white marker:content-none">
            Project
          </summary>
          <div className="border-t border-white/10 px-4 py-3 text-sm text-white/55">
            {focusedInspectorModel ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  {focusedInspectorModel.project.map((item) => (
                    <div
                      key={item.label}
                      className="flex items-start justify-between gap-4 border-b border-white/[0.05] pb-2 last:border-0 last:pb-0"
                    >
                      <span className="text-white/45">{item.label}</span>
                      <span className="text-right font-medium text-white">{item.value}</span>
                    </div>
                  ))}
                </div>

                {focusedInspectorModel.quoteBadge ? (
                  <div className="space-y-2">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Quote status</p>
                    <Badge className={getQuoteRequestStatusBadgeClassName(focusedInspectorModel.quoteBadge.status)}>
                      {focusedInspectorModel.quoteBadge.label}
                    </Badge>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Vendor preferences</p>
                  <VendorPreferencePanel
                    availableVendors={availableVendors}
                    errorMessage={focusedVendorPreferencesErrorMessage}
                    isSavingVendorPreferences={isSavingVendorPreferences}
                    isVendorPreferenceLoading={isVendorPreferenceLoading}
                    jobVendorPreferences={jobVendorPreferences}
                    projectVendorPreferences={projectVendorPreferences}
                    onUpdateVendorPreferences={updateVendorPreferences}
                  />
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={onOpenPartWorkspace}
                >
                  Full workspace
                </Button>
              </div>
            ) : (
              "Project details appear here after you select a part."
            )}
          </div>
        </details>
      </div>
    </>
  );
}

const ClientProject = () => {
  const {
    activeFilter,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    canManageMembers,
    filteredJobs,
    dissolveProjectMutation,
    handleAddPartSubmit,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleClearFocusedJob,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleInviteProjectMember,
    handleOpenJobDrawer,
    handlePinPart,
    handlePinProject,
    handleRemovePartFromProject,
    handleRemoveProjectMember,
    handleRenameProject,
    handleRequestProjectQuotes,
    handleSetJobVendorPreferences,
    handleSetProjectVendorPreferences,
    handleToggleInspector,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    navigate,
    newJobFilePicker,
    prefetchPart,
    prefetchProject,
    projectCollaborationUnavailable,
    projectId,
    projectInvitesQuery,
    projectJobs,
    projectJobsQuery,
    projectMembershipsQuery,
    projectName,
    projectQuery,
    projectWorkspaceItemsQuery,
    projectPartCount,
    resolveSidebarProjectIdsForJob,
    requestProjectQuotesMutation,
    setActiveFilter,
    isSearchOpen,
    setIsSearchOpen,
    setProjectName,
    setShowAddPart,
    setShowArchive,
    setShowDissolve,
    setShowMembers,
    setShowRename,
    showAddPart,
    showArchive,
    showDissolve,
    showMembers,
    showRename,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    updateProjectMutation,
    user,
    accessibleJobs,
    accessibleProjects,
    isAuthInitializing,
    isInspectorOpen,
    workspaceItemsByJobId,
    projectAssigneeLookupReady,
    projectAssigneesByUserId,
    projectJobMembershipsByCompositeKey,
    focusedJobId,
    focusedVendorPreferences,
    focusedVendorPreferencesErrorMessage,
    focusedWorkspaceItem,
    isMobile,
    isSavingVendorPreferences,
    isVendorPreferenceLoading,
    mobileDrawerOpen,
    setMobileDrawerOpen,
  } = useClientProjectController();
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  const notificationCenter = useWorkspaceNotifications({
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const navigateToPartDestination = (jobId: string) => {
    const job = accessibleJobs.find((candidate) => candidate.id === jobId);
    const projectIdForPart = job ? resolveSidebarProjectIdsForJob(job)[0] ?? null : null;

    if (projectIdForPart) {
      navigate(`/projects/${projectIdForPart}?part=${jobId}`);
      return;
    }

    navigate(`/parts/${jobId}`);
  };
  const navigateToPartWorkspace = (jobId: string) => {
    navigate(`/parts/${jobId}`);
  };

  const quoteRequestViewModelsByJobId = useMemo(
    () =>
      new Map(
        projectJobs.map((job) => {
          const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;

          return [
            job.id,
            buildQuoteRequestViewModel({
              job,
              part: workspaceItem?.part ?? null,
              latestQuoteRequest: workspaceItem?.latestQuoteRequest ?? null,
              latestQuoteRun: workspaceItem?.latestQuoteRun ?? null,
            }),
          ] as const;
        }),
      ),
    [projectJobs, workspaceItemsByJobId],
  );

  const projectAssigneeBadgesByJobId = useMemo(() => {
    if (!projectAssigneeLookupReady) {
      return new Map<string, ReturnType<typeof buildProjectAssigneeBadgeModel>>();
    }

    // Until a dedicated part-assignee relation exists, the ledger uses
    // project_jobs.created_by as the minimum safe per-row assignee source.
    return new Map(
      projectJobs.map((job) => {
        const projectJobMembership =
          projectJobMembershipsByCompositeKey?.get(`${projectId}:${job.id}`) ?? null;
        const assigneeProfile =
          projectJobMembership && projectAssigneesByUserId
            ? projectAssigneesByUserId.get(projectJobMembership.created_by) ?? null
            : null;

        return [job.id, buildProjectAssigneeBadgeModel(assigneeProfile)] as const;
      }),
    );
  }, [
    projectAssigneeLookupReady,
    projectAssigneesByUserId,
    projectId,
    projectJobMembershipsByCompositeKey,
    projectJobs,
  ]);

  const projectRequestableJobIds = useMemo(
    () =>
      projectJobs
        .map((job) => [job.id, quoteRequestViewModelsByJobId.get(job.id) ?? null] as const)
        .filter(
          (entry): entry is readonly [string, NonNullable<typeof entry[1]>] =>
            Boolean(entry[1]) &&
            entry[1]!.action.kind === "request" &&
            !entry[1]!.action.disabled,
        )
        .map(([jobId]) => jobId),
    [projectJobs, quoteRequestViewModelsByJobId],
  );

  const projectQuoteRequestSummary = useMemo(
    () =>
      Array.from(quoteRequestViewModelsByJobId.values()).reduce(
        (summary, model) => {
          switch (model.status) {
            case "queued":
            case "requesting":
              summary.requesting += 1;
              break;
            case "received":
              summary.received += 1;
              break;
            case "failed":
            case "canceled":
              summary.needsAttention += 1;
              break;
            case "not_requested":
            default:
              summary.notRequested += 1;
              break;
          }

          return summary;
        },
        {
          received: 0,
          requesting: 0,
          notRequested: 0,
          needsAttention: 0,
        },
      ),
    [quoteRequestViewModelsByJobId],
  );

  const projectSummaryPanel = useMemo<ProjectSummaryModel>(() => {
    const partRows = projectJobs.map((job) => {
      const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
      const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
      const presentation = getClientItemPresentation(job, summary);
      const selectedSpendUsd = summary?.selectedPriceUsd ?? null;
      const selectedLeadTimeBusinessDays = summary?.selectedLeadTimeBusinessDays ?? null;
      const hasSelection =
        summary?.selectedSupplier !== null &&
        selectedSpendUsd !== null &&
        selectedSpendUsd !== undefined;
      const hasQuotes =
        hasSelection ||
        (workspaceItem?.part?.vendorQuotes.length ?? 0) > 0 ||
        (quoteRequestViewModelsByJobId.get(job.id)?.status ?? "not_requested") === "received";

      return {
        jobId: job.id,
        label: presentation.partNumber ?? presentation.title,
        selectedSpendUsd,
        selectedLeadTimeBusinessDays,
        hasQuotes,
        hasSelection,
      };
    });

    const totalCount = partRows.length;
    const quotedCount = partRows.filter((row) => row.hasQuotes).length;
    const selectedRows = partRows.filter((row) => row.hasSelection && row.selectedSpendUsd !== null);
    const selectedCount = selectedRows.length;
    const totalSpendUsd = selectedRows.reduce((sum, row) => sum + (row.selectedSpendUsd ?? 0), 0);
    const criticalPathRow = selectedRows.reduce<typeof selectedRows[number] | null>((current, row) => {
      if (row.selectedLeadTimeBusinessDays === null || row.selectedLeadTimeBusinessDays === undefined) {
        return current;
      }

      if (!current || (current.selectedLeadTimeBusinessDays ?? -1) < row.selectedLeadTimeBusinessDays) {
        return row;
      }

      return current;
    }, null);
    const spendRows = selectedRows
      .map<ProjectSummaryPartRow>((row) => ({
        jobId: row.jobId,
        label: row.label,
        spendUsd: row.selectedSpendUsd ?? 0,
        sharePercent: totalSpendUsd > 0 ? ((row.selectedSpendUsd ?? 0) / totalSpendUsd) * 100 : 0,
        hasSelection: row.hasSelection,
        isCriticalPath: criticalPathRow?.jobId === row.jobId,
      }))
      .sort((left, right) => right.spendUsd - left.spendUsd || left.label.localeCompare(right.label));
    const dominantSpendRow = spendRows[0] ?? null;

    return {
      totalSpendUsd,
      criticalPathDays: criticalPathRow?.selectedLeadTimeBusinessDays ?? null,
      criticalPathLabel: criticalPathRow?.label ?? null,
      quotedCount,
      selectedCount,
      totalCount,
      unquotedCount: Math.max(totalCount - quotedCount, 0),
      pendingSelectionCount: Math.max(quotedCount - selectedCount, 0),
      quotedPercent: totalCount > 0 ? (quotedCount / totalCount) * 100 : 0,
      selectedPercent: totalCount > 0 ? (selectedCount / totalCount) * 100 : 0,
      spendRows,
      dominantSpendLabel: dominantSpendRow?.label ?? null,
      dominantSpendPercent: dominantSpendRow?.sharePercent ?? null,
    };
  }, [projectJobs, quoteRequestViewModelsByJobId, summariesByJobId, workspaceItemsByJobId]);

  const activeFilterOption = useMemo(
    () => clientFilterOptions.find((filter) => filter.id === activeFilter) ?? clientFilterOptions[0],
    [activeFilter],
  );

  const jobSearchTextById = useMemo(
    () =>
      new Map(
        Array.from(workspaceItemsByJobId.entries()).map(([jobId, item]) => {
          const requirement = item.part?.clientRequirement;
          const approvedRequirement = item.part?.approvedRequirement;

          return [
            jobId,
            [
              requirement?.material ?? approvedRequirement?.material ?? "",
              requirement?.finish ?? approvedRequirement?.finish ?? "",
              requirement?.process ?? "",
              requirement?.notes ?? "",
              item.summary?.serviceNotes ?? "",
            ]
              .join(" ")
              .trim(),
          ];
        }),
      ),
    [workspaceItemsByJobId],
  );

  const focusedInspectorModel = useMemo(() => {
    if (!focusedJobId || !focusedWorkspaceItem) {
      return null;
    }

    const job = focusedWorkspaceItem.job;
    const part = focusedWorkspaceItem.part;
    const summary = focusedWorkspaceItem.summary;
    const approvedRequirement = part?.approvedRequirement ?? null;
    const clientRequirement = part?.clientRequirement ?? null;
    const specSnapshot = asRecord(approvedRequirement?.spec_snapshot);
    const quoteRequestViewModel = quoteRequestViewModelsByJobId.get(focusedJobId) ?? null;

    const partNumber =
      approvedRequirement?.part_number ??
      clientRequirement?.partNumber ??
      summary?.partNumber ??
      part?.name ??
      job.title;
    const description =
      approvedRequirement?.description ??
      clientRequirement?.description ??
      summary?.description ??
      part?.name ??
      job.title;
    const material = clientRequirement?.material ?? approvedRequirement?.material ?? null;
    const finish =
      clientRequirement?.finish ??
      approvedRequirement?.finish ??
      readSpecSnapshotString(specSnapshot, "quoteFinish") ??
      null;
    const threads =
      readSpecSnapshotString(specSnapshot, "threads") ?? readSpecSnapshotString(specSnapshot, "thread") ?? null;
    const specSnapshotToleranceLabel = readSpecSnapshotString(specSnapshot, "tightest_tolerance");
    const rawToleranceValue =
      clientRequirement?.tightestToleranceInch ??
      approvedRequirement?.tightest_tolerance_inch ??
      readSpecSnapshotNumber(specSnapshot, "tightest_tolerance");
    const formattedTolerance = formatToleranceLabel(rawToleranceValue);
    const tightestTolerance =
      formattedTolerance !== "—"
        ? formattedTolerance
        : formatPropertyValue(specSnapshotToleranceLabel);

    const quoteBadge = quoteRequestViewModel
      ? {
          label: quoteRequestViewModel.label,
          status: quoteRequestViewModel.status,
        }
      : null;

    return {
      description,
      partNumber,
      properties: [
        { label: "Material", value: formatPropertyValue(material) },
        { label: "Finish", value: formatPropertyValue(finish) },
        { label: "Threads", value: formatPropertyValue(threads) },
        { label: "Tightest tolerance", value: tightestTolerance },
        { label: "Part number", value: formatPropertyValue(partNumber) },
        { label: "Description", value: formatPropertyValue(description) },
      ],
      project: [
        { label: "Project", value: formatPropertyValue(projectQuery.data?.name ?? projectName ?? "Project") },
        { label: "Project parts", value: String(projectPartCount) },
        {
          label: "Quote quantities",
          value: formatQuoteQuantitiesLabel(
            summary?.requestedQuoteQuantities ??
              clientRequirement?.quoteQuantities ??
              approvedRequirement?.quote_quantities,
          ),
        },
        {
          label: "Need by",
          value: formatPropertyValue(
            summary?.requestedByDate ??
              clientRequirement?.requestedByDate ??
              approvedRequirement?.requested_by_date,
          ),
        },
      ],
      quoteBadge,
    };
  }, [
    focusedJobId,
    focusedWorkspaceItem,
    projectPartCount,
    projectName,
    projectQuery.data?.name,
    quoteRequestViewModelsByJobId,
  ]);

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your project workspace." />;
  }

  if (!user) {
    return null;
  }

  const scopedProject = projectQuery.data
    ? {
        id: projectId,
        name: projectQuery.data.name,
        partCount: projectJobs.length,
      }
    : null;

  return (
    <>
      <ClientWorkspaceShell
        onLogoClick={() => navigate("/")}
        headerContent={
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-white/[0.94]">
            {projectQuery.data?.name ?? "Project"}
          </span>
        }
        topRightContent={
          <WorkspaceInlineSearch
            className="w-full md:w-[360px] md:max-w-[42vw]"
            projects={accessibleProjects.map((project) => ({
              id: project.project.id,
              name: project.project.name,
              partCount: project.partCount,
            }))}
            jobs={accessibleJobs}
            summariesByJobId={summariesByJobId}
            jobSearchTextById={jobSearchTextById}
            scopedProject={scopedProject}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
            onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
            onSelectPart={navigateToPartDestination}
          />
        }
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: SearchIcon, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobs}
            summariesByJobId={summariesByJobId}
            activeProjectId={projectId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={projectCollaborationUnavailable ? undefined : newJobFilePicker.openFilePicker}
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user.id}
            pinnedProjectIds={sidebarPinsQuery.data?.projectIds ?? []}
            pinnedJobIds={sidebarPinsQuery.data?.jobIds ?? []}
            onPinProject={handlePinProject}
            onUnpinProject={handleUnpinProject}
            onPinPart={handlePinPart}
            onUnpinPart={handleUnpinPart}
            onAssignPartToProject={handleAssignPartToProject}
            onRemovePartFromProject={handleRemovePartFromProject}
            onCreateProjectFromSelection={
              projectCollaborationUnavailable ? undefined : handleCreateProjectFromSelection
            }
            onRenameProject={handleRenameProject}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
            onSelectPart={navigateToPartWorkspace}
            onPrefetchProject={prefetchProject}
            onPrefetchPart={prefetchPart}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
          />
        }
        sidebarFooter={
          <WorkspaceAccountMenu
            user={user}
            activeMembership={activeMembership}
            notificationCenter={notificationCenter}
            onSignOut={signOut}
            onSignedOut={() => navigate("/", { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
            onUnarchivePart={handleUnarchivePart}
            onDeleteArchivedParts={handleDeleteArchivedParts}
          />
        }
      >
        <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white">
              {projectQuery.data?.name ?? "Project"}
            </h1>
            <p className="mt-2 text-sm text-white/55">
              Review every part in this project from a single dense ledger view.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge className="border border-white/10 bg-white/6 text-white/70">Parts: {projectPartCount}</Badge>
              {projectQuoteRequestSummary.received > 0 ? (
                <Badge className={getQuoteRequestStatusBadgeClassName("received")}>
                  Quoted: {projectQuoteRequestSummary.received}
                </Badge>
              ) : null}
              {projectQuoteRequestSummary.requesting > 0 ? (
                <Badge className={getQuoteRequestStatusBadgeClassName("requesting")}>
                  Requesting: {projectQuoteRequestSummary.requesting}
                </Badge>
              ) : null}
              {projectQuoteRequestSummary.notRequested > 0 ? (
                <Badge className={getQuoteRequestStatusBadgeClassName("not_requested")}>
                  Not requested: {projectQuoteRequestSummary.notRequested}
                </Badge>
              ) : null}
              {projectQuoteRequestSummary.needsAttention > 0 ? (
                <Badge className="border border-rose-400/20 bg-rose-500/10 text-rose-100">
                  Needs attention: {projectQuoteRequestSummary.needsAttention}
                </Badge>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!projectCollaborationUnavailable ? (
                <Button type="button" className="rounded-full" onClick={() => setShowAddPart(true)}>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  Add parts
                </Button>
              ) : null}
              <Button
                type="button"
                className="rounded-full"
                disabled={requestProjectQuotesMutation.isPending || projectRequestableJobIds.length === 0}
                onClick={() => {
                  void handleRequestProjectQuotes(projectRequestableJobIds);
                }}
              >
                {requestProjectQuotesMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {projectRequestableJobIds.length > 0
                  ? `Request ${projectRequestableJobIds.length} quote${projectRequestableJobIds.length === 1 ? "" : "s"}`
                  : "Request quotes"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => setShowMembers(true)}
              >
                Share
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-expanded={isFilterPanelOpen}
                  aria-pressed={activeFilter !== "all"}
                  className={cn(
                    "rounded-full border-white/10 bg-transparent text-white hover:bg-white/6",
                    (isFilterPanelOpen || activeFilter !== "all") && "border-white/20 bg-white/10",
                  )}
                  onClick={() => setIsFilterPanelOpen((current) => !current)}
                >
                  <FilterIcon className="mr-2 h-4 w-4" />
                  {activeFilter === "all" ? "Filter" : `Filter: ${activeFilterOption.label}`}
                </Button>
                {isFilterPanelOpen ? (
                  clientFilterOptions.map((filter) => (
                    <Button
                      key={filter.id}
                      type="button"
                      variant="outline"
                      className={cn(
                        "rounded-full border-white/10 bg-transparent text-white hover:bg-white/6",
                        activeFilter === filter.id && "border-white/20 bg-white/10",
                      )}
                      onClick={() => setActiveFilter(filter.id)}
                    >
                      {filter.label}
                    </Button>
                  ))
                ) : activeFilter !== "all" ? (
                  <Badge className="border border-white/10 bg-white/6 text-white/70">
                    {activeFilterOption.label}
                  </Badge>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                aria-label={isInspectorOpen ? "Hide inspector" : "Show inspector"}
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={handleToggleInspector}
              >
                {isInspectorOpen ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <ProjectSummaryPanel
            summary={projectSummaryPanel}
            isLoading={projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading}
          />

          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-ws-border-subtle bg-ws-card">
              {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                <div className="flex min-h-[240px] items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                </div>
              ) : filteredJobs.length === 0 ? (
                <div className="px-6 py-12 text-center text-white/45">No parts match the current project filter.</div>
              ) : (
                <Table className="w-full min-w-[640px] text-white">
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent">
                      <TableHead className="h-10 px-5 py-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        Part Number
                      </TableHead>
                      <TableHead className="h-10 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        Description
                      </TableHead>
                      <TableHead className="h-10 px-2 py-2 text-center text-[11px] uppercase tracking-[0.18em] text-white/45">
                        CAD
                      </TableHead>
                      <TableHead className="h-10 px-2 py-2 text-center text-[11px] uppercase tracking-[0.18em] text-white/45">
                        DWG
                      </TableHead>
                      <TableHead className="h-10 px-2 py-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        Quote
                      </TableHead>
                      <TableHead className="h-10 px-2 py-2 text-[11px] uppercase tracking-[0.18em] text-white/45">
                        Assignee
                      </TableHead>
                      <TableHead className="h-10 py-2 pl-2 pr-5 text-right text-[11px] uppercase tracking-[0.18em] text-white/45">
                        Creation Date
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredJobs.map((job) => {
                      const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                      const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                      const presentation = getClientItemPresentation(job, summary);
                      const quoteRequestViewModel = quoteRequestViewModelsByJobId.get(job.id) ?? null;
                      const quoteStatusLabel = quoteRequestViewModel?.label ?? formatStatusLabel(job.status);
                      const quoteStatusClassName = getQuoteRequestStatusBadgeClassName(
                        quoteRequestViewModel?.status ?? "not_requested",
                      );
                      const partNumber =
                        workspaceItem?.part?.approvedRequirement?.part_number ?? presentation.partNumber ?? "—";
                      const description =
                        workspaceItem?.part?.approvedRequirement?.description ??
                        presentation.description ??
                        presentation.title;
                      const assigneeBadge = projectAssigneeBadgesByJobId.get(job.id) ?? null;
                      const isSelected = focusedJobId === job.id;

                      return (
                        <TableRow
                          key={job.id}
                          aria-selected={isSelected}
                          data-state={isSelected ? "selected" : "idle"}
                          className={cn(
                            "cursor-pointer border-white/[0.04] transition-colors",
                            isSelected
                              ? "bg-white/[0.08] shadow-[inset_3px_0_0_rgba(255,255,255,0.92)] hover:bg-white/[0.09]"
                              : "hover:bg-white/[0.02]",
                          )}
                          onClick={() => handleOpenJobDrawer(job.id)}
                          onDoubleClick={() => navigate(`/parts/${job.id}`)}
                        >
                          <TableCell className="w-[18%] max-w-[220px] px-5 py-2.5">
                            <p className="truncate text-[13px] font-medium text-white">{partNumber}</p>
                          </TableCell>
                          <TableCell className="max-w-[420px] px-4 py-2.5">
                            <p className="truncate text-[13px] text-white/65">{description}</p>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5 text-center">
                            <Badge
                              className={
                                workspaceItem?.part?.cadFile
                                  ? "border border-emerald-400/30 bg-emerald-500/20 text-emerald-300"
                                  : "border border-white/10 bg-white/6 text-white/30"
                              }
                            >
                              {workspaceItem?.part?.cadFile ? "Yes" : "No"}
                            </Badge>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5 text-center">
                            <Badge
                              className={
                                workspaceItem?.part?.drawingFile
                                  ? "border border-emerald-400/30 bg-emerald-500/20 text-emerald-300"
                                  : "border border-white/10 bg-white/6 text-white/30"
                              }
                            >
                              {workspaceItem?.part?.drawingFile ? "Yes" : "No"}
                            </Badge>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5">
                            <Badge className={quoteStatusClassName}>{quoteStatusLabel}</Badge>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5">
                            {assigneeBadge ? (
                              assigneeBadge.isUnassigned ? (
                                <div className="flex items-center gap-2 text-[13px] text-white/45">
                                  <span
                                    aria-hidden="true"
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-white/10 bg-white/[0.03] text-[11px] font-semibold text-white/35"
                                  >
                                    —
                                  </span>
                                  <span>Unassigned</span>
                                </div>
                              ) : (
                                <div className="flex justify-center">
                                  <span
                                    className={cn(
                                      "inline-flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold uppercase tracking-[0.08em] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
                                      assigneeBadge.colorClassName,
                                    )}
                                    title={assigneeBadge.displayName}
                                    aria-label={`${assigneeBadge.displayName} assignee`}
                                  >
                                    {assigneeBadge.initials ?? "?"}
                                  </span>
                                </div>
                              )
                            ) : (
                              <span
                                aria-hidden="true"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-white/10 bg-white/[0.03] text-[11px] font-semibold text-white/35"
                              >
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap py-2.5 pl-2 pr-5 text-right text-[13px] text-white/55">
                            {formatDateLabel(job.created_at)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>

            {isInspectorOpen && !isMobile ? (
              <aside
                aria-label="Project inspector"
                className="w-full shrink-0 rounded-lg border border-ws-border-subtle bg-ws-card p-4 xl:sticky xl:top-4 xl:w-[320px]"
              >
                <ProjectInspectorContent
                  focusedJobId={focusedJobId}
                  focusedWorkspaceItem={focusedWorkspaceItem}
                  focusedInspectorModel={focusedInspectorModel}
                  focusedVendorPreferences={focusedVendorPreferences}
                  focusedVendorPreferencesErrorMessage={focusedVendorPreferencesErrorMessage}
                  isVendorPreferenceLoading={isVendorPreferenceLoading}
                  isSavingVendorPreferences={isSavingVendorPreferences}
                  onSetProjectVendorPreferences={handleSetProjectVendorPreferences}
                  onSetJobVendorPreferences={handleSetJobVendorPreferences}
                  onClear={handleClearFocusedJob}
                  onOpenPartWorkspace={() => {
                    if (focusedJobId) {
                      navigate(`/parts/${focusedJobId}`);
                    }
                  }}
                />
              </aside>
            ) : null}
          </div>
        </div>
      </ClientWorkspaceShell>

      {isInspectorOpen && isMobile ? (
        <Sheet open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
          <SheetContent
            side="bottom"
            className="h-[min(85vh,42rem)] overflow-y-auto border-white/10 bg-ws-card px-4 pb-6 pt-10 text-white sm:max-w-none"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Project inspector</SheetTitle>
              <SheetDescription>Inspect the currently selected part inside the project workspace.</SheetDescription>
            </SheetHeader>
            <ProjectInspectorContent
              focusedJobId={focusedJobId}
              focusedWorkspaceItem={focusedWorkspaceItem}
              focusedInspectorModel={focusedInspectorModel}
              focusedVendorPreferences={focusedVendorPreferences}
              focusedVendorPreferencesErrorMessage={focusedVendorPreferencesErrorMessage}
              isVendorPreferenceLoading={isVendorPreferenceLoading}
              isSavingVendorPreferences={isSavingVendorPreferences}
              onSetProjectVendorPreferences={handleSetProjectVendorPreferences}
              onSetJobVendorPreferences={handleSetJobVendorPreferences}
              onClear={handleClearFocusedJob}
              onOpenPartWorkspace={() => {
                if (focusedJobId) {
                  navigate(`/parts/${focusedJobId}`);
                }
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobs}
        summariesByJobId={summariesByJobId}
        onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
        onSelectPart={navigateToPartDestination}
      />

      <input
        ref={newJobFilePicker.inputRef}
        type="file"
        multiple
        accept={newJobFilePicker.accept}
        onChange={(event) => {
          void newJobFilePicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Create new job from files"
      />

      <Dialog open={showAddPart} onOpenChange={setShowAddPart}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Add part</DialogTitle>
            <DialogDescription className="text-white/55">
              Create a new draft directly inside this project.
            </DialogDescription>
          </DialogHeader>
          <PromptComposer isSignedIn={Boolean(user)} onSubmit={handleAddPartSubmit} />
        </DialogContent>
      </Dialog>

      <ProjectNameDialog
        open={showRename}
        onOpenChange={setShowRename}
        title="Rename project"
        description="Update the project name shown throughout this project workspace."
        value={projectName}
        onValueChange={setProjectName}
        submitLabel="Save"
        isPending={updateProjectMutation.isPending}
        isSubmitDisabled={projectName.trim().length === 0}
        onSubmit={() => updateProjectMutation.mutate(projectName.trim())}
      />

      <Dialog open={showArchive} onOpenChange={setShowArchive}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Archive project</DialogTitle>
            <DialogDescription className="text-white/55">
              Parts only in this project will also be archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowArchive(false)}
            >
              Cancel
            </Button>
            <Button disabled={archiveProjectMutation.isPending} onClick={() => archiveProjectMutation.mutate()}>
              {archiveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDissolve} onOpenChange={setShowDissolve}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Dissolve project</DialogTitle>
            <DialogDescription className="text-white/55">
              This deletes the project and leaves its parts in the main Parts list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowDissolve(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={dissolveProjectMutation.isPending}
              onClick={() => dissolveProjectMutation.mutate()}
            >
              {dissolveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Dissolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectMembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        currentUserId={user.id}
        memberships={projectMembershipsQuery.data ?? []}
        invites={projectInvitesQuery.data ?? []}
        canManage={canManageMembers}
        onInvite={handleInviteProjectMember}
        onRemoveMembership={handleRemoveProjectMember}
      />
    </>
  );
};

export default ClientProject;
