import { PlusSquare, Search, Upload, UploadCloud } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
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
    accessibleJobs,
    accessibleJobsQuery,
  } = useClientHomeController();
  const notificationCenter = useWorkspaceNotifications({
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  const renderAnonymousContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-6 pb-20">
        {/* Section 1: Hero */}
        <section className="pt-16">
          <p className="font-mono text-[11px] font-medium tracking-[0.08em] text-white/35 mb-5">
            // manufacturing workspace
          </p>

          <h1 className="text-[38px] font-bold leading-[1.0] tracking-[-0.04em] text-white sm:text-[48px] lg:text-[60px]">
            From part files
            <br />
            to vetted quotes.{' '}
            <em className="not-italic text-white/55">In one workspace.</em>
          </h1>

          <p className="text-[17px] leading-[1.65] text-white/55 max-w-[520px] mt-5">
            Upload your CAD and drawing package. OverDrafter extracts specs, dispatches vendor quotes, and keeps parts, projects, and options organized — start to selection.
          </p>

          <div className="mt-8 flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center">
            <Button
              type="button"
              className="rounded-full"
              onClick={() => openAuth("signup")}
            >
              Get started free
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => openAuth("signin")}
            >
              Log in
            </Button>
          </div>

          <p className="mt-3 text-[11px] text-white/35">
            No vendor account needed. Email or social sign-in.
          </p>
        </section>

        {/* Section 2: How it works */}
        <section className="mt-20">
          <div className="flex items-center gap-4 mb-9">
            <p className="ws-section-label">How it works</p>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>

          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            {/* Card 1: Upload */}
            <div className="bg-ws-card border border-ws-border-subtle rounded-surface-lg p-6">
              <p className="text-[10px] font-semibold font-mono tracking-[0.1em] text-white/35 mb-2.5">
                01 / UPLOAD
              </p>
              <h3 className="text-[15px] font-semibold mb-2 text-white">
                Drop your part package.
              </h3>
              <p className="text-[13px] leading-[1.6] text-white/55 mb-4">
                Upload STEP files and PDF drawings together. Files are matched into parts automatically by filename — CAD and drawing stay paired from the start.
              </p>

              {/* Mock file list */}
              <div>
                <div className="flex items-center justify-between text-[12px] py-1.5 border-b border-white/[0.04]">
                  <span className="text-white">FLT-BRACKET-01.step</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white/45">STEP · 1.4 MB</span>
                    <span className="bg-emerald-400/10 border border-emerald-400/20 text-emerald-400 text-[10px] font-semibold px-1.5 py-0.5 rounded-surface-sm">
                      CAD
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[12px] py-1.5">
                  <span className="text-white">FLT-BRACKET-01.pdf</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white/45">Drawing · 0.3 MB</span>
                    <span className="bg-blue-400/10 border border-blue-400/20 text-blue-400 text-[10px] font-semibold px-1.5 py-0.5 rounded-surface-sm">
                      Drawing
                    </span>
                  </div>
                </div>
              </div>

              {/* Success bar */}
              <div className="bg-emerald-400/10 border border-emerald-400/30 rounded text-[11px] text-emerald-400 px-2.5 py-2 mt-2.5">
                ✓ 1 CAD/PDF pair matched automatically
              </div>
            </div>

            {/* Card 2: Extract */}
            <div className="bg-ws-card border border-ws-border-subtle rounded-surface-lg p-6">
              <p className="text-[10px] font-semibold font-mono tracking-[0.1em] text-white/35 mb-2.5">
                02 / EXTRACT
              </p>
              <h3 className="text-[15px] font-semibold mb-2 text-white">
                Specs pulled from your drawing.
              </h3>
              <p className="text-[13px] leading-[1.6] text-white/55 mb-4">
                Material, finish, tolerances, revision, and thread callouts are extracted from drawing title blocks. Review and correct before quoting — always traceable.
              </p>

              {/* Mock table */}
              <div className="space-y-1.5">
                {[
                  { label: 'Material', value: '6061-T6 Aluminum' },
                  { label: 'Finish', value: 'Clear Anodize Type II' },
                  { label: 'Tolerance', value: '±0.005 in' },
                  { label: 'Quantity', value: '25 pcs' },
                  { label: 'Revision', value: 'Rev C' },
                ].map((row) => (
                  <div key={row.label} className="flex text-[12px]">
                    <span className="text-white/45 w-[44%]">{row.label}</span>
                    <span className="text-white font-medium">{row.value}</span>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-white/35 mt-2">
                Source: drawing title block · FLT-BRACKET-01.pdf
              </p>
            </div>

            {/* Card 3: Quote */}
            <div className="bg-ws-card border border-ws-border-subtle rounded-surface-lg p-6">
              <p className="text-[10px] font-semibold font-mono tracking-[0.1em] text-white/35 mb-2.5">
                03 / QUOTE
              </p>
              <h3 className="text-[15px] font-semibold mb-2 text-white">
                Vendor quotes dispatched automatically.
              </h3>
              <p className="text-[13px] leading-[1.6] text-white/55 mb-4">
                Click "Request Quote" and OverDrafter routes your validated package to enabled vendors. Track each request in real time — queued, requesting, received, or failed.
              </p>

              {/* Mock status rows */}
              <div>
                <div className="bg-amber-400/10 border border-amber-400/30 rounded px-3 py-2.5 mb-1.5 flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-amber-400">Requesting</span>
                  <span className="text-[11px] text-white/45">Xometry · 2 min</span>
                </div>
                <div className="bg-emerald-400/10 border border-emerald-400/30 rounded px-3 py-2.5 flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-emerald-400">Received</span>
                  <span className="text-[11px] text-white/45">Quote package ready for review</span>
                </div>
              </div>
            </div>

            {/* Card 4: Select */}
            <div className="bg-ws-card border border-ws-border-subtle rounded-surface-lg p-6">
              <p className="text-[10px] font-semibold font-mono tracking-[0.1em] text-white/35 mb-2.5">
                04 / SELECT
              </p>
              <h3 className="text-[15px] font-semibold mb-2 text-white">
                Compare and choose the best fit.
              </h3>
              <p className="text-[13px] leading-[1.6] text-white/55 mb-4">
                Published options appear side by side. Price, lead time, process, and certification — all visible. Select and your choice is recorded in the project workspace.
              </p>

              {/* Mock quote rows */}
              <div className="space-y-1.5">
                {/* Option A */}
                <div className="flex items-center justify-between border border-ws-border-subtle rounded px-3 py-2.5 bg-white/[0.02]">
                  <div className="flex items-center gap-2 min-w-0">
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-[12px] font-semibold text-white">Xometry — CNC Machining</span>
                        <span className="bg-emerald-400/10 border border-emerald-400/20 text-emerald-400 text-[9px] font-bold uppercase tracking-[0.1em] rounded-surface-sm px-1.5 py-0.5">
                          Best price
                        </span>
                      </div>
                      <p className="text-[11px] text-white/45 mt-0.5">12 bd · AS9100</p>
                    </div>
                  </div>
                  <span className="text-[16px] font-bold text-white shrink-0">$487</span>
                </div>

                {/* Option B */}
                <div className="flex items-center justify-between border border-ws-border-subtle rounded px-3 py-2.5 bg-white/[0.02]">
                  <div>
                    <p className="text-[12px] font-semibold text-white">Precision Shop</p>
                    <p className="text-[11px] text-white/45 mt-0.5">7 bd · Fastest · ISO 9001</p>
                  </div>
                  <span className="text-[16px] font-bold text-white shrink-0">$612</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  };

  const renderOnboardContent = () => {
    return (
      <div className="mx-auto flex w-full max-w-[620px] flex-1 flex-col px-6 py-10">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white mb-2.5">
          Upload your first part package to get started.
        </h1>

        <p className="text-[15px] leading-[1.65] text-white/55 mb-7">
          Drop your STEP files and PDF drawings together. OverDrafter will extract specs from your drawings, match files
          into parts, and get you to a quote in minutes.
        </p>

        {/* Drop zone */}
        <div
          className="border-2 border-dashed border-white/[0.12] rounded-surface-lg px-8 py-12 text-center bg-black/[0.15] hover:border-white/[0.22] hover:bg-white/[0.02] cursor-pointer mb-5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
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
          <div className="text-[16px] font-semibold mb-1.5 text-white">Drop files here, or click to browse</div>
          <p className="text-[13px] text-white/45 leading-[1.55]">
            Upload STEP files and PDF drawings together. OverDrafter matches them by filename automatically.
          </p>

          {/* Format chips */}
          <div className="mt-3 flex justify-center flex-wrap gap-1.5">
            {[".step", ".stp", ".iges", ".sldprt", ".x_t", ".pdf"].map((format) => (
              <div
                key={format}
                className="font-mono text-[11px] text-white/45 bg-white/5 border border-ws-border-subtle rounded-surface-sm px-2 py-1"
              >
                {format}
              </div>
            ))}
          </div>
        </div>

        {/* Tip cards */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-white">Pair your files</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Name your STEP and PDF the same way — <code className="text-white/45">PART-01.step</code> +{" "}
              <code className="text-white/45">PART-01.pdf</code> — and they'll pair automatically.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-white">Upload multiple parts</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Select all your files at once. OverDrafter creates individual part workspaces for each matched pair.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-white">Projects come later</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
              Upload parts first. You can group them into a project after — or let OverDrafter suggest one based on your
              filenames.
            </div>
          </div>

          <div className="bg-ws-card border border-ws-border-subtle rounded p-4">
            <div className="text-[13px] font-semibold mb-1.5 text-white">Extraction is automatic</div>
            <div className="text-[12px] leading-[1.6] text-white/55">
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
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                  Keep projects moving with the next highest-impact action.
                </h1>
                <p className="mt-2 text-sm text-white/55">
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
                  className="w-full justify-start rounded border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => setIsSearchOpen(true)}
                >
                  <Search className="mr-2 h-4 w-4" />
                  Search projects and parts
                </Button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="rounded-surface-lg border border-ws-border-subtle bg-black/20 p-4">
                <p className="ws-subsection-label">
                  {`Parts awaiting your decision (${awaitingDecisionCount})`}
                </p>
                <p className="mt-2 text-xs text-white/50">
                  Published quote packages ready for client selection.
                </p>
                {awaitingDecisionJobs.length === 0 ? (
                  <p className="mt-4 rounded border border-dashed border-white/10 bg-black/20 px-3 py-4 text-sm text-white/45">
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
                          onClick={() => navigate(`/parts/${job.id}`)}
                          className="block w-full rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-white/85 transition hover:border-white/20 hover:bg-white/[0.05]"
                        >
                          {presentation.title}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="rounded-surface-lg border border-ws-border-subtle bg-black/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="ws-subsection-label">Recently active projects</p>
                  <Badge className="border border-white/10 bg-white/6 text-white/70">
                    {recentProjects.length}
                  </Badge>
                </div>
                {recentProjects.length === 0 ? (
                  <p className="mt-4 rounded border border-dashed border-white/10 bg-black/20 px-3 py-4 text-sm text-white/45">
                    No active projects yet. Upload parts to start your first project.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {recentProjects.slice(0, 3).map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => navigate(`/projects/${project.id}`)}
                        className="block w-full rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-white/85 transition hover:border-white/20 hover:bg-white/[0.05]"
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
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentProjects.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentProjects.length === 0 ? (
                <div className="rounded-surface-lg border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
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

          <section className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="ws-subsection-label">Recent parts</p>
              <Badge className="border border-white/10 bg-white/6 text-white/70">
                {recentJobs.length} shown
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {recentJobs.length === 0 ? (
                <div className="rounded-surface-lg border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-white/45">
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
                      className="block w-full rounded border border-ws-border-subtle border-l-2 border-l-emerald-500/30 bg-ws-card px-4 py-3.5 text-left transition hover:border-ws-border hover:border-l-emerald-500/30"
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
        showSidebar={Boolean(user)}
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
                className="w-full justify-start rounded pl-1 pr-3 text-white/[0.94] hover:bg-white/6 hover:text-white"
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
                className="w-full justify-start rounded pl-1 pr-3 text-white/[0.94] hover:bg-white/6 hover:text-white"
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
          ) : null
        }
      >
        {user &&
        activeMembership &&
        accessibleJobsQuery.isLoading === false &&
        sidebarProjects.length === 0
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
        jobs={accessibleJobs}
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
