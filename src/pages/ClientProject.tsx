import { useMemo } from "react";
import { ArrowRight, Loader2, PlusSquare, Search as SearchIcon } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { WorkspaceInlineSearch } from "@/components/workspace/WorkspaceInlineSearch";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
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
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleInviteProjectMember,
    handlePinPart,
    handlePinProject,
    handleRemovePartFromProject,
    handleRemoveProjectMember,
    handleRenameProject,
    handleRequestProjectQuotes,
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
    workspaceItemsByJobId,
  } = useClientProjectController();

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

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your project workspace." />;
  }

  if (!user) {
    return null;
  }

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
                <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                  Quoted: {projectQuoteRequestSummary.received}
                </Badge>
              ) : null}
              {projectQuoteRequestSummary.requesting > 0 ? (
                <Badge className="border border-amber-400/20 bg-amber-500/10 text-amber-100">
                  Requesting: {projectQuoteRequestSummary.requesting}
                </Badge>
              ) : null}
              {projectQuoteRequestSummary.notRequested > 0 ? (
                <Badge className="border border-white/10 bg-white/6 text-white/70">
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

          <div className="overflow-x-auto rounded-lg border border-ws-border-subtle bg-ws-card">
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
                    const quoteStatusClassName =
                      quoteRequestViewModel?.status === "received"
                        ? "border border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                        : quoteRequestViewModel?.status === "queued" || quoteRequestViewModel?.status === "requesting"
                          ? "border border-amber-400/20 bg-amber-500/10 text-amber-100"
                          : quoteRequestViewModel?.status === "failed" || quoteRequestViewModel?.status === "canceled"
                            ? "border border-rose-400/20 bg-rose-500/10 text-rose-100"
                            : "border border-white/10 bg-white/6 text-white/70";
                    const partNumber =
                      workspaceItem?.part?.approvedRequirement?.part_number ?? presentation.partNumber ?? "—";
                    const description =
                      workspaceItem?.part?.approvedRequirement?.description ??
                      presentation.description ??
                      presentation.title;

                    return (
                      <TableRow key={job.id} className="border-white/[0.04] hover:bg-white/[0.02]">
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
                        <TableCell className="w-px whitespace-nowrap px-2 py-2.5 text-[13px] font-medium text-white/75">
                          BW
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
        </div>
      </ClientWorkspaceShell>

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
