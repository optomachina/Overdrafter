import {
  ChevronDown,
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
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { ActivityLog } from "@/components/quotes/ActivityLog";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { ClientQuoteComparisonChart } from "@/components/quotes/ClientQuoteComparisonChart";
import { ClientWorkspaceStateSummary, ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import {
  buildClientWorkspaceState,
  getClientQuoteOptionStateReasons,
} from "@/features/quotes/client-workspace-state";
import { formatCurrency, formatLeadTime, formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientPart = () => {
  const {
    accessibleJobsQuery,
    activeMembership,
    activePreset,
    activityEntries,
    archivedJobsQuery,
    archivedProjectsQuery,
    assignJobMutation,
    attachFilesPicker,
    cadFile,
    currentPartName,
    currentProjectOptions,
    displayPartTitle,
    drawingFile,
    drawingPreview,
    drawingPreviewPageUrls,
    effectiveRequestDraft,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedPart,
    handleDissolveProject,
    handleDownloadFile,
    handleDraftChange,
    handlePinPart,
    handlePinProject,
    handlePresetSelection,
    handleRemovePartFromProject,
    handleRenamePart,
    handleRenameProject,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartArchiveBusy,
    isPartOptionsOpen,
    isPartPinBusy,
    isRenamingPart,
    isSearchOpen,
    jobId,
    navigate,
    newJobFilePicker,
    partDetail,
    partDetailQuery,
    partRenameValue,
    pinnedJobIds,
    prefetchPart,
    prefetchProject,
    presentation,
    projectCollaborationUnavailable,
    projectMemberships,
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
  } = useClientPartController();

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

  return (
    <>
      <ChatWorkspaceLayout
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
            onSelectPart={(partId) => navigate(`/parts/${partId}`)}
            onPrefetchProject={prefetchProject}
            onPrefetchPart={prefetchPart}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
          />
        }
        sidebarFooter={
          <WorkspaceAccountMenu
            user={user}
            activeMembership={activeMembership}
            onSignOut={signOut}
            onSignedOut={() => navigate("/", { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
            onUnarchivePart={handleUnarchivePart}
            onDeleteArchivedPart={handleDeleteArchivedPart}
          />
        }
      >
        <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          {partDetailQuery.isLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
          ) : partDetail?.job && presentation ? (
            <>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-white/35">Part workspace</p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{displayPartTitle}</h1>
                  <p className="mt-2 max-w-3xl text-sm text-white/55">{presentation.description}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge className="border border-white/10 bg-white/6 text-white/75">
                      {formatStatusLabel(partDetail.job.status)}
                    </Badge>
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
                  </div>
                  <RequestSummaryBadges
                    quantity={requestSummaryQuantity}
                    requestedQuoteQuantities={requestQuantities}
                    requestedByDate={requestSummaryRequestedByDate}
                    className="mt-4"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {revisionOptions.length > 1 ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => {
                          const previousId =
                            revisionOptions[
                              (selectedRevisionIndex - 1 + revisionOptions.length) %
                                revisionOptions.length
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
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={attachFilesPicker.openFilePicker}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Attach files
                  </Button>
                  <Button type="button" className="rounded-full" onClick={() => navigate(`/parts/${jobId}/review`)}>
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
                </div>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <ClientDrawingPreviewPanel
                  drawingFile={drawingFile}
                  drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
                  onOpenDialog={drawingFile ? () => setShowDrawingPreview(true) : undefined}
                />
                <ClientCadPreviewPanel cadFile={cadFile} />
              </div>

              {workspaceState ? <ClientWorkspaceStateSummary state={workspaceState} /> : null}

              <section className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quote comparison</p>
                    <p className="mt-2 text-sm text-white/55">
                      Ready, warning, and blocked reasons update as due dates, exclusions, and quote responses change.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(["cheapest", "fastest", "domestic"] as const).map((preset) => (
                      <Button
                        key={preset}
                        type="button"
                        variant={activePreset === preset ? "default" : "outline"}
                        className={cn(
                          "rounded-full border-white/10",
                          activePreset === preset
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-transparent text-white hover:bg-white/6",
                        )}
                        onClick={() => handlePresetSelection(preset)}
                      >
                        {preset === "cheapest" ? "Cheapest" : preset === "fastest" ? "Fastest" : "Domestic"}
                      </Button>
                    ))}
                  </div>
                </div>

                {selectedQuoteOption ? (
                  <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Current selection</p>
                    <p className="mt-2 text-lg font-semibold text-white">{selectedQuoteOption.vendorLabel}</p>
                    <p className="text-sm text-emerald-100/85">
                      {formatCurrency(selectedQuoteOption.totalPriceUsd)} total ·{" "}
                      {selectedQuoteOption.resolvedDeliveryDate ?? formatLeadTime(selectedQuoteOption.leadTimeBusinessDays)}
                    </p>
                  </div>
                ) : null}

                {!rankedQuoteOptions.length ? (
                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-6 text-sm text-white/45">
                    {cadFile
                      ? "No quote options are available yet."
                      : "Upload a CAD model before quote options can be compared."}
                  </div>
                ) : (
                  <>
                    <div className="mt-4 rounded-[22px] border border-white/8 bg-black/20 p-4">
                      <ClientQuoteComparisonChart
                        options={rankedQuoteOptions}
                        selectedKey={selectedQuoteOption?.key ?? null}
                        onSelect={handleSelectQuoteOption}
                      />
                    </div>

                    <div className="mt-4 space-y-3">
                      {rankedQuoteOptions.map((option) => {
                        const selected = selectedQuoteOption?.key === option.key;
                        const domesticLabel =
                          option.domesticStatus === "domestic"
                            ? "USA"
                            : option.domesticStatus === "foreign"
                              ? "Foreign"
                              : "Unknown";

                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => handleSelectQuoteOption(option)}
                            className={cn(
                              "block w-full rounded-2xl border px-4 py-4 text-left transition",
                              selected
                                ? "border-emerald-500/30 bg-emerald-500/10"
                                : "border-white/8 bg-black/20 hover:bg-white/4",
                              !option.isSelectable && "cursor-not-allowed opacity-70",
                            )}
                            disabled={!option.isSelectable}
                          >
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-semibold text-white">{option.vendorLabel}</p>
                                  <Badge className="border border-white/10 bg-white/6 text-white/70">
                                    Qty {option.requestedQuantity}
                                  </Badge>
                                  <Badge
                                    className={cn(
                                      "border",
                                      option.domesticStatus === "domestic"
                                        ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                                        : option.domesticStatus === "foreign"
                                          ? "border-sky-400/20 bg-sky-500/10 text-sky-100"
                                          : "border-white/10 bg-white/6 text-white/70",
                                    )}
                                  >
                                    {domesticLabel}
                                  </Badge>
                                  {option.expedite ? (
                                    <Badge className="border border-fuchsia-400/20 bg-fuchsia-500/10 text-fuchsia-100">
                                      Expedite
                                    </Badge>
                                  ) : null}
                                  {!option.dueDateEligible && requestSummaryRequestedByDate ? (
                                    <Badge className="border border-amber-400/20 bg-amber-500/10 text-amber-100">
                                      Late
                                    </Badge>
                                  ) : null}
                                  {option.excluded ? (
                                    <Badge className="border border-white/10 bg-white/6 text-white/70">
                                      Excluded
                                    </Badge>
                                  ) : null}
                                  {selected ? (
                                    <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                                      Selected
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-2 text-sm text-white/55">
                                  {option.laneLabel ?? option.tier ?? "Standard lane"}
                                  {option.process ? ` · ${option.process}` : ""}
                                  {option.material ? ` · ${option.material}` : ""}
                                </p>
                                {(() => {
                                  const optionReasons = getClientQuoteOptionStateReasons({
                                    option,
                                    requestedByDate: requestSummaryRequestedByDate,
                                    preset: activePreset ?? null,
                                  });

                                  if (optionReasons.length === 0) {
                                    return null;
                                  }

                                  return (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {optionReasons.map((reason) => (
                                        <ClientWorkspaceToneBadge
                                          key={`${option.key}:${reason.id}`}
                                          tone={reason.tone}
                                          label={reason.label}
                                          className="tracking-normal normal-case"
                                        />
                                      ))}
                                    </div>
                                  );
                                })()}
                              </div>
                              <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                                <div className="text-left lg:text-right">
                                  <p className="text-sm font-semibold text-white">
                                    {formatCurrency(option.totalPriceUsd)}
                                  </p>
                                  <p className="text-xs text-white/45">
                                    {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleToggleVendorExclusion(option.vendorKey, !option.excluded);
                                  }}
                                >
                                  {option.excluded ? "Include vendor" : "Exclude vendor"}
                                </Button>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                <Collapsible defaultOpen className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">Metadata and RFQ details</p>
                      <p className="mt-2 text-sm text-white/55">
                        Correct extracted fields and keep revised files on this same line item.
                      </p>
                    </div>
                    <ChevronDown className="h-4 w-4 text-white/45" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-4">
                    {effectiveRequestDraft ? (
                      <ClientPartRequestEditor
                        draft={effectiveRequestDraft}
                        quoteQuantityInput={quoteQuantityInput}
                        onQuoteQuantityInputChange={setQuoteQuantityInput}
                        onChange={handleDraftChange}
                        onSave={handleSaveRequest}
                        onUploadRevision={attachFilesPicker.openFilePicker}
                        isSaving={saveRequestMutation.isPending}
                      />
                    ) : (
                      <p className="text-sm text-white/45">Part details are still loading.</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <ActivityLog entries={activityEntries} />
              </div>
            </>
          ) : (
            <div className="rounded-[26px] border border-white/8 bg-[#262626] px-6 py-12 text-center text-white/45">
              This part could not be loaded.
            </div>
          )}
        </div>
      </ChatWorkspaceLayout>

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
        onSelectPart={(partId) => navigate(`/parts/${partId}`)}
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
          pages={drawingPreviewPageUrls}
          isLoading={isDrawingPreviewLoading}
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
