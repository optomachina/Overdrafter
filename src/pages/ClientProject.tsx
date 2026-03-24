import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoveRight,
  PlusSquare,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import {
  ClientQuoteRequestStatusCard,
} from "@/components/quotes/ClientWorkspacePanelContent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
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
import {
  clientFilterOptions,
  useClientProjectController,
} from "@/features/quotes/use-client-project-controller";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildProjectAssigneeBadgeModel } from "@/features/quotes/project-assignee";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

function formatCurrency(value: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "No quote selected";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

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
    year: "numeric",
  }).format(new Date(parsed));
}

function propertyValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "Not set";
  }

  return String(value);
}

const ClientProject = () => {
  const {
    activeFilter,
    accessibleJobsQuery,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    attachFilesPicker,
    canManageMembers,
    filteredJobs,
    focusedDraft,
    focusedJob,
    focusedJobId,
    focusedQuoteOptions,
    focusedQuoteQuantityInput,
    focusedSelectedOption,
    focusedSummary,
    focusedWorkspaceItem,
    handleClearFocusedJob,
    dissolveProjectMutation,
    handleAddPartSubmit,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleInviteProjectMember,
    handleOpenJobDrawer,
    handlePinPart,
    handlePinProject,
    handleQuoteQuantityInputChange,
    handleRemovePartFromProject,
    handleRemoveProjectMember,
    handleRenameProject,
    handleRequestProjectQuotes,
    handleRequestDraftChange,
    handleSaveRequest,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isMobile,
    mobileDrawerOpen,
    navigate,
    newJobFilePicker,
    projectSelectionSummary,
    prefetchPart,
    prefetchProject,
    projectCollaborationUnavailable,
    projectId,
    projectAssigneeLookupFailed,
    projectAssigneeLookupReady,
    projectInvitesQuery,
    projectAssigneesByUserId,
    projectJobs,
    projectJobsQuery,
    projectJobMembershipsByCompositeKey,
    projectMembershipsQuery,
    projectName,
    projectQuery,
    projectWorkspaceItemsQuery,
    resolveSidebarProjectIdsForJob,
    search,
    saveRequestMutation,
    requestProjectQuotesMutation,
    setActiveFilter,
    isSearchOpen,
    setIsSearchOpen,
    setMobileDrawerOpen,
    setProjectName,
    setSearch,
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
    isAuthInitializing,
    workspaceItemsByJobId,
  } = useClientProjectController();
  const [desktopInspectorOpen, setDesktopInspectorOpen] = useState(true);
  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClearFocusedJob();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClearFocusedJob]);

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
  const focusedQuoteRequestViewModel = focusedJob
    ? quoteRequestViewModelsByJobId.get(focusedJob.id) ?? null
    : null;
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
  const focusedPresentation =
    focusedJob && focusedSummary ? getClientItemPresentation(focusedJob, focusedSummary) : focusedJob
      ? getClientItemPresentation(focusedJob, null)
      : null;
  const focusedRequestedByDate =
    focusedDraft?.requestedByDate ?? focusedSummary?.requestedByDate ?? focusedWorkspaceItem?.job.requested_by_date ?? null;
  const focusedQuantity = focusedDraft?.quantity ?? focusedSummary?.quantity ?? null;
  const focusedRequestedQuoteQuantities =
    focusedDraft?.requestedQuoteQuantities ?? focusedSummary?.requestedQuoteQuantities ?? [];
  const focusedProperties = focusedWorkspaceItem?.part?.approvedRequirement ?? null;
  const focusedSelectedPrice = focusedSelectedOption?.totalPriceUsd ?? focusedSummary?.selectedPriceUsd ?? null;
  const focusedSelectedLeadTime =
    focusedSelectedOption?.leadTimeBusinessDays ?? focusedSummary?.selectedLeadTimeBusinessDays ?? null;

  const renderInspectorContent = () => {
    if (!focusedJob || !focusedWorkspaceItem || !focusedPresentation) {
      return (
        <div className="space-y-4">
          <div className="rounded-surface-lg border border-white/10 bg-black/20 p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Inspector</p>
            <h2 className="mt-3 text-lg font-semibold text-white">Project detail rail</h2>
            <p className="mt-2 text-sm text-white/55">
              Single-click a part row to inspect it here. Double-click opens the full part workspace, and `Escape` clears the selection.
            </p>
          </div>

          <Collapsible defaultOpen>
            <div className="rounded-surface-lg border border-white/10 bg-black/20">
              <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-4 text-left">
                <div>
                  <p className="text-sm font-medium text-white">Properties</p>
                  <p className="mt-1 text-xs text-white/45">Selection-sensitive part details.</p>
                </div>
                <ChevronDown className="h-4 w-4 text-white/45" />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t border-white/10 px-5 py-4">
                <p className="text-sm text-white/45">No part selected.</p>
              </CollapsibleContent>
            </div>
          </Collapsible>

          <Collapsible defaultOpen>
            <div className="rounded-surface-lg border border-white/10 bg-black/20">
              <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-4 text-left">
                <div>
                  <p className="text-sm font-medium text-white">Project</p>
                  <p className="mt-1 text-xs text-white/45">Shared project-level status and actions.</p>
                </div>
                <ChevronDown className="h-4 w-4 text-white/45" />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 border-t border-white/10 px-5 py-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Parts</p>
                    <p className="mt-2 text-lg font-semibold text-white">{projectJobs.length}</p>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Quoted</p>
                    <p className="mt-2 text-lg font-semibold text-white">{projectQuoteRequestSummary.received}</p>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3 text-sm text-white/65">
                  <p className="font-medium text-white">{projectQuery.data?.name ?? "Project"}</p>
                  <p className="mt-2">Use the ledger for fast scanning and keep the deeper artifact workspace on the part route.</p>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>
      );
    }

    const visibleOptions = focusedQuoteOptions.slice(0, 4);

    return (
      <div className="space-y-4">
        <div className="rounded-surface-lg border border-white/10 bg-black/20 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected part</p>
              <h2 className="mt-2 text-lg font-semibold text-white">{focusedPresentation.title}</h2>
              <p className="mt-2 text-sm text-white/55">{focusedPresentation.description}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-white/60 hover:bg-white/8 hover:text-white"
              onClick={handleClearFocusedJob}
              aria-label="Clear selected part"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Badge className="border border-white/10 bg-white/6 text-white/70">
              {formatStatusLabel(focusedJob.status)}
            </Badge>
            {focusedSelectedOption ? (
              <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                {focusedSelectedOption.vendorLabel}
              </Badge>
            ) : null}
            <Badge className="border border-white/10 bg-white/6 text-white/70">
              Created {formatDateLabel(focusedJob.created_at)}
            </Badge>
          </div>

          <RequestSummaryBadges
            requestedServiceKinds={focusedDraft?.requestedServiceKinds ?? focusedSummary?.requestedServiceKinds ?? []}
            quantity={focusedQuantity}
            requestedQuoteQuantities={focusedRequestedQuoteQuantities}
            requestedByDate={focusedRequestedByDate}
            className="mt-4"
          />

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
              <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Selected quote</p>
              <p className="mt-2 text-lg font-semibold text-white">{formatCurrency(focusedSelectedPrice)}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
              <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Lead time</p>
              <p className="mt-2 text-lg font-semibold text-white">
                {typeof focusedSelectedLeadTime === "number" ? `${focusedSelectedLeadTime} days` : "Unknown"}
              </p>
            </div>
          </div>

          <Button
            type="button"
            className="mt-4 w-full rounded-full"
            onClick={() => navigate(`/parts/${focusedJob.id}`)}
          >
            Open full part workspace
            <MoveRight className="ml-2 h-4 w-4" />
          </Button>
        </div>

        <ClientExtractionStatusNotice diagnostics={focusedWorkspaceItem.part?.clientExtraction ?? null} />

        {focusedQuoteRequestViewModel ? (
          <ClientQuoteRequestStatusCard
            status={focusedQuoteRequestViewModel.status}
            tone={focusedQuoteRequestViewModel.tone}
            label={focusedQuoteRequestViewModel.label}
            detail={focusedQuoteRequestViewModel.detail}
            actionLabel={focusedQuoteRequestViewModel.action.label}
            actionDisabled={focusedQuoteRequestViewModel.action.disabled}
            blockerReasons={focusedQuoteRequestViewModel.blockerReasons}
            isBusy={requestProjectQuotesMutation.isPending}
            onAction={
              focusedQuoteRequestViewModel.action.kind === "none"
                ? null
                : () => {
                    void handleRequestProjectQuotes(
                      [focusedJob.id],
                      focusedQuoteRequestViewModel.action.kind === "retry",
                    );
                  }
            }
          />
        ) : null}

        {visibleOptions.length > 0 ? (
          <div className="rounded-surface-lg border border-white/10 bg-black/20 p-5">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Vendor visibility</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {visibleOptions.map((option) => (
                <Button
                  key={`${focusedJob.id}:${option.key}`}
                  type="button"
                  variant="outline"
                  className={cn(
                    "rounded-full border-white/10 bg-transparent text-white hover:bg-white/6",
                    option.excluded && "border-amber-400/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15",
                  )}
                  onClick={() => handleToggleVendorExclusion(focusedJob.id, option.vendorKey, !option.excluded)}
                >
                  {option.excluded ? `Include ${option.vendorLabel}` : `Exclude ${option.vendorLabel}`}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <Collapsible defaultOpen>
          <div className="rounded-surface-lg border border-white/10 bg-black/20">
            <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-4 text-left">
              <div>
                <p className="text-sm font-medium text-white">Properties</p>
                <p className="mt-1 text-xs text-white/45">Selected-part metadata and request details.</p>
              </div>
              <ChevronRight className="h-4 w-4 text-white/45" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 border-t border-white/10 px-5 py-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Part number</p>
                  <p className="mt-2 text-white">{propertyValue(focusedProperties?.part_number ?? focusedSummary?.partNumber)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Revision</p>
                  <p className="mt-2 text-white">{propertyValue(focusedProperties?.revision ?? focusedSummary?.revision)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Material</p>
                  <p className="mt-2 text-white">{propertyValue(focusedProperties?.material)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Finish</p>
                  <p className="mt-2 text-white">{propertyValue(focusedProperties?.finish)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Qty</p>
                  <p className="mt-2 text-white">{propertyValue(focusedQuantity)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Updated</p>
                  <p className="mt-2 text-white">{formatDateLabel(focusedWorkspaceItem.part?.updated_at ?? focusedJob.updated_at)}</p>
                </div>
              </div>

              {focusedDraft ? (
                <div className="rounded-surface-lg border border-white/8 bg-white/[0.03] p-4">
                  <p className="text-sm font-medium text-white">Request details</p>
                  <p className="mt-1 text-xs text-white/45">
                    Quote-safe request editing stays available in the inspector while the deep artifact workspace remains on the part route.
                  </p>
                  <div className="mt-4">
                    <ClientPartRequestEditor
                      draft={focusedDraft}
                      quoteQuantityInput={focusedQuoteQuantityInput}
                      onQuoteQuantityInputChange={(value) => handleQuoteQuantityInputChange(focusedJob.id, value)}
                      onChange={(next) => handleRequestDraftChange(focusedJob.id, next)}
                      onSave={() => handleSaveRequest(focusedJob.id)}
                      onUploadRevision={attachFilesPicker.openFilePicker}
                      isSaving={saveRequestMutation.isPending}
                    />
                  </div>
                </div>
              ) : null}
            </CollapsibleContent>
          </div>
        </Collapsible>

        <Collapsible defaultOpen>
          <div className="rounded-surface-lg border border-white/10 bg-black/20">
            <CollapsibleTrigger className="flex w-full items-center justify-between px-5 py-4 text-left">
              <div>
                <p className="text-sm font-medium text-white">Project</p>
                <p className="mt-1 text-xs text-white/45">Context for the current project and ledger selection.</p>
              </div>
              <ChevronRight className="h-4 w-4 text-white/45" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 border-t border-white/10 px-5 py-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Project</p>
                  <p className="mt-2 text-white">{projectQuery.data?.name ?? "Project"}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">Created</p>
                  <p className="mt-2 text-white">{formatDateLabel(focusedJob.created_at)}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">CAD</p>
                  <p className="mt-2 text-white">{focusedWorkspaceItem.part?.cadFile ? "Attached" : "Missing"}</p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-white/35">DWG</p>
                  <p className="mt-2 text-white">{focusedWorkspaceItem.part?.drawingFile ? "Attached" : "Missing"}</p>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    );
  };

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your project workspace." />;
  }

  if (!user) {
    return null;
  }

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
        <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm text-white/55">
            <span>Projects</span>
            <span>/</span>
            <span>{projectQuery.data?.name ?? "Project"}</span>
          </div>

          {/* Project header */}
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white">
              {projectQuery.data?.name ?? "Project"}
            </h1>
            <p className="mt-2 text-sm text-white/55">
              Scan and manage parts across this project. Select a line item to inspect its artifacts and quotes.
            </p>

            {/* Status badge row */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {projectQuoteRequestSummary.received > 0 && (
                <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                  Quoted: {projectQuoteRequestSummary.received}
                </Badge>
              )}
              {projectQuoteRequestSummary.requesting > 0 && (
                <Badge className="border border-amber-400/20 bg-amber-500/10 text-amber-100">
                  Requesting: {projectQuoteRequestSummary.requesting}
                </Badge>
              )}
              {projectQuoteRequestSummary.notRequested > 0 && (
                <Badge className="border border-white/10 bg-white/6 text-white/70">
                  Not requested: {projectQuoteRequestSummary.notRequested}
                </Badge>
              )}
              {projectQuoteRequestSummary.needsAttention > 0 && (
                <Badge className="border border-rose-400/20 bg-rose-500/10 text-rose-100">
                  Needs attention: {projectQuoteRequestSummary.needsAttention}
                </Badge>
              )}
            </div>

            {/* Header actions */}
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

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Total parts</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectJobs.length}</p>
            </div>
            <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Quoted</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-emerald-400">{projectQuoteRequestSummary.received}</p>
            </div>
            <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Requesting</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-amber-400">{projectQuoteRequestSummary.requesting}</p>
            </div>
            <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Not requested</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectQuoteRequestSummary.notRequested}</p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <div className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search project parts"
                      className="border-white/10 bg-white/[0.03] text-white placeholder:text-white/35 focus-visible:ring-white/20"
                      aria-label="Search project parts"
                    />
                    <div className="flex flex-wrap gap-2">
                      {clientFilterOptions.map((filter) => (
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
                      ))}
                    </div>
                  </div>

                  {!isMobile ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => setDesktopInspectorOpen((current) => !current)}
                    >
                      {desktopInspectorOpen ? "Hide inspector" : "Show inspector"}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Selected total</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">
                    {formatCurrency(projectSelectionSummary.totalPriceUsd)}
                  </p>
                </div>
                <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Selected lines</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectSelectionSummary.selectedCount}</p>
                </div>
                <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Domestic</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-emerald-400">{projectSelectionSummary.domesticCount}</p>
                </div>
                <div className="rounded border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Foreign / unknown</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">
                    {projectSelectionSummary.foreignCount + projectSelectionSummary.unknownCount}
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-surface-lg border border-ws-border-subtle bg-ws-card">
                {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="px-6 py-12 text-center text-white/45">No parts match the current project filter.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <div className="grid min-w-[1040px] grid-cols-[1.4fr_1.8fr_120px_88px_88px_1fr_140px_120px] border-b border-white/[0.04] bg-white/[0.02] px-5 py-2.5">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Part</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Description</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Assignee</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">CAD</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">DWG</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Quote</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Created</div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Action</div>
                    </div>

                    {filteredJobs.map((job) => {
                      const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                      const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                      const presentation = getClientItemPresentation(job, summary);
                      const quoteRequestViewModel = quoteRequestViewModelsByJobId.get(job.id) ?? null;
                      const isSelected = focusedJobId === job.id;
                      const quoteStatusLabel = quoteRequestViewModel?.label ?? formatStatusLabel(job.status);
                      const quoteStatusClassName =
                        quoteRequestViewModel?.status === "received"
                          ? "border border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                          : quoteRequestViewModel?.status === "queued" || quoteRequestViewModel?.status === "requesting"
                            ? "border border-amber-400/20 bg-amber-500/10 text-amber-100"
                            : quoteRequestViewModel?.status === "failed" || quoteRequestViewModel?.status === "canceled"
                              ? "border border-rose-400/20 bg-rose-500/10 text-rose-100"
                              : "border border-white/10 bg-white/6 text-white/70";
                      const canTriggerRequest =
                        quoteRequestViewModel &&
                        !quoteRequestViewModel.action.disabled &&
                        (quoteRequestViewModel.action.kind === "request" || quoteRequestViewModel.action.kind === "retry");
                      // Until a dedicated part assignee field exists, the ledger uses the
                      // project-scoped creator on project_jobs as the narrowest ownership signal.
                      const projectJobMembership = projectJobMembershipsByCompositeKey?.get(`${projectId}:${job.id}`) ?? null;
                      const assigneeProfile =
                        projectJobMembership?.created_by
                          ? projectAssigneesByUserId?.get(projectJobMembership.created_by) ?? null
                          : null;
                      const assignee = buildProjectAssigneeBadgeModel(assigneeProfile);

                      return (
                        <div
                          key={job.id}
                          className={cn(
                            "grid min-w-[1040px] grid-cols-[1.4fr_1.8fr_120px_88px_88px_1fr_140px_120px] items-center border-b border-white/[0.04] px-5 py-3 last:border-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-inset",
                            isSelected ? "bg-white/[0.06]" : "hover:bg-white/[0.02]",
                          )}
                          onClick={() => handleOpenJobDrawer(job.id)}
                          onDoubleClick={() => navigate(`/parts/${job.id}`)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleOpenJobDrawer(job.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open ${presentation.title} line item`}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-white">{presentation.title}</p>
                            <p className="text-[11px] text-white/45">{summary?.revision ? `Rev ${summary.revision}` : "No revision"}</p>
                          </div>
                          <div className="min-w-0 pr-4">
                            <p className="truncate text-[13px] text-white/65">{presentation.description}</p>
                          </div>
                          <div>
                            {!projectAssigneeLookupReady && !projectAssigneeLookupFailed ? (
                              <span className="text-[12px] text-white/35">Loading</span>
                            ) : projectAssigneeLookupFailed ? (
                              <span className="text-[12px] text-white/35">Unavailable</span>
                            ) : assignee.isUnassigned || !assignee.initials ? (
                              <span className="text-[12px] text-white/45">Unassigned</span>
                            ) : (
                              <div
                                className="flex items-center"
                                title={assignee.displayName}
                                aria-label={`Assignee: ${assignee.displayName}`}
                              >
                                <span
                                  className={cn(
                                    "inline-flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-semibold tracking-[0.08em]",
                                    assignee.colorClassName,
                                  )}
                                >
                                  {assignee.initials}
                                </span>
                              </div>
                            )}
                          </div>
                          <div>
                            <Badge className="border border-white/10 bg-white/6 text-white/70">
                              {workspaceItem?.part?.cadFile ? "Yes" : "No"}
                            </Badge>
                          </div>
                          <div>
                            <Badge className="border border-white/10 bg-white/6 text-white/70">
                              {workspaceItem?.part?.drawingFile ? "Yes" : "No"}
                            </Badge>
                          </div>
                          <div>
                            <Badge className={quoteStatusClassName}>{quoteStatusLabel}</Badge>
                          </div>
                          <div className="text-[13px] text-white/55">{formatDateLabel(job.created_at)}</div>
                          <div className="text-right">
                            {canTriggerRequest ? (
                              <Button
                                type="button"
                                className="h-auto rounded-surface-sm px-2 py-1 text-xs"
                                disabled={
                                  quoteRequestViewModel.action.disabled ||
                                  requestProjectQuotesMutation.isPending
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleRequestProjectQuotes(
                                    [job.id],
                                    quoteRequestViewModel.action.kind === "retry",
                                  );
                                }}
                              >
                                {quoteRequestViewModel.action.kind === "retry" ? "Retry" : "Request"}
                                <ArrowRight className="ml-1 h-3 w-3" />
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                className="h-auto rounded-surface-sm border-white/10 bg-transparent px-2 py-1 text-xs text-white hover:bg-white/6"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  navigate(`/parts/${job.id}`);
                                }}
                              >
                                Open
                                <ArrowRight className="ml-1 h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {!isMobile && desktopInspectorOpen ? (
              <aside className="xl:sticky xl:top-4 xl:self-start">
                {renderInspectorContent()}
              </aside>
            ) : null}
          </div>
        </div>
      </ClientWorkspaceShell>

      <Sheet open={mobileDrawerOpen && Boolean(focusedJobId)} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="right" className="w-[min(96vw,38rem)] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white sm:max-w-[38rem]">
          <SheetHeader className="border-b border-white/10 px-6 py-5">
            <SheetTitle className="text-white">Line item detail</SheetTitle>
            <SheetDescription className="text-white/55">
              Review selected-part details without leaving the project ledger.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-5">{renderInspectorContent()}</div>
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
