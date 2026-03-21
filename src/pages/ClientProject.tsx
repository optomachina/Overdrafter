import { useMemo } from "react";
import { Loader2, MoveRight, PlusSquare, Search as SearchIcon, ArrowRight } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { ActivityLog } from "@/components/quotes/ActivityLog";
import { ClientArtifactWorkspace } from "@/components/quotes/ClientArtifactWorkspace";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ClientIntelligencePanel } from "@/components/quotes/ClientIntelligencePanel";
import { ClientPartHeader } from "@/components/quotes/ClientPartHeader";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import { ClientQuoteDecisionPanel } from "@/components/quotes/ClientQuoteDecisionPanel";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { ClientWorkspaceStateSummary } from "@/components/quotes/ClientWorkspaceStateSummary";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import {
  ClientDfmPanel,
  ClientMetadataPanel,
  ClientQuoteRequestStatusCard,
  ClientReadOnlyChatPanel,
} from "@/components/quotes/ClientWorkspacePanelContent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useClientProjectController } from "@/features/quotes/use-client-project-controller";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  buildClientWorkspaceState,
} from "@/features/quotes/client-workspace-state";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { formatStatusLabel, normalizeDrawingExtraction } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientProject = () => {
  const {
    accessibleJobsQuery,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    attachFilesPicker,
    canManageMembers,
    filteredJobs,
    focusedActivityEntries,
    focusedDraft,
    focusedJob,
    focusedJobId,
    focusedQuoteDataMessage,
    focusedQuoteDataStatus,
    focusedQuoteDiagnostics,
    focusedQuoteOptions,
    focusedQuoteQuantityInput,
    focusedSelectedOption,
    focusedSummary,
    focusedWorkspaceItem,
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
    handleSelectQuoteOption,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isMobile,
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
    requestDraftsByJobId,
    resolveSidebarProjectIdsForJob,
    saveRequestMutation,
    optionsByJobId,
    requestProjectQuotesMutation,
    selectedOptionsByJobId,
    isSearchOpen,
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
    user,
    isAuthInitializing,
    workspaceItemsByJobId,
  } = useClientProjectController();
  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const workspaceStatesByJobId = useMemo(
    () =>
      new Map(
        projectJobs.map((job) => {
          const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
          const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
          const requestDraft = requestDraftsByJobId[job.id] ?? null;
          const requestedByDate =
            requestDraft?.requestedByDate ??
            summary?.requestedByDate ??
            workspaceItem?.job.requested_by_date ??
            job.requested_by_date ??
            null;

          return [
            job.id,
            buildClientWorkspaceState({
              job,
              summary,
              part: workspaceItem?.part ?? null,
              options: optionsByJobId[job.id] ?? [],
              selectedOption: selectedOptionsByJobId[job.id] ?? null,
              requestedByDate,
            }),
          ] as const;
        }),
      ),
    [optionsByJobId, projectJobs, requestDraftsByJobId, selectedOptionsByJobId, summariesByJobId, workspaceItemsByJobId],
  );
  const focusedWorkspaceState = focusedJob ? workspaceStatesByJobId.get(focusedJob.id) ?? null : null;
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
  const focusedExtraction =
    focusedWorkspaceItem?.part ? normalizeDrawingExtraction(focusedWorkspaceItem.part.extraction, focusedWorkspaceItem.part.id) : null;

  const renderFocusedWorkspace = () => {
    if (!focusedJob || !focusedWorkspaceItem) {
      return (
        <div className="rounded-[30px] border border-white/8 bg-[#262626] p-8">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Selected part workspace</p>
          <p className="mt-3 text-lg font-medium text-white">Select a project part to inspect its artifacts and quotes.</p>
          <p className="mt-2 max-w-2xl text-sm text-white/50">
            The project stays project-first, but the selected line item now opens as an artifact-first workspace with quote and metadata context docked to the side.
          </p>
        </div>
      );
    }

    const focusedPresentation = getClientItemPresentation(focusedJob, focusedSummary);
    const focusedRequestedByDate =
      focusedDraft?.requestedByDate ?? focusedSummary?.requestedByDate ?? focusedWorkspaceItem.job.requested_by_date ?? null;
    const focusedQuantity = focusedDraft?.quantity ?? focusedSummary?.quantity ?? null;
    const focusedRequestedQuoteQuantities = focusedDraft?.requestedQuoteQuantities ?? focusedSummary?.requestedQuoteQuantities ?? [];

    const renderVendorExclusionControls = () => {
      const visibleOptions = focusedQuoteOptions.slice(0, 6);

      if (visibleOptions.length === 0) {
        return null;
      }

      return (
        <section className="rounded-[24px] border border-white/8 bg-black/20 p-4">
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
        </section>
      );
    };

    const quoteRailContent = (
      <div className="space-y-4">
        <section className="rounded-[24px] border border-white/8 bg-black/20 p-4">
          <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Request summary</p>
          <RequestSummaryBadges
            requestedServiceKinds={focusedDraft?.requestedServiceKinds ?? focusedSummary?.requestedServiceKinds ?? []}
            quantity={focusedQuantity}
            requestedQuoteQuantities={focusedRequestedQuoteQuantities}
            requestedByDate={focusedRequestedByDate}
            className="mt-3"
          />
        </section>

        <ClientExtractionStatusNotice diagnostics={focusedWorkspaceItem.part?.clientExtraction ?? null} />

        {focusedQuoteRequestViewModel ? (
          <ClientQuoteRequestStatusCard
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

        {renderVendorExclusionControls()}

        <section className="rounded-[24px] border border-white/8 bg-black/20 p-4">
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Request details</p>
            <p className="mt-2 text-sm text-white/55">
              Edit quote-safe request details for this selected line item without leaving the project workspace.
            </p>
          </div>
          {focusedDraft ? (
            <ClientPartRequestEditor
              draft={focusedDraft}
              quoteQuantityInput={focusedQuoteQuantityInput}
              onQuoteQuantityInputChange={(value) => handleQuoteQuantityInputChange(focusedJob.id, value)}
              onChange={(next) => handleRequestDraftChange(focusedJob.id, next)}
              onSave={() => handleSaveRequest(focusedJob.id)}
              onUploadRevision={attachFilesPicker.openFilePicker}
              isSaving={saveRequestMutation.isPending}
            />
          ) : (
            <p className="text-sm text-white/45">Select a part with editable request details to continue.</p>
          )}
        </section>
      </div>
    );

    return (
      <div className="space-y-6">
        <ClientPartHeader
          eyebrow="Selected part workspace"
          title={focusedPresentation.title}
          description={focusedPresentation.description}
          badges={
            <>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {formatStatusLabel(focusedJob.status)}
              </Badge>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {projectQuery.data?.name ?? "Project"}
              </Badge>
              {focusedSelectedOption ? (
                <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                  {focusedSelectedOption.vendorLabel}
                </Badge>
              ) : null}
            </>
          }
          details={
            <RequestSummaryBadges
              requestedServiceKinds={focusedDraft?.requestedServiceKinds ?? focusedSummary?.requestedServiceKinds ?? []}
              quantity={focusedQuantity}
              requestedQuoteQuantities={focusedRequestedQuoteQuantities}
              requestedByDate={focusedRequestedByDate}
            />
          }
          actions={
            <Button type="button" className="rounded-full" onClick={() => navigate(`/parts/${focusedJob.id}`)}>
              Open part workspace
              <MoveRight className="ml-2 h-4 w-4" />
            </Button>
          }
        />

        {focusedWorkspaceState ? <ClientWorkspaceStateSummary state={focusedWorkspaceState} /> : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <ClientArtifactWorkspace
              itemKey={focusedJob.id}
              hasCad={Boolean(focusedWorkspaceItem.part?.cadFile)}
              hasDrawing={Boolean(focusedWorkspaceItem.part?.drawingFile)}
              drawingPanel={
                <ClientDrawingPreviewPanel
                  drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
                  drawingPreview={focusedWorkspaceItem.drawingPreview}
                />
              }
              cadPanel={<ClientCadPreviewPanel cadFile={focusedWorkspaceItem.part?.cadFile ?? null} />}
            />

            <ClientQuoteDecisionPanel
              title="Selected part quote intelligence"
              description="Keep the project-level selection view, but make the chosen line item readable as an artifact-first engineering workspace."
              options={focusedQuoteOptions}
              selectedOption={focusedSelectedOption}
              quoteDataStatus={focusedQuoteDataStatus}
              quoteDataMessage={focusedQuoteDataMessage}
              quoteDiagnostics={focusedQuoteDiagnostics}
              partId={focusedWorkspaceItem.part?.id ?? null}
              organizationId={focusedWorkspaceItem.job.organization_id}
              onSelect={(option) => {
                void handleSelectQuoteOption(focusedJob.id, option);
              }}
              requestedByDate={focusedRequestedByDate}
              onToggleVendorExclusion={(vendorKey, nextExcluded) => {
                handleToggleVendorExclusion(focusedJob.id, vendorKey, nextExcluded);
              }}
              emptyState="No quote options are available for this project line item yet."
            />
          </div>

          <ClientIntelligencePanel
            itemKey={focusedJob.id}
            quoteContent={quoteRailContent}
            metadataContent={
              <ClientMetadataPanel
                summary={focusedSummary}
                part={focusedWorkspaceItem.part}
                extraction={focusedExtraction}
                quoteOptions={focusedQuoteOptions}
              />
            }
            dfmContent={<ClientDfmPanel quoteOptions={focusedQuoteOptions} />}
            historyContent={<ActivityLog entries={focusedActivityEntries} />}
            chatContent={
              <ClientReadOnlyChatPanel
                partLabel={focusedPresentation.title}
                latestQuoteRequest={focusedWorkspaceItem.latestQuoteRequest}
                latestQuoteRun={focusedWorkspaceItem.latestQuoteRun}
              />
            }
          />
        </div>
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
          <div className="grid grid-cols-4 gap-[10px]">
            <div className="rounded-[16px] border border-ws-border-subtle bg-ws-card p-[16px]">
              <p className="mb-[4px] text-[11px] text-white/45">Total parts</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectJobs.length}</p>
            </div>
            <div className="rounded-[16px] border border-ws-border-subtle bg-ws-card p-[16px]">
              <p className="mb-[4px] text-[11px] text-white/45">Quoted</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-emerald-400">{projectQuoteRequestSummary.received}</p>
            </div>
            <div className="rounded-[16px] border border-ws-border-subtle bg-ws-card p-[16px]">
              <p className="mb-[4px] text-[11px] text-white/45">Requesting</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-amber-400">{projectQuoteRequestSummary.requesting}</p>
            </div>
            <div className="rounded-[16px] border border-ws-border-subtle bg-ws-card p-[16px]">
              <p className="mb-[4px] text-[11px] text-white/45">Not requested</p>
              <p className="text-[24px] font-bold tracking-[-0.02em] text-white">{projectQuoteRequestSummary.notRequested}</p>
            </div>
          </div>

          {/* Parts table */}
          <div className="overflow-hidden rounded-[24px] border border-ws-border-subtle bg-ws-card">
            {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
              <div className="flex min-h-[240px] items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-white/60" />
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="px-6 py-12 text-center text-white/45">No parts in this project yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <div className="grid grid-cols-[2fr_1fr_1fr_1fr_100px] border-b border-white/[0.04] px-[18px] py-[10px] bg-white/[0.02]">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Part</div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Material</div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Qty</div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Quote status</div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">Action</div>
                </div>

                {filteredJobs.map((job) => {
                  const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                  const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                  const presentation = getClientItemPresentation(job, summary);
                  const quoteRequestViewModel = quoteRequestViewModelsByJobId.get(job.id) ?? null;

                  const fileType = workspaceItem?.part?.cadFile
                    ? "STEP/SLDPRT"
                    : workspaceItem?.part?.drawingFile
                      ? "PDF"
                      : "Unknown";
                  const revision = summary?.revision ?? "—";
                  const quantity = summary?.quantity ?? "—";
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
                    <div
                      key={job.id}
                      className="grid grid-cols-[2fr_1fr_1fr_1fr_100px] border-b border-white/[0.04] px-[18px] py-[13px] last:border-0 items-center hover:bg-white/[0.02] cursor-pointer transition"
                      onClick={() => handleOpenJobDrawer(job.id)}
                    >
                      {/* Part column */}
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-white truncate">{presentation.title}</p>
                        <p className="text-[11px] text-white/45">
                          {fileType} • {revision}
                        </p>
                      </div>

                      {/* Material column */}
                      <div className="text-[13px] text-white/55">—</div>

                      {/* Qty column */}
                      <div className="text-[13px] text-white/55">{quantity}</div>

                      {/* Quote status badge */}
                      <div>
                        <Badge className={quoteStatusClassName}>{quoteStatusLabel}</Badge>
                      </div>

                      {/* Action button */}
                      <div className="text-right">
                        {canTriggerRequest ? (
                          <Button
                            type="button"
                            className="rounded-[6px] h-auto px-2 py-1 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
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
                            className="rounded-[6px] border-white/10 bg-transparent text-white hover:bg-white/6 h-auto px-2 py-1 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenJobDrawer(job.id);
                            }}
                          >
                            View <ArrowRight className="ml-1 h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {!isMobile ? renderFocusedWorkspace() : null}
        </div>
      </ClientWorkspaceShell>

      <Sheet open={mobileDrawerOpen && Boolean(focusedJobId)} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="right" className="w-[min(96vw,38rem)] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white sm:max-w-[38rem]">
          <SheetHeader className="border-b border-white/10 px-6 py-5">
            <SheetTitle className="text-white">Line item detail</SheetTitle>
            <SheetDescription className="text-white/55">
              Review previews, metadata, and quote options for the selected project row.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-5">{renderFocusedWorkspace()}</div>
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
