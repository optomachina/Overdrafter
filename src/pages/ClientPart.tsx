import { useEffect, useState } from "react";
import {
  FolderInput,
  Loader2,
  MoreHorizontal,
  MoveRight,
  PlusSquare,
  Search,
  Upload,
  XCircle,
} from "lucide-react";
import { PartDropdownMenuActions } from "@/components/chat/PartActionsMenu";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { CadPanel } from "@/components/workspace/CadPanel";
import { PartInfoPanel } from "@/components/workspace/PartInfoPanel";
import { PdfPanel } from "@/components/workspace/PdfPanel";
import { QuoteChart } from "@/components/workspace/QuoteChart";
import { QuoteList } from "@/components/workspace/QuoteList";
import { QuoteStatBar } from "@/components/workspace/QuoteStatBar";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ClientPartHeader } from "@/components/quotes/ClientPartHeader";
import { ClientWorkspaceStateSummary, ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";
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
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import { buildClientWorkspaceState } from "@/features/quotes/client-workspace-state";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientPart = () => {
  const {
    accessibleJobsQuery,
    activeMembership,
    activePreset,
    archivedJobsQuery,
    archivedProjectsQuery,
    assignJobMutation,
    attachFilesPicker,
    cadFile,
    currentPartName,
    currentProjectOptions,
    displayPartTitle,
    drawingFile,
    drawingPdfUrl,
    drawingPreview,
    drawingPreviewPageUrls,
    drawingViewerMode,
    drawingPreviewState,
    drawingPreviewStatusMessage,
    extractionDiagnostics,
    effectiveRequestDraft,
    extraction,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleDownloadFile,
    handleDraftChange,
    handlePinPart,
    handlePinProject,
    handlePresetSelection,
    handleRemovePartFromProject,
    handleRenamePart,
    handleRenameProject,
    handleRequestQuote,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isPartOptionsOpen,
    isPartPinBusy,
    isRequestingQuote,
    isRenamingPart,
    isSearchOpen,
    jobId,
    navigate,
    newJobFilePicker,
    partDetail,
    partRenameValue,
    pinnedJobIds,
    prefetchPart,
    prefetchProject,
    presentation,
    projectCollaborationUnavailable,
    projectMemberships,
    quoteDataMessage,
    quoteDataStatus,
    quoteDiagnostics,
    quoteQuantityInput,
    rankedQuoteOptions,
    removeJobMutation,
    requestQuantities,
    requestSummaryQuantity,
    requestSummaryRequestedByDate,
    resolveSidebarProjectIdsForJob,
    revisionOptions,
    saveRequestMutation,
    selectedQuoteOption,
    selectedRevisionIndex,
    setIsPartArchiveBusy,
    setIsPartOptionsOpen,
    setIsSearchOpen,
    setPartRenameValue,
    setQuoteQuantityInput,
    setShowDrawingPreview,
    setShowMoveDialog,
    setShowRenameDialog,
    showDrawingPreview,
    showMoveDialog,
    showRenameDialog,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    summary,
    user,
    isAuthInitializing,
  } = useClientPartController();

  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(selectedQuoteOption?.offerId ?? null);

  useEffect(() => {
    setSelectedOfferId(selectedQuoteOption?.offerId ?? null);
  }, [selectedQuoteOption?.offerId]);

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your part workspace." />;
  }

  if (!user) {
    return null;
  }

  const workspaceState =
    partDetail?.job && partDetail.part
      ? buildClientWorkspaceState({
          job: partDetail.job,
          summary,
          part: partDetail.part,
          options: rankedQuoteOptions,
          selectedOption: selectedQuoteOption,
          requestedByDate: requestSummaryRequestedByDate,
        })
      : null;
  const quoteRequestViewModel =
    partDetail?.job
      ? buildQuoteRequestViewModel({
          job: partDetail.job,
          part: partDetail.part,
          latestQuoteRequest: partDetail.latestQuoteRequest,
          latestQuoteRun: partDetail.latestQuoteRun,
        })
      : null;

  const handleQuoteRequestAction = () => {
    if (!quoteRequestViewModel || quoteRequestViewModel.action.kind === "none") {
      return;
    }

    void handleRequestQuote(quoteRequestViewModel.action.kind === "retry");
  };

  const handleWorkspaceOfferSelect = (offerId: string | null) => {
    if (offerId === null) {
      setSelectedOfferId(null);
      handleSelectQuoteOption(null);
      return;
    }

    const nextOption = rankedQuoteOptions.find((option) => option.offerId === offerId) ?? null;

    if (!nextOption) {
      return;
    }

    setSelectedOfferId(offerId);
    handleSelectQuoteOption(nextOption);
  };

  return (
    <>
      <ClientWorkspaceShell
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: Search, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeJobId={jobId}
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
            onRenamePart={handleRenamePart}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
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
        <div className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          {isPartDetailLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
          ) : partDetail?.job && presentation ? (
            <>
              <ClientPartHeader
                eyebrow="Part workspace"
                title={displayPartTitle}
                description={presentation.description}
                badges={
                  <>
                    <Badge className="border border-white/10 bg-white/6 text-white/75">
                      {formatStatusLabel(partDetail.job.status)}
                    </Badge>
                    {quoteRequestViewModel ? (
                      <ClientWorkspaceToneBadge
                        tone={quoteRequestViewModel.tone}
                        label={`Quote ${quoteRequestViewModel.label}`}
                        className="tracking-normal normal-case"
                      />
                    ) : null}
                    {projectMemberships.length > 0 ? (
                      projectMemberships.map((project) => (
                        <Badge key={project.project.id} className="border border-white/10 bg-white/6 text-white/75">
                          {project.project.name}
                        </Badge>
                      ))
                    ) : (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">Standalone part</Badge>
                    )}
                    {!cadFile ? (
                      <Badge className="border border-amber-400/25 bg-amber-500/10 text-amber-200">
                        CAD missing
                      </Badge>
                    ) : null}
                    {!drawingFile ? (
                      <Badge className="border border-sky-400/25 bg-sky-500/10 text-sky-200">
                        Drawing missing
                      </Badge>
                    ) : null}
                  </>
                }
                details={
                  <RequestSummaryBadges
                    requestedServiceKinds={
                      effectiveRequestDraft?.requestedServiceKinds ?? summary?.requestedServiceKinds ?? []
                    }
                    quantity={requestSummaryQuantity}
                    requestedQuoteQuantities={requestQuantities}
                    requestedByDate={requestSummaryRequestedByDate}
                  />
                }
                actions={
                  <>
                    {revisionOptions.length > 1 ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                          onClick={() => {
                            const previousId =
                              revisionOptions[
                                (selectedRevisionIndex - 1 + revisionOptions.length) % revisionOptions.length
                              ]?.jobId;
                            if (previousId) {
                              navigate(`/parts/${previousId}`);
                            }
                          }}
                        >
                          Prev rev
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                          onClick={() => {
                            const nextId =
                              revisionOptions[(selectedRevisionIndex + 1) % revisionOptions.length]?.jobId;
                            if (nextId) {
                              navigate(`/parts/${nextId}`);
                            }
                          }}
                        >
                          {revisionOptions[selectedRevisionIndex]?.revision ?? "Rev"}
                        </Button>
                      </>
                    ) : null}
                    {projectMemberships.length === 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => navigate(`/projects/${projectMemberships[0]!.project.id}`)}
                      >
                        Open project
                      </Button>
                    ) : null}
                    {!projectCollaborationUnavailable ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => setShowMoveDialog(true)}
                      >
                        <FolderInput className="mr-2 h-4 w-4" />
                        Manage projects
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-white/8 text-white hover:bg-white/12"
                      onClick={attachFilesPicker.openFilePicker}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Attach files
                    </Button>
                    <Button type="button" className="rounded-full shadow-sm" onClick={() => navigate(`/parts/${jobId}/review`)}>
                      Review order
                      <MoveRight className="ml-2 h-4 w-4" />
                    </Button>
                    <DropdownMenu open={isPartOptionsOpen} onOpenChange={setIsPartOptionsOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label="Part options"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        >
                          <MoreHorizontal className="mr-2 h-4 w-4" />
                          Options
                        </Button>
                      </DropdownMenuTrigger>
                      <PartDropdownMenuActions
                        onEditPart={() => navigate(`/parts/${jobId}`)}
                        onRenamePart={() => {
                          setPartRenameValue(currentPartName);
                          setShowRenameDialog(true);
                          setIsPartOptionsOpen(false);
                        }}
                        onCreateProject={
                          !projectCollaborationUnavailable
                            ? () => {
                                setIsPartOptionsOpen(false);
                                void handleCreateProjectFromSelection([jobId]);
                              }
                            : undefined
                        }
                        addableProjects={currentProjectOptions
                          .filter((project) => !(partDetail?.projectIds ?? []).includes(project.project.id))
                          .map((project) => ({ id: project.project.id, name: project.project.name }))}
                        removableProjects={currentProjectOptions
                          .filter((project) => (partDetail?.projectIds ?? []).includes(project.project.id))
                          .map((project) => ({ id: project.project.id, name: project.project.name }))}
                        singleRemoveLabel="Remove from project"
                        isMoveBusy={assignJobMutation.isPending || removeJobMutation.isPending}
                        onAddToProject={
                          !projectCollaborationUnavailable
                            ? (projectId) => {
                                assignJobMutation.mutate(projectId);
                                setIsPartOptionsOpen(false);
                              }
                            : undefined
                        }
                        onRemoveFromProject={
                          !projectCollaborationUnavailable
                            ? (projectId) => {
                                removeJobMutation.mutate(projectId);
                                setIsPartOptionsOpen(false);
                              }
                            : undefined
                        }
                        onArchivePart={() => {
                          setIsPartOptionsOpen(false);
                          setIsPartArchiveBusy(true);
                          void handleArchivePart(jobId).finally(() => setIsPartArchiveBusy(false));
                        }}
                        isArchiveBusy={isPartArchiveBusy}
                        pinLabel={pinnedJobIds.includes(jobId) ? "Unpin" : "Pin"}
                        onTogglePin={() => {
                          setIsPartOptionsOpen(false);
                          void handleToggleCurrentPartPin();
                        }}
                        isPinBusy={isPartPinBusy}
                      />
                    </DropdownMenu>
                  </>
                }
              />

              {workspaceState ? <ClientWorkspaceStateSummary state={workspaceState} /> : null}

              <div className="grid items-start gap-4 xl:grid-cols-[2fr_1fr]">
                <div className="flex flex-col gap-4">
                  <QuoteStatBar quotes={rankedQuoteOptions} />
                  <QuoteChart
                    quotes={rankedQuoteOptions}
                    selectedOfferId={selectedOfferId}
                    onSelect={handleWorkspaceOfferSelect}
                  />
                  <QuoteList
                    quotes={rankedQuoteOptions}
                    selectedOfferId={selectedOfferId}
                    onSelect={handleWorkspaceOfferSelect}
                    requestedByDate={requestSummaryRequestedByDate}
                    quoteDataStatus={quoteDataStatus}
                    quoteDataMessage={quoteDataMessage}
                    quoteDiagnostics={quoteDiagnostics}
                    activePreset={activePreset}
                    onPresetSelect={handlePresetSelection}
                    onToggleVendorExclusion={handleToggleVendorExclusion}
                  />
                </div>

                <div className="flex flex-col gap-6">
                  <PartInfoPanel
                    part={partDetail.part}
                    summary={summary}
                    extraction={extraction}
                    effectiveRequestDraft={effectiveRequestDraft}
                    quoteQuantityInput={quoteQuantityInput}
                    onQuoteQuantityInputChange={setQuoteQuantityInput}
                    onDraftChange={handleDraftChange}
                    onSave={handleSaveRequest}
                    onUploadRevision={attachFilesPicker.openFilePicker}
                    isSaving={saveRequestMutation.isPending}
                    drawingFileName={drawingFile?.original_name ?? null}
                    statusContent={
                      <>
                        <ClientExtractionStatusNotice diagnostics={extractionDiagnostics} />
                        {quoteRequestViewModel ? (
                          <ClientQuoteRequestStatusCard
                            tone={quoteRequestViewModel.tone}
                            label={quoteRequestViewModel.label}
                            detail={quoteRequestViewModel.detail}
                            actionLabel={quoteRequestViewModel.action.label}
                            actionDisabled={quoteRequestViewModel.action.disabled}
                            blockerReasons={quoteRequestViewModel.blockerReasons}
                            isBusy={isRequestingQuote}
                            onAction={quoteRequestViewModel.action.kind === "none" ? null : handleQuoteRequestAction}
                          />
                        ) : null}
                      </>
                    }
                  />
                  <CadPanel cadFile={cadFile} />
                  <PdfPanel
                    drawingFile={drawingFile}
                    drawingPreview={drawingPreview}
                    drawingPdfUrl={drawingPdfUrl}
                    drawingPreviewPageUrls={drawingPreviewPageUrls}
                    drawingViewerMode={drawingViewerMode}
                    drawingPreviewState={drawingPreviewState}
                    drawingPreviewStatusMessage={drawingPreviewStatusMessage}
                    isLoading={isDrawingPreviewLoading}
                    onOpenDialog={drawingFile ? () => setShowDrawingPreview(true) : undefined}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-[26px] border border-white/8 bg-[#262626] px-6 py-12 text-center text-white/45">
              This part could not be loaded.
            </div>
          )}
        </div>
      </ClientWorkspaceShell>

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
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
        aria-label="Attach files to part"
      />

      {drawingFile ? (
        <DrawingPreviewDialog
          open={showDrawingPreview}
          onOpenChange={setShowDrawingPreview}
          fileName={drawingFile.original_name}
          pageCount={drawingPreview?.pageCount ?? 0}
          viewerMode={drawingViewerMode}
          pdfUrl={drawingPdfUrl}
          pages={drawingPreviewPageUrls}
          isLoading={isDrawingPreviewLoading}
          state={drawingPreviewState}
          statusMessage={drawingPreviewStatusMessage}
          onDownload={() => {
            void handleDownloadFile(drawingFile);
          }}
        />
      ) : null}

      <ProjectNameDialog
        open={showRenameDialog}
        onOpenChange={(open) => {
          setShowRenameDialog(open);
          if (!open) {
            setPartRenameValue(currentPartName);
          }
        }}
        title="Rename part"
        description="Update the part name shown throughout your workspace."
        value={partRenameValue}
        onValueChange={setPartRenameValue}
        submitLabel="Save"
        placeholder="Part name"
        isPending={isRenamingPart}
        isSubmitDisabled={partRenameValue.trim().length === 0 || partRenameValue.trim() === currentPartName}
        onSubmit={() => handleRenamePart(jobId, partRenameValue.trim())}
      />

      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Manage project membership</DialogTitle>
            <DialogDescription className="text-white/55">
              Add this part to more projects or remove it from projects it already belongs to.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {currentProjectOptions.length === 0 ? (
              <p className="text-sm text-white/45">No compatible projects are available for this part.</p>
            ) : (
              currentProjectOptions.map((project) => (
                <button
                  key={project.project.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-left transition hover:bg-white/4",
                    partDetail?.projectIds.includes(project.project.id) && "border-white/20",
                  )}
                  disabled={assignJobMutation.isPending || removeJobMutation.isPending}
                  onClick={() => {
                    if (partDetail?.projectIds.includes(project.project.id)) {
                      removeJobMutation.mutate(project.project.id);
                      return;
                    }

                    assignJobMutation.mutate(project.project.id);
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-white">{project.project.name}</p>
                    <p className="text-xs text-white/45">{project.partCount} parts</p>
                  </div>
                  {partDetail?.projectIds.includes(project.project.id) ? (
                    <XCircle className="h-4 w-4 text-white/45" />
                  ) : (
                    <MoveRight className="h-4 w-4 text-white/45" />
                  )}
                </button>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowMoveDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ClientPart;
