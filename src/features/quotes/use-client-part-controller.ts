import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAppSession } from "@/hooks/use-app-session";
import {
  archiveJob,
  deleteArchivedJobs,
  isArchivedDeleteCapabilityError,
  unarchiveJob,
} from "@/features/quotes/api/archive-api";
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
import { reconcileJobParts, requestExtraction } from "@/features/quotes/api/extraction-api";
import { requestQuote, setJobSelectedVendorQuoteOffer } from "@/features/quotes/api/quote-requests-api";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { createJobsFromUploadFiles, uploadFilesToJob } from "@/features/quotes/api/uploads-api";
import {
  fetchClientActivityEventsByJobIds,
  fetchPartDetailByJobId,
  resolveClientPartDetailRoute,
} from "@/features/quotes/api/workspace-access";
import { updateClientPartRequest } from "@/features/quotes/api/jobs-api";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { buildActivityLogEntries } from "@/features/quotes/activity-log";
import { formatPartLabel, getClientItemPresentation } from "@/features/quotes/client-presentation";
import { describeClientPresetUnavailableReason } from "@/features/quotes/client-workspace-state";
import {
  logArchivedDeleteFailure,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "@/features/quotes/archive-delete-errors";
import {
  buildSidebarProjectIdsByJobId,
  buildSidebarProjects,
  resolveWorkspaceProjectIdsForJob,
} from "@/features/quotes/client-workspace";
import {
  invalidateClientWorkspaceQueries,
  useClientWorkspaceData,
  useWarmClientWorkspaceNavigation,
  workspaceDetailQueryOptions,
} from "@/features/quotes/use-client-workspace-data";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import { buildClientPartRequestUpdateInput } from "@/features/quotes/rfq-metadata";
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
import { prefetchPartPage, prefetchProjectPage, workspaceQueryKeys } from "@/features/quotes/workspace-navigation";
import { downloadStoredFileBlob } from "@/lib/stored-file";
import { getUserFacingErrorMessage } from "@/lib/error-message";
import {
  buildRequirementDraft,
  formatCurrency,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import type { DrawingPreviewState } from "@/components/quotes/ClientQuoteAssetPanels";
import type { ActivityLogEntry } from "@/components/quotes/ActivityLog";
import type { VendorName } from "@/integrations/supabase/types";

function shouldPollExtractionState(
  lifecycle: string | null | undefined,
) {
  return lifecycle === "queued" || lifecycle === "extracting" || lifecycle === "uploaded";
}

export function useClientPartController() {
  const { jobId: routeJobId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut } = useAppSession();
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDrawingPreview, setShowDrawingPreview] = useState(false);
  const [drawingPdfUrl, setDrawingPdfUrl] = useState<string | null>(null);
  const [drawingPreviewPageUrls, setDrawingPreviewPageUrls] = useState<
    Array<{ pageNumber: number; url: string }>
  >([]);
  const [isDrawingPreviewLoading, setIsDrawingPreviewLoading] = useState(false);
  const [drawingPreviewLoadError, setDrawingPreviewLoadError] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<QuotePreset | null>(null);
  const [excludedVendorKeys, setExcludedVendorKeys] = useState<VendorName[]>([]);
  const [requestDraft, setRequestDraft] = useState<ClientPartRequestUpdateInput | null>(null);
  const [quoteQuantityInput, setQuoteQuantityInput] = useState("");
  const [partRenameValue, setPartRenameValue] = useState("");
  const [isPartOptionsOpen, setIsPartOptionsOpen] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [isRenamingPart, setIsRenamingPart] = useState(false);
  const [isPartPinBusy, setIsPartPinBusy] = useState(false);
  const [isPartArchiveBusy, setIsPartArchiveBusy] = useState(false);
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
  const sidebarProjectIdsByJobId = useMemo(
    () => buildSidebarProjectIdsByJobId(projectJobMembershipsQuery.data ?? []),
    [projectJobMembershipsQuery.data],
  );
  const { sidebarProjects } = useMemo(
    () =>
      buildSidebarProjects({
        accessibleProjects: accessibleProjectsQuery.data ?? [],
      }),
    [accessibleProjectsQuery.data],
  );

  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const result = await createJobsFromUploadFiles({ files });

      await invalidateClientWorkspaceQueries(queryClient, { jobId: routeJobId });

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });

  const partRouteQuery = useQuery({
    queryKey: workspaceQueryKeys.partDetailRoute(routeJobId),
    queryFn: () => resolveClientPartDetailRoute(routeJobId),
    enabled: Boolean(user) && Boolean(routeJobId),
    retry: false,
    ...workspaceDetailQueryOptions,
  });
  const resolvedJobId = partRouteQuery.data?.jobId ?? null;
  const partDetailQuery = useQuery({
    queryKey: workspaceQueryKeys.partDetail(resolvedJobId ?? ""),
    queryFn: () => fetchPartDetailByJobId(resolvedJobId ?? ""),
    enabled: Boolean(user) && Boolean(resolvedJobId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const lifecycle = data?.part?.clientExtraction?.lifecycle ?? null;
      return shouldPollExtractionState(lifecycle) ? 5000 : false;
    },
    ...workspaceDetailQueryOptions,
  });
  const activityEventsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientActivity(resolvedJobId ? [resolvedJobId] : []),
    queryFn: () => fetchClientActivityEventsByJobIds([resolvedJobId ?? ""]),
    enabled: Boolean(user) && Boolean(resolvedJobId),
    refetchInterval: () => {
      const lifecycle = partDetailQuery.data?.part?.clientExtraction?.lifecycle ?? null;
      return shouldPollExtractionState(lifecycle) ? 5000 : false;
    },
    ...workspaceDetailQueryOptions,
  });
  const partDetail = partDetailQuery.data;
  const canonicalJobId = resolvedJobId ?? partDetail?.job?.id ?? routeJobId;
  const isPartDetailLoading =
    partRouteQuery.isLoading || partRouteQuery.isFetching || partDetailQuery.isLoading;

  const attachFilesPicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const normalizedStem = partDetail?.part?.normalized_key;

      if (!normalizedStem) {
        throw new Error("This part is not ready for attachments yet.");
      }

      const invalid = files.find((file) => normalizeUploadStem(file.name) !== normalizedStem);

      if (invalid) {
        throw new Error(`"${invalid.name}" does not match this part's filename stem.`);
      }

      const uploadSummary = await uploadFilesToJob(canonicalJobId, files);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await reconcileJobParts(canonicalJobId);
        await requestExtraction(canonicalJobId);
      }

      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        toast.success("Files attached to part.");
      }
    },
  });

  const currentProjectOptions = useMemo(() => {
    if (!partDetail?.job) {
      return [];
    }

    return (accessibleProjectsQuery.data ?? []).filter(
      (project) => project.project.organization_id === partDetail.job.organization_id,
    );
  }, [accessibleProjectsQuery.data, partDetail?.job]);

  const assignJobMutation = useMutation({
    mutationFn: (projectId: string) => assignJobToProject({ jobId: canonicalJobId, projectId }),
    onSuccess: async () => {
      toast.success("Part moved to project.");
      setShowMoveDialog(false);
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
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

      return removeJobFromProject(canonicalJobId, projectId);
    },
    onSuccess: async () => {
      toast.success("Part removed from project.");
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove part from project.");
    },
  });

  const selectOfferMutation = useMutation({
    mutationFn: (offerId: string) => setJobSelectedVendorQuoteOffer(canonicalJobId, offerId),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Selected quote updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update selected quote.");
    },
  });

  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Request details updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update request details.");
    },
  });

  const renamePartMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Part renamed.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to rename part.");
    },
  });

  const requestQuoteMutation = useMutation({
    mutationFn: ({ forceRetry = false }: { forceRetry?: boolean }) => requestQuote(canonicalJobId, forceRetry),
    onSuccess: async (result, variables) => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });

      if (!result.accepted) {
        toast.error(result.reason || "Quote request could not be started.");
        return;
      }

      if (result.created) {
        toast.success(variables.forceRetry ? "Quote retry queued." : "Quote request queued.");
        return;
      }

      toast.success("Quote request is already in progress.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to request a quote.");
    },
  });

  const resolveSidebarProjectIdsForJob = (job: {
    id: string;
    project_id: string | null;
    source: string;
  }) =>
    resolveWorkspaceProjectIdsForJob({
      job,
      sidebarProjectIdsByJobId,
    });

  useWarmClientWorkspaceNavigation({
    enabled: Boolean(user),
    canPrefetchProjects: !projectCollaborationUnavailable,
    projects: sidebarProjects,
    jobs: accessibleJobsQuery.data ?? [],
    pinnedProjectIds: sidebarPinsQuery.data?.projectIds ?? [],
    pinnedJobIds: sidebarPinsQuery.data?.jobIds ?? [],
    resolveProjectIdsForJob: resolveSidebarProjectIdsForJob,
    activeJobId: canonicalJobId,
  });

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

  useEffect(() => {
    if (resolvedJobId && resolvedJobId !== routeJobId) {
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.partDetail(routeJobId),
        exact: true,
      });
      navigate(`/parts/${resolvedJobId}`, { replace: true });
      return;
    }

    if (partDetail?.job?.id && partDetail.job.id !== routeJobId) {
      navigate(`/parts/${partDetail.job.id}`, { replace: true });
    }
  }, [navigate, partDetail?.job?.id, queryClient, resolvedJobId, routeJobId]);

  const summary = partDetail?.summary ?? summariesByJobId.get(canonicalJobId) ?? null;
  const presentation = partDetail?.job ? getClientItemPresentation(partDetail.job, summary) : null;
  const projectMemberships = useMemo(
    () =>
      (accessibleProjectsQuery.data ?? []).filter((project) =>
        partDetail?.projectIds.includes(project.project.id),
      ),
    [accessibleProjectsQuery.data, partDetail?.projectIds],
  );
  const extraction = partDetail?.part
    ? normalizeDrawingExtraction(partDetail.part.extraction, partDetail.part.id)
    : null;
  const extractionDiagnostics = partDetail?.part?.clientExtraction ?? null;
  const drawingPreview = partDetail?.drawingPreview ?? null;
  const drawingFile = partDetail?.files.find((file) => file.file_kind === "drawing") ?? null;
  const cadFile = partDetail?.files.find((file) => file.file_kind === "cad") ?? null;
  const fallbackRequestDraft = useMemo(() => {
    if (!partDetail?.part) {
      return null;
    }

    const requirement = buildRequirementDraft(partDetail.part, {
      requested_service_kinds: partDetail.job.requested_service_kinds ?? [],
      primary_service_kind: partDetail.job.primary_service_kind ?? null,
      service_notes: partDetail.job.service_notes ?? null,
      requested_quote_quantities: partDetail.job.requested_quote_quantities ?? [],
      requested_by_date: partDetail.job.requested_by_date ?? null,
    });

    return buildClientPartRequestUpdateInput(canonicalJobId, requirement);
  }, [
    canonicalJobId,
    partDetail?.job.primary_service_kind,
    partDetail?.job.requested_by_date,
    partDetail?.job.requested_quote_quantities,
    partDetail?.job.requested_service_kinds,
    partDetail?.job.service_notes,
    partDetail?.part,
  ]);
  const effectiveRequestDraft = requestDraft ?? fallbackRequestDraft;
  const currentPartName =
    effectiveRequestDraft?.partNumber ??
    summary?.partNumber ??
    presentation?.partNumber ??
    presentation?.title ??
    "Part";
  const currentRevision = effectiveRequestDraft?.revision ?? summary?.revision ?? null;
  const displayPartTitle = partDetail?.job
    ? formatPartLabel(
        effectiveRequestDraft?.partNumber ?? summary?.partNumber ?? presentation?.partNumber ?? null,
        currentRevision,
        partDetail.job.title,
      )
    : presentation?.title ?? currentPartName;
  const requestQuantities = useMemo(
    () =>
      parseRequestedQuoteQuantitiesInput(
        quoteQuantityInput,
        effectiveRequestDraft?.quantity ?? summary?.quantity ?? partDetail?.part?.quantity ?? 1,
      ),
    [effectiveRequestDraft?.quantity, partDetail?.part?.quantity, quoteQuantityInput, summary?.quantity],
  );
  const requestSummaryQuantity =
    effectiveRequestDraft?.quantity ?? summary?.quantity ?? partDetail?.part?.quantity ?? null;
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
        jobId: canonicalJobId,
        revision: summary.revision,
        title: `${summary.partNumber ?? presentation?.title ?? "Part"}${
          summary.revision ? ` rev ${summary.revision}` : ""
        }`,
      },
      ...(partDetail?.revisionSiblings ?? []),
    ].sort((left, right) => (left.revision ?? "").localeCompare(right.revision ?? ""));
  }, [canonicalJobId, partDetail?.revisionSiblings, presentation?.title, summary]);
  const selectedRevisionIndex = revisionOptions.findIndex((revision) => revision.jobId === canonicalJobId);
  const activityEntries = useMemo(
    () => buildActivityLogEntries(activityEventsQuery.data ?? []),
    [activityEventsQuery.data],
  );
  const drawingPreviewState: DrawingPreviewState = useMemo(() => {
    if (!drawingFile) {
      return "missing";
    }

    if (drawingPreviewLoadError) {
      return "unavailable";
    }

    if (drawingPdfUrl) {
      return "ready";
    }

    if (extractionDiagnostics?.lifecycle === "failed") {
      return "failed";
    }

    return "pending";
  }, [drawingFile, drawingPdfUrl, drawingPreviewLoadError, extractionDiagnostics?.lifecycle]);
  const drawingPreviewStatusMessage = useMemo(() => {
    switch (drawingPreviewState) {
      case "missing":
        return "PDF drawing missing. Upload a drawing file to validate extracted dimensions and notes.";
      case "pending":
        return extractionDiagnostics?.lifecycle === "partial"
          ? "Drawing preview pages are still catching up. The extracted metadata below is partial and needs review."
          : "Drawing preview is still processing. The original PDF can still be downloaded.";
      case "failed":
        return (
          extractionDiagnostics?.lastFailureMessage ??
          "Drawing preview generation failed. Download the original PDF while this is investigated."
        );
      case "unavailable":
        return drawingPreviewLoadError ?? "Drawing preview could not be loaded.";
      default:
        return null;
    }
  }, [drawingPreviewLoadError, drawingPreviewState, extractionDiagnostics]);

  useEffect(() => {
    setExcludedVendorKeys(readExcludedVendorKeys(canonicalJobId));
    setActivePreset(null);
    setRequestDraft(null);
    setQuoteQuantityInput("");
    setPartRenameValue("");
    setShowRenameDialog(false);
    setIsPartOptionsOpen(false);
    setDrawingPdfUrl(null);
    setDrawingPreviewLoadError(null);
  }, [canonicalJobId]);

  useEffect(() => {
    if (!fallbackRequestDraft) {
      return;
    }

    setRequestDraft(fallbackRequestDraft);
    setQuoteQuantityInput(
      formatRequestedQuoteQuantitiesInput(fallbackRequestDraft.requestedQuoteQuantities),
    );
    setPartRenameValue(fallbackRequestDraft.partNumber ?? presentation?.title ?? "");
  }, [fallbackRequestDraft, presentation?.title]);

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    if (!drawingFile) {
      setDrawingPdfUrl(null);
      setDrawingPreviewPageUrls([]);
      setIsDrawingPreviewLoading(false);
      setDrawingPreviewLoadError(null);
      return;
    }

    setIsDrawingPreviewLoading(true);
    setDrawingPreviewLoadError(null);

    void downloadStoredFileBlob(drawingFile)
      .then((blob) => {
        if (!isActive) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setDrawingPdfUrl(objectUrl);
        setDrawingPreviewPageUrls([]);
        setDrawingPreviewLoadError(null);
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return;
        }

        const message = getUserFacingErrorMessage(error, "Unable to load drawing preview.");
        toast.error(message);
        setDrawingPreviewLoadError(message);
        setDrawingPdfUrl(null);
        setDrawingPreviewPageUrls([]);
      })
      .finally(() => {
        if (isActive) {
          setIsDrawingPreviewLoading(false);
        }
      });

    return () => {
      isActive = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [drawingFile]);

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

  const handleToggleCurrentPartPin = async () => {
    setIsPartPinBusy(true);

    try {
      if ((sidebarPinsQuery.data?.jobIds ?? []).includes(canonicalJobId)) {
        await handleUnpinPart(canonicalJobId);
        return;
      }

      await handlePinPart(canonicalJobId);
    } finally {
      setIsPartPinBusy(false);
    }
  };

  const handleAssignPartToProject = async (targetJobId: string, projectId: string) => {
    try {
      await assignJobToProject({ jobId: targetJobId, projectId });
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId, projectId });
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (targetJobId: string, projectId: string) => {
    try {
      await removeJobFromProject(targetJobId, projectId);
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId, projectId });
      toast.success("Part removed from project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove part.");
      throw error;
    }
  };

  const handleRenameProject = async (projectId: string, name: string) => {
    try {
      await updateProject({ projectId, name });
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
      toast.success("Project updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project.");
      throw error;
    }
  };

  const handleRenamePart = async (targetJobId: string, name: string) => {
    const baseDraft = requestDraft ?? fallbackRequestDraft;

    if (!baseDraft || targetJobId !== canonicalJobId) {
      return;
    }

    const payload = {
      ...baseDraft,
      partNumber: name,
    } satisfies ClientPartRequestUpdateInput;

    setIsRenamingPart(true);

    try {
      setRequestDraft(payload);
      await renamePartMutation.mutateAsync(payload);
      setPartRenameValue(name);
      setShowRenameDialog(false);
    } catch (error) {
      setRequestDraft(baseDraft);
      throw error;
    } finally {
      setIsRenamingPart(false);
    }
  };

  const handleArchivePart = async (targetJobId: string) => {
    try {
      await archiveJob(targetJobId);
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId });
      registerArchiveUndo({
        label: "Part",
        undo: async () => {
          await unarchiveJob(targetJobId);
          await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId });
        },
      });
      toast.success("Part archived. Press Ctrl+Z to undo.");
      if (targetJobId === canonicalJobId) {
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
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(projectId);
          await invalidateClientWorkspaceQueries(queryClient, { projectId });
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
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId });
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
      await invalidateClientWorkspaceQueries(queryClient, {
        jobId: normalizedIds.length === 1 ? normalizedIds[0] : undefined,
      });

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
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
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

      await Promise.all(
        jobIds.map((selectedJobId) => assignJobToProject({ jobId: selectedJobId, projectId })),
      );
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: jobIds,
      });
      toast.success("Project created.");
      navigate(`/projects/${projectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
      throw error;
    }
  };

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
        describeClientPresetUnavailableReason({
          options: quoteOptions,
          preset,
          requestedByDate: requestSummaryRequestedByDate,
        }),
      );
      return;
    }

    selectOfferMutation.mutate(nextOption.persistedOfferId);
  };

  const handleToggleVendorExclusion = (vendorKey: VendorName, shouldExclude: boolean) => {
    setExcludedVendorKeys(toggleExcludedVendorKey(canonicalJobId, vendorKey, shouldExclude));
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

  const handleRequestQuote = async (forceRetry = false) => {
    await requestQuoteMutation.mutateAsync({ forceRetry });
  };

  const handleDownloadFile = async (file: {
    storage_bucket: string;
    storage_path: string;
    original_name: string;
  }) => {
    try {
      const blob = await downloadStoredFileBlob(file);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.original_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(getUserFacingErrorMessage(error, "Download failed."));
    }
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
    accessibleJobsQuery,
    activeMembership,
    activePreset,
    activityEntries,
    archivedJobsQuery,
    archivedProjectsQuery,
    assignJobMutation,
    attachFilesPicker,
    cadFile,
    currentPartName,
    currentProjectOptions,
    displayPartTitle,
    drawingFile,
    extractionDiagnostics,
    drawingPreview,
    drawingPdfUrl,
    drawingPreviewPageUrls,
    drawingPreviewState,
    drawingPreviewStatusMessage,
    effectiveRequestDraft,
    eligibleQuoteCount,
    extraction,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleDownloadFile,
    handleDraftChange,
    handlePinPart,
    handlePinProject,
    handlePresetSelection,
    handleRemovePartFromProject,
    handleRenamePart,
    handleRenameProject,
    handleRequestQuote,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isRequestingQuote: requestQuoteMutation.isPending,
    isPartOptionsOpen,
    isPartPinBusy,
    isRenamingPart,
    isSearchOpen,
    jobId: canonicalJobId,
    navigate,
    newJobFilePicker,
    partDetail,
    partRouteQuery,
    partDetailQuery,
    partRenameValue,
    pinnedJobIds: sidebarPinsQuery.data?.jobIds ?? [],
    prefetchPart,
    prefetchProject,
    presentation,
    projectCollaborationUnavailable,
    projectMemberships,
    quoteQuantityInput,
    rankedQuoteOptions,
    removeJobMutation,
    requestQuantities,
    requestQuoteMutation,
    requestSummaryQuantity,
    requestSummaryRequestedByDate,
    resolveSidebarProjectIdsForJob,
    revisionOptions,
    saveRequestMutation,
    selectedQuoteOption,
    selectedRevisionIndex,
    setIsPartArchiveBusy,
    setIsPartOptionsOpen,
    setIsSearchOpen,
    setPartRenameValue,
    setQuoteQuantityInput,
    setShowDrawingPreview,
    setShowMoveDialog,
    setShowRenameDialog,
    showDrawingPreview,
    showMoveDialog,
    showRenameDialog,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    summary,
    updatePartRenameValue: setPartRenameValue,
    user,
  };
}
