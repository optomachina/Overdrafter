import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FolderPlus, Loader2, Pencil, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
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
import { Badge } from "@/components/ui/badge";
import { useAppSession } from "@/hooks/use-app-session";
import {
  assignJobToProject,
  createClientDraft,
  createProject,
  deleteProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchJobPartSummariesByJobIds,
  fetchJobsByProject,
  fetchProject,
  fetchProjectInvites,
  fetchProjectMemberships,
  fetchSidebarPins,
  inviteProjectMember,
  pinJob,
  pinProject,
  reconcileJobParts,
  removeJobFromProject,
  removeProjectMember,
  requestExtraction,
  unpinJob,
  unpinProject,
  updateProject,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { getClientItemPresentation, matchesClientJobSearch } from "@/features/quotes/client-presentation";
import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";
import { buildDmriflesProjects, DMRIFLES_EMAIL, resolveImportedBatch } from "@/features/quotes/client-workspace";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

type JobFilter = "all" | "needs_attention" | "quoting" | "published";

const clientFilterOptions: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All parts" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "quoting", label: "Quoting" },
  { id: "published", label: "Published" },
];

function matchesJobFilter(status: string, filter: JobFilter) {
  switch (filter) {
    case "needs_attention":
      return status === "needs_spec_review" || status === "internal_review";
    case "quoting":
      return status === "quoting";
    case "published":
      return status === "published";
    case "all":
    default:
      return true;
  }
}

