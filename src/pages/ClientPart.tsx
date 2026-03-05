import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FolderInput, Loader2, MoveRight, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppSession } from "@/hooks/use-app-session";
import {
  assignJobToProject,
  deleteProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchJobPartSummariesByJobIds,
  fetchPartDetail,
  fetchSidebarPins,
  pinJob,
  pinProject,
  removeJobFromProject,
  unpinJob,
  unpinProject,
  updateProject,
} from "@/features/quotes/api";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { buildDmriflesProjects, DMRIFLES_EMAIL, resolveImportedBatch } from "@/features/quotes/client-workspace";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientPart = () => {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signOut } = useAppSession();
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;

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
  const partDetailQuery = useQuery({
    queryKey: ["part-detail", jobId],
    queryFn: () => fetchPartDetail(jobId),
    enabled: Boolean(user) && Boolean(jobId),
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
        canManage: project.currentUserRole === "owner",
        createdAt: project.project.created_at,
        updatedAt: project.project.updated_at,
      })),
    [accessibleProjectsQuery.data],
  );
  const sidebarProjects = isDmriflesWorkspace ? seededProjects : remoteProjects;

  const partDetail = partDetailQuery.data;
  const currentProjectOptions = useMemo(() => {
    if (!partDetail?.job) {
      return [];
    }

    return (accessibleProjectsQuery.data ?? []).filter(
      (project) => project.project.organization_id === partDetail.job.organization_id,
    );
  }, [accessibleProjectsQuery.data, partDetail?.job]);

  const assignJobMutation = useMutation({
    mutationFn: (projectId: string) => assignJobToProject({ jobId, projectId }),
    onSuccess: async () => {
      toast.success("Part moved to project.");
      setShowMoveDialog(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to move part.");
    },
  });
  const removeJobMutation = useMutation({
    mutationFn: () => removeJobFromProject(jobId),
    onSuccess: async () => {
      toast.success("Part removed from project.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove part from project.");
    },
  });

  const resolveSidebarProjectIdForJob = (job: { id: string; project_id: string | null; source: string }) => {
    if (!isDmriflesWorkspace) {
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
      queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
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

  const handlePinPart = async (targetJobId: string) => {
    try {
      await pinJob(targetJobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin part.");
      throw error;
    }
  };

  const handleUnpinPart = async (targetJobId: string) => {
    try {
      await unpinJob(targetJobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpin part.");
      throw error;
    }
  };

  const handleAssignPartToProject = async (targetJobId: string, projectId: string) => {
    try {
      await assignJobToProject({ jobId: targetJobId, projectId });
      await invalidateSidebarQueries();
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (targetJobId: string) => {
    try {
      await removeJobFromProject(targetJobId);
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

  useEffect(() => {
    if (!user) {
      navigate("/?auth=signin", { replace: true });
    }
  }, [navigate, user]);

  if (!user) {
    return null;
  }

  const summary = partDetail?.summary ?? summariesByJobId.get(jobId) ?? null;
  const presentation = partDetail?.job ? getClientItemPresentation(partDetail.job, summary) : null;
  const currentProject = partDetail?.job?.project_id
    ? accessibleProjectsQuery.data?.find((project) => project.project.id === partDetail.job.project_id)
    : null;
  const dmriflesBatchProjectId = summary?.importedBatch ? `seed-${summary.importedBatch.toLowerCase()}` : null;

  return (
    <>
      <ChatWorkspaceLayout
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeJobId={jobId}
            canCreateProject={!isDmriflesWorkspace}
            onCreateProject={() => navigate("/?createProject=1")}
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
            onSelectPart={(partId) => navigate(`/parts/${partId}`)}
            resolveProjectIdForJob={resolveSidebarProjectIdForJob}
          />
        }
        sidebarFooter={
          <div className="space-y-3">
            <div>
              <p className="truncate text-sm font-medium text-white">{user.email}</p>
              <p className="text-xs text-white/45">Your parts and shared projects</p>
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
          {partDetailQuery.isLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
          ) : partDetail?.job && presentation ? (
            <>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-white/35">Part</p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{presentation.title}</h1>
                  <p className="mt-2 max-w-3xl text-sm text-white/55">{presentation.description}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge className="border border-white/10 bg-white/6 text-white/75">
                      {formatStatusLabel(partDetail.job.status)}
                    </Badge>
                    {currentProject ? (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">
                        {currentProject.project.name}
                      </Badge>
                    ) : dmriflesBatchProjectId ? (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">
                        {summary?.importedBatch}
                      </Badge>
                    ) : (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">Your Parts</Badge>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {currentProject ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => navigate(`/projects/${currentProject.project.id}`)}
                    >
                      Open project
                    </Button>
                  ) : dmriflesBatchProjectId ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => navigate(`/projects/${dmriflesBatchProjectId}`)}
                    >
                      Open batch
                    </Button>
                  ) : null}

                  {!isDmriflesWorkspace ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => setShowMoveDialog(true)}
                    >
                      <FolderInput className="mr-2 h-4 w-4" />
                      Move to project
                    </Button>
                  ) : null}

                  {partDetail.job.project_id && !isDmriflesWorkspace ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      disabled={removeJobMutation.isPending}
                      onClick={() => removeJobMutation.mutate()}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Remove from project
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-4">
                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Files</p>
                    <div className="mt-4 space-y-3">
                      {partDetail.files.length === 0 ? (
                        <p className="text-sm text-white/45">No files uploaded yet.</p>
                      ) : (
                        partDetail.files.map((file) => (
                          <div
                            key={file.id}
                            className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-white">{file.original_name}</p>
                                <p className="text-xs uppercase tracking-[0.14em] text-white/35">
                                  {file.file_kind}
                                </p>
                              </div>
                              <Badge className="border border-white/10 bg-white/6 text-white/70">
                                {file.mime_type ?? "file"}
                              </Badge>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Published options</p>
                    <div className="mt-4 space-y-3">
                      {partDetail.packages.length === 0 ? (
                        <p className="text-sm text-white/45">No published quote packages yet.</p>
                      ) : (
                        partDetail.packages.map((pkg) => (
                          <Link
                            key={pkg.id}
                            to={`/client/packages/${pkg.id}`}
                            className="block rounded-2xl border border-white/8 bg-black/20 px-4 py-3 transition hover:bg-white/4"
                          >
                            <p className="text-sm font-medium text-white">Package {pkg.id.slice(0, 8)}</p>
                            <p className="mt-1 text-xs text-white/45">
                              Published {new Date(pkg.published_at).toLocaleDateString()}
                            </p>
                          </Link>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <aside className="space-y-4">
                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Details</p>
                    <div className="mt-4 space-y-3">
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Created</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {new Date(partDetail.job.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Quantity</p>
                        <p className="mt-2 text-sm font-medium text-white">{summary?.quantity ?? 1}</p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Tags</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {partDetail.job.tags.length > 0 ? partDetail.job.tags.join(", ") : "No tags"}
                        </p>
                      </div>
                    </div>
                  </div>
                </aside>
              </div>
            </>
          ) : (
            <div className="rounded-[26px] border border-white/8 bg-[#262626] px-6 py-12 text-center text-white/45">
              This part could not be loaded.
            </div>
          )}
        </div>
      </ChatWorkspaceLayout>

      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Move to project</DialogTitle>
            <DialogDescription className="text-white/55">
              Move this part into another project in the same hidden workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {currentProjectOptions.length === 0 ? (
              <p className="text-sm text-white/45">No compatible projects are available for this part.</p>
            ) : (
              currentProjectOptions.map((project) => (
                <button
                  key={project.project.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-left transition hover:bg-white/4",
                    partDetail?.job.project_id === project.project.id && "border-white/20",
                  )}
                  disabled={assignJobMutation.isPending || partDetail?.job.project_id === project.project.id}
                  onClick={() => assignJobMutation.mutate(project.project.id)}
                >
                  <div>
                    <p className="text-sm font-medium text-white">{project.project.name}</p>
                    <p className="text-xs text-white/45">{project.partCount} parts</p>
                  </div>
                  <MoveRight className="h-4 w-4 text-white/45" />
                </button>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowMoveDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
};

export default ClientPart;
