import { useEffect, useMemo, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronDown,
  Filter,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import {
  clientFilterOptions,
  useClientProjectController,
  type JobFilter,
} from "@/features/quotes/use-client-project-controller";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { buildRequirementDraft, formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function readSpecSnapshotString(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getQuoteBadgeClass(status: string) {
  switch (status) {
    case "received":
      return "border border-emerald-400/20 bg-emerald-500/10 text-emerald-100";
    case "queued":
    case "requesting":
      return "border border-amber-400/20 bg-amber-500/10 text-amber-100";
    case "failed":
    case "canceled":
      return "border border-rose-400/20 bg-rose-500/10 text-rose-100";
    default:
      return "border border-white/10 bg-white/6 text-white/70";
  }
}

function LedgerSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="overflow-hidden rounded-[22px] border border-white/10 bg-black/20"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-white [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown className="h-4 w-4 text-white/45 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="border-t border-white/8 px-5 py-4">{children}</div>
    </details>
  );
}

function InspectorField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-sm">
      <div className="text-white/45">{label}</div>
      <div className="min-w-0 text-white">{value}</div>
    </div>
  );
}

const ClientProject = () => {
  const {
    accessibleJobsQuery,
    activeFilter,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    attachFilesPicker,
    canManageMembers,
    filteredJobs,
    focusedJob,
    focusedJobId,
    focusedSummary,
    focusedWorkspaceItem,
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
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isAuthInitializing,
    isInspectorOpen,
    isMobile,
    isSearchOpen,
    mobileDrawerOpen,
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
    requestProjectQuotesMutation,
    resolveSidebarProjectIdsForJob,
    setActiveFilter,
    setIsInspectorOpen,
    setIsSearchOpen,
    setMobileDrawerOpen,
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
    dissolveProjectMutation,
    user,
    workspaceItemsByJobId,
  } = useClientProjectController();

  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
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
      Array.from(quoteRequestViewModelsByJobId.values()).reduce<{
        received: number;
        requesting: number;
        notRequested: number;
        needsAttention: number;
      }>((summary, model) => {
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
        }, {
          received: 0,
          requesting: 0,
          notRequested: 0,
          needsAttention: 0,
        },
      ),
    [quoteRequestViewModelsByJobId],
  );

  const activeFilterLabel =
    clientFilterOptions.find((option) => option.id === activeFilter)?.label ?? clientFilterOptions[0].label;

  const cycleFilter = () => {
    const currentIndex = clientFilterOptions.findIndex((option) => option.id === activeFilter);
    const nextOption = clientFilterOptions[(currentIndex + 1) % clientFilterOptions.length];
    setActiveFilter(nextOption.id as JobFilter);
  };

  useEffect(() => {
    if (!focusedJobId) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClearFocusedJob();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [focusedJobId, handleClearFocusedJob]);

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your project workspace." />;
  }

  if (!user) {
    return null;
  }

  const focusedPresentation = focusedJob
    ? getClientItemPresentation(focusedJob, focusedSummary)
    : null;
  const focusedRequirement =
    focusedWorkspaceItem?.part
      ? buildRequirementDraft(focusedWorkspaceItem.part, {
          requested_quote_quantities: focusedWorkspaceItem.job.requested_quote_quantities ?? [],
          requested_by_date: focusedWorkspaceItem.job.requested_by_date ?? null,
          requested_service_kinds: focusedWorkspaceItem.job.requested_service_kinds ?? [],
          primary_service_kind: focusedWorkspaceItem.job.primary_service_kind ?? null,
          service_notes: focusedWorkspaceItem.job.service_notes ?? null,
        })
      : null;
  const focusedThreads =
    readSpecSnapshotString(focusedWorkspaceItem?.part?.approvedRequirement?.spec_snapshot, "threads") ??
    readSpecSnapshotString(focusedWorkspaceItem?.part?.approvedRequirement?.spec_snapshot, "threadNotes") ??
    "Not available";
  const focusedQuoteRequest = focusedJob
    ? quoteRequestViewModelsByJobId.get(focusedJob.id) ?? null
    : null;

  const renderInspector = () => {
    const properties = focusedRequirement
      ? [
          { label: "Material", value: focusedRequirement.material || "Not available" },
          { label: "Finish", value: focusedRequirement.finish || "Not available" },
          { label: "Threads", value: focusedThreads },
          {
            label: "Tightest tolerance",
            value:
              focusedRequirement.tightestToleranceInch !== null &&
              focusedRequirement.tightestToleranceInch !== undefined
                ? `${focusedRequirement.tightestToleranceInch} in`
                : "Not available",
          },
          { label: "Part number", value: focusedRequirement.partNumber || "Not available" },
          { label: "Description", value: focusedRequirement.description || "Not available" },
        ]
      : [
          { label: "Material", value: "Select a part to inspect manufacturing details." },
          { label: "Finish", value: "Project-level inspector is ready for the selected row." },
          { label: "Threads", value: "No part selected" },
          { label: "Tightest tolerance", value: "No part selected" },
          { label: "Part number", value: "No part selected" },
          { label: "Description", value: "Use single-click on a row to load part details here." },
        ];

    const projectFields = focusedJob
      ? [
          { label: "Project", value: projectQuery.data?.name ?? "Project" },
          { label: "Selected part", value: focusedPresentation?.title ?? "Not available" },
          { label: "Quote state", value: focusedQuoteRequest?.label ?? formatStatusLabel(focusedJob.status) },
          { label: "Assignee", value: "BW" },
          { label: "Created", value: formatDate(focusedJob.created_at) },
        ]
      : [
          { label: "Project", value: projectQuery.data?.name ?? "Project" },
          { label: "Parts in view", value: String(filteredJobs.length) },
          { label: "Current filter", value: activeFilterLabel },
          { label: "Quoted", value: String(projectQuoteRequestSummary.received) },
          { label: "Needs attention", value: String(projectQuoteRequestSummary.needsAttention) },
        ];

    return (
      <div className="space-y-4">
        <div className="rounded-[24px] border border-white/10 bg-[#202020] px-5 py-5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">
            {focusedJob ? "Selected part" : "Project inspector"}
          </p>
          <h2 className="mt-3 text-xl font-medium tracking-[-0.02em] text-white">
            {focusedJob ? focusedPresentation?.title : "No part selected"}
          </h2>
          <p className="mt-2 text-sm text-white/55">
            {focusedJob
              ? "Single-click keeps inspection in this docked panel. Double-click opens the full part workspace."
              : "Use the project ledger to scan parts, then inspect the selected row here without leaving the route."}
          </p>
          {focusedJob ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge className={getQuoteBadgeClass(focusedQuoteRequest?.status ?? "not_requested")}>
                {focusedQuoteRequest?.label ?? formatStatusLabel(focusedJob.status)}
              </Badge>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {projectQuery.data?.name ?? "Project"}
              </Badge>
            </div>
          ) : null}
        </div>

        <LedgerSection title="Properties">
          <div className="space-y-3">
            {properties.map((field) => (
              <InspectorField key={field.label} label={field.label} value={field.value} />
            ))}
          </div>
        </LedgerSection>

        <LedgerSection title="Project">
          <div className="space-y-3">
            {projectFields.map((field) => (
              <InspectorField key={field.label} label={field.label} value={field.value} />
            ))}
          </div>

          {focusedJob ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                type="button"
                className="rounded-full"
                onClick={() => navigate(`/parts/${focusedJob.id}`)}
              >
                Open part workspace
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={handleClearFocusedJob}
              >
                Clear selection
              </Button>
            </div>
          ) : null}
        </LedgerSection>
      </div>
    );
  };

  return (
    <>
      <ClientWorkspaceShell
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: SearchIcon, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeProjectId={projectId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={
              projectCollaborationUnavailable ? undefined : newJobFilePicker.openFilePicker
            }
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user?.id}
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
        <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          <div className="flex items-center gap-2 text-sm text-white/55">
            <span>Projects</span>
            <span>/</span>
            <span>{projectQuery.data?.name ?? "Project"}</span>
          </div>

          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-white">
                {projectQuery.data?.name ?? "Project"}
              </h1>
              <p className="mt-2 text-sm text-white/55">
                Scan and manage parts from a single ledger. Single-click inspects in place, double-click opens the full part workspace.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {projectQuoteRequestSummary.received > 0 ? (
                  <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                    Quoted: {projectQuoteRequestSummary.received}
                  </Badge>
                ) : null}
                {projectQuoteRequestSummary.requesting > 0 ? (
                  <Badge className="border border-amber-400/20 bg-amber-500/10 text-amber-100">
                    Requesting: {projectQuoteRequestSummary.requesting}
                  </Badge>
                ) : null}
                <Badge className="border border-white/10 bg-white/6 text-white/70">
                  Not requested: {projectQuoteRequestSummary.notRequested}
                </Badge>
                {projectQuoteRequestSummary.needsAttention > 0 ? (
                  <Badge className="border border-rose-400/20 bg-rose-500/10 text-rose-100">
                    Needs attention: {projectQuoteRequestSummary.needsAttention}
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              {!projectCollaborationUnavailable ? (
                <Button type="button" className="rounded-full" onClick={() => setShowAddPart(true)}>
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
                {requestProjectQuotesMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
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

          <div className="grid gap-[10px] md:grid-cols-4">
            <div className="rounded-[18px] border border-white/10 bg-[#202020] p-4">
              <p className="text-[11px] text-white/45">Total parts</p>
              <p className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-white">{projectJobs.length}</p>
            </div>
            <div className="rounded-[18px] border border-white/10 bg-[#202020] p-4">
              <p className="text-[11px] text-white/45">Quoted</p>
              <p className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-emerald-400">
                {projectQuoteRequestSummary.received}
              </p>
            </div>
            <div className="rounded-[18px] border border-white/10 bg-[#202020] p-4">
              <p className="text-[11px] text-white/45">Requesting</p>
              <p className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-amber-400">
                {projectQuoteRequestSummary.requesting}
              </p>
            </div>
            <div className="rounded-[18px] border border-white/10 bg-[#202020] p-4">
              <p className="text-[11px] text-white/45">Needs attention</p>
              <p className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-rose-300">
                {projectQuoteRequestSummary.needsAttention}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={cycleFilter}
            >
              <Filter className="mr-2 h-4 w-4" />
              Filter: {activeFilterLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => {
                if (isMobile) {
                  setMobileDrawerOpen(Boolean(focusedJobId) && !mobileDrawerOpen);
                  return;
                }

                setIsInspectorOpen(!isInspectorOpen);
              }}
            >
              {isMobile ? (
                <>
                  {mobileDrawerOpen ? <PanelRightClose className="mr-2 h-4 w-4" /> : <PanelRightOpen className="mr-2 h-4 w-4" />}
                  Detail drawer
                </>
              ) : (
                <>
                  {isInspectorOpen ? <PanelRightClose className="mr-2 h-4 w-4" /> : <PanelRightOpen className="mr-2 h-4 w-4" />}
                  {isInspectorOpen ? "Hide rail" : "Show rail"}
                </>
              )}
            </Button>
          </div>

          <div className={cn("grid gap-6", !isMobile && isInspectorOpen && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
            <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#1c1c1c]">
              <div className="grid grid-cols-[1.2fr_1.3fr_88px_88px_120px_92px_120px] gap-4 border-b border-white/8 bg-white/[0.02] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
                <div>Part Number</div>
                <div>Description</div>
                <div>CAD</div>
                <div>DWG</div>
                <div>Quote</div>
                <div>Assignee</div>
                <div>Creation Date</div>
              </div>

              {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                <div className="flex min-h-[240px] items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                </div>
              ) : filteredJobs.length === 0 ? (
                <div className="px-6 py-12 text-center text-white/45">No parts match the current project filter.</div>
              ) : (
                <div className="divide-y divide-white/6">
                  {filteredJobs.map((job) => {
                    const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                    const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                    const presentation = getClientItemPresentation(job, summary);
                    const requirement = workspaceItem?.part
                      ? buildRequirementDraft(workspaceItem.part, {
                          requested_quote_quantities: workspaceItem.job.requested_quote_quantities ?? [],
                          requested_by_date: workspaceItem.job.requested_by_date ?? null,
                          requested_service_kinds: workspaceItem.job.requested_service_kinds ?? [],
                          primary_service_kind: workspaceItem.job.primary_service_kind ?? null,
                          service_notes: workspaceItem.job.service_notes ?? null,
                        })
                      : null;
                    const quoteRequestViewModel = quoteRequestViewModelsByJobId.get(job.id) ?? null;
                    const isSelected = job.id === focusedJobId;

                    return (
                      <button
                        key={job.id}
                        type="button"
                        className={cn(
                          "grid w-full grid-cols-[1.2fr_1.3fr_88px_88px_120px_92px_120px] gap-4 px-5 py-4 text-left transition hover:bg-white/[0.02]",
                          isSelected && "bg-white/[0.06] shadow-[inset_3px_0_0_0_rgba(255,255,255,0.8)]",
                        )}
                        onClick={() => handleOpenJobDrawer(job.id)}
                        onDoubleClick={() => navigate(`/parts/${job.id}`)}
                        aria-pressed={isSelected}
                        aria-label={`Select ${presentation.title} row`}
                      >
                        <div>
                          <p className="text-sm font-medium text-white">
                            {summary?.partNumber ?? requirement?.partNumber ?? presentation.title}
                          </p>
                          <p className="mt-1 text-xs text-white/45">{presentation.title}</p>
                        </div>
                        <div className="text-sm text-white/72">
                          {summary?.description ?? requirement?.description ?? job.description ?? "No description"}
                        </div>
                        <div className="text-sm text-white/72">
                          {workspaceItem?.part?.cadFile ? workspaceItem.part.cadFile.original_name : "Missing"}
                        </div>
                        <div className="text-sm text-white/72">
                          {workspaceItem?.part?.drawingFile ? workspaceItem.part.drawingFile.original_name : "Missing"}
                        </div>
                        <div>
                          <Badge className={getQuoteBadgeClass(quoteRequestViewModel?.status ?? "not_requested")}>
                            {quoteRequestViewModel?.label ?? formatStatusLabel(job.status)}
                          </Badge>
                        </div>
                        <div className="text-sm text-white/72">BW</div>
                        <div className="text-sm text-white/72">{formatDate(job.created_at)}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {!isMobile && isInspectorOpen ? <div>{renderInspector()}</div> : null}
          </div>
        </div>
      </ClientWorkspaceShell>

      <Sheet open={mobileDrawerOpen && Boolean(focusedJobId)} onOpenChange={setMobileDrawerOpen}>
        <SheetContent
          side="right"
          className="w-[min(96vw,34rem)] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white sm:max-w-[34rem]"
        >
          <SheetHeader className="border-b border-white/10 px-6 py-5">
            <SheetTitle className="text-white">Project inspector</SheetTitle>
            <SheetDescription className="text-white/55">
              Review the currently selected part without leaving the project ledger.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-5">{renderInspector()}</div>
        </SheetContent>
      </Sheet>

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
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
      <input
        ref={attachFilesPicker.inputRef}
        type="file"
        multiple
        accept={attachFilesPicker.accept}
        onChange={(event) => {
          void attachFilesPicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Attach files to selected project line item"
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
        currentUserId={user?.id ?? ""}
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
