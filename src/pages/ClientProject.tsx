import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Loader2,
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
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { QuoteChart } from "@/components/workspace/QuoteChart";
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
    focusedSelectedOption,
    focusedSummary,
    focusedWorkspaceItem,
    handleClearFocusedJob,
    dissolveProjectMutation,
    handleAddPartSubmit,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCancelQuoteRequest,
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
    handleSelectQuoteOption,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isCancelingQuoteRequest,
    isMobile,
    mobileDrawerOpen,
    navigate,
    newJobFilePicker,
    projectSelectionSummary,
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
    search,
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
  const [showCancelRequestDialog, setShowCancelRequestDialog] = useState(false);
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
  const focusedQuantity = focusedDraft?.quantity ?? focusedSummary?.quantity ?? null;
  const focusedProperties = focusedWorkspaceItem?.part?.approvedRequirement ?? null;
  const focusedSelectedPrice = focusedSelectedOption?.totalPriceUsd ?? focusedSummary?.selectedPriceUsd ?? null;
  const focusedSelectedLeadTime =
    focusedSelectedOption?.leadTimeBusinessDays ?? focusedSummary?.selectedLeadTimeBusinessDays ?? null;
  const focusedSelectedOfferId = focusedSelectedOption?.offerId ?? null;

  const handleInspectorQuoteSelect = (offerId: string | null) => {
    if (!focusedJob || offerId === null) {
      return;
    }

    const nextOption = focusedQuoteOptions.find((option) => option.offerId === offerId) ?? null;

    if (!nextOption) {
      return;
    }

    void handleSelectQuoteOption(focusedJob.id, nextOption);
  };

  const renderInspectorContent = () => {
    if (!focusedJob || !focusedWorkspaceItem || !focusedPresentation) {
      return (
        <div className="space-y-4">
          <div className="rounded-lg border border-white/10 bg-black/20 p-5">
            <h2 className="text-lg font-semibold text-white">Project inspector</h2>
            <p className="mt-2 text-sm text-white/55">
              Single-click a part row to inspect it here. Double-click opens the full part workspace, and `Escape` clears the selection.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-white/10 bg-black/20 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-white">{focusedPresentation.title}</h2>
              {focusedPresentation.description ? (
                <p className="mt-1 line-clamp-2 text-xs text-white/45">{focusedPresentation.description}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-full text-white/40 hover:bg-white/8 hover:text-white"
              onClick={handleClearFocusedJob}
              aria-label="Clear selected part"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/8 bg-white/8">
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Part no.</p>
              <p className="mt-1 text-sm font-medium text-white">{propertyValue(focusedProperties?.part_number ?? focusedSummary?.partNumber)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Rev</p>
              <p className="mt-1 text-sm font-medium text-white">{propertyValue(focusedProperties?.revision ?? focusedSummary?.revision)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Material</p>
              <p className="mt-1 text-sm font-medium text-white">{propertyValue(focusedProperties?.material)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Finish</p>
              <p className="mt-1 text-sm font-medium text-white">{propertyValue(focusedProperties?.finish)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Qty</p>
              <p className="mt-1 text-sm font-medium text-white">{propertyValue(focusedQuantity)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Status</p>
              <p className="mt-1 text-sm font-medium text-white">{formatStatusLabel(focusedJob.status)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Created</p>
              <p className="mt-1 text-sm font-medium text-white">{formatDateLabel(focusedJob.created_at)}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Project</p>
              <p className="mt-1 text-sm font-medium text-white">{projectQuery.data?.name ?? "Project"}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Selected quote</p>
              <p className="mt-1 text-sm font-semibold text-white">{focusedSelectedPrice != null ? formatCurrency(focusedSelectedPrice) : "—"}</p>
            </div>
            <div className="bg-black/40 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Lead time</p>
              <p className="mt-1 text-sm font-semibold text-white">
                {typeof focusedSelectedLeadTime === "number" ? `${focusedSelectedLeadTime}d` : "—"}
              </p>
            </div>
          </div>
        </div>

        <ClientDrawingPreviewPanel
          drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
          drawingPreview={focusedWorkspaceItem.drawingPreview}
          className="rounded-lg"
        />

        <ClientCadPreviewPanel
          cadFile={focusedWorkspaceItem.part?.cadFile ?? null}
          className="rounded-lg"
        />

        <section className="rounded-lg border border-white/10 bg-black/20 p-5">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quotes</p>
            <p className="mt-2 text-sm text-white/55">
              Compare vendor offers here and select the quote to keep without leaving the project ledger.
            </p>
          </div>
          <div className="mt-4">
            {focusedQuoteOptions.length > 0 ? (
              <QuoteChart
                quotes={focusedQuoteOptions}
                selectedOfferId={focusedSelectedOfferId}
                onSelect={handleInspectorQuoteSelect}
              />
            ) : (
              <div className="rounded-lg border border-white/8 bg-white/[0.03] px-4 py-5 text-sm text-white/45">
                No plottable quote offers are available for this part yet.
              </div>
            )}
          </div>
        </section>
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
      <AlertDialog open={showCancelRequestDialog} onOpenChange={setShowCancelRequestDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel quote request?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the current vendor quote request for this package. You can request a new quote again after canceling.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep request</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const requestId = focusedWorkspaceItem?.latestQuoteRequest?.id;

                if (!requestId) {
                  return;
                }

                void handleCancelQuoteRequest(requestId);
              }}
              disabled={isCancelingQuoteRequest}
            >
              {isCancelingQuoteRequest ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
            <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Total parts</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectJobs.length}</p>
            </div>
            <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Quoted</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-emerald-400">{projectQuoteRequestSummary.received}</p>
            </div>
            <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Requesting</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-amber-400">{projectQuoteRequestSummary.requesting}</p>
            </div>
            <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
              <p className="mb-1 text-[11px] text-white/45">Not requested</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectQuoteRequestSummary.notRequested}</p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
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
                <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Selected total</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">
                    {formatCurrency(projectSelectionSummary.totalPriceUsd)}
                  </p>
                </div>
                <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Selected lines</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectSelectionSummary.selectedCount}</p>
                </div>
                <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Domestic</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-emerald-400">{projectSelectionSummary.domesticCount}</p>
                </div>
                <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
                  <p className="mb-1 text-[11px] text-white/45">Foreign / unknown</p>
                  <p className="text-[24px] font-bold tracking-[-0.02em] text-white">
                    {projectSelectionSummary.foreignCount + projectSelectionSummary.unknownCount}
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-ws-border-subtle bg-ws-card">
                {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="px-6 py-12 text-center text-white/45">No parts match the current project filter.</div>
                ) : (
                  <Table className="w-full text-white">
                    <TableBody>
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
                      return (
                        <TableRow
                          key={job.id}
                          className={cn(
                            "cursor-pointer border-white/[0.04] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-inset",
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
                          <TableCell className="w-[1%] max-w-[200px] px-5 py-2.5">
                            <p className="truncate text-[13px] font-medium text-white">{presentation.title}</p>
                          </TableCell>
                          <TableCell className="px-4 py-2.5">
                            <p className="truncate text-[13px] text-white/65">{presentation.description}</p>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap pl-8 pr-2 py-2.5 text-[13px] text-white/45">
                            {summary?.revision ? `Rev ${summary.revision}` : null}
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5">
                            <Badge className={workspaceItem?.part?.cadFile ? "border border-emerald-400/30 bg-emerald-500/20 text-emerald-300" : "border border-white/10 bg-white/6 text-white/30"}>
                              CAD
                            </Badge>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5">
                            <Badge className={workspaceItem?.part?.drawingFile ? "border border-emerald-400/30 bg-emerald-500/20 text-emerald-300" : "border border-white/10 bg-white/6 text-white/30"}>
                              DWG
                            </Badge>
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap px-2 py-2.5">
                            <Badge className={quoteStatusClassName}>{quoteStatusLabel}</Badge>
                          </TableCell>
                          <TableCell className={cn("w-px whitespace-nowrap py-2.5 text-[13px] text-white/55", canTriggerRequest ? "px-2" : "pl-2 pr-5")}>
                            {formatDateLabel(job.created_at)}
                          </TableCell>
                          <TableCell className="w-px whitespace-nowrap pl-2 pr-5 py-2.5 text-right">
                            {canTriggerRequest ? (
                              <Button
                                type="button"
                                className="h-auto rounded-lg px-2 py-1 text-xs"
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
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                      })}
                    </TableBody>
                  </Table>
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
