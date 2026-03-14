import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAppSession } from "@/hooks/use-app-session";
import {
  archiveJob,
  archiveProject,
  assignJobToProject,
  createJobsFromUploadFiles,
  createProject,
  deleteArchivedJob,
  dissolveProject,
  fetchPartDetail,
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
import { formatPartLabel, getClientItemPresentation } from "@/features/quotes/client-presentation";
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
import {
  buildRequirementDraft,
  formatCurrency,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import type { ActivityLogEntry } from "@/components/quotes/ActivityLog";
import type { VendorName } from "@/integrations/supabase/types";

export function useClientPartController() {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut } = useAppSession();
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDrawingPreview, setShowDrawingPreview] = useState(false);
  const [drawingPreviewPageUrls, setDrawingPreviewPageUrls] = useState<
    Array<{ pageNumber: number; url: string }>
  >([]);
  const [isDrawingPreviewLoading, setIsDrawingPreviewLoading] = useState(false);
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

      await invalidateClientWorkspaceQueries(queryClient, { jobId });

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });

  const partDetailQuery = useQuery({
    queryKey: workspaceQueryKeys.partDetail(jobId),
    queryFn: () => fetchPartDetail(jobId),
    enabled: Boolean(user) && Boolean(jobId),
    ...workspaceDetailQueryOptions,
  });
  const partDetail = partDetailQuery.data;

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

      const uploadSummary = await uploadFilesToJob(jobId, files);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await reconcileJobParts(jobId);
        await requestExtraction(jobId);
      }

      await invalidateClientWorkspaceQueries(queryClient, { jobId });

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
    mutationFn: (projectId: string) => assignJobToProject({ jobId, projectId }),
    onSuccess: async () => {
      toast.success("Part moved to project.");
      setShowMoveDialog(false);
      await invalidateClientWorkspaceQueries(queryClient, { jobId });
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
      await invalidateClientWorkspaceQueries(queryClient, { jobId });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove part from project.");
    },
  });

  const selectOfferMutation = useMutation({
    mutationFn: (offerId: string) => setJobSelectedVendorQuoteOffer(jobId, offerId),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId });
      toast.success("Selected quote updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update selected quote.");
    },
  });

  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId });
      toast.success("Request details updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update request details.");
    },
  });

  const renamePartMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId });
      toast.success("Part renamed.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to rename part.");
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
    activeJobId: jobId,
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

  const summary = partDetail?.summary ?? summariesByJobId.get(jobId) ?? null;
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
        jobId,
        revision: summary.revision,
        title: `${summary.partNumber ?? presentation?.title ?? "Part"}${
          summary.revision ? ` rev ${summary.revision}` : ""
        }`,
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
          ? `Drawing ${drawingFile.original_name} is attached${
              drawingPreview?.pageCount ? ` with ${drawingPreview.pageCount} preview page(s)` : ""
            }.`
          : "No drawing PDF is attached yet.",
        tone: drawingFile ? "active" : "attention",
      },
      {
        id: "metadata",
        label: "Extracting part details",
        detail: extraction
          ? `Material ${extraction.material.normalized ?? extraction.material.raw ?? "pending"}, finish ${
              extraction.finish.normalized ?? extraction.finish.raw ?? "pending"
            }, revision ${extraction.revision ?? "pending"}.`
          : "Extraction is pending or unavailable.",
        tone: extraction ? "active" : "attention",
      },
      {
        id: "matching",
        label: "Matching vendor options",
        detail:
          rankedQuoteOptions.length > 0
            ? `${rankedQuoteOptions.length} quote option${
                rankedQuoteOptions.length === 1 ? "" : "s"
              } available across anonymized vendors.`
            : "No quote options are available yet.",
        tone: rankedQuoteOptions.length > 0 ? "active" : "attention",
      },
      requestSummaryRequestedByDate
        ? {
            id: "due-date",
            label: "Filtering late deliveries",
            detail: `${eligibleQuoteCount} option${
              eligibleQuoteCount === 1 ? "" : "s"
            } remain eligible for the requested date ${requestSummaryRequestedByDate}.`,
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
        detail: selectedQuoteOption
          ? `${selectedQuoteOption.vendorLabel} currently leads at ${formatCurrency(
              selectedQuoteOption.totalPriceUsd,
            )} total.`
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
    setPartRenameValue("");
    setShowRenameDialog(false);
    setIsPartOptionsOpen(false);
  }, [jobId]);

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
    const objectUrls: string[] = [];

    if (!drawingFile || !drawingPreview || (!drawingPreview.thumbnail && drawingPreview.pages.length === 0)) {
      setDrawingPreviewPageUrls([]);
      setIsDrawingPreviewLoading(false);
      return;
    }

    setIsDrawingPreviewLoading(true);

    const loadAsset = async (storageBucket: string, storagePath: string) => {
      const blob = await downloadStoredFileBlob({
        storage_bucket: storageBucket,
        storage_path: storagePath,
        original_name: drawingFile.original_name,
      });
      const url = URL.createObjectURL(blob);
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
      if ((sidebarPinsQuery.data?.jobIds ?? []).includes(jobId)) {
        await handleUnpinPart(jobId);
        return;
      }

      await handlePinPart(jobId);
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

    if (!baseDraft || targetJobId !== jobId) {
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

  const handleDeleteArchivedPart = async (targetJobId: string) => {
    try {
      await deleteArchivedJob(targetJobId);
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId });
      toast.success("Archived part deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete archived part.");
      throw error;
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
      toast.error(error instanceof Error ? error.message : "Download failed.");
    }
  };

  const prefetchProject = (projectId: string) => {
    void prefetchProjectPage(queryClient, projectId, {
      enabled: !projectCollaborationUnavailable,
    });
  };

  const prefetchPart = (partId: string) => {
    void prefetchPartPage(queryClient, partId);
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
    drawingPreview,
    drawingPreviewPageUrls,
    effectiveRequestDraft,
    eligibleQuoteCount,
    extraction,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedPart,
    handleDissolveProject,
    handleDownloadFile,
    handleDraftChange,
    handlePinPart,
    handlePinProject,
    handlePresetSelection,
    handleRemovePartFromProject,
    handleRenamePart,
    handleRenameProject,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartArchiveBusy,
    isPartOptionsOpen,
    isPartPinBusy,
    isRenamingPart,
    isSearchOpen,
    jobId,
    navigate,
    newJobFilePicker,
    partDetail,
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
