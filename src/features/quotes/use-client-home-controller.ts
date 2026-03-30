import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import type { PromptComposerHandle } from "@/components/chat/PromptComposer";
import type { AppSessionData } from "@/features/quotes/types";
import { supabase } from "@/integrations/supabase/client";
import { getDefaultAccountName } from "@/lib/account-profile";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import {
  archiveJob,
  deleteArchivedJobs,
  isArchivedDeleteCapabilityError,
  unarchiveJob,
} from "@/features/quotes/api/archive-api";
import { checkClientIntakeCompatibility } from "@/features/quotes/api/compatibility-api";
import { createClientDraft } from "@/features/quotes/api/jobs-api";
import {
  archiveProject,
  assignJobToProject,
  createProject,
  dissolveProject,
  pinJob,
  pinProject,
  removeJobFromProject,
  unarchiveProject,
  unpinJob,
  unpinProject,
  updateProject,
} from "@/features/quotes/api/projects-api";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { createJobsFromUploadFiles } from "@/features/quotes/api/uploads-api";
import {
  createSelfServiceOrganization,
  resendSignupConfirmation,
} from "@/features/quotes/api/session-access";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  PROJECT_STORAGE_PREFIX,
  resolveWorkspaceProjectIdsForJob,
} from "@/features/quotes/client-workspace";
import {
  logArchivedDeleteFailure,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "@/features/quotes/archive-delete-errors";
import {
  invalidateClientWorkspaceQueries,
  useClientWorkspaceData,
  useWarmClientWorkspaceNavigation,
} from "@/features/quotes/use-client-workspace-data";
import { prefetchPartPage, prefetchProjectPage } from "@/features/quotes/workspace-navigation";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { buildProjectNameFromLabels } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { useWorkspaceNavigationModel } from "@/features/quotes/use-workspace-navigation-model";
import { useAppSession } from "@/hooks/use-app-session";
import { useWorkspaceReadiness } from "@/hooks/use-workspace-readiness";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import { WorkspaceNotReadyError } from "@/lib/workspace-errors";
import { MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE, type MembershipResolutionStatus } from "@/hooks/workspace-readiness";

const APP_SESSION_QUERY_KEY = ["app-session"] as const;
const MEMBERSHIP_RECOVERY_DELAYS_MS = [0, 300, 900, 1_800] as const;

function isExistingMembershipBootstrapError(message: string | null | undefined): boolean {
  return Boolean(message?.toLowerCase().includes("already has an organization membership"));
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

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
  const appSession = useAppSession();
  const memberships = appSession.memberships ?? [];
  const {
    user,
    authState,
    activeMembership,
    isLoading,
    isFetching,
    isPlatformAdmin,
    isVerifiedAuth,
    signOut,
    isAuthInitializing,
    membershipError,
  } = appSession;
  const hasWorkspaceAuthContext =
    Boolean(user) && authState !== "anonymous" && authState !== "invalid_session";
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [membershipResolutionStatus, setMembershipResolutionStatus] =
    useState<MembershipResolutionStatus>("idle");
  const [membershipResolutionErrorMessage, setMembershipResolutionErrorMessage] = useState<string | null>(null);
  const [membershipResolutionAttempt, setMembershipResolutionAttempt] = useState(0);
  const membershipRecoveryKeyRef = useRef<string | null>(null);
  const authIntent = searchParams.get("auth");
  const focusComposerIntent = searchParams.get("focusComposer");
  const authDialogMode: "sign-in" | "sign-up" = authIntent === "signup" ? "sign-up" : "sign-in";
  const defaultAccountName = useMemo(() => getDefaultAccountName(user), [user]);
  const registerArchiveUndo = useArchiveUndo();
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const {
    accessibleProjects,
    accessibleJobs,
    accessibleProjectsQuery,
    accessibleJobsQuery,
    accessibleJobsById,
    projectJobMemberships,
    projectJobMembershipsQuery,
    sidebarPinsQuery,
    archivedProjectsQuery,
    archivedJobsQuery,
    summariesByJobId,
  } = useClientWorkspaceData({
    enabled: hasWorkspaceAuthContext,
    userId: user?.id,
    projectCollaborationUnavailable,
  });

  const openAuth = (mode: "signin" | "signup") => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("auth", mode);
    setSearchParams(nextSearchParams, { replace: true });
    setIsAuthDialogOpen(true);
  };

  const safeProjectJobMembershipsQuery = projectJobMembershipsQuery ?? {
    isFetching: false,
    isSuccess: projectCollaborationUnavailable || projectJobMemberships.length > 0 || accessibleJobs.length === 0,
  };
  const navigationModel = useWorkspaceNavigationModel({
    accessibleJobs,
    accessibleProjects,
    projectJobMemberships,
    summariesByJobId,
    accessibleJobsQuery,
    accessibleProjectsQuery,
    projectJobMembershipsQuery: safeProjectJobMembershipsQuery,
    projectCollaborationUnavailable,
  });
  const sidebarProjects = navigationModel.sidebarProjects;
  const sidebarProjectIdsByJobId = navigationModel.partToProjectIds;

  const bootstrapAccountMutation = useMutation({
    mutationKey: ["client-home", "bootstrap-account"],
    meta: {
      suppressDiagnosticErrorMessages: ["already has an organization membership"],
    },
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

  const bootstrapErrorMessage =
    bootstrapAccountMutation.error instanceof Error ? bootstrapAccountMutation.error.message : null;
  const shouldRecoverMembership =
    Boolean(user) &&
    isVerifiedAuth &&
    !activeMembership &&
    (bootstrapAccountMutation.status === "success" ||
      (bootstrapAccountMutation.status === "error" && isExistingMembershipBootstrapError(bootstrapErrorMessage)));

  const canBootstrapSelfServiceOrganization =
    Boolean(user) &&
    !isPlatformAdmin &&
    authState === "authenticated" &&
    isVerifiedAuth &&
    !isAuthInitializing &&
    !isLoading &&
    !isFetching &&
    !membershipError &&
    !activeMembership &&
    memberships.length === 0 &&
    bootstrapAccountMutation.status === "idle";

  const { readiness: workspaceReadiness, waitForReady } = useWorkspaceReadiness({
    user,
    isLoading,
    isVerifiedAuth,
    activeMembership,
    membershipCount: memberships.length,
    bootstrapStatus: bootstrapAccountMutation.status,
    bootstrapErrorMessage,
    membershipResolutionStatus,
    membershipResolutionErrorMessage,
    membershipResolutionAttempt,
  });

  const ensureWorkspaceReady = async () => {
    if (workspaceReadiness.status === "ready") {
      return workspaceReadiness.membership;
    }
    if (workspaceReadiness.status === "anonymous") {
      throw new WorkspaceNotReadyError("Please sign in to continue.");
    }
    if (workspaceReadiness.status === "unverified") {
      throw new WorkspaceNotReadyError("Please verify your email before uploading.");
    }
    if (workspaceReadiness.status === "provisioning_failed") {
      throw new WorkspaceNotReadyError(workspaceReadiness.error);
    }
    // loading or provisioning — wait
    return waitForReady();
  };

  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => openAuth("signin"),
    onFilesSelected: async (files) => {
      await ensureWorkspaceReady();

      const result = await createJobsFromUploadFiles({ files });

      await invalidateClientWorkspaceQueries(queryClient);

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });

  const migrateLegacyProjectsMutation = useMutation({
    mutationKey: ["client-home", "migrate-legacy-projects"],
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
    if (!user || !activeMembership || !isVerifiedAuth) {
      return;
    }

    void checkClientIntakeCompatibility()
      .then(() => undefined)
      .catch(() => undefined);
  }, [activeMembership, isVerifiedAuth, user]);

  useEffect(() => {
    if (!canBootstrapSelfServiceOrganization) {
      return;
    }

    bootstrapAccountMutation.mutate(defaultAccountName);
  }, [
    bootstrapAccountMutation,
    defaultAccountName,
    canBootstrapSelfServiceOrganization,
    isAuthInitializing,
    isFetching,
    isLoading,
    isVerifiedAuth,
    membershipError,
    user,
    authState,
    memberships.length,
    activeMembership,
  ]);

  useEffect(() => {
    if (!user || !isVerifiedAuth || activeMembership) {
      membershipRecoveryKeyRef.current = null;
      setMembershipResolutionStatus("idle");
      setMembershipResolutionErrorMessage(null);
      setMembershipResolutionAttempt(0);
      return;
    }

    if (!shouldRecoverMembership) {
      if (bootstrapAccountMutation.status !== "error") {
        setMembershipResolutionStatus("idle");
        setMembershipResolutionErrorMessage(null);
        setMembershipResolutionAttempt(0);
      }
      return;
    }

    const recoveryKey = `${user.id}:${bootstrapAccountMutation.status}:${bootstrapErrorMessage ?? ""}`;
    if (membershipRecoveryKeyRef.current === recoveryKey) {
      return;
    }

    membershipRecoveryKeyRef.current = recoveryKey;

    let cancelled = false;

    setMembershipResolutionStatus("retrying");
    setMembershipResolutionErrorMessage(null);
    setMembershipResolutionAttempt(0);

    recordWorkspaceSessionDiagnostic(
      "warn",
      "client-home.membership-recovery.start",
      "Starting bounded app-session recovery for an authenticated user without membership.",
      {
        userId: user.id,
        bootstrapStatus: bootstrapAccountMutation.status,
        bootstrapErrorMessage,
      },
    );

    const recoverMembership = async () => {
      for (const [attemptIndex, delayMs] of MEMBERSHIP_RECOVERY_DELAYS_MS.entries()) {
        if (delayMs > 0) {
          await waitForDelay(delayMs);
        }

        if (cancelled) {
          return;
        }

        const nextAttempt = attemptIndex + 1;
        setMembershipResolutionAttempt(nextAttempt);
        recordWorkspaceSessionDiagnostic(
          "info",
          "client-home.membership-recovery.attempt",
          "Retrying app-session fetch while waiting for workspace membership.",
          {
            userId: user.id,
            attempt: nextAttempt,
            delayMs,
          },
        );

        await queryClient.invalidateQueries({ queryKey: APP_SESSION_QUERY_KEY, exact: true });
        await queryClient.refetchQueries({ queryKey: APP_SESSION_QUERY_KEY, exact: true });

        if (cancelled) {
          return;
        }

        const session = queryClient.getQueryData<AppSessionData>(APP_SESSION_QUERY_KEY);
        if ((session?.memberships.length ?? 0) > 0) {
          membershipRecoveryKeyRef.current = null;
          setMembershipResolutionStatus("idle");
          setMembershipResolutionErrorMessage(null);
          setMembershipResolutionAttempt(nextAttempt);
          recordWorkspaceSessionDiagnostic(
            "info",
            "client-home.membership-recovery.resolved",
            "App-session recovery found a workspace membership.",
            {
              userId: user.id,
              attempt: nextAttempt,
              membershipCount: session?.memberships.length ?? 0,
            },
          );
          return;
        }
      }

      if (cancelled) {
        return;
      }

      setMembershipResolutionStatus("exhausted");
      setMembershipResolutionErrorMessage(MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE);
      recordWorkspaceSessionDiagnostic(
        "warn",
        "client-home.membership-recovery.exhausted",
        "App-session recovery exhausted without finding a workspace membership.",
        {
          userId: user.id,
          bootstrapStatus: bootstrapAccountMutation.status,
          bootstrapErrorMessage,
          attempts: MEMBERSHIP_RECOVERY_DELAYS_MS.length,
        },
      );
    };

    void recoverMembership();

    return () => {
      cancelled = true;
    };
  }, [
    activeMembership,
    bootstrapAccountMutation.status,
    bootstrapErrorMessage,
    isVerifiedAuth,
    queryClient,
    shouldRecoverMembership,
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

  const shouldWarmWorkspaceNavigation = Boolean(user) && authState === "authenticated" && !isLoading;

  useWarmClientWorkspaceNavigation({
    enabled: shouldWarmWorkspaceNavigation,
    canPrefetchProjects: !projectCollaborationUnavailable,
    projects: sidebarProjects,
    jobs: navigationModel.parts,
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

  const handleDeleteArchivedParts = async (jobIds: string[]) => {
    const normalizedIds = [...new Set(jobIds)];

    if (normalizedIds.length === 0) {
      toast.error("No archived parts selected.");
      return;
    }

    try {
      const result = await deleteArchivedJobs(normalizedIds);
      await invalidateClientWorkspaceQueries(queryClient);

      if (result.failures.length === 0) {
        toast.success(
          result.deletedJobIds.length === 1
            ? "Archived part deleted."
            : `${result.deletedJobIds.length} archived parts deleted.`,
        );
        return;
      }

      if (result.deletedJobIds.length === 0) {
        const failure = result.failures[0];

        throw failure?.reporting
          ? withArchivedDeleteReporting(new Error(failure.message), {
              ...failure.reporting,
              partIds: failure.reporting.partIds.length > 0 ? failure.reporting.partIds : normalizedIds,
            })
          : new Error(failure?.message ?? "Failed to delete archived parts.");
      }

      toast.error(
        `Deleted ${result.deletedJobIds.length} archived parts, but ${result.failures.length} could not be removed.`,
      );
    } catch (error) {
      const surfacedError = toArchivedDeleteError(error);

      if (!isArchivedDeleteCapabilityError(surfacedError)) {
        logArchivedDeleteFailure({
          error,
          jobIds: normalizedIds,
          organizationId: activeMembership?.organizationId,
          userId: user?.id,
        });
      }
      toast.error(surfacedError.message);
      throw surfacedError;
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
    await ensureWorkspaceReady();

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
  const sidebarJobs = navigationModel.parts;

  return {
    activeMembership,
    workspaceReadiness,
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
    handleRefreshVerification,
    handleRemovePartFromProject,
    handleRenameProject,
    handleResendVerification,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isAuthDialogOpen,
    isAuthInitializing,
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
    navigationModel,
    setIsAuthDialogOpen,
    setIsSearchOpen,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    user,
    accessibleJobs: sidebarJobs,
    accessibleJobsQuery,
  };
}
