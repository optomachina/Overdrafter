import {
  Archive,
  FolderPlus,
  Globe2,
  Loader2,
  MapPin,
  MoveRight,
  Pencil,
  PlusSquare,
  RotateCcw,
  Search as SearchIcon,
  Users,
} from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { ActivityLog } from "@/components/quotes/ActivityLog";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
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
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  clientFilterOptions,
  useClientProjectController,
} from "@/features/quotes/use-client-project-controller";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { parseRequestedQuoteQuantitiesInput } from "@/features/quotes/request-intake";
import { formatCurrency, formatLeadTime, formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientProject = () => {
  const {
    accessibleJobsQuery,
    activeFilter,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    attachFilesPicker,
    canDissolveProject,
    canManageMembers,
    canRenameProject,
    filteredJobs,
    focusedActivityEntries,
    focusedDraft,
    focusedJob,
    focusedJobId,
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
    handleBulkPreset,
    handleCreateProjectFromSelection,
    handleDeleteArchivedPart,
    handleDissolveProject,
    handleInviteProjectMember,
    handleOpenJobDrawer,
    handlePinPart,
    handlePinProject,
    handleQuoteQuantityInputChange,
    handleRemovePartFromProject,
    handleRemoveProjectMember,
    handleRenameProject,
    handleRequestDraftChange,
    handleRevertBulk,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isMobile,
    isSearchOpen,
    lastBulkAction,
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
    projectSelectionSummary,
    projectWorkspaceItemsQuery,
    requestDraftsByJobId,
    resolveSidebarProjectIdsForJob,
    search,
    saveRequestMutation,
    selectedOptionsByJobId,
    setActiveFilter,
    setIsSearchOpen,
    setMobileDrawerOpen,
    setProjectName,
    setSearch,
    setShowAddPart,
    setShowArchive,
    setShowDissolve,
    setShowMembers,
    setShowRename,
    sharedRequestSummary,
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
    workspaceItemsByJobId,
  } = useClientProjectController();

  const renderDetailDrawer = () => {
    if (!focusedJob || !focusedWorkspaceItem) {
      return (
        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5 text-sm text-white/45">
          Select a line item to inspect quotes, files, and extracted metadata.
        </div>
      );
    }

    const focusedPresentation = getClientItemPresentation(focusedJob, focusedSummary);

    return (
      <div className="space-y-4">
        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Line item</p>
          <p className="mt-2 text-xl font-semibold text-white">{focusedPresentation.title}</p>
          <p className="mt-2 text-sm text-white/55">{focusedPresentation.description}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge className="border border-white/10 bg-white/6 text-white/70">
              {formatStatusLabel(focusedJob.status)}
            </Badge>
            {focusedSelectedOption ? (
              <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                {focusedSelectedOption.vendorLabel}
              </Badge>
            ) : null}
          </div>
          <RequestSummaryBadges
            quantity={focusedDraft?.quantity ?? focusedSummary?.quantity ?? null}
            requestedQuoteQuantities={parseRequestedQuoteQuantitiesInput(
              focusedQuoteQuantityInput,
              focusedDraft?.quantity ?? focusedSummary?.quantity ?? 1,
            )}
            requestedByDate={focusedDraft?.requestedByDate ?? focusedSummary?.requestedByDate ?? null}
            className="mt-4"
          />
        </div>

        <ClientDrawingPreviewPanel
          drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
          drawingPreview={focusedWorkspaceItem.drawingPreview}
        />
        <ClientCadPreviewPanel cadFile={focusedWorkspaceItem.part?.cadFile ?? null} />

        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quote options</p>
          <div className="mt-4 space-y-3">
            {focusedQuoteOptions.length === 0 ? (
              <p className="text-sm text-white/45">No quote options available for this line item.</p>
            ) : (
              focusedQuoteOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => {
                    void handleSelectQuoteOption(focusedJob.id, option);
                  }}
                  className={cn(
                    "block w-full rounded-2xl border px-4 py-3 text-left transition",
                    focusedSelectedOption?.key === option.key
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : "border-white/8 bg-black/20 hover:bg-white/4",
                  )}
                  disabled={!option.isSelectable}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white">{option.vendorLabel}</p>
                      <p className="mt-1 text-xs text-white/45">
                        Qty {option.requestedQuantity} ·{" "}
                        {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-white">
                        {formatCurrency(option.totalPriceUsd)}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        className="mt-1 h-auto p-0 text-xs text-white/60 hover:bg-transparent hover:text-white"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleVendorExclusion(
                            focusedJob.id,
                            option.vendorKey,
                            !option.excluded,
                          );
                        }}
                      >
                        {option.excluded ? "Include vendor" : "Exclude vendor"}
                      </Button>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {focusedDraft ? (
          <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">Metadata and RFQ details</p>
            <div className="mt-4">
              <ClientPartRequestEditor
                draft={focusedDraft}
                quoteQuantityInput={focusedQuoteQuantityInput}
                onQuoteQuantityInputChange={(value) =>
                  handleQuoteQuantityInputChange(focusedJob.id, value)
                }
                onChange={(next) => handleRequestDraftChange(focusedJob.id, next)}
                onSave={() => handleSaveRequest(focusedJob.id)}
                onUploadRevision={attachFilesPicker.openFilePicker}
                isSaving={saveRequestMutation.isPending}
              />
            </div>
          </div>
        ) : null}

        <ActivityLog entries={focusedActivityEntries} />
      </div>
    );
  };

  if (!user) {
    return null;
  }

  return (
    <>
      <ChatWorkspaceLayout
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
        <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Project workspace</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                {projectQuery.data?.name ?? "Project"}
              </h1>
              <p className="mt-2 text-sm text-white/55">
                Dense procurement workspace tuned for fast quote selection.
              </p>
              {sharedRequestSummary ? (
                <RequestSummaryBadges
                  quantity={sharedRequestSummary.requestedQuoteQuantities[0] ?? null}
                  requestedQuoteQuantities={sharedRequestSummary.requestedQuoteQuantities}
                  requestedByDate={sharedRequestSummary.requestedByDate}
                  className="mt-4"
                />
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {!projectCollaborationUnavailable ? (
                <Button type="button" className="rounded-full" onClick={() => setShowAddPart(true)}>
                  <FolderPlus className="mr-2 h-4 w-4" />
                  Add part
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("cheapest")}
              >
                Cheapest
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("fastest")}
              >
                Fastest
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("domestic")}
              >
                Domestic
              </Button>
              {lastBulkAction.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => {
                    void handleRevertBulk();
                  }}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Revert bulk
                </Button>
              ) : null}
              <Button type="button" className="rounded-full" onClick={() => navigate(`/projects/${projectId}/review`)}>
                Review order
                <MoveRight className="ml-2 h-4 w-4" />
              </Button>
              {canManageMembers ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowMembers(true)}
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Members
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowRename(true)}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowArchive(true)}
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </Button>
                </>
              ) : null}
              {canDissolveProject ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setShowDissolve(true)}
                >
                  Dissolve
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected total</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {formatCurrency(projectSelectionSummary.totalPriceUsd)}
              </p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected lines</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {projectSelectionSummary.selectedCount}/{projectJobs.length}
              </p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Domestic</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {projectSelectionSummary.domesticCount}
              </p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Foreign / unknown</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {projectSelectionSummary.foreignCount + projectSelectionSummary.unknownCount}
              </p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-[26px] border border-white/8 bg-[#262626] p-4">
                <div className="flex flex-col gap-3 md:flex-row">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search parts in this project"
                    className="border-white/10 bg-[#1f1f1f] text-white placeholder:text-white/35"
                  />
                  <div className="flex flex-wrap gap-2">
                    {clientFilterOptions.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant={activeFilter === option.id ? "default" : "outline"}
                        className={cn(
                          "rounded-full border-white/10",
                          activeFilter === option.id
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-transparent text-white hover:bg-white/6",
                        )}
                        onClick={() => setActiveFilter(option.id)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <p className="text-sm text-white/45">{filteredJobs.length} visible parts</p>
              </div>

              <div className="overflow-hidden rounded-[26px] border border-white/8 bg-[#262626]">
                {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="px-6 py-12 text-center text-white/45">No parts match this view.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/45">Part</TableHead>
                          <TableHead className="text-white/45">Rev</TableHead>
                          <TableHead className="text-white/45">Qty</TableHead>
                          <TableHead className="text-white/45">Process</TableHead>
                          <TableHead className="text-white/45">Material</TableHead>
                          <TableHead className="text-white/45">Finish</TableHead>
                          <TableHead className="text-white/45">Source</TableHead>
                          <TableHead className="text-white/45">Vendor</TableHead>
                          <TableHead className="text-white/45">Price</TableHead>
                          <TableHead className="text-white/45">Lead time</TableHead>
                          <TableHead className="text-white/45">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredJobs.map((job) => {
                          const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                          const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                          const draft = requestDraftsByJobId[job.id] ?? null;
                          const selectedOption = selectedOptionsByJobId[job.id] ?? null;
                          const presentation = getClientItemPresentation(job, summary);
                          const sourceIcon =
                            selectedOption?.domesticStatus === "domestic" ? (
                              <MapPin className="h-4 w-4 text-emerald-300" />
                            ) : (
                              <Globe2 className="h-4 w-4 text-sky-300" />
                            );

                          return (
                            <TableRow
                              key={job.id}
                              className={cn(
                                "cursor-pointer border-white/8 hover:bg-white/4",
                                focusedJobId === job.id && "bg-white/6",
                              )}
                              onClick={() => handleOpenJobDrawer(job.id)}
                            >
                              <TableCell className="min-w-[220px]">
                                <div className="flex items-center gap-3">
                                  <div className="h-10 w-10 overflow-hidden rounded-xl border border-white/10 bg-black/20">
                                    {workspaceItem?.drawingPreview.thumbnail ? (
                                      <div className="flex h-full items-center justify-center text-[10px] text-white/45">
                                        PDF
                                      </div>
                                    ) : (
                                      <div className="flex h-full items-center justify-center text-[10px] text-white/45">
                                        CAD
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-white">{presentation.title}</p>
                                    <p className="truncate text-xs text-white/45">{presentation.description}</p>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/70">
                                {draft?.revision ?? summary?.revision ?? "—"}
                              </TableCell>
                              <TableCell className="text-white/70">
                                {draft?.quantity ?? summary?.quantity ?? "—"}
                              </TableCell>
                              <TableCell className="text-white/70">{draft?.process ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.material ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.finish ?? "—"}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {sourceIcon}
                                  <span className="text-white/70">
                                    {selectedOption?.domesticStatus === "domestic" ? "USA" : "Global"}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/70">
                                {selectedOption?.vendorLabel ?? "Unselected"}
                              </TableCell>
                              <TableCell className="text-white/70">
                                {formatCurrency(selectedOption?.totalPriceUsd ?? null)}
                              </TableCell>
                              <TableCell className="text-white/70">
                                {selectedOption
                                  ? selectedOption.resolvedDeliveryDate ??
                                    formatLeadTime(selectedOption.leadTimeBusinessDays)
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                <Badge className="border border-white/10 bg-white/6 text-white/70">
                                  {formatStatusLabel(job.status)}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>

            {!isMobile ? <aside className="space-y-4">{renderDetailDrawer()}</aside> : null}
          </div>
        </div>
      </ChatWorkspaceLayout>

      <Sheet open={mobileDrawerOpen && Boolean(focusedJobId)} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="right" className="w-[min(96vw,38rem)] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white sm:max-w-[38rem]">
          <SheetHeader className="border-b border-white/10 px-6 py-5">
            <SheetTitle className="text-white">Line item detail</SheetTitle>
            <SheetDescription className="text-white/55">
              Review previews, metadata, and quote options for the selected project row.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-5">{renderDetailDrawer()}</div>
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
        canRename={canRenameProject}
        canDelete={canDissolveProject}
        onInvite={handleInviteProjectMember}
        onRemoveMembership={handleRemoveProjectMember}
      />
    </>
  );
};

export default ClientProject;
