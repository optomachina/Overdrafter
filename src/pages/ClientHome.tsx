import { PlusSquare, Search, Upload, UploadCloud } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { SignInDialog } from "@/components/SignInDialog";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildClientWorkspaceState } from "@/features/quotes/client-workspace-state";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";

const quickStartItems = [
  { label: "Upload a STEP file and drawing for quoting", action: "upload" as const },
  { label: "Compare price and lead time options", action: "search" as const },
  { label: "Group related parts into a project", action: "upload" as const },
  { label: "Share a project with a teammate", action: "search" as const },
];

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
    accessibleJobsQuery,
  } = useClientHomeController();
  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  const renderAnonymousContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col px-6 pb-20 pt-12">
        <div>
          <p className="ws-section-label">Manufacturing workspace</p>
          <h1 className="mt-3 text-[2.75rem] font-semibold tracking-tight text-white md:text-[2.75rem]">
            Artifact-first quoting for machined parts.
          </h1>
          <p className="mt-4 max-w-xl text-base text-white/55">
            Upload your CAD and drawing package. OverDrafter extracts part metadata, surfaces vendor quotes, and keeps everything in one workspace.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button
            type="button"
            className="rounded-full px-6 shadow-lg shadow-white/5"
            onClick={() => openAuth("signup")}
          >
            <Upload className="mr-2 h-4 w-4" />
            Get started free
          </Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-white/10 bg-transparent px-6 text-white hover:bg-white/6"
            onClick={() => openAuth("signin")}
          >
            Log in
          </Button>
        </div>

        <div className="mt-12">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quick start</p>
          <div className="mt-3 divide-y divide-white/6 rounded-[20px] border border-white/8 bg-black/20">
            {quickStartItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => openAuth("signup")}
                className="flex w-full items-center gap-4 px-5 py-4 text-left text-sm text-white/60 transition hover:bg-white/4 hover:text-white/90 first:rounded-t-[20px] last:rounded-b-[20px]"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.action === "upload" ? "bg-emerald-400/40" : "bg-blue-400/40"}`} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

      </div>
    );
  };

  const renderOnboardContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[620px] flex-1 flex-col px-6 py-10">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white mb-[10px]">
          Upload your first part package to get started.
        </h1>

        <p className="text-[15px] leading-[1.65] text-white/55 mb-[28px]">
          Drop your STEP files and PDF drawings together. OverDrafter will extract specs from your drawings, match files
          into parts, and get you to a quote in minutes.
        </p>

        {/* Drop zone */}
        <div
          className="border-2 border-dashed border-white/[0.12] rounded-[24px] p-[50px_30px] text-center bg-black/[0.15] hover:border-white/[0.22] hover:bg-white/[0.02] cursor-pointer mb-[20px] transition"
          onClick={newJobFilePicker.openFilePicker}
        >
          <UploadCloud className="h-9 w-9 opacity-50 mx-auto mb-[14px]" />
          <div className="text-[16px] font-semibold mb-[6px] text-white">Drop files here, or click to browse</div>
          <p className="text-[13px] text-white/45 leading-[1.55]">
            Upload STEP files and PDF drawings together. OverDrafter matches them by filename automatically.
          </p>

          {/* Format chips */}
          <div className="mt-[12px] flex justify-center flex-wrap gap-[6px]">
            {[".step", ".stp", ".iges", ".sldprt", ".x_t", ".pdf"].map((format) => (
              <div
                key={format}
                className="font-mono text-[11px] text-white/45 bg-white/5 border border-ws-border-subtle rounded-[6px] px-[9px] py-[3px]"
              >
                {format}
              </div>
            ))}
          </div>
        </div>

        {/* Tip cards */}
        <div className="grid grid-cols-2 gap-[10px]">
          <div className="bg-ws-card border border-ws-border-subtle rounded-[16px] p-[16px]">
            <div className="text-[13px] font-semibold mb-[6px] text-white">Pair your files</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Name your STEP and PDF the same way — <code className="text-white/45">PART-01.step</code> +{" "}
              <code className="text-white/45">PART-01.pdf</code> — and they'll pair automatically.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded-[16px] p-[16px]">
            <div className="text-[13px] font-semibold mb-[6px] text-white">Upload multiple parts</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Select all your files at once. OverDrafter creates individual part workspaces for each matched pair.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded-[16px] p-[16px]">
            <div className="text-[13px] font-semibold mb-[6px] text-white">Projects come later</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Upload parts first. You can group them into a project after — or let OverDrafter suggest one based on your
              filenames.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded-[16px] p-[16px]">
            <div className="text-[13px] font-semibold mb-[6px] text-white">Extraction is automatic</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Material, finish, and tolerance are pulled from your drawing title block — no manual entry needed.
            </div>
          </div>
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
        {/* Workspace header */}
        <section className="rounded-[30px] border border-ws-border-subtle bg-gradient-to-br from-ws-card to-ws-card/80 p-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="ws-section-label">Workspace</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                Start with a part package or open an existing project.
              </h1>
              <p className="mt-2 text-sm text-white/55">
                Upload files to begin intake. Projects group related parts and stay at the top of the information hierarchy.
              </p>
            </div>

            <div className="flex shrink-0 flex-col gap-2 lg:w-[260px]">
              <Button
                type="button"
                className="w-full justify-start rounded-[16px]"
                onClick={newJobFilePicker.openFilePicker}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload parts and drawings
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start rounded-[16px] border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => setIsSearchOpen(true)}
              >
                <Search className="mr-2 h-4 w-4" />
                Search projects and parts
              </Button>
              <div className="mt-1 divide-y divide-white/6 rounded-[14px] border border-white/8 bg-black/20">
                {quickStartItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.action === "upload" ? newJobFilePicker.openFilePicker : () => setIsSearchOpen(true)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs text-white/55 transition hover:bg-white/4 hover:text-white/80 first:rounded-t-[14px] last:rounded-b-[14px]"
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.action === "upload" ? "bg-emerald-400/40" : "bg-blue-400/40"}`} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Recent projects + recent parts */}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-[30px] border border-ws-border-subtle bg-ws-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="ws-subsection-label">Recent projects</p>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentProjects.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentProjects.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
                  No projects yet. Upload a group of parts to create one automatically.
                </div>
              ) : (
                recentProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className="block w-full rounded-[18px] border border-ws-border-subtle border-l-2 border-l-blue-500/30 bg-ws-card px-4 py-3.5 text-left transition hover:border-ws-border hover:border-l-blue-500/30"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">{project.name}</p>
                        <p className="mt-0.5 text-xs text-white/45">{project.partCount} parts</p>
                      </div>
                      <Badge className="shrink-0 border border-white/10 bg-white/6 text-white/70">
                        Project
                      </Badge>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-[30px] border border-ws-border-subtle bg-ws-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="ws-subsection-label">Recent parts</p>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentJobs.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentJobs.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
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
                      className="block w-full rounded-[18px] border border-ws-border-subtle border-l-2 border-l-emerald-500/30 bg-ws-card px-4 py-3.5 text-left transition hover:border-ws-border hover:border-l-emerald-500/30"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{presentation.title}</p>
                          <p className="mt-0.5 truncate text-xs text-white/45">{presentation.description}</p>
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
                { label: "New Job", icon: PlusSquare, onClick: () => openAuth("signup") },
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
                onClick={() => openAuth("signup")}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-white/[0.96]">
                  <PlusSquare aria-hidden="true" className="h-4 w-4" />
                </span>
                Get started
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
        {user && activeMembership && accessibleJobsQuery.isLoading === false && (accessibleJobsQuery.data ?? []).length === 0
          ? renderOnboardContent()
          : user
            ? renderSignedInContent()
            : renderAnonymousContent()}
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
