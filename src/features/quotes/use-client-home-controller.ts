import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { PromptComposerHandle } from "@/components/chat/PromptComposer";
import { supabase } from "@/integrations/supabase/client";
import { getDefaultAccountName } from "@/lib/account-profile";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import {
  archiveJob,
  archiveProject,
  assignJobToProject,
  createClientDraft,
  createJobsFromUploadFiles,
  createProject,
  createSelfServiceOrganization,
  deleteArchivedJob,
  dissolveProject,
  isProjectCollaborationSchemaUnavailable,
  pinJob,
  pinProject,
  removeJobFromProject,
  resendSignupConfirmation,
  unarchiveJob,
  unarchiveProject,
  unpinJob,
  unpinProject,
  updateProject,
} from "@/features/quotes/api";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  buildSidebarProjectIdsByJobId,
  buildSidebarProjects,
  PROJECT_STORAGE_PREFIX,
  resolveWorkspaceProjectIdsForJob,
} from "@/features/quotes/client-workspace";
import {
  invalidateClientWorkspaceQueries,
  useClientWorkspaceData,
  useWarmClientWorkspaceNavigation,
} from "@/features/quotes/use-client-workspace-data";
import { prefetchPartPage, prefetchProjectPage } from "@/features/quotes/workspace-navigation";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { buildProjectNameFromLabels } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { useAppSession } from "@/hooks/use-app-session";

function createProjectStorageKey(organizationId?: string, userEmail?: string): string | null {
  if (!organizationId || !userEmail) {
    return null;
  }

  return `${PROJECT_STORAGE_PREFIX}:${organizationId}:${userEmail.toLowerCase()}`;
}

