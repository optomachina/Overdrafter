import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Download, FolderInput, Loader2, MoveRight, PlusSquare, Search, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { RequestedQuantityFilter } from "@/components/quotes/RequestedQuantityFilter";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import {
  archiveJob,
  archiveProject,
  assignJobToProject,
  createJobsFromUploadFiles,
  createProject,
  deleteArchivedJob,
  dissolveProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchPartDetail,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
  isProjectCollaborationSchemaUnavailable,
  pinJob,
  pinProject,
  reconcileJobParts,
  removeJobFromProject,
  requestExtraction,
  setJobSelectedVendorQuoteOffer,
  unarchiveJob,
  unpinJob,
  unpinProject,
  updateProject,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  collectRequestedQuantities,
  groupByRequestedQuantity,
  resolveRequestedQuantitySelection,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import { buildDmriflesProjects, DMRIFLES_EMAIL, resolveImportedBatch } from "@/features/quotes/client-workspace";
import { buildProjectNameFromLabels, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import {
  formatCurrency,
  formatLeadTime,
  formatStatusLabel,
  getImportedVendorOffers,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientPart = () => {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut } = useAppSession();
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDrawingPreview, setShowDrawingPreview] = useState(false);
  const [drawingPreviewThumbnailUrl, setDrawingPreviewThumbnailUrl] = useState<string | null>(null);
  const [drawingPreviewPageUrls, setDrawingPreviewPageUrls] = useState<Array<{ pageNumber: number; url: string }>>([]);
  const [isDrawingPreviewLoading, setIsDrawingPreviewLoading] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [activeRequestedQuantity, setActiveRequestedQuantity] =
    useState<RequestedQuantityFilterValue | null>(null);
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
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["sidebar-pins", user?.id] }),
      ]);

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
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
  const projectJobMembershipsQuery = useQuery({
    queryKey: ["client-project-job-memberships", accessibleJobIds],
    queryFn: () => fetchProjectJobMembershipsByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0 && !projectCollaborationUnavailable,
  });
  const partDetailQuery = useQuery({
    queryKey: ["part-detail", jobId],
    queryFn: () => fetchPartDetail(jobId),
    enabled: Boolean(user) && Boolean(jobId),
  });
  const attachFilesPicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const normalizedStem = partDetailQuery.data?.part?.normalized_key;

      if (!normalizedStem) {
        throw new Error("This part is not ready for attachments yet.");
      }

      const invalid = files.find((file) => normalizeUploadStem(file.name) !== normalizedStem);

      if (invalid) {
        throw new Error(`"${invalid.name}" does not match this part's filename stem.`);
      }

      const uploadSummary = await uploadFilesToJob(jobId, files);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await reconcileJobParts(jobId);
        await requestExtraction(jobId);
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      ]);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        toast.success("Files attached to part.");
      }
    },
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

    (projectJobMembershipsQuery.data ?? []).forEach((membership) => {
      const projectIds = next.get(membership.job_id) ?? [];

      if (!projectIds.includes(membership.project_id)) {
        projectIds.push(membership.project_id);
      }

      next.set(membership.job_id, projectIds);
    });

    return next;
  }, [projectJobMembershipsQuery.data]);
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
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to move part.");
    },
  });
  const removeJobMutation = useMutation({
    mutationFn: (projectId: string) => {
      if (!projectId) {
        throw new Error("This part is not currently assigned to a project.");
      }

      return removeJobFromProject(jobId, projectId);
    },
    onSuccess: async () => {
      toast.success("Part removed from project.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove part from project.");
    },
  });
  const selectOfferMutation = useMutation({
    mutationFn: (offerId: string) => setJobSelectedVendorQuoteOffer(jobId, offerId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      ]);
      toast.success("Selected quote updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update selected quote.");
    },
  });
  const createProjectMutation = useMutation({
    mutationFn: (name: string) => createProject({ name }),
    onSuccess: async (projectId) => {
      toast.success("Project created.");
      setIsCreateProjectOpen(false);
      setNewProjectName("");
      await queryClient.invalidateQueries({ queryKey: ["client-projects"] });
      navigate(`/projects/${projectId}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create project.");
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
      queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
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

  const handleRemovePartFromProject = async (targetJobId: string, projectId: string) => {
    try {
      await removeJobFromProject(targetJobId, projectId);
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

  const handleArchivePart = async (targetJobId: string) => {
    try {
      await archiveJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Part archived.");
      if (targetJobId === jobId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive part.");
      throw error;
    }
  };

  const handleArchiveProject = async (projectId: string) => {
    try {
      await archiveProject(projectId);
      await invalidateSidebarQueries();
      toast.success("Project archived.");
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

  const handleDissolveProject = async (projectId: string) => {
    try {
      await dissolveProject(projectId);
      await invalidateSidebarQueries();
      toast.success("Project dissolved.");
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
      const projectId = await createProject({
        name: buildProjectNameFromLabels(labels),
      });

      await Promise.all(jobIds.map((selectedJobId) => assignJobToProject({ jobId: selectedJobId, projectId })));
      await invalidateSidebarQueries();
      toast.success("Project created.");
      navigate(`/projects/${projectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
      throw error;
    }
  };

  useEffect(() => {
    if (projectCollaborationUnavailable) {
      setShowMoveDialog(false);
    }
  }, [projectCollaborationUnavailable]);

  useEffect(() => {
    if (!user) {
      navigate("/?auth=signin", { replace: true });
    }
  }, [navigate, user]);

  const summary = partDetail?.summary ?? summariesByJobId.get(jobId) ?? null;
  const presentation = partDetail?.job ? getClientItemPresentation(partDetail.job, summary) : null;
  const projectMemberships = useMemo(
    () =>
      (accessibleProjectsQuery.data ?? []).filter((project) =>
        partDetail?.projectIds.includes(project.project.id),
      ),
    [accessibleProjectsQuery.data, partDetail?.projectIds],
  );
  const dmriflesBatchProjectId = summary?.importedBatch ? `seed-${summary.importedBatch.toLowerCase()}` : null;
  const extraction = partDetail?.part ? normalizeDrawingExtraction(partDetail.part.extraction, partDetail.part.id) : null;
  const drawingPreview = partDetail?.drawingPreview ?? null;
  const drawingFile = partDetail?.files.find((file) => file.file_kind === "drawing") ?? null;
  const cadFiles = partDetail?.files.filter((file) => file.file_kind === "cad") ?? [];
  const quoteOffers = useMemo(() => {
    if (!partDetail?.part) {
      return [];
    }

    return partDetail.part.vendorQuotes
      .flatMap((quote) =>
        getImportedVendorOffers(quote).map((offer) => ({
          ...offer,
          vendor: quote.vendor,
        })),
      )
      .filter((offer) => Number.isFinite(offer.totalPriceUsd))
      .sort((left, right) => {
        if (left.totalPriceUsd !== right.totalPriceUsd) {
          return left.totalPriceUsd - right.totalPriceUsd;
        }

        return (left.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER) - (right.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER);
      });
  }, [partDetail?.part]);
  const selectedOffer =
    quoteOffers.find((offer) => offer.id === partDetail?.job.selected_vendor_quote_offer_id) ?? quoteOffers[0] ?? null;
  const requestSummaryQuantity = summary?.quantity ?? partDetail?.part?.quantity ?? null;
  const requestSummaryRequestedByDate =
    summary?.requestedByDate ??
    partDetail?.part?.approvedRequirement?.requested_by_date ??
    partDetail?.job.requested_by_date ??
    null;
  const requestQuantities = useMemo(
    () =>
      collectRequestedQuantities(
        [
          summary?.requestedQuoteQuantities,
          partDetail?.part?.approvedRequirement?.quote_quantities,
          partDetail?.job.requested_quote_quantities,
          quoteOffers.map((offer) => offer.requestedQuantity),
        ],
        requestSummaryQuantity,
      ),
    [
      partDetail?.job.requested_quote_quantities,
      partDetail?.part?.approvedRequirement?.quote_quantities,
      quoteOffers,
      requestSummaryQuantity,
      summary?.requestedQuoteQuantities,
    ],
  );
  const visibleQuoteOffers = useMemo(() => {
    if (activeRequestedQuantity === "all" || activeRequestedQuantity === null) {
      return quoteOffers;
    }

    return quoteOffers.filter((offer) => offer.requestedQuantity === activeRequestedQuantity);
  }, [activeRequestedQuantity, quoteOffers]);
  const visibleQuoteOfferGroups = useMemo(() => {
    if (visibleQuoteOffers.length === 0) {
      return [];
    }

    if (activeRequestedQuantity === "all") {
      return groupByRequestedQuantity(visibleQuoteOffers);
    }

    return [
      {
        requestedQuantity:
          typeof activeRequestedQuantity === "number"
            ? activeRequestedQuantity
            : visibleQuoteOffers[0]?.requestedQuantity ?? 1,
        items: visibleQuoteOffers,
      },
    ];
  }, [activeRequestedQuantity, visibleQuoteOffers]);
  const revisionOptions = useMemo(() => {
    if (!summary) {
      return [];
    }

    return [
      {
        jobId,
        revision: summary.revision,
        title: `${summary.partNumber ?? presentation?.title ?? "Part"}${summary.revision ? ` rev ${summary.revision}` : ""}`,
      },
      ...partDetail?.revisionSiblings ?? [],
    ].sort((left, right) => (left.revision ?? "").localeCompare(right.revision ?? ""));
  }, [jobId, partDetail?.revisionSiblings, presentation?.title, summary]);
  const selectedRevisionIndex = revisionOptions.findIndex((revision) => revision.jobId === jobId);

  useEffect(() => {
    let isActive = true;
    const objectUrls: string[] = [];

    if (!drawingFile || (!drawingPreview?.thumbnail && drawingPreview?.pages.length === 0)) {
      setDrawingPreviewThumbnailUrl(null);
      setDrawingPreviewPageUrls([]);
      setIsDrawingPreviewLoading(false);
      return;
    }

    setIsDrawingPreviewLoading(true);

    const loadAsset = async (storageBucket: string, storagePath: string) => {
      const { data, error } = await supabase.storage.from(storageBucket).download(storagePath);

      if (error || !data) {
        throw error ?? new Error(`Unable to load ${drawingFile.original_name}.`);
      }

      const url = URL.createObjectURL(data);
      objectUrls.push(url);
      return url;
    };

    void Promise.all([
      drawingPreview.thumbnail
        ? loadAsset(drawingPreview.thumbnail.storageBucket, drawingPreview.thumbnail.storagePath)
        : Promise.resolve<string | null>(null),
      Promise.all(
        drawingPreview.pages.map(async (page) => ({
          pageNumber: page.pageNumber,
          url: await loadAsset(page.storageBucket, page.storagePath),
        })),
      ),
    ])
      .then(([thumbnailUrl, pageUrls]) => {
        if (!isActive) {
          return;
        }

        setDrawingPreviewThumbnailUrl(thumbnailUrl);
        setDrawingPreviewPageUrls(pageUrls);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to load drawing preview.";
        toast.error(message);
        setDrawingPreviewThumbnailUrl(null);
        setDrawingPreviewPageUrls([]);
      })
      .finally(() => {
        if (isActive) {
          setIsDrawingPreviewLoading(false);
        }
      });

    return () => {
      isActive = false;
      objectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    };
  }, [drawingFile, drawingPreview]);

  useEffect(() => {
    setActiveRequestedQuantity((current) =>
      resolveRequestedQuantitySelection({
        availableQuantities: requestQuantities,
        currentSelection: current,
        preferredQuantity: selectedOffer?.requestedQuantity ?? requestSummaryQuantity,
        allowAll: true,
      }),
    );
  }, [requestQuantities, requestSummaryQuantity, selectedOffer?.requestedQuantity]);

  if (!user) {
    return null;
  }

  const handleDownloadFile = async (file: { storage_bucket: string; storage_path: string; original_name: string }) => {
    try {
      const { data, error } = await supabase.storage.from(file.storage_bucket).download(file.storage_path);

      if (error || !data) {
        throw error ?? new Error(`Unable to download ${file.original_name}.`);
      }

      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.original_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download failed.");
    }
  };

  return (
    <>
      <ChatWorkspaceLayout
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: Search, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeJobId={jobId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={projectCollaborationUnavailable ? undefined : () => setIsCreateProjectOpen(true)}
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user.id}
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
            onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
            onSelectPart={(partId) => navigate(`/parts/${partId}`)}
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
                    {projectMemberships.length > 0 ? (
                      projectMemberships.map((project) => (
                        <Badge
                          key={project.project.id}
                          className="border border-white/10 bg-white/6 text-white/75"
                        >
                          {project.project.name}
                        </Badge>
                      ))
                    ) : dmriflesBatchProjectId ? (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">
                        {summary?.importedBatch}
                      </Badge>
                    ) : (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">Your Parts</Badge>
                    )}
                    {!cadFiles.length ? (
                      <Badge className="border border-amber-400/25 bg-amber-500/10 text-amber-200">
                        Upload CAD to complete quoting
                      </Badge>
                    ) : null}
                  {!drawingFile ? (
                      <Badge className="border border-sky-400/25 bg-sky-500/10 text-sky-200">
                        Upload drawing PDF for extraction
                      </Badge>
                    ) : null}
                  </div>
                  <RequestSummaryBadges
                    quantity={requestSummaryQuantity}
                    requestedQuoteQuantities={requestQuantities}
                    requestedByDate={requestSummaryRequestedByDate}
                    className="mt-4"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  {revisionOptions.length > 1 ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => {
                          const previousId =
                            revisionOptions[(selectedRevisionIndex - 1 + revisionOptions.length) % revisionOptions.length]?.jobId;
                          if (!previousId) {
                            return;
                          }
                          navigate(`/parts/${previousId}`);
                        }}
                      >
                        &lt;
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => {
                          const nextId = revisionOptions[(selectedRevisionIndex + 1) % revisionOptions.length]?.jobId;
                          if (!nextId) {
                            return;
                          }
                          navigate(`/parts/${nextId}`);
                        }}
                      >
                        {revisionOptions[selectedRevisionIndex]?.revision ?? "Rev"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => {
                          const nextId = revisionOptions[(selectedRevisionIndex + 1) % revisionOptions.length]?.jobId;
                          if (!nextId) {
                            return;
                          }
                          navigate(`/parts/${nextId}`);
                        }}
                      >
                        &gt;
                      </Button>
                    </>
                  ) : null}
                  {projectMemberships.length === 1 ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => navigate(`/projects/${projectMemberships[0]!.project.id}`)}
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

                  {!isDmriflesWorkspace && !projectCollaborationUnavailable ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                      onClick={() => setShowMoveDialog(true)}
                    >
                      <FolderInput className="mr-2 h-4 w-4" />
                      Manage projects
                    </Button>
                  ) : null}

                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={attachFilesPicker.openFilePicker}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Attach files
                  </Button>

                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-4">
                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Files</p>
                    <div className="mt-4 space-y-3">
                      {drawingFile ? (
                        <button
                          type="button"
                          onClick={() => setShowDrawingPreview(true)}
                          className="flex w-full items-center gap-4 rounded-2xl border border-white/8 bg-black/20 p-4 text-left transition hover:bg-white/4"
                        >
                          <div className="h-24 w-20 overflow-hidden rounded-xl border border-white/8 bg-white">
                            {drawingPreviewUrl ? (
                              <img
                                src={drawingPreviewThumbnailUrl}
                                alt={`Preview ${drawingFile.original_name}`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center bg-zinc-100 text-zinc-500">
                                {isDrawingPreviewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "PDF"}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-white">{drawingFile.original_name}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-white/35">Drawing preview</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            className="shrink-0 text-white/70"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDownloadFile(drawingFile);
                            }}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            PDF
                          </Button>
                        </button>
                      ) : null}
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
                              <div className="flex items-center gap-2">
                                <Badge className="border border-white/10 bg-white/6 text-white/70">
                                  {file.mime_type ?? "file"}
                                </Badge>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="text-white/70"
                                  onClick={() => {
                                    void handleDownloadFile(file);
                                  }}
                                >
                                  <Download className="mr-2 h-4 w-4" />
                                  Download
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quote comparison</p>
                    <div className="mt-4 space-y-3">
                      <RequestedQuantityFilter
                        quantities={requestQuantities}
                        value={activeRequestedQuantity}
                        onChange={setActiveRequestedQuantity}
                      />
                      {!quoteOffers.length ? (
                        <p className="text-sm text-white/45">
                          {cadFiles.length
                            ? "No vendor quote lanes are available yet."
                            : "Upload a CAD model before vendor quote lanes can be compared."}
                        </p>
                      ) : (
                        <>
                          <div className="h-64 rounded-2xl border border-white/8 bg-black/20 p-3">
                            <ResponsiveContainer width="100%" height="100%">
                              <ScatterChart margin={{ top: 12, right: 12, bottom: 12, left: 0 }}>
                                <CartesianGrid stroke="rgba(255,255,255,0.08)" />
                                <XAxis
                                  type="number"
                                  dataKey="leadTimeBusinessDays"
                                  tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11 }}
                                  name="Lead time"
                                  unit="d"
                                />
                                <YAxis
                                  type="number"
                                  dataKey="unitPriceUsd"
                                  tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11 }}
                                  tickFormatter={(value) => `$${value}`}
                                  name="Unit price"
                                />
                                <ZAxis type="number" dataKey={() => 5} range={[160, 160]} />
                                <Tooltip
                                  cursor={{ strokeDasharray: "3 3" }}
                                  content={({ active, payload }) => {
                                    if (!active || !payload?.[0]?.payload) {
                                      return null;
                                    }

                                    const offer = payload[0].payload as (typeof quoteOffers)[number];
                                    return (
                                      <div className="rounded-lg border border-white/10 bg-[#1f1f1f] p-3 text-xs text-white shadow-xl">
                                        <p className="font-medium">{offer.supplier}</p>
                                        <p>Qty {offer.requestedQuantity}</p>
                                        <p>{formatCurrency(offer.unitPriceUsd)} unit</p>
                                        <p>{formatCurrency(offer.totalPriceUsd)} total</p>
                                        <p>{formatLeadTime(offer.leadTimeBusinessDays)}</p>
                                      </div>
                                    );
                                  }}
                                />
                                <Scatter
                                  data={visibleQuoteOffers}
                                  fill="#34d399"
                                  onClick={(point) => {
                                    const offer = point as (typeof quoteOffers)[number];
                                    if (offer.id) {
                                      selectOfferMutation.mutate(offer.id);
                                    }
                                  }}
                                />
                              </ScatterChart>
                            </ResponsiveContainer>
                          </div>

                          {selectedOffer ? (
                            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Current selection</p>
                              <p className="mt-2 text-lg font-semibold text-white">{selectedOffer.supplier}</p>
                              <p className="text-sm text-emerald-100/85">
                                Qty {selectedOffer.requestedQuantity} · {formatCurrency(selectedOffer.unitPriceUsd)} unit · {formatCurrency(selectedOffer.totalPriceUsd)} total · {formatLeadTime(selectedOffer.leadTimeBusinessDays)}
                              </p>
                            </div>
                          ) : null}

                          {visibleQuoteOffers.length === 0 ? (
                            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-white/50">
                              No vendor lanes are available for qty {activeRequestedQuantity}.
                            </div>
                          ) : (
                            visibleQuoteOfferGroups.map((group) => (
                              <div key={group.requestedQuantity} className="space-y-3">
                                {activeRequestedQuantity === "all" ? (
                                  <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                                    <p className="text-sm font-medium text-white">
                                      Qty {group.requestedQuantity}
                                    </p>
                                    <p className="text-xs text-white/45">
                                      {group.items.length} lane{group.items.length === 1 ? "" : "s"}
                                    </p>
                                  </div>
                                ) : null}
                                {group.items.map((offer) => (
                                  <button
                                    key={offer.offerId}
                                    type="button"
                                    className={cn(
                                      "block w-full rounded-2xl border px-4 py-3 text-left transition",
                                      selectedOffer?.offerId === offer.offerId
                                        ? "border-emerald-500/35 bg-emerald-500/10"
                                        : "border-white/8 bg-black/20 hover:bg-white/4",
                                    )}
                                    onClick={() => {
                                      if (offer.id) {
                                        selectOfferMutation.mutate(offer.id);
                                      }
                                    }}
                                  >
                                    <div className="flex items-start justify-between gap-4">
                                      <div>
                                        <p className="text-sm font-medium text-white">{offer.supplier}</p>
                                        <div className="mt-2 flex flex-wrap gap-2">
                                          <Badge className="border border-white/10 bg-white/6 text-white/70">
                                            Qty {offer.requestedQuantity}
                                          </Badge>
                                          <Badge className="border border-white/10 bg-white/6 text-white/70">
                                            {offer.laneLabel ?? offer.tier ?? "Quote lane"}
                                          </Badge>
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        <p className="text-sm font-semibold text-white">{formatCurrency(offer.unitPriceUsd)}</p>
                                        <p className="text-xs text-white/45">{formatLeadTime(offer.leadTimeBusinessDays)}</p>
                                      </div>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ))
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <aside className="space-y-4">
                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Details</p>
                    <div className="mt-4 space-y-3">
                      {selectedOffer ? (
                        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Selected quote</p>
                          <p className="mt-2 text-base font-semibold text-white">{selectedOffer.supplier}</p>
                          <p className="text-sm text-emerald-100/85">
                            {formatCurrency(selectedOffer.unitPriceUsd)} unit · {formatCurrency(selectedOffer.totalPriceUsd)} total
                          </p>
                          <p className="text-xs text-emerald-100/70">{formatLeadTime(selectedOffer.leadTimeBusinessDays)}</p>
                        </div>
                      ) : null}
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Created</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {new Date(partDetail.job.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Quantity</p>
                        <p className="mt-2 text-sm font-medium text-white">{requestSummaryQuantity ?? 1}</p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Request</p>
                        <RequestSummaryBadges
                          quantity={requestSummaryQuantity}
                          requestedQuoteQuantities={requestQuantities}
                          requestedByDate={requestSummaryRequestedByDate}
                          className="mt-2"
                        />
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Tags</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {partDetail.job.tags.length > 0 ? partDetail.job.tags.join(", ") : "No tags"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Projects</p>
                        <p className="mt-2 text-sm font-medium text-white">
                          {projectMemberships.length > 0
                            ? projectMemberships.map((project) => project.project.name).join(", ")
                            : "Standalone part"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Drawing details</p>
                    <div className="mt-4 space-y-3">
                      {[
                        ["Part number", extraction?.partNumber ?? summary?.partNumber ?? "Unknown"],
                        ["Revision", extraction?.revision ?? summary?.revision ?? "Unknown"],
                        ["Description", extraction?.description ?? summary?.description ?? "Unknown"],
                        ["Material", extraction?.material.normalized ?? extraction?.material.raw ?? "Unknown"],
                        ["Finish", extraction?.finish.normalized ?? extraction?.finish.raw ?? "Unknown"],
                        [
                          "Tolerance",
                          extraction?.tightestTolerance.raw ??
                            (extraction?.tightestTolerance.valueInch
                              ? `${extraction.tightestTolerance.valueInch.toFixed(4)} in`
                              : "Unknown"),
                        ],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</p>
                          <p className="mt-2 text-sm font-medium text-white">{value}</p>
                        </div>
                      ))}
                      {extraction?.warnings.length ? (
                        <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-amber-200/80">Warnings</p>
                          <ul className="mt-2 space-y-1 text-sm text-amber-100/90">
                            {extraction.warnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
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

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
        onSelectPart={(partId) => navigate(`/parts/${partId}`)}
      />

      <ProjectNameDialog
        open={isCreateProjectOpen}
        onOpenChange={(open) => {
          setIsCreateProjectOpen(open);
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
      <input
        ref={attachFilesPicker.inputRef}
        type="file"
        multiple
        accept={attachFilesPicker.accept}
        onChange={(event) => {
          void attachFilesPicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Attach files to part"
      />

      <Dialog open={showDrawingPreview} onOpenChange={setShowDrawingPreview}>
        <DialogContent className="max-w-5xl border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>{drawingFile?.original_name ?? "Drawing preview"}</DialogTitle>
            <DialogDescription className="text-white/55">
              Review the uploaded drawing PDF and download the original file.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-[70vh] overflow-hidden rounded-2xl border border-white/8 bg-white">
            {drawingPreviewUrl ? (
              <iframe
                title={drawingFile?.original_name ?? "Drawing preview"}
                src={`${drawingPreviewUrl}#toolbar=0&navpanes=0&scrollbar=0&page=1`}
                className="h-[70vh] w-full"
              />
            ) : (
              <div className="flex h-[70vh] items-center justify-center text-zinc-500">
                {isDrawingPreviewLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Preview unavailable"}
              </div>
            )}
          </div>
          <DialogFooter>
            {drawingFile ? (
              <Button
                type="button"
                variant="outline"
                className="border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => {
                  void handleDownloadFile(drawingFile);
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                Download PDF
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Manage project membership</DialogTitle>
            <DialogDescription className="text-white/55">
              Add this part to more projects or remove it from projects it already belongs to.
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
                    partDetail?.projectIds.includes(project.project.id) && "border-white/20",
                  )}
                  disabled={assignJobMutation.isPending || removeJobMutation.isPending}
                  onClick={() => {
                    if (partDetail?.projectIds.includes(project.project.id)) {
                      removeJobMutation.mutate(project.project.id);
                      return;
                    }

                    assignJobMutation.mutate(project.project.id);
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-white">{project.project.name}</p>
                    <p className="text-xs text-white/45">{project.partCount} parts</p>
                  </div>
                  {partDetail?.projectIds.includes(project.project.id) ? (
                    <XCircle className="h-4 w-4 text-white/45" />
                  ) : (
                    <MoveRight className="h-4 w-4 text-white/45" />
                  )}
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
