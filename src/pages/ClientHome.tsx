import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { PromptComposer, type PromptComposerHandle } from "@/components/chat/PromptComposer";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { SignInDialog } from "@/components/SignInDialog";
import { Button } from "@/components/ui/button";
import { useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import {
  assignJobToProject,
  createClientDraft,
  createProject,
  createSelfServiceOrganization,
  deleteProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchJobPartSummariesByJobIds,
  fetchSidebarPins,
  pinJob,
  pinProject,
  reconcileJobParts,
  removeJobFromProject,
  requestExtraction,
  resendSignupConfirmation,
  unpinJob,
  unpinProject,
  updateProject,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";
import {
  buildDmriflesProjects,
  DMRIFLES_EMAIL,
  PROJECT_STORAGE_PREFIX,
  resolveImportedBatch,
} from "@/features/quotes/client-workspace";

function normalizeAccountNameSeed(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getDefaultAccountName(user: User | null): string {
  if (!user) {
    return "Personal workspace";
  }

  const metadataName = [
    user.user_metadata?.full_name,
    user.user_metadata?.name,
    user.user_metadata?.company,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (metadataName) {
    return metadataName.trim();
  }

  const emailLocalPart = normalizeAccountNameSeed(user.email?.split("@")[0] ?? "");
  return emailLocalPart ? toTitleCase(emailLocalPart) : "Personal workspace";
}

function createProjectStorageKey(organizationId?: string, userEmail?: string): string | null {
  if (!organizationId || !userEmail) {
    return null;
  }

  return `${PROJECT_STORAGE_PREFIX}:${organizationId}:${userEmail.toLowerCase()}`;
}

const suggestionRows = [
  "Upload a STEP file and drawing for quoting",
  "Compare price and lead time options",
  "Group related parts into a project",
  "Share a project with a teammate",
];

const ClientHome = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const composerRef = useRef<PromptComposerHandle>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, activeMembership, isLoading, isVerifiedAuth, signOut } = useAppSession();
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const authIntent = searchParams.get("auth");
  const focusComposerIntent = searchParams.get("focusComposer");
  const createProjectIntent = searchParams.get("createProject");
  const authDialogMode = authIntent === "signup" ? "sign-up" : "sign-in";
  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;
  const defaultAccountName = useMemo(() => getDefaultAccountName(user), [user]);

  const accessibleProjectsQuery = useQuery({
    queryKey: ["client-projects"],
    queryFn: fetchAccessibleProjects,
    enabled: Boolean(user),
  });
  const accessibleJobsQuery = useQuery({
    queryKey: ["client-jobs"],
    queryFn: fetchAccessibleJobs,
    enabled: Boolean(user),
  });
  const sidebarPinsQuery = useQuery({
    queryKey: ["sidebar-pins", user?.id],
    queryFn: fetchSidebarPins,
    enabled: Boolean(user),
  });

  const accessibleJobIds = useMemo(
    () => (accessibleJobsQuery.data ?? []).map((job) => job.id),
    [accessibleJobsQuery.data],
  );
  const partSummariesQuery = useQuery({
    queryKey: ["client-part-summaries", accessibleJobIds],
    queryFn: () => fetchJobPartSummariesByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0,
  });

  const summariesByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );

  const seededProjects = useMemo(() => {
    if (!isDmriflesWorkspace) {
      return [] as WorkspaceSidebarProject[];
    }

    const summaryMap = new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary]));

    return buildDmriflesProjects(accessibleJobsQuery.data ?? [], summaryMap).map((project) => ({
      id: project.id,
      name: project.name,
      partCount: project.jobIds.length,
      roleLabel: "batch",
      isReadOnly: true,
      canManage: false,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    }));
  }, [accessibleJobsQuery.data, isDmriflesWorkspace, partSummariesQuery.data]);

  const remoteProjects = useMemo(
    () =>
      (accessibleProjectsQuery.data ?? []).map((project) => ({
        id: project.project.id,
        name: project.project.name,
        partCount: project.partCount,
        inviteCount: project.inviteCount,
        roleLabel: project.currentUserRole,
        canRename: project.currentUserRole === "owner" || project.currentUserRole === "editor",
        canDelete: project.currentUserRole === "owner",
        createdAt: project.project.created_at,
        updatedAt: project.project.updated_at,
      })),
    [accessibleProjectsQuery.data],
  );
  const sidebarProjects = isDmriflesWorkspace
    ? [...seededProjects, ...remoteProjects.filter((project) => !seededProjects.some((seeded) => seeded.id === project.id))]
    : remoteProjects;

  const bootstrapAccountMutation = useMutation({
    mutationFn: (organizationName: string) => createSelfServiceOrganization(organizationName),
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
    },
    onError: async (error: Error) => {
      if (error.message.toLowerCase().includes("already has an organization membership")) {
        await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      }
    },
  });
  const createProjectMutation = useMutation({
    mutationFn: (name: string) => createProject({ name }),
    onSuccess: async (projectId) => {
      toast.success("Project created.");
      setShowCreateProject(false);
      setProjectName("");
      await queryClient.invalidateQueries({ queryKey: ["client-projects"] });
      navigate(`/projects/${projectId}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create project.");
    },
  });
  const migrateLegacyProjectsMutation = useMutation({
    mutationFn: async () => {
      if (!activeMembership?.organizationId || !user?.email) {
        return;
      }

      const projectStorageKey = createProjectStorageKey(activeMembership.organizationId, user.email);
      if (!projectStorageKey) {
        return;
      }

      const migrationKey = `${projectStorageKey}:remote-projects-migrated`;
      if (window.localStorage.getItem(migrationKey) === "1") {
        return;
      }

      const rawProjects = window.localStorage.getItem(projectStorageKey);
      if (!rawProjects) {
        window.localStorage.setItem(migrationKey, "1");
        return;
      }

      const parsedProjects = JSON.parse(rawProjects) as Array<{
        name: string;
        jobIds: string[];
      }>;

      if (!Array.isArray(parsedProjects) || parsedProjects.length === 0) {
        window.localStorage.setItem(migrationKey, "1");
        return;
      }

      for (const legacyProject of parsedProjects) {
        const projectId = await createProject({ name: legacyProject.name });

        for (const jobId of legacyProject.jobIds) {
          await assignJobToProject({ jobId, projectId });
        }
      }

      window.localStorage.setItem(migrationKey, "1");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
      ]);
    },
  });

  const showWorkspaceSetupState =
    Boolean(user) && !activeMembership && bootstrapAccountMutation.isPending;

  useEffect(() => {
    if (authIntent === "signin" || authIntent === "signup") {
      setIsAuthDialogOpen(true);
    }
  }, [authIntent]);

  useEffect(() => {
    if (focusComposerIntent !== "1") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      composerRef.current?.focus();
    }, 0);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("focusComposer");
    setSearchParams(nextSearchParams, { replace: true });

    return () => window.clearTimeout(timeoutId);
  }, [focusComposerIntent, searchParams, setSearchParams]);

  useEffect(() => {
    if (createProjectIntent !== "1" || !user) {
      return;
    }

    setShowCreateProject(true);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("createProject");
    setSearchParams(nextSearchParams, { replace: true });
  }, [createProjectIntent, searchParams, setSearchParams, user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    setIsAuthDialogOpen(false);
    if (authIntent) {
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete("auth");
      setSearchParams(nextSearchParams, { replace: true });
    }
  }, [authIntent, searchParams, setSearchParams, user]);

  useEffect(() => {
    if (
      !user ||
      isLoading ||
      activeMembership ||
      !isVerifiedAuth ||
      bootstrapAccountMutation.status !== "idle"
    ) {
      return;
    }

    bootstrapAccountMutation.mutate(defaultAccountName);
  }, [
    activeMembership,
    bootstrapAccountMutation,
    defaultAccountName,
    isLoading,
    isVerifiedAuth,
    user,
  ]);

  useEffect(() => {
    if (
      !user ||
      !activeMembership?.organizationId ||
      isDmriflesWorkspace ||
      accessibleProjectsQuery.isLoading ||
      migrateLegacyProjectsMutation.isPending
    ) {
      return;
    }

    if ((accessibleProjectsQuery.data ?? []).length === 0) {
      migrateLegacyProjectsMutation.mutate();
    }
  }, [
    accessibleProjectsQuery.data,
    accessibleProjectsQuery.isLoading,
    activeMembership?.organizationId,
    isDmriflesWorkspace,
    migrateLegacyProjectsMutation,
    user,
  ]);

  const openAuth = (mode: "signin" | "signup") => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("auth", mode);
    setSearchParams(nextSearchParams, { replace: true });
    setIsAuthDialogOpen(true);
  };

  const resolveSidebarProjectIdForJob = (job: { id: string; project_id: string | null; source: string }) => {
    if (!isDmriflesWorkspace || job.project_id) {
      return job.project_id;
    }

    const importedBatch = resolveImportedBatch(job, summariesByJobId.get(job.id));
    return importedBatch ? `seed-${importedBatch.toLowerCase()}` : null;
  };

  const invalidateSidebarQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
      queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] }),
      queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
    ]);
  };

  const handlePinProject = async (projectId: string) => {
    try {
      await pinProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin project.");
      throw error;
    }
  };

  const handleUnpinProject = async (projectId: string) => {
    try {
      await unpinProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpin project.");
      throw error;
    }
  };

  const handlePinPart = async (jobId: string) => {
    try {
      await pinJob(jobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin part.");
      throw error;
    }
  };

  const handleUnpinPart = async (jobId: string) => {
    try {
      await unpinJob(jobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpin part.");
      throw error;
    }
  };

  const handleAssignPartToProject = async (jobId: string, projectId: string) => {
    try {
      await assignJobToProject({ jobId, projectId });
      await invalidateSidebarQueries();
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (jobId: string) => {
    try {
      await removeJobFromProject(jobId);
      await invalidateSidebarQueries();
      toast.success("Part removed from project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove part.");
      throw error;
    }
  };

  const handleRenameProject = async (projectId: string, name: string) => {
    try {
      await updateProject({ projectId, name });
      await queryClient.invalidateQueries({ queryKey: ["client-projects"] });
      toast.success("Project updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project.");
      throw error;
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      await deleteProject(projectId);
      await invalidateSidebarQueries();
      toast.success("Project deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete project.");
      throw error;
    }
  };

  const handleRefreshVerification = async () => {
    setIsRefreshingVerification(true);

    try {
      const { data, error } = await supabase.auth.getUser();

      if (error) {
        throw error;
      }

      if (!data.user) {
        throw new Error("Open the confirmation link from your email first.");
      }

      if (isEmailConfirmationRequired(data.user)) {
        throw new Error("Email confirmation has not completed yet.");
      }

      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      toast.success("Email verified.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh verification status.");
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user?.email) {
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(user.email);
      toast.success(`Confirmation email resent to ${user.email}.`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to resend confirmation email.");
    } finally {
      setIsResendingVerification(false);
    }
  };

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
            onSubmit={async ({ prompt, files, clear }) => {
              if (!activeMembership) {
                throw new Error("Your workspace is still being prepared. Please wait a moment and try again.");
              }

              const title = buildDraftTitleFromPrompt(prompt, files);
              const jobId = await createClientDraft({
                title,
                description: prompt.trim() || undefined,
                tags: [],
              });

              if (files.length > 0) {
                await uploadFilesToJob(jobId, files);
                await reconcileJobParts(jobId);
                await requestExtraction(jobId);
              }

              clear();
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
                queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
                queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
                queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
              ]);

              navigate(`/parts/${jobId}`);
            }}
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
        sidebarContent={
          user ? (
            <WorkspaceSidebar
              projects={sidebarProjects}
              jobs={accessibleJobsQuery.data ?? []}
              summariesByJobId={summariesByJobId}
              onCreateProject={() => setShowCreateProject(true)}
              storageScopeKey={user.id}
              pinnedProjectIds={sidebarPinsQuery.data?.projectIds ?? []}
              pinnedJobIds={sidebarPinsQuery.data?.jobIds ?? []}
              onPinProject={handlePinProject}
              onUnpinProject={handleUnpinProject}
              onPinPart={handlePinPart}
              onUnpinPart={handleUnpinPart}
              onAssignPartToProject={isDmriflesWorkspace ? undefined : handleAssignPartToProject}
              onRemovePartFromProject={isDmriflesWorkspace ? undefined : handleRemovePartFromProject}
              onRenameProject={handleRenameProject}
              onDeleteProject={handleDeleteProject}
              onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
              onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
              resolveProjectIdForJob={resolveSidebarProjectIdForJob}
            />
          ) : (
            <div className="space-y-1">
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start rounded-xl px-3 text-white/85 hover:bg-white/6 hover:text-white"
                onClick={() => composerRef.current?.focus()}
              >
                New Part
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start rounded-xl px-3 text-white/85 hover:bg-white/6 hover:text-white"
                onClick={() => openAuth("signin")}
              >
                Search Parts
              </Button>
            </div>
          )
        }
        sidebarFooter={
          user ? (
            <div className="space-y-3">
              <div>
                <p className="truncate text-sm font-medium text-white">{user.email}</p>
                <p className="text-xs text-white/45">
                  {activeMembership || !showWorkspaceSetupState
                    ? "Private workspace ready"
                    : "Private workspace in setup"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 flex-1 rounded-full border border-white/10 bg-transparent text-white/80 hover:bg-white/6 hover:text-white"
                  onClick={async () => {
                    await signOut();
                    navigate("/", { replace: true });
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </Button>
              </div>
            </div>
          ) : (
            <GuestSidebarCta onLogIn={() => openAuth("signin")} />
          )
        }
      >
        {renderCenteredContent()}
      </ChatWorkspaceLayout>

      <ProjectNameDialog
        open={showCreateProject}
        onOpenChange={(open) => {
          setShowCreateProject(open);
          if (!open) {
            setProjectName("");
          }
        }}
        title="Create project"
        description="Projects are shareable by default and live in your hidden workspace."
        value={projectName}
        onValueChange={setProjectName}
        submitLabel="Create"
        isPending={createProjectMutation.isPending}
        isSubmitDisabled={projectName.trim().length === 0}
        onSubmit={() => createProjectMutation.mutate(projectName.trim())}
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