export function useClientHomeController() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const composerRef = useRef<PromptComposerHandle>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, activeMembership, isLoading, isVerifiedAuth, signOut } = useAppSession();
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const authIntent = searchParams.get("auth");
  const focusComposerIntent = searchParams.get("focusComposer");
  const authDialogMode = authIntent === "signup" ? "sign-up" : "sign-in";
  const defaultAccountName = useMemo(() => getDefaultAccountName(user), [user]);
  const registerArchiveUndo = useArchiveUndo();
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const {
    accessibleProjectsQuery,
    accessibleJobsQuery,
    accessibleJobsById,
    projectJobMembershipsQuery,
    sidebarPinsQuery,
    archivedProjectsQuery,
    archivedJobsQuery,
    summariesByJobId,
  } = useClientWorkspaceData({
    enabled: Boolean(user),
    userId: user?.id,
    projectCollaborationUnavailable,
  });

  const openAuth = (mode: "signin" | "signup") => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("auth", mode);
    setSearchParams(nextSearchParams, { replace: true });
    setIsAuthDialogOpen(true);
  };

  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => openAuth("signin"),
    onFilesSelected: async (files) => {
      if (!activeMembership) {
        throw new Error("Your workspace is still being prepared. Please wait a moment and try again.");
      }

      const result = await createJobsFromUploadFiles({ files });

      await invalidateClientWorkspaceQueries(queryClient);

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });

  const sidebarProjectIdsByJobId = useMemo(
    () => buildSidebarProjectIdsByJobId(projectJobMembershipsQuery.data ?? []),
    [projectJobMembershipsQuery.data],
  );
  const { remoteProjects, sidebarProjects } = useMemo(
    () =>
      buildSidebarProjects({
        accessibleProjects: accessibleProjectsQuery.data ?? [],
      }),
    [accessibleProjectsQuery.data],
  );

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
      await invalidateClientWorkspaceQueries(queryClient);
    },
  });

  const resolveSidebarProjectIdsForJob = (job: { id: string; project_id: string | null; source: string }) => {
    return resolveWorkspaceProjectIdsForJob({
      job,
      sidebarProjectIdsByJobId,
    });
  };

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
      projectCollaborationUnavailable ||
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
    projectCollaborationUnavailable,
    migrateLegacyProjectsMutation,
    user,
  ]);

  useWarmClientWorkspaceNavigation({
    enabled: Boolean(user) && !isLoading,
    canPrefetchProjects: !projectCollaborationUnavailable,
    projects: sidebarProjects,
    jobs: accessibleJobsQuery.data ?? [],
    pinnedProjectIds: sidebarPinsQuery.data?.projectIds ?? [],
    pinnedJobIds: sidebarPinsQuery.data?.jobIds ?? [],
    resolveProjectIdsForJob: resolveSidebarProjectIdsForJob,
  });

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
      await invalidateClientWorkspaceQueries(queryClient);
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (jobId: string, projectId: string) => {
    try {
      await removeJobFromProject(jobId, projectId);
      await invalidateClientWorkspaceQueries(queryClient);
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

  const handleArchivePart = async (jobId: string) => {
    try {
      await archiveJob(jobId);
      await invalidateClientWorkspaceQueries(queryClient);
      registerArchiveUndo({
        label: "Part",
        undo: async () => {
          await unarchiveJob(jobId);
          await invalidateClientWorkspaceQueries(queryClient);
        },
      });
      toast.success("Part archived. Press Ctrl+Z to undo.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive part.");
      throw error;
    }
  };

  const handleArchiveProject = async (projectId: string) => {
    try {
      await archiveProject(projectId);
      await invalidateClientWorkspaceQueries(queryClient);
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(projectId);
          await invalidateClientWorkspaceQueries(queryClient);
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive project.");
      throw error;
    }
  };

  const handleUnarchivePart = async (jobId: string) => {
    try {
      await unarchiveJob(jobId);
      await invalidateClientWorkspaceQueries(queryClient);
      toast.success("Part restored.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unarchive part.");
      throw error;
    }
  };

  const handleDeleteArchivedPart = async (jobId: string) => {
    try {
      await deleteArchivedJob(jobId);
      await invalidateClientWorkspaceQueries(queryClient);
      toast.success("Archived part deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete archived part.");
      throw error;
    }
  };

  const handleDissolveProject = async (projectId: string) => {
    try {
      await dissolveProject(projectId);
      await invalidateClientWorkspaceQueries(queryClient);
      toast.success("Project dissolved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dissolve project.");
      throw error;
    }
  };

  const handleCreateProjectFromSelection = async (jobIds: string[]) => {
    try {
      const labels = jobIds
        .map((jobId) => {
          const job = accessibleJobsById.get(jobId);
          return job ? getClientItemPresentation(job, summariesByJobId.get(jobId)).title : null;
        })
        .filter((label): label is string => Boolean(label));
      const projectId = await createProject({
        name: buildProjectNameFromLabels(labels),
      });

      await Promise.all(jobIds.map((selectedJobId) => assignJobToProject({ jobId: selectedJobId, projectId })));
      await invalidateClientWorkspaceQueries(queryClient);
      toast.success("Project created.");
      navigate(`/projects/${projectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
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

  const handleComposerSubmit = async ({
    prompt,
    files,
    clear,
  }: {
    prompt: string;
    files: File[];
    clear: () => void;
  }) => {
    if (!activeMembership) {
      throw new Error("Your workspace is still being prepared. Please wait a moment and try again.");
    }

    const result =
      files.length > 0
        ? await createJobsFromUploadFiles({
            files,
            prompt,
          })
        : {
            projectId: null,
            jobIds: [
              await (() => {
                const requestIntake = parseRequestIntake(prompt);
                return createClientDraft({
                  title: prompt.trim().split("\n")[0].slice(0, 120) || "Untitled part",
                  description: prompt.trim() || undefined,
                  tags: [],
                  requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
                  requestedByDate: requestIntake.requestedByDate,
                });
              })(),
            ],
          };

    clear();
    await invalidateClientWorkspaceQueries(queryClient);

    if (result.projectId && result.jobIds.length > 1) {
      navigate(`/projects/${result.projectId}`);
      return;
    }

    navigate(`/parts/${result.jobIds[0]}`);
  };

  const prefetchProject = (projectId: string) => {
    void prefetchProjectPage(queryClient, projectId, {
      enabled: !projectCollaborationUnavailable,
    });
  };

  const prefetchPart = (jobId: string) => {
    void prefetchPartPage(queryClient, jobId);
  };

  return {
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
    handleRefreshVerification,
    handleRemovePartFromProject,
    handleRenameProject,
    handleResendVerification,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isAuthDialogOpen,
    isDmriflesWorkspace,
    isRefreshingVerification,
    isResendingVerification,
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
  };
}
