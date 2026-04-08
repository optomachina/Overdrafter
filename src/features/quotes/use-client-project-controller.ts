import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { buildActivityLogEntries, groupClientActivityEventsByJobId } from "@/features/quotes/activity-log";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppSession } from "@/hooks/use-app-session";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
import {
  archiveJob,
  deleteArchivedJobs,
  isArchivedDeleteCapabilityError,
  unarchiveJob,
} from "@/features/quotes/api/archive-api";
import { createClientDraft, updateClientPartRequest } from "@/features/quotes/api/jobs-api";
import {
  archiveProject,
  assignJobToProject,
  createProject,
  dissolveProject,
  fetchProject,
  fetchProjectInvites,
  fetchProjectMemberships,
  inviteProjectMember,
  pinJob,
  pinProject,
  removeJobFromProject,
  removeProjectMember,
  unarchiveProject,
  unpinJob,
  unpinProject,
  updateProject,
} from "@/features/quotes/api/projects-api";
import { reconcileJobParts, requestExtraction } from "@/features/quotes/api/extraction-api";
import {
  cancelQuoteRequest,
  requestQuotes,
  setJobSelectedVendorQuoteOffer,
} from "@/features/quotes/api/quote-requests-api";
import {
  fetchJobVendorPreferenceContext,
  setJobVendorPreferences,
  setProjectVendorPreferences,
} from "@/features/quotes/api/vendor-preferences-api";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { createJobsFromUploadFiles, uploadFilesToJob } from "@/features/quotes/api/uploads-api";
import {
  fetchClientActivityEventsByJobIds,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProjectAssigneeProfiles,
} from "@/features/quotes/api/workspace-access";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  logArchivedDeleteFailure,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "@/features/quotes/archive-delete-errors";
import {
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
  parseRequestIntake,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import { buildClientPartRequestUpdateInput } from "@/features/quotes/rfq-metadata";
import { getSharedRequestMetadata } from "@/features/quotes/request-scenarios";
import {
  applyBulkPresetSelection,
  buildClientQuoteSelectionResult,
  buildVendorLabelMap,
  getSelectedOption,
  revertBulkPresetSelection,
  sortQuoteOptionsForPreset,
  summarizeSelectedQuoteOptions,
  summarizeQuoteDiagnostics,
  type BulkSelectionChange,
  type ClientQuoteSelectionOption,
  type QuotePreset,
} from "@/features/quotes/selection";
import { logQuoteFetchDiagnostics } from "@/features/quotes/quote-chart-diagnostics";
import type {
  ClientPartRequestUpdateInput,
  ClientQuoteWorkspaceItem,
  QuoteDataStatus,
  QuoteDiagnostics,
} from "@/features/quotes/types";
import { buildProjectNameFromLabels, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { readExcludedVendorKeys, toggleExcludedVendorKey } from "@/features/quotes/vendor-exclusions";
import { useWorkspaceNavigationModel } from "@/features/quotes/use-workspace-navigation-model";
import {
  prefetchPartPage,
  prefetchProjectPage,
  stableJobIds,
  workspaceQueryKeys,
} from "@/features/quotes/workspace-navigation";
import {
  buildRequirementDraft,
} from "@/features/quotes/utils";
import type { ActivityLogEntry } from "@/components/quotes/ActivityLog";
import type { VendorName } from "@/integrations/supabase/types";

const EMPTY_QUOTE_DIAGNOSTICS: QuoteDiagnostics = {
  rawQuoteRowCount: 0,
  rawOfferCount: 0,
  plottableOfferCount: 0,
  excludedOfferCount: 0,
  excludedOffers: [],
  excludedReasonCounts: [],
};

export type JobFilter = "all" | "needs_attention" | "quoting" | "published";

export const clientFilterOptions: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All parts" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "quoting", label: "Quoting" },
  { id: "published", label: "Published" },
];

function workspaceItemsNeedExtractionPolling(items: ClientQuoteWorkspaceItem[] | undefined) {
  return (items ?? []).some((item) => {
    const lifecycle = item.part?.clientExtraction?.lifecycle ?? null;
    return lifecycle === "queued" || lifecycle === "extracting" || lifecycle === "uploaded";
  });
}

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

export function useClientProjectController() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut, isAuthInitializing } = useAppSession();
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showDissolve, setShowDissolve] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedOfferOverrides, setSelectedOfferOverrides] = useState<Record<string, string | null>>({});
  const [lastBulkAction, setLastBulkAction] = useState<BulkSelectionChange[]>([]);
  const [activePreset, setActivePreset] = useState<QuotePreset | null>(null);
  const [projectDueByDate, setProjectDueByDate] = useState<string | null>(null);
  const [excludedVendorKeysByJobId, setExcludedVendorKeysByJobId] = useState<Record<string, VendorName[]>>({});
  const [requestDraftsByJobId, setRequestDraftsByJobId] = useState<Record<string, ClientPartRequestUpdateInput>>({});
  const [quoteQuantityInputsByJobId, setQuoteQuantityInputsByJobId] = useState<Record<string, string>>({});
  const isRequestProjectQuotesLockedRef = useRef(false);
  const isCancelQuoteRequestLockedRef = useRef(false);
  const isMobile = useIsMobile();
  const registerArchiveUndo = useArchiveUndo();
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const focusedJobSearchParam = searchParams.get("part");

  const setFocusedProjectPart = (jobId: string | null) => {
    const nextSearchParams = new URLSearchParams(searchParams);

    if (jobId) {
      nextSearchParams.set("part", jobId);
    } else {
      nextSearchParams.delete("part");
    }

    setSearchParams(nextSearchParams, { replace: true });
  };

  useEffect(() => {
    if (!focusedJobId) {
      setMobileDrawerOpen(false);
      return;
    }

    setMobileDrawerOpen(isMobile);
  }, [focusedJobId, isMobile]);

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
    enabled: Boolean(user),
    userId: user?.id,
    projectCollaborationUnavailable,
  });
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
  const canLoadRemoteProjectData =
    Boolean(user) && !projectCollaborationUnavailable;
  const projectQuery = useQuery({
    queryKey: workspaceQueryKeys.project(projectId),
    queryFn: () => fetchProject(projectId),
    enabled: canLoadRemoteProjectData,
    ...workspaceDetailQueryOptions,
  });
  const projectJobsQuery = useQuery({
    queryKey: workspaceQueryKeys.projectJobs(projectId),
    queryFn: () => fetchJobsByProject(projectId),
    enabled: canLoadRemoteProjectData,
    ...workspaceDetailQueryOptions,
  });
  const projectMembershipsQuery = useQuery({
    queryKey: ["project-memberships", projectId],
    queryFn: () => fetchProjectMemberships(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });
  const projectAssigneesQuery = useQuery({
    queryKey: workspaceQueryKeys.projectAssignees(projectId),
    queryFn: () => fetchProjectAssigneeProfiles(projectId),
    enabled: canLoadRemoteProjectData,
    ...workspaceDetailQueryOptions,
  });
  const projectInvitesQuery = useQuery({
    queryKey: ["project-invites", projectId],
    queryFn: () => fetchProjectInvites(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });
  const projectJobs = useMemo(() => projectJobsQuery.data ?? [], [projectJobsQuery.data]);
  const projectAssigneesByUserId = useMemo(
    () =>
      projectAssigneesQuery.isSuccess
        ? new Map(projectAssigneesQuery.data.map((profile) => [profile.userId, profile]))
        : null,
    [projectAssigneesQuery.data, projectAssigneesQuery.isSuccess],
  );
  const projectJobMembershipsByCompositeKey = useMemo(
    () =>
      projectJobMembershipsQuery.isSuccess
        ? new Map(
            projectJobMembershipsQuery.data.map((membership) => [
              `${membership.project_id}:${membership.job_id}`,
              membership,
            ]),
          )
        : null,
    [projectJobMembershipsQuery.data, projectJobMembershipsQuery.isSuccess],
  );
  const projectAssigneeLookupReady =
    projectAssigneesQuery.isSuccess && projectJobMembershipsQuery.isSuccess;
  const projectAssigneeLookupFailed =
    projectAssigneesQuery.isError || projectJobMembershipsQuery.isError;
  const projectJobIds = useMemo(() => stableJobIds(projectJobs.map((job) => job.id)), [projectJobs]);
  const projectWorkspaceItemsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientQuoteWorkspace(projectJobIds),
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(projectJobIds),
    enabled: Boolean(user) && projectJobIds.length > 0,
    refetchInterval: (query) =>
      workspaceItemsNeedExtractionPolling(query.state.data as ClientQuoteWorkspaceItem[] | undefined)
        ? 5000
        : false,
    ...workspaceDetailQueryOptions,
  });
  const projectActivityQuery = useQuery({
    queryKey: workspaceQueryKeys.clientActivity(projectJobIds),
    queryFn: () => fetchClientActivityEventsByJobIds(projectJobIds),
    enabled: Boolean(user) && projectJobIds.length > 0,
    refetchInterval: () =>
      workspaceItemsNeedExtractionPolling(projectWorkspaceItemsQuery.data) ? 5000 : false,
    ...workspaceDetailQueryOptions,
  });
  const workspaceItemsByJobId = useMemo(
    () => new Map((projectWorkspaceItemsQuery.data ?? []).map((item) => [item.job.id, item])),
    [projectWorkspaceItemsQuery.data],
  );
  const activityEventsByJobId = useMemo(
    () => groupClientActivityEventsByJobId(projectActivityQuery.data ?? []),
    [projectActivityQuery.data],
  );
  const currentSelectedOfferIdsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobs.map((job) => [
          job.id,
          selectedOfferOverrides[job.id] ?? job.selected_vendor_quote_offer_id ?? null,
        ]),
      ),
    [projectJobs, selectedOfferOverrides],
  );
  const quoteSelectionResultsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobIds.map((jobId) => {
          const workspaceItem = workspaceItemsByJobId.get(jobId);

          if (!workspaceItem?.part) {
            return [
              jobId,
              {
                options: [] as ClientQuoteSelectionOption[],
                diagnostics: workspaceItem?.quoteDiagnostics ?? EMPTY_QUOTE_DIAGNOSTICS,
              },
            ];
          }

          const requestedByDate =
            requestDraftsByJobId[jobId]?.requestedByDate ??
            workspaceItem.summary?.requestedByDate ??
            workspaceItem.job.requested_by_date ??
            projectDueByDate ??
            null;
          const vendorLabels = buildVendorLabelMap(
            workspaceItem.part.vendorQuotes.map((quote) => quote.vendor),
          );
          const selectionResult = buildClientQuoteSelectionResult({
            vendorQuotes: workspaceItem.part.vendorQuotes,
            requestedByDate,
            excludedVendorKeys: excludedVendorKeysByJobId[jobId] ?? [],
            vendorLabels,
          });

          return [
            jobId,
            {
              ...selectionResult,
              options: sortQuoteOptionsForPreset(
                selectionResult.options,
                "cheapest",
              ),
            },
          ];
        }),
      ) as Record<
        string,
        {
          options: ClientQuoteSelectionOption[];
          diagnostics: QuoteDiagnostics;
        }
      >,
    [excludedVendorKeysByJobId, projectDueByDate, projectJobIds, requestDraftsByJobId, workspaceItemsByJobId],
  );
  const optionsByJobId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(quoteSelectionResultsByJobId).map(([jobId, result]) => [jobId, result.options]),
      ) as Record<string, ClientQuoteSelectionOption[]>,
    [quoteSelectionResultsByJobId],
  );
  const quoteDiagnosticsByJobId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(quoteSelectionResultsByJobId).map(([jobId, result]) => [jobId, result.diagnostics]),
      ) as Record<string, QuoteDiagnostics>,
    [quoteSelectionResultsByJobId],
  );
  const selectedOptionsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobIds.map((jobId) => [
          jobId,
          getSelectedOption(optionsByJobId[jobId] ?? [], currentSelectedOfferIdsByJobId[jobId]),
        ]),
      ) as Record<string, ClientQuoteSelectionOption | null>,
    [currentSelectedOfferIdsByJobId, optionsByJobId, projectJobIds],
  );
  const projectSelectionSummary = useMemo(
    () => summarizeSelectedQuoteOptions(projectJobIds.map((jobId) => selectedOptionsByJobId[jobId])),
    [projectJobIds, selectedOptionsByJobId],
  );
  const filteredJobs = useMemo(
    () => projectJobs.filter((job) => matchesJobFilter(job.status, activeFilter)),
    [activeFilter, projectJobs],
  );
  const focusedJob = useMemo(
    () => filteredJobs.find((job) => job.id === focusedJobId) ?? null,
    [filteredJobs, focusedJobId],
  );
  const focusedWorkspaceItem = focusedJob ? workspaceItemsByJobId.get(focusedJob.id) ?? null : null;
  const focusedVendorPreferenceQuery = useQuery({
    queryKey: ["job-vendor-preferences", focusedJobId],
    queryFn: async () => {
      if (!focusedJobId) {
        throw new Error("Select a part before loading vendor preferences.");
      }

      return fetchJobVendorPreferenceContext(focusedJobId);
    },
    enabled: Boolean(focusedJobId),
    ...workspaceDetailQueryOptions,
  });
  const focusedVendorPreferencesErrorMessage =
    focusedVendorPreferenceQuery.error instanceof Error
      ? focusedVendorPreferenceQuery.error.message
      : focusedVendorPreferenceQuery.error
        ? "Failed to load vendor preference controls."
        : null;
  const focusedSummary =
    focusedWorkspaceItem?.summary ?? (focusedJob ? summariesByJobId.get(focusedJob.id) ?? null : null);
  const focusedSelectedOption = focusedJob ? selectedOptionsByJobId[focusedJob.id] ?? null : null;
  const focusedQuoteOptions = focusedJob ? optionsByJobId[focusedJob.id] ?? [] : [];
  const focusedQuoteDiagnostics = focusedJob
    ? quoteDiagnosticsByJobId[focusedJob.id] ?? focusedWorkspaceItem?.quoteDiagnostics ?? EMPTY_QUOTE_DIAGNOSTICS
    : EMPTY_QUOTE_DIAGNOSTICS;
  const focusedQuoteDataStatus: QuoteDataStatus =
    focusedWorkspaceItem?.quoteDataStatus === "schema_unavailable"
      ? "schema_unavailable"
      : focusedWorkspaceItem?.quoteDataStatus === "invalid_for_plotting" ||
          (focusedQuoteDiagnostics.rawQuoteRowCount > 0 &&
            focusedQuoteOptions.length === 0 &&
            focusedQuoteDiagnostics.excludedOfferCount > 0)
        ? "invalid_for_plotting"
        : "available";
  const focusedQuoteDataMessage =
    focusedQuoteDataStatus === "schema_unavailable"
      ? focusedWorkspaceItem?.quoteDataMessage ?? null
      : focusedQuoteDataStatus === "invalid_for_plotting"
        ? summarizeQuoteDiagnostics(focusedQuoteDiagnostics)
        : null;
  const sharedRequestSummary = useMemo(
    () => getSharedRequestMetadata(projectJobs.map((job) => summariesByJobId.get(job.id) ?? null)),
    [projectJobs, summariesByJobId],
  );
  const projectSummary =
    accessibleProjectsQuery.data?.find((project) => project.project.id === projectId) ?? null;
  const projectPartCount = projectSummary?.partCount ?? projectJobs.length;
  const canRenameProject = ["owner", "editor"].includes(projectSummary?.currentUserRole ?? "editor");
  const canManageMembers = (projectSummary?.currentUserRole ?? "editor") === "owner";
  const canDissolveProject = canManageMembers;
  const focusedDraft = focusedJob ? requestDraftsByJobId[focusedJob.id] ?? null : null;
  const focusedRequestedByDate =
    focusedJob && focusedWorkspaceItem
      ? requestDraftsByJobId[focusedJob.id]?.requestedByDate ??
        focusedWorkspaceItem.summary?.requestedByDate ??
        focusedWorkspaceItem.job.requested_by_date ??
        projectDueByDate ??
        null
      : focusedJob
        ? requestDraftsByJobId[focusedJob.id]?.requestedByDate ??
          focusedSummary?.requestedByDate ??
          focusedJob.requested_by_date ??
          projectDueByDate ??
          null
        : null;
  const focusedQuoteQuantityInput = focusedJob ? quoteQuantityInputsByJobId[focusedJob.id] ?? "" : "";
  const focusedActivityEntries = useMemo<ActivityLogEntry[]>(() => {
    if (!focusedJob) {
      return [];
    }

    return buildActivityLogEntries(activityEventsByJobId.get(focusedJob.id) ?? []);
  }, [activityEventsByJobId, focusedJob]);

  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const result = await createJobsFromUploadFiles({
        files,
        projectId,
      });

      await invalidateClientWorkspaceQueries(queryClient, { projectId });

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });

  const attachFilesPicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      if (!focusedJobId) {
        throw new Error("Select a line item before uploading a revision.");
      }

      const workspaceItem = workspaceItemsByJobId.get(focusedJobId) ?? null;
      const normalizedStem = workspaceItem?.part?.normalized_key;

      if (!normalizedStem) {
        throw new Error("This line item is not ready for attachments yet.");
      }

      const invalid = files.find((file) => normalizeUploadStem(file.name) !== normalizedStem);

      if (invalid) {
        throw new Error(`"${invalid.name}" does not match this line item's filename stem.`);
      }

      const uploadSummary = await uploadFilesToJob(focusedJobId, files);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await reconcileJobParts(focusedJobId);
        await requestExtraction(focusedJobId);
      }

      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        toast.success("Files attached to line item.");
      }
    },
  });

  const updateProjectMutation = useMutation({
    mutationFn: (name: string) => updateProject({ projectId, name }),
    onSuccess: async () => {
      toast.success("Project updated.");
      setShowRename(false);
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update project.");
    },
  });

  const archiveProjectMutation = useMutation({
    mutationFn: () => archiveProject(projectId),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(projectId);
          await invalidateClientWorkspaceQueries(queryClient, { projectId });
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
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
      await invalidateClientWorkspaceQueries(queryClient, { projectId });
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
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        includeProjectMemberships: true,
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member.");
    },
  });

  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });
      toast.success("Line item updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update line item.");
    },
  });
  const saveProjectVendorPreferencesMutation = useMutation({
    mutationFn: (input: { jobId: string; includedVendors: VendorName[]; excludedVendors: VendorName[] }) =>
      setProjectVendorPreferences({
        projectId,
        includedVendors: input.includedVendors,
        excludedVendors: input.excludedVendors,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["job-vendor-preferences"],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to save project vendor preferences.");
    },
  });
  const saveJobVendorPreferencesMutation = useMutation({
    mutationFn: (input: { jobId: string; includedVendors: VendorName[]; excludedVendors: VendorName[] }) =>
      setJobVendorPreferences({
        jobId: input.jobId,
        includedVendors: input.includedVendors,
        excludedVendors: input.excludedVendors,
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ["job-vendor-preferences", variables.jobId],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to save part vendor preferences.");
    },
  });

  const requestProjectQuotesMutation = useMutation({
    mutationFn: ({ jobIds, forceRetry = false }: { jobIds: string[]; forceRetry?: boolean }) =>
      requestQuotes(jobIds, forceRetry),
    onSuccess: async (results, variables) => {
      const jobIds = variables.jobIds;
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds.length > 0 ? projectJobIds : jobIds,
      });

      const acceptedCount = results.filter((result) => result.accepted).length;
      const createdCount = results.filter((result) => result.created).length;
      const blockedCount = results.length - acceptedCount;

      if (acceptedCount === 0) {
        toast.error(results[0]?.reason || "No quote requests could be started.");
        return;
      }

      if (createdCount === 0) {
        toast.success(
          `Quote request${acceptedCount === 1 ? " is" : "s are"} already in progress for ${acceptedCount} part${acceptedCount === 1 ? "" : "s"}.`,
        );
        return;
      }

      if (blockedCount > 0) {
        toast.success(
          `Queued ${createdCount} quote request${createdCount === 1 ? "" : "s"} and skipped ${blockedCount} part${blockedCount === 1 ? "" : "s"}.`,
        );
        return;
      }

      toast.success(
        `Queued ${createdCount} quote request${createdCount === 1 ? "" : "s"} for this project.`,
      );
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to request project quotes.");
    },
  });

  const cancelQuoteRequestMutation = useMutation({
    mutationFn: (requestId: string) => cancelQuoteRequest(requestId),
    onSuccess: async (result) => {
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });

      if (!result.accepted) {
        toast.error(result.reason || "Quote request could not be canceled.");
        return;
      }

      toast.success("Quote request canceled.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to cancel quote request.");
    },
  });

  const resolveSidebarProjectIdsForJob = (job: {
    id: string;
    project_id: string | null;
    source: string;
  }) => {
    return resolveWorkspaceProjectIdsForJob({
      job,
      sidebarProjectIdsByJobId,
    });
  };

  useWarmClientWorkspaceNavigation({
    enabled: Boolean(user),
    canPrefetchProjects: !projectCollaborationUnavailable,
    projects: sidebarProjects,
    jobs: navigationModel.parts,
    pinnedProjectIds: sidebarPinsQuery.data?.projectIds ?? [],
    pinnedJobIds: sidebarPinsQuery.data?.jobIds ?? [],
    resolveProjectIdsForJob: (job) => resolveSidebarProjectIdsForJob(job),
    activeProjectId: projectId,
  });

  useEffect(() => {
    logQuoteFetchDiagnostics({
      partId: focusedWorkspaceItem?.part?.id ?? null,
      organizationId: focusedWorkspaceItem?.job.organization_id ?? null,
      quoteDataStatus: focusedQuoteDataStatus,
      quoteDataMessage: focusedQuoteDataMessage,
      rawQuoteRows: focusedWorkspaceItem?.part?.vendorQuotes ?? [],
      diagnostics: focusedQuoteDiagnostics,
    });
  }, [
    focusedQuoteDataMessage,
    focusedQuoteDataStatus,
    focusedQuoteDiagnostics,
    focusedWorkspaceItem?.job.organization_id,
    focusedWorkspaceItem?.part?.id,
    focusedWorkspaceItem?.part?.vendorQuotes,
  ]);

  useEffect(() => {
    if (filteredJobs.length === 0) {
      setFocusedJobId(null);
      return;
    }

    if (focusedJobId && !filteredJobs.some((job) => job.id === focusedJobId)) {
      setFocusedJobId(null);
    }
  }, [filteredJobs, focusedJobId]);

  useEffect(() => {
    if (!focusedJobSearchParam) {
      return;
    }

    if (!projectJobs.some((job) => job.id === focusedJobSearchParam)) {
      return;
    }

    setFocusedJobId((current) => (current === focusedJobSearchParam ? current : focusedJobSearchParam));
    setIsInspectorOpen(true);
    setMobileDrawerOpen(isMobile);
  }, [focusedJobSearchParam, isMobile, projectJobs]);

  useEffect(() => {
    if (!focusedJobId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      setFocusedJobId(null);
      setMobileDrawerOpen(false);
      setIsInspectorOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [focusedJobId]);

  useEffect(() => {
    if ((projectWorkspaceItemsQuery.data ?? []).length === 0) {
      return;
    }

    setExcludedVendorKeysByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        next[item.job.id] = readExcludedVendorKeys(item.job.id);
      });

      return next;
    });

    setRequestDraftsByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        if (!item.part) {
          return;
        }

        const requirement = buildRequirementDraft(item.part, {
          requested_service_kinds: item.job.requested_service_kinds ?? [],
          primary_service_kind: item.job.primary_service_kind ?? null,
          service_notes: item.job.service_notes ?? null,
          requested_quote_quantities: item.job.requested_quote_quantities ?? [],
          requested_by_date: item.job.requested_by_date ?? null,
        });

        next[item.job.id] = buildClientPartRequestUpdateInput(item.job.id, requirement);
      });

      return next;
    });

    setQuoteQuantityInputsByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        if (!item.part) {
          return;
        }

        const requirement = buildRequirementDraft(item.part, {
          requested_service_kinds: item.job.requested_service_kinds ?? [],
          primary_service_kind: item.job.primary_service_kind ?? null,
          service_notes: item.job.service_notes ?? null,
          requested_quote_quantities: item.job.requested_quote_quantities ?? [],
          requested_by_date: item.job.requested_by_date ?? null,
        });

        next[item.job.id] = formatRequestedQuoteQuantitiesInput(requirement.quoteQuantities);
      });

      return next;
    });
  }, [projectWorkspaceItemsQuery.data]);

  useEffect(() => {
    if (projectQuery.data) {
      setProjectName(projectQuery.data.name);
    }
  }, [projectQuery.data]);

  useEffect(() => {
    if (isAuthInitializing || user) {
      return;
    }

    recordWorkspaceSessionDiagnostic(
      "warn",
      "client-project.redirect.unauthenticated",
      "Redirecting to sign-in after startup auth resolution completed without a user.",
      {
        projectId,
      },
    );
    navigate("/?auth=signin", { replace: true });
  }, [isAuthInitializing, navigate, projectId, user]);

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

  const handleAssignPartToProject = async (jobId: string, targetProjectId: string) => {
    try {
      await assignJobToProject({ jobId, projectId: targetProjectId });
      await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId, jobId });
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (jobId: string, targetProjectId: string) => {
    try {
      await removeJobFromProject(jobId, targetProjectId);
      await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId, jobId });
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
      await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId });
      toast.success("Project updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project.");
      throw error;
    }
  };

  const handleArchivePart = async (targetJobId: string) => {
    try {
      await archiveJob(targetJobId);
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId, projectId });
      registerArchiveUndo({
        label: "Part",
        undo: async () => {
          await unarchiveJob(targetJobId);
          await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId, projectId });
        },
      });
      toast.success("Part archived. Press Ctrl+Z to undo.");
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
      await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId });
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(targetProjectId);
          await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId });
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
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
      await invalidateClientWorkspaceQueries(queryClient, { jobId: targetJobId, projectId });
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
        projectId,
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

  const handleDissolveProject = async (targetProjectId: string) => {
    try {
      await dissolveProject(targetProjectId);
      await invalidateClientWorkspaceQueries(queryClient, { projectId: targetProjectId });
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
        jobIds.map((selectedJobId) =>
          assignJobToProject({ jobId: selectedJobId, projectId: nextProjectId }),
        ),
      );
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId: nextProjectId,
        clientQuoteWorkspaceJobIds: jobIds,
      });
      toast.success("Project created.");
      navigate(`/projects/${nextProjectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
      throw error;
    }
  };

  const handleOpenJobDrawer = (jobId: string) => {
    setFocusedJobId(jobId);
    setMobileDrawerOpen(isMobile);
    setIsInspectorOpen(true);
    setFocusedProjectPart(jobId);
  };

  const handleClearFocusedJob = () => {
    setFocusedJobId(null);
    setMobileDrawerOpen(false);
    setIsInspectorOpen(true);
    setFocusedProjectPart(null);
  };

  const handleToggleInspector = () => {
    setIsInspectorOpen((current) => !current);
  };

  const handleToggleVendorExclusion = (
    jobId: string,
    vendorKey: VendorName,
    shouldExclude: boolean,
  ) => {
    setExcludedVendorKeysByJobId((current) => ({
      ...current,
      [jobId]: toggleExcludedVendorKey(jobId, vendorKey, shouldExclude),
    }));
  };

  const handleSelectQuoteOption = async (jobId: string, option: ClientQuoteSelectionOption) => {
    if (!option.persistedOfferId) {
      toast.error("This quote option is not ready to select yet.");
      return;
    }

    const previousOfferId = currentSelectedOfferIdsByJobId[jobId] ?? null;

    setSelectedOfferOverrides((current) => ({
      ...current,
      [jobId]: option.persistedOfferId,
    }));

    try {
      await setJobSelectedVendorQuoteOffer(jobId, option.persistedOfferId);
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });
    } catch (error) {
      setSelectedOfferOverrides((current) => ({
        ...current,
        [jobId]: previousOfferId,
      }));
      toast.error(error instanceof Error ? error.message : "Failed to update selected quote.");
    }
  };

  const handleRevertBulk = async () => {
    if (lastBulkAction.length === 0) {
      return;
    }

    const result = revertBulkPresetSelection({
      currentSelectedOfferIdsByJobId,
      lastBulkAction,
    });

    if (result.restoredJobIds.length === 0) {
      toast.error("Nothing could be restored from the last bulk action.");
      return;
    }

    setSelectedOfferOverrides((current) => ({
      ...current,
      ...Object.fromEntries(
        result.restoredJobIds.map((jobId) => [
          jobId,
          result.nextSelectedOfferIdsByJobId[jobId] ?? null,
        ]),
      ),
    }));

    try {
      await Promise.all(
        result.restoredJobIds.map((jobId) =>
          setJobSelectedVendorQuoteOffer(jobId, result.nextSelectedOfferIdsByJobId[jobId] ?? null),
        ),
      );
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });
      setLastBulkAction([]);
      setActivePreset(null);
      toast.success("Bulk selection reverted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revert bulk selection.");
    }
  };

  const handleBulkPreset = async (preset: QuotePreset) => {
    if (activePreset === preset && lastBulkAction.length > 0) {
      await handleRevertBulk();
      return;
    }

    const result = applyBulkPresetSelection({
      optionsByJobId,
      currentSelectedOfferIdsByJobId,
      preset,
    });

    if (result.changes.length === 0) {
      toast.error(
        result.unavailableJobIds.length > 0
          ? "No eligible project quotes were available for that preset."
          : "Selections already match this preset.",
      );
      return;
    }

    setSelectedOfferOverrides((current) => ({
      ...current,
      ...Object.fromEntries(result.changes.map((change) => [change.jobId, change.appliedOfferId])),
    }));
    setLastBulkAction(result.changes);
    setActivePreset(preset);

    const presetLabel =
      preset === "cheapest" ? "Cheapest"
      : preset === "fastest" ? "Fastest"
      : preset === "domestic" ? "Domestic"
      : preset === "cheapest_domestic" ? "Cheapest domestic"
      : preset === "fastest_domestic" ? "Fastest domestic"
      : preset === "cheapest_global" ? "Cheapest global"
      : preset === "fastest_global" ? "Fastest global"
      : preset;

    try {
      await Promise.all(
        result.changes.map((change) =>
          setJobSelectedVendorQuoteOffer(change.jobId, change.appliedOfferId),
        ),
      );
      await invalidateClientWorkspaceQueries(queryClient, {
        projectId,
        clientQuoteWorkspaceJobIds: projectJobIds,
      });
      toast.success(
        `${presetLabel} preset applied to ${result.changes.length} part${result.changes.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setSelectedOfferOverrides((current) => ({
        ...current,
        ...Object.fromEntries(result.changes.map((change) => [change.jobId, change.previousOfferId])),
      }));
      setActivePreset(null);
      toast.error(error instanceof Error ? error.message : "Bulk preset failed.");
    }
  };

  const handleRequestDraftChange = (
    jobId: string,
    next: Partial<ClientPartRequestUpdateInput>,
  ) => {
    setRequestDraftsByJobId((current) => {
      const existing = current[jobId];

      if (!existing) {
        return current;
      }

      return {
        ...current,
        [jobId]: {
          ...existing,
          ...next,
        },
      };
    });
  };

  const handleQuoteQuantityInputChange = (jobId: string, value: string) => {
    setQuoteQuantityInputsByJobId((current) => ({
      ...current,
      [jobId]: value,
    }));
  };

  const handleSaveRequest = (jobId: string) => {
    const draft = requestDraftsByJobId[jobId];

    if (!draft) {
      return;
    }

    const requestedQuoteQuantities = parseRequestedQuoteQuantitiesInput(
      quoteQuantityInputsByJobId[jobId] ?? "",
      draft.quantity,
    );
    const nextDraft = {
      ...draft,
      requestedQuoteQuantities,
    } satisfies ClientPartRequestUpdateInput;

    setRequestDraftsByJobId((current) => ({
      ...current,
      [jobId]: nextDraft,
    }));
    setQuoteQuantityInputsByJobId((current) => ({
      ...current,
      [jobId]: formatRequestedQuoteQuantitiesInput(requestedQuoteQuantities),
    }));
    saveRequestMutation.mutate(nextDraft);
  };

  const handleAddPartSubmit = async (input: {
    prompt: string;
    files: File[];
    clear: () => void;
  }) => {
    const result =
      input.files.length > 0
        ? await createJobsFromUploadFiles({
            files: input.files,
            prompt: input.prompt,
            projectId,
          })
        : {
            projectId,
            jobIds: [
              await (() => {
                const requestIntake = parseRequestIntake(input.prompt);
                return createClientDraft({
                  title: input.prompt.trim().split("\n")[0].slice(0, 120) || "Untitled part",
                  description: input.prompt.trim() || undefined,
                  projectId,
                  requestedServiceKinds: requestIntake.requestedServiceKinds,
                  primaryServiceKind: requestIntake.primaryServiceKind,
                  serviceNotes: requestIntake.serviceNotes,
                  requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
                  requestedByDate: requestIntake.requestedByDate,
                });
              })(),
            ],
          };

    input.clear();
    setShowAddPart(false);
    await invalidateClientWorkspaceQueries(queryClient, { projectId });

    if (result.projectId && result.jobIds.length > 1) {
      navigate(`/projects/${result.projectId}`);
      return;
    }

    navigate(`/parts/${result.jobIds[0]}`);
  };

  const handleInviteProjectMember = async (email: string) => {
    const invite = await inviteProjectMember({ projectId, email });
    toast.success(`Invite created for ${invite.email}.`);
    await invalidateClientWorkspaceQueries(queryClient, {
      projectId,
      includeProjectInvites: true,
    });
  };

  const handleRemoveProjectMember = async (membershipId: string) => {
    await removeProjectMemberMutation.mutateAsync(membershipId);
  };

  const prefetchProject = (nextProjectId: string) => {
    void prefetchProjectPage(queryClient, nextProjectId, {
      enabled: !projectCollaborationUnavailable,
    });
  };

  const prefetchPart = (jobId: string) => {
    void prefetchPartPage(queryClient, jobId);
  };

  const handleRequestProjectQuotes = async (jobIds: string[], forceRetry = false) => {
    if (isRequestProjectQuotesLockedRef.current || requestProjectQuotesMutation.isPending) {
      return;
    }

    if (jobIds.length === 0) {
      toast.error("No project parts are ready to request quotes.");
      return;
    }

    isRequestProjectQuotesLockedRef.current = true;

    try {
      await requestProjectQuotesMutation.mutateAsync({ jobIds, forceRetry });
    } catch {
      return;
    } finally {
      isRequestProjectQuotesLockedRef.current = false;
    }
  };

  const handleSetProjectVendorPreferences = async (input: {
    jobId: string;
    includedVendors: VendorName[];
    excludedVendors: VendorName[];
  }) => {
    await saveProjectVendorPreferencesMutation.mutateAsync(input);
  };

  const handleSetJobVendorPreferences = async (input: {
    jobId: string;
    includedVendors: VendorName[];
    excludedVendors: VendorName[];
  }) => {
    await saveJobVendorPreferencesMutation.mutateAsync(input);
  };

  const handleCancelQuoteRequest = async (requestId: string) => {
    if (isCancelQuoteRequestLockedRef.current || cancelQuoteRequestMutation.isPending) {
      return;
    }

    isCancelQuoteRequestLockedRef.current = true;

    try {
      await cancelQuoteRequestMutation.mutateAsync(requestId);
    } catch {
      return;
    } finally {
      isCancelQuoteRequestLockedRef.current = false;
    }
  };
  const sidebarJobs = navigationModel.parts;

  return {
    accessibleJobs: sidebarJobs,
    accessibleJobsQuery,
    activeFilter,
    activePreset,
    activeMembership,
    archivedJobsQuery,
    archivedProjectsQuery,
    archiveProjectMutation,
    attachFilesPicker,
    canDissolveProject,
    canManageMembers,
    canRenameProject,
    filteredJobs,
    focusedActivityEntries,
    focusedDraft,
    focusedJob,
    focusedJobId,
    focusedQuoteDataMessage,
    focusedQuoteDataStatus,
    focusedQuoteDiagnostics,
    focusedQuoteOptions,
    focusedQuoteQuantityInput,
    focusedRequestedByDate,
    focusedSelectedOption,
    focusedSummary,
    focusedVendorPreferences: focusedVendorPreferenceQuery.data ?? null,
    focusedVendorPreferencesErrorMessage,
    focusedWorkspaceItem,
    handleClearFocusedJob,
    handleAddPartSubmit,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCancelQuoteRequest,
    handleBulkPreset,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleInviteProjectMember,
    handleOpenJobDrawer,
    handlePinPart,
    handlePinProject,
    handleQuoteQuantityInputChange,
    handleRemovePartFromProject,
    handleRemoveProjectMember,
    handleRenameProject,
    handleRequestProjectQuotes,
    handleSetJobVendorPreferences,
    handleSetProjectVendorPreferences,
    handleRequestDraftChange,
    handleRevertBulk,
    handleSaveRequest,
    handleSelectQuoteOption,
    handleToggleInspector,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isMobile,
    isCancelingQuoteRequest: cancelQuoteRequestMutation.isPending,
    isSavingVendorPreferences:
      saveProjectVendorPreferencesMutation.isPending || saveJobVendorPreferencesMutation.isPending,
    isSearchOpen,
    isVendorPreferenceLoading: focusedVendorPreferenceQuery.isLoading || focusedVendorPreferenceQuery.isFetching,
    lastBulkAction,
    mobileDrawerOpen,
    navigate,
    newJobFilePicker,
    prefetchPart,
    prefetchProject,
    projectCollaborationUnavailable,
    projectDueByDate,
    projectId,
    projectAssigneeLookupFailed,
    projectAssigneeLookupReady,
    projectInvitesQuery,
    projectAssigneesByUserId,
    projectJobs,
    projectJobsQuery,
    projectJobMembershipsByCompositeKey,
    projectMembershipsQuery,
    projectPartCount,
    projectName,
    projectQuery,
    projectSelectionSummary,
    projectWorkspaceItemsQuery,
    requestDraftsByJobId,
    resolveSidebarProjectIdsForJob,
    navigationModel,
    saveRequestMutation,
    optionsByJobId,
    selectedOptionsByJobId,
    requestProjectQuotesMutation,
    cancelQuoteRequestMutation,
    setActiveFilter,
    setIsSearchOpen,
    setMobileDrawerOpen,
    setProjectName,
    setProjectDueByDate,
    setShowAddPart,
    setShowArchive,
    setShowDissolve,
    setShowMembers,
    setShowRename,
    sharedRequestSummary,
    showAddPart,
    showArchive,
    showDissolve,
    showMembers,
    showRename,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    updateProjectMutation,
    dissolveProjectMutation,
    user,
    isAuthInitializing,
    isInspectorOpen,
    workspaceItemsByJobId,
    accessibleProjects,
  };
}
