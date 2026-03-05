import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { PromptComposer, type PromptComposerHandle } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { SignInDialog } from "@/components/SignInDialog";
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
import { useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import {
  assignJobToProject,
  createClientDraft,
  createProject,
  createSelfServiceOrganization,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchJobPartSummariesByJobIds,
  fetchUngroupedParts,
  reconcileJobParts,
  requestExtraction,
  resendSignupConfirmation,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";
import {
  buildDmriflesProjects,
  DMRIFLES_EMAIL,
  PROJECT_STORAGE_PREFIX,
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
  const [showSearch, setShowSearch] = useState(false);
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
  const ungroupedPartsQuery = useQuery({
    queryKey: ["client-ungrouped-parts", user?.id],
    queryFn: fetchUngroupedParts,
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
      })),
    [accessibleProjectsQuery.data],
  );
  const sidebarProjects = isDmriflesWorkspace ? seededProjects : remoteProjects;

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
    Boolean(user) && !activeMembership && (bootstrapAccountMutation.isPending || !isVerifiedAuth);

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
    if (createProjectIntent !== "1" || !user || isDmriflesWorkspace) {
      return;
    }

    setShowCreateProject(true);

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("createProject");
    setSearchParams(nextSearchParams, { replace: true });
  }, [createProjectIntent, isDmriflesWorkspace, searchParams, setSearchParams, user]);

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
    if (showWorkspaceSetupState) {
      return (
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center justify-center px-6 pb-16">
          <div className="w-full rounded-[28px] border border-white/8 bg-[#2a2a2a] p-8 text-center shadow-[0_8px_40px_rgba(0,0,0,0.2)]">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-white/8">
              <Loader2 className="h-5 w-5 animate-spin text-white/80" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Setting up your workspace</h1>
            <p className="mt-3 text-sm leading-6 text-white/55">
              Your private workspace is created automatically in the background. Shared project access
              continues to work while setup finishes.
            </p>

            {!isVerifiedAuth && user.email ? (
              <div className="mt-6 flex justify-center gap-3">
                <Button
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  disabled={isRefreshingVerification}
                  onClick={() => {
                    void handleRefreshVerification();
                  }}
                >
                  {isRefreshingVerification ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
                </Button>
                <Button
                  variant="ghost"
                  className="rounded-full text-white/70 hover:bg-white/6 hover:text-white"
                  disabled={isResendingVerification}
                  onClick={() => {
                    void handleResendVerification();
                  }}
                >
                  {isResendingVerification ? <Loader2 className="h-4 w-4 animate-spin" /> : "Resend email"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

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
              yourParts={ungroupedPartsQuery.data ?? []}
              summariesByJobId={summariesByJobId}
              canCreateProject={!isDmriflesWorkspace}
              onCreateProject={() => setShowCreateProject(true)}
              onNewPart={() => {
                navigate("/");
                window.setTimeout(() => composerRef.current?.focus(), 0);
              }}
              onSearchParts={() => setShowSearch(true)}
              onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
              onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
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

      <Dialog open={showCreateProject} onOpenChange={setShowCreateProject}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription className="text-white/55">
              Projects are shareable by default and live in your hidden workspace.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Project name"
            className="border-white/10 bg-[#2a2a2a] text-white placeholder:text-white/35"
          />
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowCreateProject(false)}
            >
              Cancel
            </Button>
            <Button
              className="rounded-full"
              disabled={createProjectMutation.isPending || projectName.trim().length === 0}
              onClick={() => createProjectMutation.mutate(projectName.trim())}
            >
              {createProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SearchPartsDialog
        open={showSearch}
        onOpenChange={setShowSearch}
        projects={accessibleProjectsQuery.data ?? []}
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