const ClientProject = () => {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signOut } = useAppSession();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [createProjectName, setCreateProjectName] = useState("");
  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;
  const isSeededProject = projectId.startsWith("seed-");

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

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
    enabled: Boolean(user) && !isSeededProject,
  });
  const projectJobsQuery = useQuery({
    queryKey: ["project-jobs", projectId],
    queryFn: () => fetchJobsByProject(projectId),
    enabled: Boolean(user) && !isSeededProject,
  });
  const projectMembershipsQuery = useQuery({
    queryKey: ["project-memberships", projectId],
    queryFn: () => fetchProjectMemberships(projectId),
    enabled: Boolean(user) && showMembers && !isSeededProject,
  });
  const projectInvitesQuery = useQuery({
    queryKey: ["project-invites", projectId],
    queryFn: () => fetchProjectInvites(projectId),
    enabled: Boolean(user) && showMembers && !isSeededProject,
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

  const seededProject = useMemo(() => {
    if (!isSeededProject) {
      return null;
    }

    const summaryMap = new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary]));
    return buildDmriflesProjects(accessibleJobsQuery.data ?? [], summaryMap).find(
      (project) => project.id === projectId,
    );
  }, [accessibleJobsQuery.data, isSeededProject, partSummariesQuery.data, projectId]);

  const projectJobs = useMemo(() => {
    if (seededProject) {
      const jobsById = new Map((accessibleJobsQuery.data ?? []).map((job) => [job.id, job]));
      return seededProject.jobIds
        .map((jobId) => jobsById.get(jobId))
        .filter((job): job is NonNullable<typeof job> => Boolean(job));
    }

    return projectJobsQuery.data ?? [];
  }, [accessibleJobsQuery.data, projectJobsQuery.data, seededProject]);

  const filteredJobs = useMemo(
    () =>
      projectJobs.filter(
        (job) => matchesJobFilter(job.status, activeFilter) && matchesClientJobSearch(job, search),
      ),
    [activeFilter, projectJobs, search],
  );

  useEffect(() => {
    if (filteredJobs.length === 0) {
      setFocusedJobId(null);
      return;
    }

    if (!focusedJobId || !filteredJobs.some((job) => job.id === focusedJobId)) {
      setFocusedJobId(filteredJobs[0].id);
    }
  }, [filteredJobs, focusedJobId]);

  const focusedJob = useMemo(
    () => filteredJobs.find((job) => job.id === focusedJobId) ?? null,
    [filteredJobs, focusedJobId],
  );
  const focusedSummary = focusedJob ? summariesByJobId.get(focusedJob.id) ?? null : null;
  const projectSummary = accessibleProjectsQuery.data?.find((project) => project.project.id === projectId) ?? null;
  const canRenameProject = !isSeededProject && ["owner", "editor"].includes(projectSummary?.currentUserRole ?? "editor");
  const canDeleteProject = !isSeededProject && (projectSummary?.currentUserRole ?? "editor") === "owner";
  const canManageMembers = canDeleteProject;

  const createProjectMutation = useMutation({
    mutationFn: (name: string) => createProject({ name }),
    onSuccess: async (nextProjectId) => {
      toast.success("Project created.");
      setShowCreateProject(false);
      setCreateProjectName("");
      await queryClient.invalidateQueries({ queryKey: ["client-projects"] });
      navigate(`/projects/${nextProjectId}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create project.");
    },
  });

  const updateProjectMutation = useMutation({
    mutationFn: (name: string) => updateProject({ projectId, name }),
    onSuccess: async () => {
      toast.success("Project updated.");
      setShowRename(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update project.");
    },
  });
  const deleteProjectMutation = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      toast.success("Project deleted.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
      ]);
      navigate("/");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete project.");
    },
  });
  const removeProjectMemberMutation = useMutation({
    mutationFn: removeProjectMember,
    onSuccess: async () => {
      toast.success("Member removed.");
      await queryClient.invalidateQueries({ queryKey: ["project-memberships", projectId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member.");
    },
  });

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
      queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["project"] }),
      queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
    ]);
  };

  const handlePinProject = async (targetProjectId: string) => {
    try {
      await pinProject(targetProjectId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin project.");
      throw error;
    }
  };

  const handleUnpinProject = async (targetProjectId: string) => {
    try {
      await unpinProject(targetProjectId);
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

  const handleAssignPartToProject = async (jobId: string, targetProjectId: string) => {
    try {
      await assignJobToProject({ jobId, projectId: targetProjectId });
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

  const handleRenameProject = async (targetProjectId: string, name: string) => {
    try {
      await updateProject({ projectId: targetProjectId, name });
      if (targetProjectId === projectId) {
        setProjectName(name);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", targetProjectId] }),
      ]);
      toast.success("Project updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project.");
      throw error;
    }
  };

  const handleDeleteProject = async (targetProjectId: string) => {
    try {
      await deleteProject(targetProjectId);
      await invalidateSidebarQueries();
      toast.success("Project deleted.");
      if (targetProjectId === projectId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete project.");
      throw error;
    }
  };

  useEffect(() => {
    if (projectQuery.data) {
      setProjectName(projectQuery.data.name);
    }
  }, [projectQuery.data]);

  useEffect(() => {
    if (!user) {
      navigate("/?auth=signin", { replace: true });
    }
  }, [navigate, user]);

  if (!user) {
    return null;
  }

  return (
    <>
      <ChatWorkspaceLayout
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeProjectId={projectId}
            onCreateProject={() => setShowCreateProject(true)}
            storageScopeKey={user?.id}
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
            onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
            resolveProjectIdForJob={resolveSidebarProjectIdForJob}
          />
        }
        sidebarFooter={
          <div className="space-y-3">
            <div>
              <p className="truncate text-sm font-medium text-white">{user?.email}</p>
              <p className="text-xs text-white/45">Shared project workspace</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full rounded-full border border-white/10 bg-transparent text-white/80 hover:bg-white/6 hover:text-white"
              onClick={async () => {
                await signOut();
                navigate("/", { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Project</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                {seededProject?.name ?? projectQuery.data?.name ?? "Project"}
              </h1>
              <p className="mt-2 text-sm text-white/55">
                {isSeededProject
                  ? "Read-only imported batch project."
                  : "Shared project members can collaborate here without exposing unrelated workspace data."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {!isSeededProject ? (
                <Button
                  type="button"
                  className="rounded-full"
                  onClick={() => setShowAddPart(true)}
                >
                  <FolderPlus className="mr-2 h-4 w-4" />
                  Add Part
                </Button>
              ) : null}
              {canManageMembers ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowMembers(true)}
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Members
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowRename(true)}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setShowDelete(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-[26px] border border-white/8 bg-[#262626] p-4">
                <div className="flex flex-col gap-3 md:flex-row">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search parts in this project"
                    className="border-white/10 bg-[#1f1f1f] text-white placeholder:text-white/35"
                  />
                  <div className="flex flex-wrap gap-2">
                    {clientFilterOptions.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant={activeFilter === option.id ? "default" : "outline"}
                        className={cn(
                          "rounded-full border-white/10",
                          activeFilter === option.id
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-transparent text-white hover:bg-white/6",
                        )}
                        onClick={() => setActiveFilter(option.id)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <p className="text-sm text-white/45">{filteredJobs.length} visible parts</p>
              </div>

              <div className="overflow-hidden rounded-[26px] border border-white/8 bg-[#262626]">
                {projectJobsQuery.isLoading && !isSeededProject ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="px-6 py-12 text-center text-white/45">No parts match this view.</div>
                ) : (
                  filteredJobs.map((job) => {
                    const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));

                    return (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => setFocusedJobId(job.id)}
                        className={cn(
                          "flex w-full items-start justify-between gap-4 border-b border-white/6 px-4 py-4 text-left transition last:border-b-0",
                          focusedJobId === job.id ? "bg-white/8" : "hover:bg-white/4",
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-base font-medium text-white">{presentation.title}</p>
                          <p className="mt-1 line-clamp-2 text-sm text-white/55">{presentation.description}</p>
                        </div>
                        <Badge className="shrink-0 border border-white/10 bg-white/6 text-white/75">
                          {formatStatusLabel(job.status)}
                        </Badge>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Focused part</p>
                {focusedJob ? (
                  <div className="mt-4 space-y-4">
                    <div>
                      <p className="text-xl font-semibold text-white">
                        {getClientItemPresentation(focusedJob, focusedSummary).title}
                      </p>
                      <p className="mt-2 text-sm text-white/55">
                        {getClientItemPresentation(focusedJob, focusedSummary).description}
                      </p>
                    </div>
                    <div className="grid gap-3">
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Status</p>
                        <p className="mt-2 text-sm font-medium text-white">{formatStatusLabel(focusedJob.status)}</p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Created</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {new Date(focusedJob.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Button asChild className="w-full rounded-full">
                      <Link to={`/parts/${focusedJob.id}`}>Open detail</Link>
                    </Button>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-white/45">Select a part to inspect it here.</p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </ChatWorkspaceLayout>

      <ProjectNameDialog
        open={showCreateProject}
        onOpenChange={(open) => {
          setShowCreateProject(open);
          if (!open) {
            setCreateProjectName("");
          }
        }}
        title="Create project"
        description="Projects are shareable by default and live in your hidden workspace."
        value={createProjectName}
        onValueChange={setCreateProjectName}
        submitLabel="Create"
        isPending={createProjectMutation.isPending}
        isSubmitDisabled={createProjectName.trim().length === 0}
        onSubmit={() => createProjectMutation.mutate(createProjectName.trim())}
      />

      <Dialog open={showAddPart} onOpenChange={setShowAddPart}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Add part</DialogTitle>
            <DialogDescription className="text-white/55">
              Create a new draft directly inside this project.
            </DialogDescription>
          </DialogHeader>
          <PromptComposer
            isSignedIn={Boolean(user)}
            onSubmit={async ({ prompt, files, clear }) => {
              const jobId = await createClientDraft({
                title: buildDraftTitleFromPrompt(prompt, files),
                description: prompt.trim() || undefined,
                projectId: isSeededProject ? undefined : projectId,
              });

              if (files.length > 0) {
                await uploadFilesToJob(jobId, files);
                await reconcileJobParts(jobId);
                await requestExtraction(jobId);
              }

              clear();
              setShowAddPart(false);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
                queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
                queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
                queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
              ]);
              navigate(`/parts/${jobId}`);
            }}
          />
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

      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription className="text-white/55">
              This moves all project parts back into their creators&apos; ungrouped lists.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProjectMutation.isPending}
              onClick={() => deleteProjectMutation.mutate()}
            >
              {deleteProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectMembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        currentUserId={user?.id ?? ""}
        memberships={projectMembershipsQuery.data ?? []}
        invites={projectInvitesQuery.data ?? []}
        canRename={canRenameProject}
        canDelete={canDeleteProject}
        onInvite={async (email) => {
          const invite = await inviteProjectMember({ projectId, email });
          toast.success(`Invite created for ${invite.email}.`);
          await queryClient.invalidateQueries({ queryKey: ["project-invites", projectId] });
        }}
        onRemoveMembership={async (membershipId) => {
          await removeProjectMemberMutation.mutateAsync(membershipId);
        }}
      />

    </>
  );
};

export default ClientProject;
