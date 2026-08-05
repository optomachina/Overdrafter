import { PlusSquare, Search, Upload, UploadCloud } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AnonymousHomeLanding } from "@/components/quote-intelligence/AnonymousHomeLanding";
import { SignInDialog } from "@/components/SignInDialog";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildClientWorkspaceState } from "@/features/quotes/client-workspace-state";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

const ClientHome = () => {
  const {
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    authDialogMode,
    handleAssignPartToProject,
    handleArchivePart,
    handleArchiveProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handlePinPart,
    handlePinProject,
    handleRemovePartFromProject,
    handleRenameProject,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isAuthDialogOpen,
    isAuthInitializing,
    isSearchOpen,
    navigate,
    newJobFilePicker,
    openAuth,
    prefetchPart,
    prefetchProject,
    projectCollaborationUnavailable,
    resolveSidebarProjectIdsForJob,
    setIsAuthDialogOpen,
    setIsSearchOpen,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    user,
    workspaceAccessScope,
    accessibleJobs,
    accessibleJobsQuery,
  } = useClientHomeController();
  const notificationCenter = useWorkspaceNotifications({
    accessScope: workspaceAccessScope,
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const navigateToPartDestination = (jobId: string) => {
    const job = accessibleJobs.find((candidate) => candidate.id === jobId);
    const projectId = job ? resolveSidebarProjectIdsForJob(job)[0] ?? null : null;

    if (projectId) {
      navigate(`/projects/${projectId}?part=${jobId}`);
      return;
    }

    navigate(`/parts/${jobId}`);
  };

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (!user) {
    return (
      <>
        <ClientWorkspaceShell
          showSidebar={false}
          sidebarContent={null}
          onLogoClick={() => navigate("/")}
          topRightContent={
            <>
              <Button
                type="button"
                className="min-h-11 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => openAuth("signin")}
              >
                Sign in
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 border-border bg-transparent px-4 text-sm text-foreground hover:bg-accent"
                onClick={() => openAuth("signup")}
              >
                Sign up for free
              </Button>
            </>
          }
        >
          <AnonymousHomeLanding
            onSignIn={() => openAuth("signin")}
            onSignUp={() => openAuth("signup")}
          />
        </ClientWorkspaceShell>
        <SignInDialog
          open={isAuthDialogOpen}
          onOpenChange={setIsAuthDialogOpen}
          initialMode={authDialogMode}
        />
      </>
    );
  }

  const renderOnboardContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[620px] flex-1 flex-col px-6 py-10">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-foreground mb-2.5">
          Upload your first part package to get started.
        </h1>

        <p className="text-[15px] leading-[1.65] text-muted-foreground mb-7">
          Drop your STEP files and PDF drawings together. OverDrafter will extract specs from your drawings, match files
          into parts, and get you to a quote in minutes.
        </p>

        {/* Drop zone */}
        <div
          className="border-2 border-dashed border-border rounded-surface-lg px-8 py-12 text-center bg-muted hover:border-border hover:bg-accent cursor-pointer mb-5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={newJobFilePicker.openFilePicker}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              newJobFilePicker.openFilePicker();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload files"
        >
          <UploadCloud className="h-9 w-9 opacity-50 mx-auto mb-3.5" />
          <div className="text-[16px] font-semibold mb-1.5 text-foreground">Drop files here, or click to browse</div>
          <p className="text-[13px] text-muted-foreground leading-[1.55]">
            Upload STEP files and PDF drawings together. OverDrafter matches them by filename automatically.
          </p>

          {/* Format chips */}
          <div className="mt-3 flex justify-center flex-wrap gap-1.5">
            {[".step", ".stp", ".iges", ".sldprt", ".x_t", ".pdf"].map((format) => (
              <div
                key={format}
                className="font-mono text-[11px] text-muted-foreground bg-accent border border-ws-border-subtle rounded-surface-sm px-2 py-1"
              >
                {format}
              </div>
            ))}
          </div>
        </div>

        {/* Tip cards */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-foreground">Pair your files</div>
            <div className="text-[12px] leading-[1.6] text-muted-foreground">
              Name your STEP and PDF the same way — <code className="text-muted-foreground">PART-01.step</code> +{" "}
              <code className="text-muted-foreground">PART-01.pdf</code> — and they'll pair automatically.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-foreground">Upload multiple parts</div>
            <div className="text-[12px] leading-[1.6] text-muted-foreground">
              Select all your files at once. OverDrafter creates individual part workspaces for each matched pair.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-foreground">Projects come later</div>
            <div className="text-[12px] leading-[1.6] text-muted-foreground">
              Upload parts first. You can group them into a project after — or let OverDrafter suggest one based on your
              filenames.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-foreground">Extraction is automatic</div>
            <div className="text-[12px] leading-[1.6] text-muted-foreground">
              Material, finish, and tolerance are pulled from your drawing title block — no manual entry needed.
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSignedInContent = () => {
    const recentProjects = [...sidebarProjects]
      .sort(
        (left, right) =>
          parseTimestamp(right.updatedAt ?? right.createdAt) - parseTimestamp(left.updatedAt ?? left.createdAt),
      )
      .slice(0, 4);
    const recentJobs = [...accessibleJobs]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .slice(0, 6);
    const awaitingDecisionJobs = [...accessibleJobs]
      .filter((job) => job.status === "published" && !job.selected_vendor_quote_offer_id)
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    const awaitingDecisionCount = awaitingDecisionJobs.length;

    return (
      <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
        {/* Workspace header */}
        <section className="rounded-surface-lg border border-ws-border-subtle bg-gradient-to-br from-ws-card to-ws-card/80 p-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="ws-section-label">Workspace</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
                  Keep projects moving with the next highest-impact action.
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Prioritize parts awaiting selection, jump into active projects, or upload new files when new work arrives.
                </p>
              </div>

              <div className="flex shrink-0 flex-col gap-2 lg:w-[260px]">
                <Button
                  type="button"
                  className="w-full justify-start rounded"
                  onClick={newJobFilePicker.openFilePicker}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Upload parts and drawings
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start rounded border-border bg-transparent text-foreground hover:bg-accent"
                  onClick={() => setIsSearchOpen(true)}
                >
                  <Search className="mr-2 h-4 w-4" />
                  Search projects and parts
                </Button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="rounded-surface-lg border border-ws-border-subtle bg-muted p-4">
                <p className="ws-subsection-label">
                  {`Parts awaiting your decision (${awaitingDecisionCount})`}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Published quote packages ready for client selection.
                </p>
                {awaitingDecisionJobs.length === 0 ? (
                  <p className="mt-4 rounded border border-dashed border-border bg-muted px-3 py-4 text-sm text-muted-foreground">
                    No published packages are waiting on your selection right now.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {awaitingDecisionJobs.slice(0, 3).map((job) => {
                      const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));

                      return (
                        <button
                          key={job.id}
                          type="button"
                          onClick={() => navigateToPartDestination(job.id)}
                          className="block w-full rounded border border-border bg-accent px-3 py-2 text-left text-sm text-foreground/80 transition hover:border-border hover:bg-accent"
                        >
                          {presentation.title}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="rounded-surface-lg border border-ws-border-subtle bg-muted p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="ws-subsection-label">Recently active projects</p>
                  <Badge className="border border-border bg-accent text-foreground/80">
                    {recentProjects.length}
                  </Badge>
                </div>
                {recentProjects.length === 0 ? (
                  <p className="mt-4 rounded border border-dashed border-border bg-muted px-3 py-4 text-sm text-muted-foreground">
                    No active projects yet. Upload parts to start your first project.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {recentProjects.slice(0, 3).map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => navigate(`/projects/${project.id}`)}
                        className="block w-full rounded border border-border bg-accent px-3 py-2 text-left text-sm text-foreground/80 transition hover:border-border hover:bg-accent"
                      >
                        {project.name}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </section>

        {/* Recent projects + recent parts */}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="ws-subsection-label">Recent projects</p>
              <Badge className="border border-border bg-accent text-foreground/80">
                {recentProjects.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentProjects.length === 0 ? (
                <div className="rounded-surface-lg border border-dashed border-border bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
                  No projects yet. Upload a group of parts to create one automatically.
                </div>
              ) : (
                recentProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className="block w-full rounded border border-ws-border-subtle border-l-2 border-l-blue-500/30 bg-ws-card px-4 py-3.5 text-left transition hover:border-ws-border hover:border-l-blue-500/30"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{project.partCount} parts</p>
                      </div>
                      <Badge className="shrink-0 border border-border bg-accent text-foreground/80">
                        Project
                      </Badge>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="ws-subsection-label">Recent parts</p>
              <Badge className="border border-border bg-accent text-foreground/80">
                {recentJobs.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentJobs.length === 0 ? (
                <div className="rounded-surface-lg border border-dashed border-border bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
                  No parts in this workspace yet.
                </div>
              ) : (
                recentJobs.map((job) => {
                  const summary = summariesByJobId.get(job.id) ?? null;
                  const presentation = getClientItemPresentation(job, summary);
                  const workspaceState = buildClientWorkspaceState({
                    job,
                    summary,
                    part: null,
                    options: [],
                    selectedOption: null,
                    requestedByDate: summary?.requestedByDate ?? job.requested_by_date ?? null,
                  });

                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => navigateToPartDestination(job.id)}
                      className="block w-full rounded border border-ws-border-subtle border-l-2 border-l-emerald-500/30 bg-ws-card px-4 py-3.5 text-left transition hover:border-ws-border hover:border-l-emerald-500/30"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{presentation.title}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{presentation.description}</p>
                        </div>
                        <ClientWorkspaceToneBadge tone={workspaceState.tone} className="shrink-0 tracking-normal normal-case" />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    );
  };

  return (
    <>
      <ClientWorkspaceShell
        showSidebar
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: Search, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobs}
            summariesByJobId={summariesByJobId}
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
            onCreateProjectFromSelection={projectCollaborationUnavailable ? undefined : handleCreateProjectFromSelection}
            onRenameProject={handleRenameProject}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
            onSelectPart={navigateToPartDestination}
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
        {activeMembership &&
        accessibleJobsQuery.isLoading === false &&
        sidebarProjects.length === 0
          ? renderOnboardContent()
          : renderSignedInContent()}
      </ClientWorkspaceShell>

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

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobs}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
        onSelectPart={navigateToPartDestination}
      />

      <SignInDialog
        open={isAuthDialogOpen}
        onOpenChange={setIsAuthDialogOpen}
        initialMode={authDialogMode}
      />
    </>
  );
};

export default ClientHome;
