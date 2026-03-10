import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, FolderInput, Loader2, MoveRight, PlusSquare, Search, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { ActivityLog, type ActivityLogEntry } from "@/components/quotes/ActivityLog";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { ClientQuoteComparisonChart } from "@/components/quotes/ClientQuoteComparisonChart";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  unarchiveProject,
  unpinJob,
  unpinProject,
  updateClientPartRequest,
  updateProject,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  buildDmriflesProjects,
  buildSeedProjectId,
  DMRIFLES_EMAIL,
  findImportedBatchProjectId,
  resolveImportedBatch,
  syncImportedBatchProjects,
} from "@/features/quotes/client-workspace";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import {
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  getSelectedOption,
  pickPresetOption,
  sortQuoteOptionsForPreset,
  type ClientQuoteSelectionOption,
  type QuotePreset,
} from "@/features/quotes/selection";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { buildProjectNameFromLabels, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { readExcludedVendorKeys, toggleExcludedVendorKey } from "@/features/quotes/vendor-exclusions";
import {
  buildRequirementDraft,
  formatCurrency,
  formatLeadTime,
  formatStatusLabel,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import type { VendorName } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

const ClientPart = () => {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut } = useAppSession();
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDrawingPreview, setShowDrawingPreview] = useState(false);
  const [drawingPreviewPageUrls, setDrawingPreviewPageUrls] = useState<Array<{ pageNumber: number; url: string }>>([]);
  const [isDrawingPreviewLoading, setIsDrawingPreviewLoading] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<QuotePreset | null>(null);
  const [excludedVendorKeys, setExcludedVendorKeys] = useState<VendorName[]>([]);
  const [requestDraft, setRequestDraft] = useState<ClientPartRequestUpdateInput | null>(null);
  const [quoteQuantityInput, setQuoteQuantityInput] = useState("");
  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;
  const registerArchiveUndo = useArchiveUndo();
  const [hasAttemptedDmriflesProjectSync, setHasAttemptedDmriflesProjectSync] = useState(false);

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
  const remoteProjectsByName = useMemo(
    () => new Map(remoteProjects.map((project) => [project.name.trim().toUpperCase(), project.id])),
    [remoteProjects],
  );
  const sidebarProjects = isDmriflesWorkspace
    ? [
        ...seededProjects.filter((project) => !remoteProjectsByName.has(project.name.trim().toUpperCase())),
        ...remoteProjects,
      ]
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
  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["part-detail", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      ]);
      toast.success("Request details updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update request details.");
    },
  });
  const resolveSidebarProjectIdsForJob = (job: { id: string; project_id: string | null; source: string }) => {
    const projectIds = [...new Set([...(sidebarProjectIdsByJobId.get(job.id) ?? []), ...(job.project_id ? [job.project_id] : [])])];

    if (!isDmriflesWorkspace) {
      return projectIds;
    }

    const importedBatch = resolveImportedBatch(job, summariesByJobId.get(job.id));
    if (!importedBatch) {
      return projectIds;
    }

    const importedBatchProjectId =
      findImportedBatchProjectId(importedBatch, remoteProjects) ?? buildSeedProjectId(importedBatch);
    return [...new Set([...projectIds, importedBatchProjectId])];
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
      registerArchiveUndo({
        label: "Part",
        undo: async () => {
          await unarchiveJob(targetJobId);
          await invalidateSidebarQueries();
        },
      });
      toast.success("Part archived. Press Ctrl+Z to undo.");
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
      if (projectId.startsWith("seed-")) {
        const batchJobs =
          buildDmriflesProjects(accessibleJobsQuery.data ?? [], summariesByJobId).find((project) => project.id === projectId)?.jobIds ?? [];

        await Promise.all(batchJobs.map((jobId) => archiveJob(jobId)));
        await invalidateSidebarQueries();
        registerArchiveUndo({
          label: "Project",
          undo: async () => {
            await Promise.all(batchJobs.map((jobId) => unarchiveJob(jobId)));
            await invalidateSidebarQueries();
          },
        });
        toast.success("Project archived. Press Ctrl+Z to undo.");
        return;
      }

      await archiveProject(projectId);
      await invalidateSidebarQueries();
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(projectId);
          await invalidateSidebarQueries();
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
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

  const syncDmriflesProjectsMutation = useMutation({
    mutationFn: async () =>
      syncImportedBatchProjects({
        jobs: accessibleJobsQuery.data ?? [],
        partSummariesByJobId: summariesByJobId,
        projects: (accessibleProjectsQuery.data ?? []).map((project) => ({
          id: project.project.id,
          name: project.project.name,
        })),
        resolveProjectIdsForJob: (targetJobId: string) => sidebarProjectIdsByJobId.get(targetJobId) ?? [],
      }),
    onSuccess: async (mutated) => {
      setHasAttemptedDmriflesProjectSync(true);

      if (!mutated) {
        return;
      }

      await invalidateSidebarQueries();
    },
    onError: () => {
      setHasAttemptedDmriflesProjectSync(true);
    },
  });

  useEffect(() => {
    if (projectCollaborationUnavailable) {
      setShowMoveDialog(false);
    }
  }, [projectCollaborationUnavailable]);

  useEffect(() => {
    if (
      !user ||
      !isDmriflesWorkspace ||
      projectCollaborationUnavailable ||
      hasAttemptedDmriflesProjectSync ||
      syncDmriflesProjectsMutation.isPending ||
      accessibleProjectsQuery.isLoading ||
      accessibleJobsQuery.isLoading ||
      partSummariesQuery.isLoading
    ) {
      return;
    }

    syncDmriflesProjectsMutation.mutate();
  }, [
    accessibleJobsQuery.isLoading,
    accessibleProjectsQuery.isLoading,
    hasAttemptedDmriflesProjectSync,
    isDmriflesWorkspace,
    partSummariesQuery.isLoading,
    projectCollaborationUnavailable,
    syncDmriflesProjectsMutation,
    user,
  ]);

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
  const dmriflesBatchProjectId =
    findImportedBatchProjectId(summary?.importedBatch, remoteProjects) ??
    (summary?.importedBatch ? buildSeedProjectId(summary.importedBatch) : null);
  const extraction = partDetail?.part ? normalizeDrawingExtraction(partDetail.part.extraction, partDetail.part.id) : null;
  const drawingPreview = partDetail?.drawingPreview ?? null;
  const drawingFile = partDetail?.files.find((file) => file.file_kind === "drawing") ?? null;
  const cadFile = partDetail?.files.find((file) => file.file_kind === "cad") ?? null;
  const fallbackRequestDraft = useMemo(() => {
    if (!partDetail?.part) {
      return null;
    }

    const requirement = buildRequirementDraft(partDetail.part, {
      requested_quote_quantities: partDetail.job.requested_quote_quantities ?? [],
      requested_by_date: partDetail.job.requested_by_date ?? null,
    });

    return {
      jobId,
      description: requirement.description ?? null,
      partNumber: requirement.partNumber ?? null,
      revision: requirement.revision ?? null,
      material: requirement.material,
      finish: requirement.finish ?? null,
      tightestToleranceInch: requirement.tightestToleranceInch ?? null,
      process: requirement.process ?? null,
      notes: requirement.notes ?? null,
      quantity: requirement.quantity,
      requestedQuoteQuantities: requirement.quoteQuantities,
      requestedByDate: requirement.requestedByDate ?? null,
    } satisfies ClientPartRequestUpdateInput;
  }, [
    jobId,
    partDetail?.job.requested_by_date,
    partDetail?.job.requested_quote_quantities,
    partDetail?.part,
  ]);
  const effectiveRequestDraft = requestDraft ?? fallbackRequestDraft;
  const requestQuantities = useMemo(
    () =>
      parseRequestedQuoteQuantitiesInput(
        quoteQuantityInput,
        effectiveRequestDraft?.quantity ?? summary?.quantity ?? partDetail?.part?.quantity ?? 1,
      ),
    [effectiveRequestDraft?.quantity, partDetail?.part?.quantity, quoteQuantityInput, summary?.quantity],
  );
  const requestSummaryQuantity = effectiveRequestDraft?.quantity ?? summary?.quantity ?? partDetail?.part?.quantity ?? null;
  const requestSummaryRequestedByDate =
    effectiveRequestDraft?.requestedByDate ??
    summary?.requestedByDate ??
    partDetail?.part?.approvedRequirement?.requested_by_date ??
    partDetail?.job.requested_by_date ??
    null;
  const vendorLabelMap = useMemo(
    () => buildVendorLabelMap(partDetail?.part?.vendorQuotes.map((quote) => quote.vendor) ?? []),
    [partDetail?.part?.vendorQuotes],
  );
  const quoteOptions = useMemo(
    () =>
      partDetail?.part
        ? buildClientQuoteSelectionOptions({
            vendorQuotes: partDetail.part.vendorQuotes,
            requestedByDate: requestSummaryRequestedByDate,
            excludedVendorKeys,
            vendorLabels: vendorLabelMap,
          })
        : [],
    [excludedVendorKeys, partDetail?.part, requestSummaryRequestedByDate, vendorLabelMap],
  );
  const rankedQuoteOptions = useMemo(
    () => sortQuoteOptionsForPreset(quoteOptions, activePreset ?? "cheapest"),
    [activePreset, quoteOptions],
  );
  const selectedQuoteOption =
    getSelectedOption(rankedQuoteOptions, partDetail?.job.selected_vendor_quote_offer_id) ??
    rankedQuoteOptions.find((option) => option.eligible) ??
    rankedQuoteOptions[0] ??
    null;
  const eligibleQuoteCount = rankedQuoteOptions.filter((option) => option.eligible).length;
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
      ...(partDetail?.revisionSiblings ?? []),
    ].sort((left, right) => (left.revision ?? "").localeCompare(right.revision ?? ""));
  }, [jobId, partDetail?.revisionSiblings, presentation?.title, summary]);
  const selectedRevisionIndex = revisionOptions.findIndex((revision) => revision.jobId === jobId);
  const activityEntries = useMemo<ActivityLogEntry[]>(() => {
    const rankingLabel =
      activePreset === "fastest"
        ? "Ranking fastest eligible quotes"
        : activePreset === "domestic"
          ? "Ranking domestic eligible quotes"
          : "Ranking cheapest eligible quotes";

    return [
      {
        id: "parsing",
        label: "Parsing drawing notes",
        detail: drawingFile
          ? `Drawing ${drawingFile.original_name} is attached${drawingPreview?.pageCount ? ` with ${drawingPreview.pageCount} preview page(s)` : ""}.`
          : "No drawing PDF is attached yet.",
        tone: drawingFile ? "active" : "attention",
      },
      {
        id: "metadata",
        label: "Extracting part details",
        detail: extraction
          ? `Material ${extraction.material.normalized ?? extraction.material.raw ?? "pending"}, finish ${extraction.finish.normalized ?? extraction.finish.raw ?? "pending"}, revision ${extraction.revision ?? "pending"}.`
          : "Extraction is pending or unavailable.",
        tone: extraction ? "active" : "attention",
      },
      {
        id: "matching",
        label: "Matching vendor options",
        detail:
          rankedQuoteOptions.length > 0
            ? `${rankedQuoteOptions.length} quote option${rankedQuoteOptions.length === 1 ? "" : "s"} available across anonymized vendors.`
            : "No quote options are available yet.",
        tone: rankedQuoteOptions.length > 0 ? "active" : "attention",
      },
      requestSummaryRequestedByDate
        ? {
            id: "due-date",
            label: "Filtering late deliveries",
            detail: `${eligibleQuoteCount} option${eligibleQuoteCount === 1 ? "" : "s"} remain eligible for the requested date ${requestSummaryRequestedByDate}.`,
            tone: eligibleQuoteCount > 0 ? "active" : "attention",
          }
        : {
            id: "due-date",
            label: "Filtering late deliveries",
            detail: "No due date provided, so all selectable vendors remain eligible.",
            tone: "default",
          },
      {
        id: "ranking",
        label: rankingLabel,
        detail:
          selectedQuoteOption
            ? `${selectedQuoteOption.vendorLabel} currently leads at ${formatCurrency(selectedQuoteOption.totalPriceUsd)} total.`
            : "No selectable quote is currently ranked.",
        tone: selectedQuoteOption ? "active" : "attention",
      },
    ];
  }, [
    activePreset,
    drawingFile,
    drawingPreview?.pageCount,
    eligibleQuoteCount,
    extraction,
    rankedQuoteOptions.length,
    requestSummaryRequestedByDate,
    selectedQuoteOption,
  ]);

  useEffect(() => {
    setExcludedVendorKeys(readExcludedVendorKeys(jobId));
    setActivePreset(null);
    setRequestDraft(null);
    setQuoteQuantityInput("");
  }, [jobId]);

  useEffect(() => {
    if (!fallbackRequestDraft) {
      return;
    }

    setRequestDraft(fallbackRequestDraft);
    setQuoteQuantityInput(formatRequestedQuoteQuantitiesInput(fallbackRequestDraft.requestedQuoteQuantities));
  }, [fallbackRequestDraft]);

  useEffect(() => {
    let isActive = true;
    const objectUrls: string[] = [];

    if (!drawingFile || !drawingPreview || (!drawingPreview.thumbnail && drawingPreview.pages.length === 0)) {
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

    void Promise.all(
      drawingPreview.pages.map(async (page) => ({
        pageNumber: page.pageNumber,
        url: await loadAsset(page.storageBucket, page.storagePath),
      })),
    )
      .then((pageUrls) => {
        if (!isActive) {
          return;
        }

        setDrawingPreviewPageUrls(pageUrls);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unable to load drawing preview.";
        toast.error(message);
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

  if (!user) {
    return null;
  }

  const handleSelectQuoteOption = (option: ClientQuoteSelectionOption) => {
    if (!option.persistedOfferId) {
      toast.error("This quote option is not ready to select yet.");
      return;
    }

    setActivePreset(null);
    selectOfferMutation.mutate(option.persistedOfferId);
  };

  const handlePresetSelection = (preset: QuotePreset) => {
    setActivePreset(preset);

    const nextOption = pickPresetOption(quoteOptions, preset);

    if (!nextOption?.persistedOfferId) {
      toast.error(
        requestSummaryRequestedByDate
          ? "No eligible quote meets the requested due date for this preset."
          : "No eligible quote is available for this preset.",
      );
      return;
    }

    selectOfferMutation.mutate(nextOption.persistedOfferId);
  };

  const handleToggleVendorExclusion = (vendorKey: VendorName, shouldExclude: boolean) => {
    setExcludedVendorKeys(toggleExcludedVendorKey(jobId, vendorKey, shouldExclude));
  };

  const handleDraftChange = (next: Partial<ClientPartRequestUpdateInput>) => {
    setRequestDraft((current) => {
      const base = current ?? fallbackRequestDraft;

      if (!base) {
        return current;
      }

      return {
        ...base,
        ...next,
      };
    });
  };

  const handleSaveRequest = () => {
    if (!effectiveRequestDraft) {
      return;
    }

    const nextQuantities = parseRequestedQuoteQuantitiesInput(
      quoteQuantityInput,
      effectiveRequestDraft.quantity,
    );

    const payload = {
      ...effectiveRequestDraft,
      requestedQuoteQuantities: nextQuantities,
    } satisfies ClientPartRequestUpdateInput;

    setRequestDraft(payload);
    setQuoteQuantityInput(formatRequestedQuoteQuantitiesInput(nextQuantities));
    saveRequestMutation.mutate(payload);
  };

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
            onCreateProject={projectCollaborationUnavailable ? undefined : newJobFilePicker.openFilePicker}
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
                  <p className="text-xs uppercase tracking-[0.18em] text-white/35">Part workspace</p>
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
                      <Badge className="border border-white/10 bg-white/6 text-white/75">Standalone part</Badge>
                    )}
                    {!cadFile ? (
                      <Badge className="border border-amber-400/25 bg-amber-500/10 text-amber-200">
                        CAD missing
                      </Badge>
                    ) : null}
                    {!drawingFile ? (
                      <Badge className="border border-sky-400/25 bg-sky-500/10 text-sky-200">
                        Drawing missing
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
                          if (previousId) {
                            navigate(`/parts/${previousId}`);
                          }
                        }}
                      >
                        Prev rev
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => {
                          const nextId = revisionOptions[(selectedRevisionIndex + 1) % revisionOptions.length]?.jobId;
                          if (nextId) {
                            navigate(`/parts/${nextId}`);
                          }
                        }}
                      >
                        {revisionOptions[selectedRevisionIndex]?.revision ?? "Rev"}
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
                  <Button type="button" className="rounded-full" onClick={() => navigate(`/parts/${jobId}/review`)}>
                    Review order
                    <MoveRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="grid gap-6 xl:grid-cols-2">
                <ClientDrawingPreviewPanel
                  drawingFile={drawingFile}
                  drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
                  onOpenDialog={drawingFile ? () => setShowDrawingPreview(true) : undefined}
                />
                <ClientCadPreviewPanel cadFile={cadFile} />
              </div>

              <section className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quote comparison</p>
                    <p className="mt-2 text-sm text-white/55">
                      Presets only rank eligible quotes, ignore excluded vendors, and honor the requested due date.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(["cheapest", "fastest", "domestic"] as const).map((preset) => (
                      <Button
                        key={preset}
                        type="button"
                        variant={activePreset === preset ? "default" : "outline"}
                        className={cn(
                          "rounded-full border-white/10",
                          activePreset === preset
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-transparent text-white hover:bg-white/6",
                        )}
                        onClick={() => handlePresetSelection(preset)}
                      >
                        {preset === "cheapest" ? "Cheapest" : preset === "fastest" ? "Fastest" : "Domestic"}
                      </Button>
                    ))}
                  </div>
                </div>

                {selectedQuoteOption ? (
                  <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/80">Current selection</p>
                    <p className="mt-2 text-lg font-semibold text-white">{selectedQuoteOption.vendorLabel}</p>
                    <p className="text-sm text-emerald-100/85">
                      {formatCurrency(selectedQuoteOption.totalPriceUsd)} total ·{" "}
                      {selectedQuoteOption.resolvedDeliveryDate ?? formatLeadTime(selectedQuoteOption.leadTimeBusinessDays)}
                    </p>
                  </div>
                ) : null}

                {!rankedQuoteOptions.length ? (
                  <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-6 text-sm text-white/45">
                    {cadFile
                      ? "No quote options are available yet."
                      : "Upload a CAD model before quote options can be compared."}
                  </div>
                ) : (
                  <>
                    <div className="mt-4 rounded-[22px] border border-white/8 bg-black/20 p-4">
                      <ClientQuoteComparisonChart
                        options={rankedQuoteOptions}
                        selectedKey={selectedQuoteOption?.key ?? null}
                        onSelect={handleSelectQuoteOption}
                      />
                    </div>

                    {requestSummaryRequestedByDate && eligibleQuoteCount === 0 ? (
                      <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                        No eligible quote currently meets the requested due date of {requestSummaryRequestedByDate}.
                      </div>
                    ) : null}

                    <div className="mt-4 space-y-3">
                      {rankedQuoteOptions.map((option) => {
                        const selected = selectedQuoteOption?.key === option.key;
                        const domesticLabel =
                          option.domesticStatus === "domestic"
                            ? "USA"
                            : option.domesticStatus === "foreign"
                              ? "Foreign"
                              : "Unknown";

                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => handleSelectQuoteOption(option)}
                            className={cn(
                              "block w-full rounded-2xl border px-4 py-4 text-left transition",
                              selected
                                ? "border-emerald-500/30 bg-emerald-500/10"
                                : "border-white/8 bg-black/20 hover:bg-white/4",
                              !option.isSelectable && "cursor-not-allowed opacity-70",
                            )}
                            disabled={!option.isSelectable}
                          >
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-semibold text-white">{option.vendorLabel}</p>
                                  <Badge className="border border-white/10 bg-white/6 text-white/70">
                                    Qty {option.requestedQuantity}
                                  </Badge>
                                  <Badge
                                    className={cn(
                                      "border",
                                      option.domesticStatus === "domestic"
                                        ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                                        : option.domesticStatus === "foreign"
                                          ? "border-sky-400/20 bg-sky-500/10 text-sky-100"
                                          : "border-white/10 bg-white/6 text-white/70",
                                    )}
                                  >
                                    {domesticLabel}
                                  </Badge>
                                  {option.expedite ? (
                                    <Badge className="border border-fuchsia-400/20 bg-fuchsia-500/10 text-fuchsia-100">
                                      Expedite
                                    </Badge>
                                  ) : null}
                                  {!option.dueDateEligible && requestSummaryRequestedByDate ? (
                                    <Badge className="border border-amber-400/20 bg-amber-500/10 text-amber-100">
                                      Late
                                    </Badge>
                                  ) : null}
                                  {option.excluded ? (
                                    <Badge className="border border-white/10 bg-white/6 text-white/70">
                                      Excluded
                                    </Badge>
                                  ) : null}
                                  {selected ? (
                                    <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                                      Selected
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-2 text-sm text-white/55">
                                  {option.laneLabel ?? option.tier ?? "Standard lane"}
                                  {option.process ? ` · ${option.process}` : ""}
                                  {option.material ? ` · ${option.material}` : ""}
                                </p>
                              </div>
                              <div className="flex flex-wrap items-center gap-3 lg:justify-end">
                                <div className="text-left lg:text-right">
                                  <p className="text-sm font-semibold text-white">{formatCurrency(option.totalPriceUsd)}</p>
                                  <p className="text-xs text-white/45">
                                    {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleToggleVendorExclusion(option.vendorKey, !option.excluded);
                                  }}
                                >
                                  {option.excluded ? "Include vendor" : "Exclude vendor"}
                                </Button>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                <Collapsible defaultOpen className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">Metadata and RFQ details</p>
                      <p className="mt-2 text-sm text-white/55">
                        Correct extracted fields and keep revised files on this same line item.
                      </p>
                    </div>
                    <ChevronDown className="h-4 w-4 text-white/45" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-4">
                    {effectiveRequestDraft ? (
                      <ClientPartRequestEditor
                        draft={effectiveRequestDraft}
                        quoteQuantityInput={quoteQuantityInput}
                        onQuoteQuantityInputChange={setQuoteQuantityInput}
                        onChange={handleDraftChange}
                        onSave={handleSaveRequest}
                        onUploadRevision={attachFilesPicker.openFilePicker}
                        isSaving={saveRequestMutation.isPending}
                        footer={
                          extraction?.warnings.length ? (
                            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                              {extraction.warnings.join(" ")}
                            </div>
                          ) : null
                        }
                      />
                    ) : (
                      <p className="text-sm text-white/45">Part details are still loading.</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <ActivityLog entries={activityEntries} />
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

      {drawingFile ? (
        <DrawingPreviewDialog
          open={showDrawingPreview}
          onOpenChange={setShowDrawingPreview}
          fileName={drawingFile.original_name}
          pageCount={drawingPreview?.pageCount ?? 0}
          pages={drawingPreviewPageUrls}
          isLoading={isDrawingPreviewLoading}
          onDownload={() => {
            void handleDownloadFile(drawingFile);
          }}
        />
      ) : null}

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
