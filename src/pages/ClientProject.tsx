import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Loader2,
  PlusSquare,
  Search as SearchIcon,
} from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { QuoteSelectionFunctionBar } from "@/components/quotes/QuoteSelectionFunctionBar";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { ProjectInspectorPanel } from "@/components/workspace/ProjectInspectorPanel";
import { WorkspaceInlineSearch } from "@/components/workspace/WorkspaceInlineSearch";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
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
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
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
import { buildScopedPreset, getPresetMode, getPresetScope } from "@/features/quotes/selection";
import { formatStatusLabel, normalizeDrawingExtraction } from "@/features/quotes/utils";
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
const ClientProject = () => {
  const {
    activeFilter,
    activePreset,
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
    focusedQuoteDataMessage,
    focusedQuoteDataStatus,
    focusedQuoteOptions,
    focusedSelectedOption,
    focusedSummary,
    focusedRequestedByDate,
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
    handleBulkPreset,
    handleRequestProjectQuotes,
    handleSelectQuoteOption,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isMobile,
    isCancelingQuoteRequest,
    mobileDrawerOpen,
    navigate,
    newJobFilePicker,
    projectSelectionSummary,
    prefetchPart,
    prefetchProject,
    projectCollaborationUnavailable,
    projectDueByDate,
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
    setMobileDrawerOpen,
    setProjectName,
    setProjectDueByDate,
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
    workspaceItemsByJobId,
  } = useClientProjectController();
  const [showCancelRequestDialog, setShowCancelRequestDialog] = useState(false);
  const notificationCenter = useWorkspaceNotifications({
    jobIds: accessibleJobs.map((job) => job.id),
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
  const focusedGeometryProjection =
    focusedWorkspaceItem?.part?.extraction && focusedWorkspaceItem.part
      ? normalizeDrawingExtraction(focusedWorkspaceItem.part.extraction, focusedWorkspaceItem.part.id).geometryProjection
      : null;
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
  const focusedSelectedPrice = focusedSelectedOption?.totalPriceUsd ?? focusedSummary?.selectedPriceUsd ?? null;
  const focusedSelectedLeadTime =
    focusedSelectedOption?.leadTimeBusinessDays ?? focusedSummary?.selectedLeadTimeBusinessDays ?? null;
  const focusedSelectedOfferId = focusedSelectedOption?.offerId ?? null;
  const projectLabel = projectQuery.data?.name ?? "Project";
  const bulkPresetScope = getPresetScope(activePreset);
  const bulkPresetMode = getPresetMode(activePreset);

  const applyProjectPreset = (mode: "cheapest" | "fastest", scope: "domestic" | "global") => {
    handleBulkPreset(buildScopedPreset(mode, scope));
  };

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

  if (isAuthInitializing && !user) {
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
        headerContent={
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-white/[0.94]">
            {projectLabel}
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
            scopedProject={
              projectQuery.data
                ? {
                    id: projectId,
                    name: projectQuery.data.name,
                    partCount: projectJobs.length,
                  }
                : null
            }
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

          <div className={cn("flex min-w-0 flex-col gap-4", !isMobile && focusedJobId && "xl:flex-row xl:items-start xl:gap-6")}>
            <div className="min-w-0 flex-1 space-y-4">
              <div className="rounded-lg border border-ws-border-subtle bg-ws-card p-4">
                <div className="flex flex-wrap items-center gap-2">
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

              <QuoteSelectionFunctionBar
                scope={bulkPresetScope}
                mode={bulkPresetMode}
                requestedByDate={projectDueByDate}
                onScopeChange={(nextScope) => applyProjectPreset(bulkPresetMode, nextScope)}
                onModeChange={(nextMode) => applyProjectPreset(nextMode, bulkPresetScope)}
                onRequestedByDateChange={setProjectDueByDate}
                dueDateHelpText="Applies to this project unless a part has its own requested-by date."
                domesticAriaLabel="Using domestic quotes for all parts"
                globalAriaLabel="Using global quotes for all parts"
              />

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
                      const rowSelectedPrice = summary?.selectedPriceUsd ?? null;
                      const rowSelectedLeadTime = summary?.selectedLeadTimeBusinessDays ?? null;
                      const hasQuote = rowSelectedPrice != null || rowSelectedLeadTime != null;
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
                          {hasQuote ? (
                            <>
                              <TableCell className="w-px whitespace-nowrap px-2 py-2.5 text-right text-[13px] text-white">
                                {rowSelectedPrice != null ? formatCurrency(rowSelectedPrice) : "—"}
                              </TableCell>
                              <TableCell className={cn("w-px whitespace-nowrap py-2.5 text-[13px] text-white/55", canTriggerRequest ? "px-2" : "pl-2 pr-5")}>
                                {typeof rowSelectedLeadTime === "number" ? `${rowSelectedLeadTime}d` : "—"}
                              </TableCell>
                            </>
                          ) : (
                            <TableCell className={cn("w-px whitespace-nowrap py-2.5 text-[13px] text-white/30", canTriggerRequest ? "px-2" : "pl-2 pr-5")} colSpan={2}>
                              —
                            </TableCell>
                          )}
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

            {!isMobile && focusedJobId ? (
              <aside className="min-w-0 xl:sticky xl:top-4 xl:w-[clamp(20rem,30vw,26.25rem)] xl:min-w-[20rem] xl:max-w-[26.25rem] xl:shrink-0">
                {focusedJob && focusedWorkspaceItem && focusedPresentation ? (
                  <ProjectInspectorPanel
                    mode="detail"
                    title={focusedPresentation.title}
                    description={focusedPresentation.description}
                    partNumber={focusedProperties?.part_number ?? focusedSummary?.partNumber}
                    revision={focusedProperties?.revision ?? focusedSummary?.revision}
                    material={focusedProperties?.material}
                    finish={focusedProperties?.finish}
                    quantity={focusedQuantity}
                    statusLabel={formatStatusLabel(focusedJob.status)}
                    createdLabel={formatDateLabel(focusedJob.created_at)}
                    projectName={projectLabel}
                    selectedQuoteLabel={focusedSelectedPrice != null ? formatCurrency(focusedSelectedPrice) : "—"}
                    leadTimeLabel={typeof focusedSelectedLeadTime === "number" ? `${focusedSelectedLeadTime}d` : "—"}
                    drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
                    drawingPreview={focusedWorkspaceItem.drawingPreview}
                    cadFile={focusedWorkspaceItem.part?.cadFile ?? null}
                    geometryProjection={focusedGeometryProjection}
                    quoteDataStatus={focusedQuoteDataStatus}
                    quoteDataMessage={focusedQuoteDataMessage}
                    quoteOptions={focusedQuoteOptions}
                    requestedByDate={focusedRequestedByDate}
                    selectedOfferId={focusedSelectedOfferId}
                    onSelectQuote={handleInspectorQuoteSelect}
                    onClear={handleClearFocusedJob}
                  />
                ) : (
                  <ProjectInspectorPanel
                    mode="empty"
                    emptyTitle="Loading line item detail"
                    emptyBody="Selected-part details are still loading."
                  />
                )}
              </aside>
            ) : null}
          </div>
        </div>
      </ClientWorkspaceShell>

      {isMobile ? (
        <Sheet
          open={mobileDrawerOpen && Boolean(focusedJobId)}
          onOpenChange={(open) => {
            if (open) {
              setMobileDrawerOpen(true);
              return;
            }

            handleClearFocusedJob();
          }}
        >
          <SheetContent side="right" className="w-[min(96vw,38rem)] overflow-y-auto border-white/10 bg-ws-overlay p-0 text-white sm:max-w-[38rem]">
            <SheetHeader className="border-b border-white/10 px-6 py-5">
              <SheetTitle className="text-white">Line item detail</SheetTitle>
              <SheetDescription className="text-white/55">
                Review selected-part details without leaving the project ledger.
              </SheetDescription>
            </SheetHeader>
            <div className="px-6 py-5">
              {focusedJob && focusedWorkspaceItem && focusedPresentation ? (
                <ProjectInspectorPanel
                  mode="detail"
                  title={focusedPresentation.title}
                  description={focusedPresentation.description}
                  partNumber={focusedProperties?.part_number ?? focusedSummary?.partNumber}
                  revision={focusedProperties?.revision ?? focusedSummary?.revision}
                  material={focusedProperties?.material}
                  finish={focusedProperties?.finish}
                  quantity={focusedQuantity}
                  statusLabel={formatStatusLabel(focusedJob.status)}
                  createdLabel={formatDateLabel(focusedJob.created_at)}
                  projectName={projectLabel}
                  selectedQuoteLabel={focusedSelectedPrice != null ? formatCurrency(focusedSelectedPrice) : "—"}
                  leadTimeLabel={typeof focusedSelectedLeadTime === "number" ? `${focusedSelectedLeadTime}d` : "—"}
                  drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
                  drawingPreview={focusedWorkspaceItem.drawingPreview}
                  cadFile={focusedWorkspaceItem.part?.cadFile ?? null}
                  geometryProjection={focusedGeometryProjection}
                  quoteDataStatus={focusedQuoteDataStatus}
                  quoteDataMessage={focusedQuoteDataMessage}
                  quoteOptions={focusedQuoteOptions}
                  requestedByDate={focusedRequestedByDate}
                  selectedOfferId={focusedSelectedOfferId}
                  onSelectQuote={handleInspectorQuoteSelect}
                  onClear={handleClearFocusedJob}
                />
              ) : (
                <ProjectInspectorPanel
                  mode="empty"
                  emptyTitle="Loading line item detail"
                  emptyBody="Selected-part details are still loading."
                />
              )}
            </div>
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
        <DialogContent className="border-white/10 bg-ws-overlay text-white">
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
        <DialogContent className="border-white/10 bg-ws-overlay text-white">
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
        <DialogContent className="border-white/10 bg-ws-overlay text-white">
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
