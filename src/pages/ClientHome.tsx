import { PlusSquare, Search } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { SignInDialog } from "@/components/SignInDialog";
import { Button } from "@/components/ui/button";
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
    handleDeleteArchivedPart,
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

  const renderCenteredContent = () => {
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
              onSignOut={signOut}
              onSignedOut={() => navigate("/", { replace: true })}
              archivedProjects={archivedProjectsQuery.data}
              archivedJobs={archivedJobsQuery.data}
              isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
              onUnarchivePart={handleUnarchivePart}
              onDeleteArchivedPart={handleDeleteArchivedPart}
            />
          ) : (
            <GuestSidebarCta onLogIn={() => openAuth("signin")} />
          )
        }
      >
        {renderCenteredContent()}
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
