import { PlusSquare, Search, Upload } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { SignInDialog } from "@/components/SignInDialog";
import { ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildClientWorkspaceState } from "@/features/quotes/client-workspace-state";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";

const suggestionRows = [
  "Upload a STEP file and drawing for quoting",
  "Compare price and lead time options",
  "Group related parts into a project",
  "Share a project with a teammate",
];

const ClientHome = () => {
  const {
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    authDialogMode,
    composerRef,
    handleAssignPartToProject,
    handleArchivePart,
    handleArchiveProject,
    handleComposerSubmit,
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
    accessibleJobsQuery,
  } = useClientHomeController();
  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const renderAnonymousContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center justify-center px-6 pb-20 pt-10">
        <h1 className="text-center text-[2.25rem] font-semibold tracking-tight text-white md:text-[2.65rem]">
          What are you working on?
        </h1>

        <div className="mt-8 w-full">
          <PromptComposer
            ref={composerRef}
            isSignedIn={Boolean(user)}
            onRequireAuth={() => openAuth("signin")}
            onSubmit={handleComposerSubmit}
          />
        </div>

        <div className="mt-6 w-full max-w-[640px] divide-y divide-white/6 rounded-[24px]">
          {suggestionRows.map((row) => (
            <button
              key={row}
              type="button"
              onClick={() => composerRef.current?.focus()}
              className="flex w-full items-center gap-3 px-4 py-4 text-left text-sm text-white/65 transition hover:bg-white/4 hover:text-white"
            >
              <span className="h-2 w-2 rounded-full bg-white/30" />
              <span>{row}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderSignedInContent = () => {
    const recentProjects = sidebarProjects.slice(0, 4);
    const recentJobs = [...(accessibleJobsQuery.data ?? [])]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .slice(0, 6);

    return (
      <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
        <section className="rounded-[30px] border border-white/8 bg-[#262626] p-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,420px)]">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Workspace launcher</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                Start intake, then jump straight into artifacts.
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-white/55">
                Projects stay at the top of the information architecture. Upload a new part package, then move immediately into the engineering workspace as files and extraction results arrive.
              </p>
              <div className="mt-6 max-w-2xl">
                <PromptComposer
                  ref={composerRef}
                  isSignedIn={Boolean(user)}
                  onRequireAuth={() => openAuth("signin")}
                  onSubmit={handleComposerSubmit}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-[26px] border border-white/8 bg-black/20 p-5">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Quick launch</p>
              <Button
                type="button"
                className="w-full justify-start rounded-[18px]"
                onClick={newJobFilePicker.openFilePicker}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload parts and drawings
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start rounded-[18px] border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => setIsSearchOpen(true)}
              >
                <Search className="mr-2 h-4 w-4" />
                Search projects and parts
              </Button>
              <div className="rounded-[20px] border border-white/8 bg-[#202020] p-4">
                <p className="text-sm font-medium text-white">Suggested flows</p>
                <div className="mt-3 space-y-2">
                  {suggestionRows.map((row) => (
                    <button
                      key={row}
                      type="button"
                      onClick={() => composerRef.current?.focus()}
                      className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/65 transition hover:bg-white/4 hover:text-white"
                    >
                      <span className="h-2 w-2 rounded-full bg-white/30" />
                      <span>{row}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-[30px] border border-white/8 bg-[#262626] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Recent projects</p>
                <p className="mt-2 text-sm text-white/55">Open the container first, then move from project to part.</p>
              </div>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentProjects.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-3">
              {recentProjects.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
                  No projects yet. Upload a group of parts to create one automatically, or start from a standalone part.
                </div>
              ) : (
                recentProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className="block w-full rounded-[22px] border border-white/8 bg-black/20 px-4 py-4 text-left transition hover:bg-white/4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-white">{project.name}</p>
                        <p className="mt-1 text-xs text-white/45">{project.partCount} parts</p>
                      </div>
                      <Badge className="border border-white/10 bg-white/6 text-white/70">
                        Project
                      </Badge>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-[30px] border border-white/8 bg-[#262626] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Recent parts</p>
                <p className="mt-2 text-sm text-white/55">Artifacts and quote state should be the fastest next click.</p>
              </div>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentJobs.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-3">
              {recentJobs.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
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
                      onClick={() => navigate(`/parts/${job.id}`)}
                      className="block w-full rounded-[22px] border border-white/8 bg-black/20 px-4 py-4 text-left transition hover:bg-white/4"
                    >
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{presentation.title}</p>
                          <p className="mt-1 truncate text-xs text-white/45">{presentation.description}</p>
                        </div>
                        <ClientWorkspaceToneBadge tone={workspaceState.tone} className="tracking-normal normal-case" />
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
      <ChatWorkspaceLayout
        onLogoClick={() => navigate("/")}
        topRightContent={
          user ? null : (
            <>
              <Button
                type="button"
                className="h-10 rounded-full bg-white px-4 text-sm font-medium text-black hover:bg-white/90"
                onClick={() => openAuth("signin")}
              >
                Log in
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-white/10 bg-transparent px-4 text-sm text-white hover:bg-white/6"
                onClick={() => openAuth("signup")}
              >
                Sign up for free
              </Button>
            </>
          )
        }
        sidebarRailActions={
          user
            ? [
                { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
                { label: "Search", icon: Search, onClick: () => setIsSearchOpen(true) },
              ]
            : [
                { label: "New Job", icon: PlusSquare, onClick: () => composerRef.current?.focus() },
                { label: "Search", icon: Search, onClick: () => openAuth("signin") },
              ]
        }
        sidebarContent={
          user ? (
            <WorkspaceSidebar
              projects={sidebarProjects}
              jobs={accessibleJobsQuery.data ?? []}
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
              onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
              onPrefetchProject={prefetchProject}
              onPrefetchPart={prefetchPart}
              resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
            />
          ) : (
            <div className="space-y-1">
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start rounded-[10px] pl-1 pr-3 text-white/[0.94] hover:bg-white/6 hover:text-white"
                onClick={() => composerRef.current?.focus()}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-white/[0.96]">
                  <PlusSquare aria-hidden="true" className="h-4 w-4" />
                </span>
                New Job
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start rounded-[10px] pl-1 pr-3 text-white/[0.94] hover:bg-white/6 hover:text-white"
                onClick={() => openAuth("signin")}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-white/[0.96]">
                  <Search aria-hidden="true" className="h-4 w-4" />
                </span>
                Search
              </Button>
            </div>
          )
        }
        sidebarFooter={
          user ? (
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
          ) : (
            <GuestSidebarCta onLogIn={() => openAuth("signin")} />
          )
        }
      >
        {user ? renderSignedInContent() : renderAnonymousContent()}
      </ChatWorkspaceLayout>

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
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
        onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
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
