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
import type { ClientQuoteRequestStatus } from "@/features/quotes/types";
import {
  clientFilterOptions,
  useClientProjectController,
} from "@/features/quotes/use-client-project-controller";
import { formatStatusLabel } from "@/features/quotes/utils";
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

type ProjectInspectorContentProps = {
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
  onClear: () => void;
  onOpenPartWorkspace: () => void;
};

function ProjectInspectorContent({
  focusedJobId,
  focusedWorkspaceItem,
  focusedInspectorModel,
  onClear,
  onOpenPartWorkspace,
}: ProjectInspectorContentProps) {
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
                  "Inspector shell only until OVD-81c wires real content."}
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

                <Button
                  type="button"
                  variant="outline"
                  className="w-full rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={onOpenPartWorkspace}
                >
                  Open part workspace
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
    focusedWorkspaceItem,
    isMobile,
    mobileDrawerOpen,
    setMobileDrawerOpen,
  } = useClientProjectController();
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  const notificationCenter = useWorkspaceNotifications({
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

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
        { label: "Project parts", value: String(projectJobs.length) },
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
    projectJobs.length,
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
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
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
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
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
              <Badge className="border border-white/10 bg-white/6 text-white/70">Parts: {projectJobs.length}</Badge>
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
        onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
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
