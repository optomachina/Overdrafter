import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Archive, FolderPlus, Loader2, Pencil, PlusSquare, Search as SearchIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
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
  archiveJob,
  archiveProject,
  assignJobToProject,
  createClientDraft,
  createJobsFromUploadFiles,
  createProject,
  deleteArchivedJob,
  dissolveProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchJobsByProject,
  fetchProject,
  fetchProjectInvites,
  fetchProjectMemberships,
  fetchSidebarPins,
  inviteProjectMember,
  isProjectCollaborationSchemaUnavailable,
  pinJob,
  pinProject,
  removeJobFromProject,
  removeProjectMember,
  unarchiveJob,
  unpinJob,
  unpinProject,
  updateProject,
} from "@/features/quotes/api";
import { getClientItemPresentation, matchesClientJobSearch } from "@/features/quotes/client-presentation";
import { buildDmriflesProjects, DMRIFLES_EMAIL, resolveImportedBatch } from "@/features/quotes/client-workspace";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { getSharedRequestMetadata } from "@/features/quotes/request-scenarios";
import { buildProjectNameFromLabels } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
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
  const { user, activeMembership, signOut } = useAppSession();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showDissolve, setShowDissolve] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
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
  const archivedProjectsQuery = useQuery({
    queryKey: ["archived-projects"],
    queryFn: fetchArchivedProjects,
    enabled: Boolean(user),
  });
  const archivedJobsQuery = useQuery({
    queryKey: ["archived-jobs"],
    queryFn: fetchArchivedJobs,
    enabled: Boolean(user),
  });
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const result = await createJobsFromUploadFiles({
        files,
        projectId: isSeededProject ? null : projectId,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["sidebar-pins", user?.id] }),
      ]);

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });
  const canLoadRemoteProjectData =
    Boolean(user) && !isSeededProject && !accessibleProjectsQuery.isLoading && !projectCollaborationUnavailable;

  const accessibleJobIds = useMemo(
    () => (accessibleJobsQuery.data ?? []).map((job) => job.id),
    [accessibleJobsQuery.data],
  );
  const partSummariesQuery = useQuery({
    queryKey: ["client-part-summaries", accessibleJobIds],
    queryFn: () => fetchJobPartSummariesByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0,
  });
  const sidebarProjectJobMembershipsQuery = useQuery({
    queryKey: ["client-project-job-memberships", accessibleJobIds],
    queryFn: () => fetchProjectJobMembershipsByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0 && !projectCollaborationUnavailable,
  });

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
    enabled: canLoadRemoteProjectData,
  });
  const projectJobsQuery = useQuery({
    queryKey: ["project-jobs", projectId],
    queryFn: () => fetchJobsByProject(projectId),
    enabled: canLoadRemoteProjectData,
  });
  const projectMembershipsQuery = useQuery({
    queryKey: ["project-memberships", projectId],
    queryFn: () => fetchProjectMemberships(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });
  const projectInvitesQuery = useQuery({
    queryKey: ["project-invites", projectId],
    queryFn: () => fetchProjectInvites(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });

  const summariesByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );
  const accessibleJobsById = useMemo(
    () => new Map((accessibleJobsQuery.data ?? []).map((job) => [job.id, job])),
    [accessibleJobsQuery.data],
  );
  const sidebarProjectIdsByJobId = useMemo(() => {
    const next = new Map<string, string[]>();

    (sidebarProjectJobMembershipsQuery.data ?? []).forEach((membership) => {
      const projectIds = next.get(membership.job_id) ?? [];

      if (!projectIds.includes(membership.project_id)) {
        projectIds.push(membership.project_id);
      }

      next.set(membership.job_id, projectIds);
    });

    return next;
  }, [sidebarProjectJobMembershipsQuery.data]);

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
  const sharedRequestSummary = useMemo(
    () => getSharedRequestMetadata(projectJobs.map((job) => summariesByJobId.get(job.id) ?? null)),
    [projectJobs, summariesByJobId],
  );
  const projectSummary = accessibleProjectsQuery.data?.find((project) => project.project.id === projectId) ?? null;
  const canRenameProject = !isSeededProject && ["owner", "editor"].includes(projectSummary?.currentUserRole ?? "editor");
  const canArchiveProject = canRenameProject;
  const canDissolveProject = !isSeededProject && (projectSummary?.currentUserRole ?? "editor") === "owner";
  const canManageMembers = canDissolveProject;

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
  const createProjectMutation = useMutation({
    mutationFn: (name: string) => createProject({ name }),
    onSuccess: async (nextProjectId) => {
      toast.success("Project created.");
      setShowCreateProject(false);
      setNewProjectName("");
      await queryClient.invalidateQueries({ queryKey: ["client-projects"] });
      navigate(`/projects/${nextProjectId}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create project.");
    },
  });
  const archiveProjectMutation = useMutation({
    mutationFn: () => archiveProject(projectId),
    onSuccess: async () => {
      toast.success("Project archived.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
      ]);
      navigate("/");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to archive project.");
    },
  });
  const dissolveProjectMutation = useMutation({
    mutationFn: () => dissolveProject(projectId),
    onSuccess: async () => {
      toast.success("Project dissolved.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
      ]);
      navigate("/");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to dissolve project.");
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

  const resolveSidebarProjectIdsForJob = (job: { id: string; project_id: string | null; source: string }) => {
    const projectIds = [...new Set([...(sidebarProjectIdsByJobId.get(job.id) ?? []), ...(job.project_id ? [job.project_id] : [])])];

    if (!isDmriflesWorkspace) {
      return projectIds;
    }

    const importedBatch = resolveImportedBatch(job, summariesByJobId.get(job.id));
    return importedBatch ? [...new Set([...projectIds, `seed-${importedBatch.toLowerCase()}`])] : projectIds;
  };

  const invalidateSidebarQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
      queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
      queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] }),
      queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["project"] }),
      queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
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

  const handleRemovePartFromProject = async (jobId: string, targetProjectId: string) => {
    try {
      await removeJobFromProject(jobId, targetProjectId);
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

  const handleArchivePart = async (targetJobId: string) => {
    try {
      await archiveJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Part archived.");
      if (targetJobId === focusedJobId) {
        setFocusedJobId(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive part.");
      throw error;
    }
  };

  const handleArchiveProject = async (targetProjectId: string) => {
    try {
      await archiveProject(targetProjectId);
      await invalidateSidebarQueries();
      toast.success("Project archived.");
      if (targetProjectId === projectId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive project.");
      throw error;
    }
  };

  const handleUnarchivePart = async (targetJobId: string) => {
    try {
      await unarchiveJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Part restored.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unarchive part.");
      throw error;
    }
  };

  const handleDeleteArchivedPart = async (targetJobId: string) => {
    try {
      await deleteArchivedJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Archived part deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete archived part.");
      throw error;
    }
  };

  const handleDissolveProject = async (targetProjectId: string) => {
    try {
      await dissolveProject(targetProjectId);
      await invalidateSidebarQueries();
      toast.success("Project dissolved.");
      if (targetProjectId === projectId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dissolve project.");
      throw error;
    }
  };

  const handleCreateProjectFromSelection = async (jobIds: string[]) => {
    try {
      const labels = jobIds
        .map((selectedJobId) => {
          const job = accessibleJobsById.get(selectedJobId);
          return job ? getClientItemPresentation(job, summariesByJobId.get(selectedJobId)).title : null;
        })
        .filter((label): label is string => Boolean(label));
      const nextProjectId = await createProject({
        name: buildProjectNameFromLabels(labels),
      });

      await Promise.all(
        jobIds.map((selectedJobId) => assignJobToProject({ jobId: selectedJobId, projectId: nextProjectId })),
      );
      await invalidateSidebarQueries();
      toast.success("Project created.");
      navigate(`/projects/${nextProjectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
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
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: SearchIcon, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeProjectId={projectId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={projectCollaborationUnavailable ? undefined : () => setShowCreateProject(true)}
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user?.id}
            pinnedProjectIds={sidebarPinsQuery.data?.projectIds ?? []}
            pinnedJobIds={sidebarPinsQuery.data?.jobIds ?? []}
            onPinProject={handlePinProject}
            onUnpinProject={handleUnpinProject}
            onPinPart={handlePinPart}
            onUnpinPart={handleUnpinPart}
            onAssignPartToProject={isDmriflesWorkspace ? undefined : handleAssignPartToProject}
            onRemovePartFromProject={isDmriflesWorkspace ? undefined : handleRemovePartFromProject}
            onCreateProjectFromSelection={projectCollaborationUnavailable ? undefined : handleCreateProjectFromSelection}
            onRenameProject={handleRenameProject}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
          />
        }
        sidebarFooter={
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
              {sharedRequestSummary ? (
                <RequestSummaryBadges
                  quantity={sharedRequestSummary.requestedQuoteQuantities[0] ?? null}
                  requestedQuoteQuantities={sharedRequestSummary.requestedQuoteQuantities}
                  requestedByDate={sharedRequestSummary.requestedByDate}
                  className="mt-4"
                />
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {!isSeededProject && !projectCollaborationUnavailable ? (
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
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowArchive(true)}
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </Button>
                </>
              ) : null}
              {canDissolveProject ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setShowDissolve(true)}
                  >
                    Dissolve
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
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Request</p>
                        <RequestSummaryBadges
                          quantity={focusedSummary?.quantity ?? null}
                          requestedQuoteQuantities={focusedSummary?.requestedQuoteQuantities ?? []}
                          requestedByDate={focusedSummary?.requestedByDate ?? null}
                          className="mt-2"
                        />
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

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
        onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
      />

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
              const result =
                files.length > 0
                  ? await createJobsFromUploadFiles({
                      files,
                      prompt,
                      projectId: isSeededProject ? null : projectId,
                    })
                  : {
                      projectId: isSeededProject ? null : projectId,
                      jobIds: [
                        await (() => {
                          const requestIntake = parseRequestIntake(prompt);
                          return createClientDraft({
                            title: prompt.trim().split("\n")[0].slice(0, 120) || "Untitled part",
                            description: prompt.trim() || undefined,
                            projectId: isSeededProject ? undefined : projectId,
                            requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
                            requestedByDate: requestIntake.requestedByDate,
                          });
                        })(),
                      ],
                    };

              clear();
              setShowAddPart(false);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
                queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
                queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
                queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
                queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
              ]);
              if (result.projectId && result.jobIds.length > 1) {
                navigate(`/projects/${result.projectId}`);
                return;
              }

              navigate(`/parts/${result.jobIds[0]}`);
            }}
          />
        </DialogContent>
      </Dialog>

      <ProjectNameDialog
        open={showCreateProject}
        onOpenChange={(open) => {
          setShowCreateProject(open);
          if (!open) {
            setNewProjectName("");
          }
        }}
        title="Create project"
        description="Choose a name for the new project."
        value={newProjectName}
        onValueChange={setNewProjectName}
        submitLabel="Create"
        isPending={createProjectMutation.isPending}
        isSubmitDisabled={newProjectName.trim().length === 0}
        onSubmit={() => createProjectMutation.mutate(newProjectName.trim())}
      />

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

      <Dialog open={showArchive} onOpenChange={setShowArchive}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Archive project</DialogTitle>
            <DialogDescription className="text-white/55">
              Parts only in this project will also be archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowArchive(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={archiveProjectMutation.isPending}
              onClick={() => archiveProjectMutation.mutate()}
            >
              {archiveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDissolve} onOpenChange={setShowDissolve}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Dissolve project</DialogTitle>
            <DialogDescription className="text-white/55">
              This deletes the project and leaves its parts in the main Parts list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowDissolve(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={dissolveProjectMutation.isPending}
              onClick={() => dissolveProjectMutation.mutate()}
            >
              {dissolveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Dissolve"}
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
        canDelete={canDissolveProject}
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
