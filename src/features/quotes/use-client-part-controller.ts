import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAppSession } from "@/hooks/use-app-session";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";
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
import {
  cancelQuoteRequest,
  getProviderDispatchScope,
  getQuoteLaneEligibility,
  getXometryBetaDispatchScope,
  persistClientQuoteSelection,
  requestProviderDispatch,
  requestXometryBetaDispatch,
  setJobSelectedVendorQuoteOffer,
} from "@/features/quotes/api/quote-requests-api";
import type {
  XometryBetaDispatchFailure,
  XometryBetaDispatchResult,
  XometryBetaModelUnits,
} from "@/features/quotes/xometry-beta-dispatch";
import { getConfiguredLiveDispatchProvider } from "@/features/quotes/live-dispatch-provider";
import {
  getConfiguredMultiProviderFanoutEnabled,
  getFanoutDenialSkipReason,
  isDispatchScopeChangeDenial,
} from "@/features/quotes/provider-fanout";
import { useProviderFanout } from "@/features/quotes/use-provider-fanout";
import { getXometryFanoutVendors } from "@/features/quotes/provider-fanout-dispatch";
import {
  LIVE_DISPATCH_PROVIDER_LABELS,
  classifyXometryBetaDispatchFailure,
  getXometryBetaDispatchDenialMessage,
  getXometryBetaScopeDenialCode,
  getXometryBetaScopeFailureMessage,
  isExplicitXometryBetaDispatchDenial,
} from "@/features/quotes/xometry-beta-dispatch";
import {
  fetchJobVendorPreferenceContext,
  resolveEffectiveJobVendorSelection,
} from "@/features/quotes/api/vendor-preferences-api";
import { useQuantityScope } from "@/features/quotes/quantity-scope";
import { useQuoteAccess } from "@/features/quotes/quote-access";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { uploadFilesToJob } from "@/features/quotes/api/uploads-api";
import { shouldPollClientWorkspaceState } from "@/features/quotes/client-workspace-polling";
import {
  fetchClientActivityEventsByJobIds,
  fetchPartDetailByJobId,
  fetchVendorCapabilityProfiles,
  resolveClientPartDetailRoute,
} from "@/features/quotes/api/workspace-access";
import { updateClientPartRequest, resetClientPartPropertyOverrides } from "@/features/quotes/api/jobs-api";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { buildActivityLogEntries } from "@/features/quotes/activity-log";
import { formatPartLabel, getClientItemPresentation } from "@/features/quotes/client-presentation";
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
  parseRequestedQuoteQuantitiesInput,
  validateRequestedQuoteQuantitiesInput,
  QUOTE_QUANTITIES_FORMAT_ERROR,
} from "@/features/quotes/request-intake";
import { buildClientPartRequestUpdateInput } from "@/features/quotes/rfq-metadata";
import { buildSingleQuantityRequest } from "@/features/quotes/single-quantity";
import {
  buildClientQuoteSelectionResult,
  buildVendorLabelMap,
  resolveStoredQuoteSelection,
  sortQuoteOptionsForPreset,
  summarizeQuoteDiagnostics,
  type ClientQuoteSelectionOption,
  type QuotePreset,
} from "@/features/quotes/selection";
import { logQuoteFetchDiagnostics } from "@/features/quotes/quote-chart-diagnostics";
import {
  buildClientQuoteComparisonOptions,
  buildClientSourcingResult,
} from "@/features/quotes/sourcing-result";
import type {
  ClientPartPropertyOverrideField,
  ClientPartRequestUpdateInput,
  DrawingExtractionData,
  PartAggregate,
  PartDetailAggregate,
  QuoteDataStatus,
  QuoteDiagnostics,
} from "@/features/quotes/types";
import { CLIENT_PART_PROPERTY_OVERRIDE_FIELDS } from "@/features/quotes/types";
import { buildProjectNameFromLabels, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { readExcludedVendorKeys, toggleExcludedVendorKey } from "@/features/quotes/vendor-exclusions";
import { useWorkspaceNavigationModel } from "@/features/quotes/use-workspace-navigation-model";
import {
  createWorkspaceAccessScope,
  prefetchPartPage,
  prefetchProjectPage,
  workspaceQueryKeys,
} from "@/features/quotes/workspace-navigation";
import { resolveStoredFileViewerMode } from "@/lib/file-viewer";
import {
  downloadStoredFileBlob,
  loadStoredDrawingPreviewPages,
  loadStoredPdfObjectUrl,
} from "@/lib/stored-file";
import { getUserFacingErrorMessage } from "@/lib/error-message";
import { isControlledBetaSingleQuantityEnabled } from "@/lib/single-quantity-flag";
import {
  buildRequirementDraft,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import type { DrawingPreviewState } from "@/components/quotes/ClientQuoteAssetPanels";
import type { VendorName } from "@/integrations/supabase/types";

const EMPTY_QUOTE_DIAGNOSTICS: QuoteDiagnostics = {
  rawQuoteRowCount: 0,
  rawOfferCount: 0,
  plottableOfferCount: 0,
  excludedOfferCount: 0,
  excludedOffers: [],
  excludedReasonCounts: [],
};

type PatchDraftPreservation = {
  requestId: number;
  draft: ClientPartRequestUpdateInput;
  patch?: Partial<ClientPartRequestUpdateInput>;
  mutationCompleted?: boolean;
};

type ResetFieldMutationInput = {
  fields: ClientPartPropertyOverrideField[];
  preserveUnresetFields: boolean;
  requestId: number;
  draftSnapshot: ClientPartRequestUpdateInput | null;
};

function getWorkspacePollingInterval(data: PartDetailAggregate | undefined): number | false {
  if (!data) {
    return false;
  }

  const hasCadFile = data.files.some((file) => file.file_kind === "cad");
  return shouldPollClientWorkspaceState({
    extractionLifecycle: data.part?.clientExtraction?.lifecycle,
    quoteRequestStatus: data.latestQuoteRequest?.status,
    quoteRequestMode: data.latestQuoteRequest?.request_mode,
    quoteRequestUpdatedAt: data.latestQuoteRequest?.updated_at,
    hasPersistedOffers: (data.quoteDiagnostics?.rawOfferCount ?? 0) > 0,
    partIsNull: data.part === null,
    hasCadFile,
  })
    ? 5000
    : false;
}

function buildRequestDraftFromPartDetail(
  partDetail: PartDetailAggregate | null | undefined,
  jobId: string,
): ClientPartRequestUpdateInput | null {
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

  return buildClientPartRequestUpdateInput(jobId, requirement);
}

function applyResetFields(
  draft: ClientPartRequestUpdateInput,
  refreshedDraft: ClientPartRequestUpdateInput,
  fields: readonly ClientPartPropertyOverrideField[],
): ClientPartRequestUpdateInput {
  const nextDraft = { ...draft };

  fields.forEach((field) => {
    switch (field) {
      case "description":
        nextDraft.description = refreshedDraft.description;
        break;
      case "partNumber":
        nextDraft.partNumber = refreshedDraft.partNumber;
        break;
      case "revision":
        nextDraft.revision = refreshedDraft.revision;
        break;
      case "material":
        nextDraft.material = refreshedDraft.material;
        break;
      case "finish":
        nextDraft.finish = refreshedDraft.finish;
        break;
      case "tightestToleranceInch":
        nextDraft.tightestToleranceInch = refreshedDraft.tightestToleranceInch;
        break;
      case "threads":
        nextDraft.threads = refreshedDraft.threads;
        break;
      case "process":
        nextDraft.process = refreshedDraft.process;
        break;
    }
  });

  return nextDraft;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The Threads value the request falls back to when its Threads field is cleared:
 * the stored property defaults when present, otherwise the drawing's thread callouts.
 * Mirrors the defaults the part workspace shows beside the Threads field.
 */
function getRequestThreadDefault(
  part: PartAggregate | null,
  extraction: DrawingExtractionData | null,
): string | null {
  const defaults = part?.clientRequirement?.projectPartProperties?.defaults;
  if (defaults && "threads" in defaults) {
    return typeof defaults.threads === "string" ? defaults.threads : null;
  }
  return extraction?.threads?.join(", ") ?? null;
}

/** Threads already stored on the approved request, which the server scope checks read. */
function getSavedRequestThreads(part: PartAggregate | null): string | null {
  const snapshot = part?.approvedRequirement?.spec_snapshot;
  const snapshotThreads =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot.threads : null;
  const clientThreads = part?.clientRequirement?.threads;
  if (hasText(clientThreads)) return clientThreads;
  return hasText(snapshotThreads) ? snapshotThreads : null;
}

function requestDraftIncludesPatch(
  draft: ClientPartRequestUpdateInput,
  patch: Partial<ClientPartRequestUpdateInput>,
): boolean {
  const patchFields = Object.keys(patch) as Array<keyof ClientPartRequestUpdateInput>;

  return patchFields.every(
    (field) => JSON.stringify(draft[field]) === JSON.stringify(patch[field]),
  );
}

/**
 * Loads the access-filtered part workspace and its quote actions.
 * Callers that render their own signed-out gate can suppress the legacy homepage redirect.
 */
export function useClientPartController(
  explicitJobId?: string,
  options: { redirectUnauthenticated?: boolean; warmNavigation?: boolean } = {},
) {
  const { redirectUnauthenticated = true, warmNavigation = true } = options;
  const { jobId: routeJobIdParam = "" } = useParams();
  const routeJobId = explicitJobId ?? routeJobIdParam;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, isPlatformAdmin, signOut, isAuthInitializing, isVerifiedAuth, hasCachedSession } = useAppSession();
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
  // undefined follows the request's own date; a value or null is the user's results filter (OVD-981).
  const [viewRequestedByDate, setViewRequestedByDate] = useState<string | null | undefined>(undefined);
  const [requestDraft, setRequestDraft] = useState<ClientPartRequestUpdateInput | null>(null);
  const [quoteQuantityInput, setQuoteQuantityInput] = useState("");
  const [partRenameValue, setPartRenameValue] = useState("");
  const [isPartOptionsOpen, setIsPartOptionsOpen] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [isRenamingPart, setIsRenamingPart] = useState(false);
  const [isPartPinBusy, setIsPartPinBusy] = useState(false);
  const [isPartArchiveBusy, setIsPartArchiveBusy] = useState(false);
  const [xometryDispatchUnits, setXometryDispatchUnits] =
    useState<XometryBetaModelUnits | null>(null);
  // Fixed per deployment (OVD-673); defaults to the legacy Xometry path.
  const [dispatchProvider] = useState(getConfiguredLiveDispatchProvider);
  const dispatchProviderLabel = LIVE_DISPATCH_PROVIDER_LABELS[dispatchProvider];
  // Off by default: one confirmation then reaches only `dispatchProvider`.
  const [isFanoutEnabled] = useState(getConfiguredMultiProviderFanoutEnabled);
  const isRequestQuoteLockedRef = useRef(false);
  const attemptedQuoteRef = useRef<{
    identity: string;
    input: {
      approvalReference: string;
      declaredModelUnits: XometryBetaModelUnits;
      envelopeRevision?: string;
      policyRevision: string;
      scopeFingerprint: string;
      xometryFanoutVendors?: VendorName[] | null;
    };
    status: "pending" | "unknown";
  } | null>(null);
  const [uncertainQuoteIdentity, setUncertainQuoteIdentity] = useState<string | null>(null);
  const isCancelQuoteRequestLockedRef = useRef(false);
  const patchDraftPreservationRef = useRef<PatchDraftPreservation | null>(null);
  const patchDraftRequestIdRef = useRef(0);
  const requestMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const serializeRequestMutation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const queuedMutation = requestMutationQueueRef.current.then(operation, operation);
    requestMutationQueueRef.current = queuedMutation.then(
      () => undefined,
      () => undefined,
    );
    return queuedMutation;
  };
  const registerArchiveUndo = useArchiveUndo();
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const workspaceAccessScope = createWorkspaceAccessScope({
    userId: user?.id,
    organizationId: activeMembership?.organizationId,
    role: activeMembership?.role,
  });
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
    accessScope: workspaceAccessScope,
    projectCollaborationUnavailable,
  });
  const safeProjectJobMembershipsQuery = projectJobMembershipsQuery ?? {
    isFetching: false,
    isSuccess: projectCollaborationUnavailable || projectJobMemberships.length > 0 || accessibleJobs.length === 0,
  };
  const navigationModel = useWorkspaceNavigationModel({
    accessScope: workspaceAccessScope,
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

  const partRouteQuery = useQuery({
    queryKey: workspaceQueryKeys.partDetailRoute(
      routeJobId,
      workspaceAccessScope,
    ),
    queryFn: () => resolveClientPartDetailRoute(routeJobId),
    enabled: Boolean(user) && Boolean(routeJobId),
    retry: false,
    ...workspaceDetailQueryOptions,
  });
  const resolvedJobId = partRouteQuery.data?.jobId ?? null;
  const partDetailQuery = useQuery({
    queryKey: workspaceQueryKeys.partDetail(
      resolvedJobId ?? "",
      workspaceAccessScope,
    ),
    queryFn: () => fetchPartDetailByJobId(resolvedJobId ?? ""),
    enabled: Boolean(user) && Boolean(resolvedJobId),
    retry: false,
    refetchInterval: (query) => getWorkspacePollingInterval(query.state.data),
    ...workspaceDetailQueryOptions,
  });
  const activityEventsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientActivity(
      resolvedJobId ? [resolvedJobId] : [],
      workspaceAccessScope,
    ),
    queryFn: () => fetchClientActivityEventsByJobIds([resolvedJobId ?? ""]),
    enabled: Boolean(user) && Boolean(resolvedJobId),
    refetchInterval: () => getWorkspacePollingInterval(partDetailQuery.data),
    ...workspaceDetailQueryOptions,
  });
  const vendorCapabilityProfilesQuery = useQuery({
    queryKey: ["vendor-capability-profiles"],
    queryFn: fetchVendorCapabilityProfiles,
    enabled: Boolean(user),
    staleTime: 15 * 60 * 1000,
  });
  const partDetail = partDetailQuery.data;
  const canonicalJobId = resolvedJobId ?? partDetail?.job?.id ?? routeJobId;
  const quoteAccessIdentity =
    user?.id && partDetail?.job?.organization_id && partDetail.job.id === canonicalJobId
      ? { actorUserId: user.id, organizationId: partDetail.job.organization_id, jobId: canonicalJobId }
      : null;
  const quoteCollectionMode = useQuoteAccess(quoteAccessIdentity, isVerifiedAuth === true);
  // OVD-997: with the client flag on, one Quantity field replaces Qty and Quote quantities, and the
  // server decides whether it may exceed 1. Off (default): the editor is unchanged and nothing is read.
  const [singleQuantityFlagOn] = useState(isControlledBetaSingleQuantityEnabled);
  const quantityScope = useQuantityScope(quoteAccessIdentity, isVerifiedAuth === true && singleQuantityFlagOn);
  const singleQuantity = singleQuantityFlagOn
    ? {
        allowAboveOne: quantityScope.status === "multiple_allowed",
        loading: quantityScope.status === "loading",
        unavailable: quantityScope.status === "unavailable",
      }
    : undefined;
  const quoteConfirmationIdentity = `${user?.id ?? ""}:${partDetail?.job.organization_id ?? ""}:${canonicalJobId}`;
  useEffect(() => {
    attemptedQuoteRef.current = null;
    setUncertainQuoteIdentity(null);
  }, [quoteConfirmationIdentity]);
  const vendorPreferenceQuery = useQuery({
    queryKey: ["job-vendor-preferences", canonicalJobId],
    queryFn: () => fetchJobVendorPreferenceContext(canonicalJobId),
    enabled: Boolean(user) && Boolean(canonicalJobId),
    retry: false,
  });
  const selectedQuoteVendors = useMemo(
    () =>
      vendorPreferenceQuery.data
        ? resolveEffectiveJobVendorSelection(vendorPreferenceQuery.data)
        : [],
    [vendorPreferenceQuery.data],
  );
  const availableQuoteVendors = vendorPreferenceQuery.data?.availableVendors ?? [];
  const quoteLaneEligibilityQuery = useQuery({
    queryKey: ["quote-lane-eligibility", canonicalJobId, availableQuoteVendors],
    queryFn: () =>
      getQuoteLaneEligibility(
        canonicalJobId,
        availableQuoteVendors,
      ),
    enabled:
      Boolean(user) &&
      Boolean(canonicalJobId) &&
      Boolean(vendorPreferenceQuery.data) &&
      !vendorPreferenceQuery.isLoading,
    retry: false,
  });
  // With fan out on, a Xometry primary reads its scope with the fan out marker,
  // since the server refuses Xometry beside another enabled provider without it.
  const isXometryFanoutScope = isFanoutEnabled && dispatchProvider === "xometry";
  const xometryScopeFanoutVendors = useMemo(
    () => (isXometryFanoutScope ? getXometryFanoutVendors(selectedQuoteVendors) : null),
    [isXometryFanoutScope, selectedQuoteVendors],
  );
  const xometryDispatchScopeQuery = useQuery({
    queryKey: [
      "xometry-beta-dispatch-scope",
      canonicalJobId,
      user?.id,
      partDetail?.job.organization_id,
      xometryDispatchUnits,
      dispatchProvider,
      xometryScopeFanoutVendors,
    ],
    queryFn: async () => {
      const scope = dispatchProvider === "xometry"
        ? await getXometryBetaDispatchScope(canonicalJobId, xometryDispatchUnits!, xometryScopeFanoutVendors)
        : await getProviderDispatchScope(canonicalJobId, dispatchProvider, xometryDispatchUnits!);
      if (scope.jobId !== canonicalJobId || scope.organizationId !== partDetail?.job.organization_id) {
        throw new TypeError("The confirmation scope identity could not be verified.");
      }
      return scope;
    },
    enabled:
      Boolean(user) &&
      Boolean(canonicalJobId) &&
      quoteCollectionMode.automaticEnabled &&
      xometryDispatchUnits !== null &&
      (!isXometryFanoutScope || Boolean(vendorPreferenceQuery.data)),
    retry: false,
  });
  const providerFanout = useProviderFanout({
    enabled: isFanoutEnabled && quoteCollectionMode.automaticEnabled,
    jobId: canonicalJobId,
    primary: dispatchProvider,
    candidates: selectedQuoteVendors,
    scope: xometryDispatchScopeQuery.data ?? null,
  });
  const isPartDetailLoading =
    partRouteQuery.isLoading || partDetailQuery.isLoading;

  const attachFilesPicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    isVerifiedAuth,
    organizationId: partDetail?.job.organization_id,
    userId: user?.id,
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
    mutationFn: (option: ClientQuoteSelectionOption | null) => {
      if (!option) {
        if (partDetail?.publishedQuoteSelection) {
          throw new Error(
            "Published quote selections cannot be cleared. Select another quote to replace it.",
          );
        }

        return setJobSelectedVendorQuoteOffer(canonicalJobId, null);
      }

      if (!option.persistedOfferId) {
        throw new Error("This quote option is not ready to select yet.");
      }

      return persistClientQuoteSelection({
        jobId: canonicalJobId,
        target: option.selectionTarget ?? {
          kind: "vendor_quote_offer",
          offerId: option.persistedOfferId,
        },
      });
    },
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Selected quote updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update selected quote.");
    },
  });

  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) =>
      serializeRequestMutation(() => updateClientPartRequest(input)),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Request details updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update request details.");
    },
  });

  const resetFieldMutation = useMutation({
    mutationFn: (input: ResetFieldMutationInput) =>
      serializeRequestMutation(async () => {
        try {
          await resetClientPartPropertyOverrides({
            jobId: canonicalJobId,
            fields: input.fields,
          });
          await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });

          const refreshedDetail = queryClient.getQueryData<PartDetailAggregate>(
            workspaceQueryKeys.partDetail(canonicalJobId, workspaceAccessScope),
          );
          const refreshedDraft = buildRequestDraftFromPartDetail(
            refreshedDetail,
            canonicalJobId,
          );

          if (input.preserveUnresetFields && refreshedDraft) {
            const currentPreservation = patchDraftPreservationRef.current;
            const draftToPreserve = currentPreservation?.draft ?? input.draftSnapshot;

            if (draftToPreserve) {
              const reconciledDraft = applyResetFields(
                draftToPreserve,
                refreshedDraft,
                input.fields,
              );
              patchDraftPreservationRef.current = {
                requestId: currentPreservation?.requestId ?? input.requestId,
                draft: reconciledDraft,
              };
              setRequestDraft(reconciledDraft);
              return;
            }
          }

          patchDraftPreservationRef.current = null;
          setRequestDraft(refreshedDraft);
        } catch (error) {
          const currentPreservation = patchDraftPreservationRef.current;
          const draftToRestore = currentPreservation?.draft ?? input.draftSnapshot;
          if (draftToRestore) {
            patchDraftPreservationRef.current = {
              requestId: currentPreservation?.requestId ?? input.requestId,
              draft: draftToRestore,
            };
            setRequestDraft(draftToRestore);
          }
          throw error;
        }
      }),
    onSuccess: () => {
      toast.success("Field reset to extracted value.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to reset field.");
    },
  });

  const handleResetField = (field: ClientPartPropertyOverrideField) => {
    const draftSnapshot = requestDraft ?? fallbackRequestDraft;
    const requestId = patchDraftRequestIdRef.current + 1;
    patchDraftRequestIdRef.current = requestId;

    if (draftSnapshot) {
      patchDraftPreservationRef.current = { requestId, draft: draftSnapshot };
    }
    resetFieldMutation.mutate({
      fields: [field],
      preserveUnresetFields: true,
      requestId,
      draftSnapshot,
    });
  };

  const handleResetAllFields = () => {
    const draftSnapshot = requestDraft ?? fallbackRequestDraft;
    const requestId = patchDraftRequestIdRef.current + 1;
    patchDraftRequestIdRef.current = requestId;
    patchDraftPreservationRef.current = null;
    setRequestDraft(null);
    resetFieldMutation.mutate({
      fields: [...CLIENT_PART_PROPERTY_OVERRIDE_FIELDS],
      preserveUnresetFields: false,
      requestId,
      draftSnapshot,
    });
  };

  const renamePartMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) =>
      serializeRequestMutation(() => updateClientPartRequest(input)),
    onSuccess: async () => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      toast.success("Part renamed.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to rename part.");
    },
  });

  const isExactUnknownReplay = (input: {
    approvalReference: string;
    declaredModelUnits: XometryBetaModelUnits;
    envelopeRevision?: string;
    policyRevision: string;
    scopeFingerprint: string;
  }) => {
    const attempted = attemptedQuoteRef.current;
    return attempted?.status === "unknown" &&
      attempted.identity === quoteConfirmationIdentity &&
      attempted.input.approvalReference === input.approvalReference &&
      attempted.input.declaredModelUnits === input.declaredModelUnits &&
      attempted.input.envelopeRevision === input.envelopeRevision &&
      attempted.input.policyRevision === input.policyRevision &&
      attempted.input.scopeFingerprint === input.scopeFingerprint;
  };

  const requestQuoteMutation = useMutation({
    mutationFn: (input: {
      approvalReference: string;
      declaredModelUnits: XometryBetaModelUnits;
      envelopeRevision?: string;
      policyRevision: string;
      scopeFingerprint: string;
      /** Set only for a Xometry primary in a fan out confirmation. */
      xometryFanoutVendors?: VendorName[] | null;
    }) => {
      const exactUnknownReplay = isExactUnknownReplay(input);
      if (isVerifiedAuth !== true || (!quoteCollectionMode.automaticEnabled && !exactUnknownReplay)) {
        throw new Error("automatic_quote_unavailable");
      }
      // Only a real, explicitly confirmed invocation creates replay eligibility.
      attemptedQuoteRef.current = { identity: quoteConfirmationIdentity, input: { ...input }, status: "pending" };
      setUncertainQuoteIdentity(null);
      if (dispatchProvider !== "xometry") {
        // The envelope revision is the one the customer reviewed in the dialog;
        // the server refuses it unless it is still the active reviewed envelope.
        if (!input.envelopeRevision) {
          throw new TypeError("The confirmation scope identity could not be verified.");
        }
        return requestProviderDispatch({
          jobId: canonicalJobId,
          provider: dispatchProvider,
          declaredModelUnits: input.declaredModelUnits,
          expectedScopeFingerprint: input.scopeFingerprint,
          noticeRevision: input.policyRevision,
          expectedEnvelopeRevision: input.envelopeRevision,
          approvalReference: input.approvalReference,
        });
      }
      return requestXometryBetaDispatch({
        jobId: canonicalJobId,
        declaredModelUnits: input.declaredModelUnits,
        expectedScopeFingerprint: input.scopeFingerprint,
        policyRevision: input.policyRevision,
        approvalReference: input.approvalReference,
        fanout: input.xometryFanoutVendors
          ? { confirmationReference: input.approvalReference, vendors: input.xometryFanoutVendors }
          : null,
      });
    },
    onSuccess: async (result) => {
      attemptedQuoteRef.current = null;
      setUncertainQuoteIdentity(null);
      await quoteCollectionMode.refresh();
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });
      await queryClient.invalidateQueries({
        queryKey: ["xometry-beta-dispatch-scope", canonicalJobId],
      });
      toast.success(
        result.created
          ? `${dispatchProviderLabel} quote request queued.`
          : `${dispatchProviderLabel} quote request is already queued.`,
      );
    },
    onError: async (error) => {
      const isExplicitDenial = isExplicitXometryBetaDispatchDenial(error);
      if (isExplicitDenial) {
        await quoteCollectionMode.refresh();
        await queryClient.invalidateQueries({
          queryKey: ["xometry-beta-dispatch-scope", canonicalJobId],
        });
      }
      toast.error(
        isExplicitDenial
          ? getXometryBetaDispatchDenialMessage(error)
          : "The request status could not be confirmed. Check the previous quote request to retry safely.",
      );
    },
  });

  const cancelQuoteRequestMutation = useMutation({
    mutationFn: (requestId: string) => cancelQuoteRequest(requestId),
    onSuccess: async (result) => {
      await invalidateClientWorkspaceQueries(queryClient, { jobId: canonicalJobId });

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
  }) =>
    resolveWorkspaceProjectIdsForJob({
      job,
      sidebarProjectIdsByJobId,
    });

  useWarmClientWorkspaceNavigation({
    enabled: Boolean(user) && warmNavigation,
    accessScope: workspaceAccessScope,
    canPrefetchProjects: !projectCollaborationUnavailable,
    projects: sidebarProjects,
    jobs: navigationModel.parts,
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
    if (!redirectUnauthenticated || isAuthInitializing || user) {
      return;
    }

    recordWorkspaceSessionDiagnostic(
      "warn",
      "client-part.redirect.unauthenticated",
      "Redirecting to sign-in after startup auth resolution completed without a user.",
      {
        routeJobId,
      },
    );
    navigate("/?auth=signin", { replace: true });
  }, [isAuthInitializing, navigate, redirectUnauthenticated, routeJobId, user]);

  useEffect(() => {
    if (resolvedJobId && resolvedJobId !== routeJobId) {
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.partDetail(
          routeJobId,
          workspaceAccessScope,
        ),
        exact: true,
      });
      navigate(`/parts/${resolvedJobId}`, { replace: true });
      return;
    }

    if (partDetail?.job?.id && partDetail.job.id !== routeJobId) {
      navigate(`/parts/${partDetail.job.id}`, { replace: true });
    }
  }, [
    navigate,
    partDetail?.job?.id,
    queryClient,
    resolvedJobId,
    routeJobId,
    workspaceAccessScope,
  ]);

  const summary = partDetail?.summary ?? summariesByJobId.get(canonicalJobId) ?? null;
  const presentation = partDetail?.job ? getClientItemPresentation(partDetail.job, summary) : null;
  const projectMemberships = useMemo(
    () =>
      accessibleProjects.filter((project) =>
        partDetail?.projectIds.includes(project.project.id),
      ),
    [accessibleProjects, partDetail?.projectIds],
  );
  const extraction = partDetail?.part
    ? normalizeDrawingExtraction(partDetail.part.extraction, partDetail.part.id)
    : null;
  const extractionDiagnostics = partDetail?.part?.clientExtraction ?? null;
  const drawingPreview = partDetail?.drawingPreview ?? null;
  const drawingFile = partDetail?.files.find((file) => file.file_kind === "drawing") ?? null;
  const drawingViewerMode = useMemo(() => resolveStoredFileViewerMode(drawingFile), [drawingFile]);
  const cadFile = partDetail?.files.find((file) => file.file_kind === "cad") ?? null;
  const fallbackRequestDraft = useMemo(() => {
    return buildRequestDraftFromPartDetail(partDetail, canonicalJobId);
  }, [canonicalJobId, partDetail]);
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
  // OVD-981/OVD-991: the Need by filter on the results is view state. Persisting it would set
  // requested_by_date, which every controlled dispatch denies, so it persists only when quote
  // access is known to be blocked (outside the controlled envelope) and settled. Loading,
  // refetching, errored and eligible access all stay view-only (fail closed).
  const needByFilterIsViewOnly = !(
    quoteCollectionMode.state === "blocked" && !quoteCollectionMode.isLoading
  );
  // OVD-991: Threads falls back to the drawing's thread callouts when cleared, and any full
  // save of the request records them. Both server scope checks deny a non-blank Threads value.
  const requestThreadDefault = getRequestThreadDefault(partDetail?.part ?? null, extraction);
  const drawingHasThreads = hasText(requestThreadDefault);
  const needByRemovalSavesDrawingThreads =
    drawingHasThreads && !hasText(getSavedRequestThreads(partDetail?.part ?? null));
  const quoteViewRequestedByDate =
    needByFilterIsViewOnly && viewRequestedByDate !== undefined
      ? viewRequestedByDate
      : requestSummaryRequestedByDate;
  const vendorLabelMap = useMemo(
    () => buildVendorLabelMap(partDetail?.part?.vendorQuotes.map((quote) => quote.vendor) ?? []),
    [partDetail?.part?.vendorQuotes],
  );
  const quoteSelectionResult = useMemo(
    () =>
      partDetail?.part
        ? buildClientQuoteSelectionResult({
            vendorQuotes: partDetail.part.vendorQuotes,
            requestedByDate: quoteViewRequestedByDate,
            excludedVendorKeys,
            vendorLabels: vendorLabelMap,
          })
        : {
            options: [] as ClientQuoteSelectionOption[],
            diagnostics: partDetail?.quoteDiagnostics ?? EMPTY_QUOTE_DIAGNOSTICS,
          },
    [excludedVendorKeys, partDetail?.part, partDetail?.quoteDiagnostics, quoteViewRequestedByDate, vendorLabelMap],
  );
  const quoteOptions = quoteSelectionResult.options;
  const quoteDiagnostics = quoteSelectionResult.diagnostics;
  const quoteDataStatus: QuoteDataStatus =
    partDetail?.quoteDataStatus === "schema_unavailable"
      ? "schema_unavailable"
      : partDetail?.quoteDataStatus === "invalid_for_plotting" ||
          (quoteDiagnostics.rawQuoteRowCount > 0 &&
            quoteOptions.length === 0 &&
            quoteDiagnostics.excludedOfferCount > 0)
        ? "invalid_for_plotting"
        : "available";
  const quoteDataMessage =
    quoteDataStatus === "schema_unavailable"
      ? partDetail?.quoteDataMessage ?? null
      : quoteDataStatus === "invalid_for_plotting"
        ? summarizeQuoteDiagnostics(quoteDiagnostics)
        : null;
  const sourcingCandidates = useMemo(
    () => sortQuoteOptionsForPreset(quoteOptions, activePreset ?? "cheapest"),
    [activePreset, quoteOptions],
  );
  const sourcingResult = useMemo(
    () => {
      const result = buildClientSourcingResult({
        part: partDetail?.part ?? null,
        profiles: vendorCapabilityProfilesQuery.data ?? [],
        liveOffers: sourcingCandidates.map((option) => ({
          ...option,
          offerKey: option.key,
        })),
        automaticCollectionEnabled: quoteCollectionMode.automaticEnabled,
        capabilityDataAvailable: !vendorCapabilityProfilesQuery.isError,
      });

      if (
        vendorCapabilityProfilesQuery.isPending &&
        result.outcome !== "live_offers_available"
      ) {
        return null;
      }

      return result;
    },
    [
      partDetail?.part,
      quoteCollectionMode.automaticEnabled,
      sourcingCandidates,
      vendorCapabilityProfilesQuery.data,
      vendorCapabilityProfilesQuery.isError,
      vendorCapabilityProfilesQuery.isPending,
    ],
  );
  const rankedQuoteOptions = useMemo(() => {
    const liveOfferKeys = new Set(
      sourcingResult?.outcome === "live_offers_available"
        ? sourcingResult.liveOfferKeys
        : [],
    );

    return buildClientQuoteComparisonOptions({
      candidates: sourcingCandidates,
      liveOfferKeys,
      publishedOptions: partDetail?.publishedQuoteOptions ?? [],
      requestedByDate: quoteViewRequestedByDate,
    });
  }, [
    partDetail?.publishedQuoteOptions,
    quoteViewRequestedByDate,
    sourcingCandidates,
    sourcingResult,
  ]);
  const {
    selectedOption: selectedQuoteOption,
    previousSelectionUnavailable: previousQuoteSelectionUnavailable,
  } = resolveStoredQuoteSelection(
    rankedQuoteOptions,
    partDetail?.job.selected_vendor_quote_offer_id,
    partDetail?.publishedQuoteSelection?.option_id,
  );
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
    logQuoteFetchDiagnostics({
      partId: partDetail?.part?.id ?? null,
      organizationId: partDetail?.job.organization_id ?? null,
      quoteDataStatus,
      quoteDataMessage,
      rawQuoteRows: partDetail?.part?.vendorQuotes ?? [],
      diagnostics: quoteDiagnostics,
    });
  }, [
    partDetail?.job.organization_id,
    partDetail?.part?.id,
    partDetail?.part?.vendorQuotes,
    quoteDataMessage,
    quoteDataStatus,
    quoteDiagnostics,
  ]);

  useEffect(() => {
    setExcludedVendorKeys(readExcludedVendorKeys(canonicalJobId));
    setActivePreset(null);
    setViewRequestedByDate(undefined);
    patchDraftPreservationRef.current = null;
    setRequestDraft(null);
    setQuoteQuantityInput("");
    setPartRenameValue("");
    setShowRenameDialog(false);
    setIsPartOptionsOpen(false);
    setDrawingPdfUrl(null);
    setDrawingPreviewPageUrls([]);
    setDrawingPreviewLoadError(null);
  }, [canonicalJobId]);

  useEffect(() => {
    if (!fallbackRequestDraft) {
      return;
    }

    const preservation = patchDraftPreservationRef.current;
    const preservedDraft = preservation?.draft ?? null;
    setRequestDraft(preservedDraft ?? fallbackRequestDraft);
    if (!preservedDraft) {
      setQuoteQuantityInput(
        formatRequestedQuoteQuantitiesInput(fallbackRequestDraft.requestedQuoteQuantities),
      );
    }
    setPartRenameValue(fallbackRequestDraft.partNumber ?? presentation?.title ?? "");
  }, [fallbackRequestDraft, presentation?.title]);

  useEffect(() => {
    const preservation = patchDraftPreservationRef.current;
    if (
      !fallbackRequestDraft ||
      !preservation?.mutationCompleted ||
      !preservation.patch ||
      !requestDraftIncludesPatch(fallbackRequestDraft, preservation.patch)
    ) {
      return;
    }

    setRequestDraft(preservation.draft);
    patchDraftPreservationRef.current = null;
  }, [fallbackRequestDraft, requestDraft]);

  useEffect(() => {
    let isActive = true;
    let pdfObjectUrl: string | null = null;
    let pageObjectUrls: string[] = [];
    const drawingPreviewPages = drawingPreview?.pages ?? [];

    if (!drawingFile) {
      setDrawingPdfUrl(null);
      setDrawingPreviewPageUrls([]);
      setIsDrawingPreviewLoading(false);
      setDrawingPreviewLoadError(null);
      return;
    }

    const shouldLoadPdfPreview = drawingViewerMode === "pdf";
    const shouldLoadPagePreviews = drawingPreviewPages.length > 0;

    if (!shouldLoadPdfPreview && !shouldLoadPagePreviews) {
      setDrawingPdfUrl(null);
      setDrawingPreviewPageUrls([]);
      setIsDrawingPreviewLoading(false);
      setDrawingPreviewLoadError(null);
      return;
    }

    setIsDrawingPreviewLoading(true);
    setDrawingPreviewLoadError(null);

    void Promise.allSettled([
      shouldLoadPdfPreview ? loadStoredPdfObjectUrl(drawingFile) : Promise.resolve(null),
      shouldLoadPagePreviews ? loadStoredDrawingPreviewPages(drawingFile, drawingPreviewPages) : Promise.resolve([]),
    ])
      .then(([pdfResult, pagesResult]) => {
        const nextPdfUrl = pdfResult.status === "fulfilled" ? pdfResult.value : null;
        const nextPages = pagesResult.status === "fulfilled" ? pagesResult.value : [];

        if (!isActive) {
          if (nextPdfUrl) {
            URL.revokeObjectURL(nextPdfUrl);
          }
          nextPages.forEach((page) => URL.revokeObjectURL(page.url));
          return;
        }

        pdfObjectUrl = nextPdfUrl;
        pageObjectUrls = nextPages.map((page) => page.url);
        setDrawingPdfUrl(nextPdfUrl);
        setDrawingPreviewPageUrls(nextPages);

        if (pdfResult.status === "rejected") {
          const message = getUserFacingErrorMessage(pdfResult.reason, "Unable to load drawing preview.");
          if (nextPages.length === 0) {
            toast.error(message);
          }
          setDrawingPreviewLoadError(message);
          setDrawingPdfUrl(null);
          return;
        }

        if (pagesResult.status === "rejected") {
          setDrawingPreviewPageUrls([]);

          if (!nextPdfUrl) {
            const message = getUserFacingErrorMessage(pagesResult.reason, "Unable to load drawing preview.");
            toast.error(message);
            setDrawingPreviewLoadError(message);
            return;
          }

          setDrawingPreviewLoadError(null);
          return;
        }

        setDrawingPreviewLoadError(null);
      })
      .finally(() => {
        if (isActive) {
          setIsDrawingPreviewLoading(false);
        }
      });

    return () => {
      isActive = false;
      if (pdfObjectUrl) {
        URL.revokeObjectURL(pdfObjectUrl);
      }
      pageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [drawingFile, drawingPreview?.pages, drawingViewerMode]);

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

  /** `onFailure` lets the caller roll back an optimistic local selection when nothing was persisted. */
  const handleSelectQuoteOption = (option: ClientQuoteSelectionOption | null, onFailure?: () => void) => {
    if (option === null) {
      selectOfferMutation.mutate(null, { onError: onFailure });
      return;
    }

    if (!option.persistedOfferId) {
      toast.error("This quote option is not ready to select yet.");
      onFailure?.();
      return;
    }

    selectOfferMutation.mutate(option, { onError: onFailure });
  };

  /** Presets and the sourcing toggle reorder or filter the table only; selecting stays an explicit buyer action. */
  const handlePresetSelection = (preset: QuotePreset) => {
    setActivePreset(preset);
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

      const nextDraft = {
        ...base,
        ...next,
      };
      const preservation = patchDraftPreservationRef.current;
      if (preservation) {
        patchDraftPreservationRef.current = {
          ...preservation,
          draft: nextDraft,
        };
      }

      return nextDraft;
    });
  };

  const handleSaveRequest = () => {
    if (!effectiveRequestDraft) {
      return;
    }

    const validated = validateRequestedQuoteQuantitiesInput(quoteQuantityInput, effectiveRequestDraft.quantity);
    if (!singleQuantity && (validated.invalidTokens.length > 0 || validated.quantities.length === 0)) {
      toast.error(QUOTE_QUANTITIES_FORMAT_ERROR);
      return;
    }

    // OVD-997: single Quantity mode saves exactly [quantity]; the hidden Quote quantities text is ignored.
    const payload = singleQuantity
      ? buildSingleQuantityRequest(effectiveRequestDraft, singleQuantity)
      : ({
          ...effectiveRequestDraft,
          requestedQuoteQuantities: validated.quantities,
        } satisfies ClientPartRequestUpdateInput);
    if (!payload) {
      return;
    }

    patchDraftPreservationRef.current = null;
    setRequestDraft(payload);
    setQuoteQuantityInput(formatRequestedQuoteQuantitiesInput(payload.requestedQuoteQuantities));
    saveRequestMutation.mutate(payload);
  };

  /** Filters the results by delivery date; inside the controlled envelope this never writes the request. */
  const handleNeedByFilterChange = (nextDate: string | null) => {
    if (needByFilterIsViewOnly) {
      setViewRequestedByDate(nextDate);
      return;
    }
    handleSaveRequestPatch({ requestedByDate: nextDate });
  };

  const handleSaveRequestPatch = (next: Partial<ClientPartRequestUpdateInput>) => {
    if (!fallbackRequestDraft) {
      return;
    }

    const payload = {
      ...fallbackRequestDraft,
      ...next,
    } satisfies ClientPartRequestUpdateInput;
    const preservedDraft = requestDraft ? { ...requestDraft, ...next } : payload;
    const requestId = patchDraftRequestIdRef.current + 1;
    patchDraftRequestIdRef.current = requestId;

    patchDraftPreservationRef.current = {
      requestId,
      draft: preservedDraft,
      patch: next,
      mutationCompleted: false,
    };
    setRequestDraft(preservedDraft);
    saveRequestMutation.mutate(payload, {
      onSuccess: () => {
        const preservation = patchDraftPreservationRef.current;
        if (preservation?.requestId !== requestId) {
          return;
        }

        const completedPreservation = {
          ...preservation,
          mutationCompleted: true,
        };
        patchDraftPreservationRef.current = completedPreservation;
        setRequestDraft({ ...completedPreservation.draft });
      },
      onError: () => {
        if (patchDraftPreservationRef.current?.requestId === requestId) {
          patchDraftPreservationRef.current = null;
        }
      },
    });
  };

  /**
   * The Xometry fan out marker for one confirmation. An exact replay resends the
   * marker it first carried, even if fan out has since turned off; otherwise the
   * marker names exactly the providers this confirmation reaches. `refused` is
   * set when the scope names other enabled providers but the plan left only
   * Xometry, which the server refuses beside them.
   */
  const resolveXometryFanoutMarker = (
    uncertainReplay: boolean,
    send: readonly VendorName[] | undefined,
  ): { vendors: VendorName[] | null; refused: boolean } => {
    if (uncertainReplay) {
      return { vendors: attemptedQuoteRef.current?.input.xometryFanoutVendors ?? null, refused: false };
    }
    if (dispatchProvider !== "xometry") return { vendors: null, refused: false };
    const vendors = getXometryFanoutVendors(send);
    return { vendors, refused: Boolean(xometryScopeFanoutVendors) && !vendors };
  };

  const handleRequestQuote = async (input: {
    approvalReference: string;
    declaredModelUnits: XometryBetaModelUnits;
    envelopeRevision?: string;
    policyRevision: string;
    scopeFingerprint: string;
  }): Promise<XometryBetaDispatchResult | XometryBetaDispatchFailure | null> => {
    if (isRequestQuoteLockedRef.current || requestQuoteMutation.isPending) {
      return null;
    }

    // The plan and confirmed package are fixed at confirmation time.
    const fanoutPlan = providerFanout?.plan ?? null;
    const confirmedScope = xometryDispatchScopeQuery.data ?? null;
    if (fanoutPlan && !fanoutPlan.send.includes(dispatchProvider)) {
      toast.error(`${dispatchProviderLabel} cannot take this request right now.`);
      // Refused by the local plan (kill switch, process, or cap); nothing reached the server.
      return { accepted: false, created: false, diagnosticCode: "local_plan_refusal", status: "denied" };
    }
    const uncertainReplay = isExactUnknownReplay(input);
    const { vendors: xometryFanoutVendors, refused: isXometryAloneRefused } = resolveXometryFanoutMarker(
      uncertainReplay,
      fanoutPlan?.send,
    );
    if (isXometryAloneRefused) {
      toast.error(`${dispatchProviderLabel} can take this request only together with another provider right now.`);
      return { accepted: false, created: false, diagnosticCode: "local_plan_refusal", status: "denied" };
    }

    isRequestQuoteLockedRef.current = true;
    const startFanoutExtras = (primaryError?: unknown) => {
      if (!providerFanout || !fanoutPlan) return;
      // The extras carry only the package the customer reviewed. If the server
      // says it changed, or the loaded scope is no longer the one the dialog
      // showed, no extra is sent.
      if (
        confirmedScope?.scopeFingerprint !== input.scopeFingerprint ||
        (primaryError !== undefined && isDispatchScopeChangeDenial(primaryError))
      ) {
        providerFanout.withholdExtras({
          approvalReference: input.approvalReference,
          plan: fanoutPlan,
          reason: "scope_changed",
        });
        return;
      }
      void providerFanout.runExtras({
        approvalReference: input.approvalReference,
        declaredModelUnits: input.declaredModelUnits,
        confirmedScope,
        plan: fanoutPlan,
      });
    };
    providerFanout?.recordOutcome({ provider: dispatchProvider, status: "pending" });

    try {
      const result = await requestQuoteMutation.mutateAsync({ ...input, xometryFanoutVendors });
      providerFanout?.recordOutcome({ provider: dispatchProvider, status: "queued", created: result.created });
      startFanoutExtras();
      return result;
    } catch (error) {
      const failure = classifyXometryBetaDispatchFailure(error, { uncertainReplay });
      const attempted = attemptedQuoteRef.current;
      if (attempted?.identity === quoteConfirmationIdentity && attempted.input.approvalReference === input.approvalReference) {
        attemptedQuoteRef.current = failure.status === "unknown" ? { ...attempted, status: "unknown" } : null;
        setUncertainQuoteIdentity(failure.status === "unknown" ? attempted.identity : null);
      }
      console.error(`${dispatchProviderLabel} beta dispatch was not accepted.`, {
        diagnosticCode: failure.diagnosticCode,
      });
      providerFanout?.recordOutcome({
        provider: dispatchProvider,
        status: failure.status,
        skipReason: getFanoutDenialSkipReason(error),
      });
      // Any other primary failure never blocks the others.
      startFanoutExtras(error);
      return failure;
    } finally {
      isRequestQuoteLockedRef.current = false;
    }
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
      accessScope: workspaceAccessScope,
    });
  };

  const prefetchPart = (jobId: string) => {
    void prefetchPartPage(queryClient, jobId, {
      accessScope: workspaceAccessScope,
    });
  };
  const sidebarJobs = navigationModel.parts;
  let quoteVendorScopeError: string | null = null;
  if (vendorPreferenceQuery.error instanceof Error) {
    quoteVendorScopeError = getUserFacingErrorMessage(
      vendorPreferenceQuery.error,
      "Vendor scope could not be loaded.",
    );
  } else if (vendorPreferenceQuery.error) {
    quoteVendorScopeError = "Vendor scope could not be loaded.";
  } else if (quoteLaneEligibilityQuery.error instanceof Error) {
    quoteVendorScopeError = getUserFacingErrorMessage(
      quoteLaneEligibilityQuery.error,
      "Quote eligibility could not be loaded.",
    );
  } else if (quoteLaneEligibilityQuery.error) {
    quoteVendorScopeError = "Quote eligibility could not be loaded.";
  }
  // RPC failures arrive as plain PostgrestError records, not Error instances.
  const xometryDispatchScopeError = xometryDispatchScopeQuery.error
    ? getXometryBetaScopeFailureMessage(xometryDispatchScopeQuery.error, dispatchProvider, {
        drawingThreads: drawingHasThreads,
      })
    : null;
  const xometryDispatchScopeDenialCode = xometryDispatchScopeQuery.error
    ? getXometryBetaScopeDenialCode(xometryDispatchScopeQuery.error)
    : null;

  return {
    accessibleJobs: sidebarJobs,
    accessibleJobsQuery,
    activeMembership,
    isPlatformAdmin,
    automaticQuoteCollectionEnabled: quoteCollectionMode.automaticEnabled,
    availableQuoteVendors,
    quoteLaneEligibility: quoteLaneEligibilityQuery.data ?? [],
    selectedQuoteVendors,
    quoteVendorScopeError,
    quoteConfirmationIdentity,
    // Recovery exposes only an existing uncertain confirmation, never fresh admission.
    canRecoverQuoteRequest:
      isVerifiedAuth === true &&
      uncertainQuoteIdentity === quoteConfirmationIdentity &&
      attemptedQuoteRef.current?.identity === quoteConfirmationIdentity &&
      attemptedQuoteRef.current.status === "unknown" &&
      !requestQuoteMutation.isPending,
    dispatchProvider,
    providerFanout: providerFanout ? { plan: providerFanout.plan, outcomes: providerFanout.outcomes } : null,
    xometryDispatchScope: quoteCollectionMode.automaticEnabled ? xometryDispatchScopeQuery.data ?? null : null,
    xometryDispatchScopeError,
    xometryDispatchScopeDenialCode,
    xometryDispatchUnits,
    setXometryDispatchUnits,
    refetchXometryDispatchScope: async () => {
      await quoteCollectionMode.refresh();
      return xometryDispatchScopeQuery.refetch();
    },
    isXometryDispatchScopeLoading:
      xometryDispatchScopeQuery.isLoading ||
      xometryDispatchScopeQuery.isFetching ||
      providerFanout?.isGuardsLoading === true,
    isQuoteVendorScopeLoading:
      vendorPreferenceQuery.isLoading ||
      vendorPreferenceQuery.isFetching ||
      quoteLaneEligibilityQuery.isLoading ||
      quoteLaneEligibilityQuery.isFetching,
    isQuoteCollectionModeLoading: quoteCollectionMode.isLoading,
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
    drawingViewerMode,
    drawingPdfUrl,
    drawingPreviewPageUrls,
    drawingPreviewState,
    drawingPreviewStatusMessage,
    effectiveRequestDraft,
    eligibleQuoteCount,
    extraction,
    handleArchivePart,
    handleArchiveProject,
    handleCancelQuoteRequest,
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
    handleResetField,
    handleResetAllFields,
    handleSaveRequest,
    handleSaveRequestPatch,
    handleNeedByFilterChange,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isCancelingQuoteRequest: cancelQuoteRequestMutation.isPending,
    isRequestingQuote: requestQuoteMutation.isPending,
    isPartOptionsOpen,
    isPartPinBusy,
    isRenamingPart,
    isSearchOpen,
    jobId: canonicalJobId,
    navigate,
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
    quoteDataMessage,
    quoteDataStatus,
    quoteDiagnostics,
    quoteQuantityInput,
    rankedQuoteOptions,
    removeJobMutation,
    requestQuantities,
    requestQuoteMutation,
    resetFieldMutation,
    cancelQuoteRequestMutation,
    requestSummaryQuantity,
    requestSummaryRequestedByDate,
    quoteViewRequestedByDate,
    needByFilterIsViewOnly,
    needByRemovalSavesDrawingThreads,
    resolveSidebarProjectIdsForJob,
    navigationModel,
    revisionOptions,
    saveRequestMutation,
    singleQuantity,
    selectedQuoteOption,
    previousQuoteSelectionUnavailable,
    selectedRevisionIndex,
    sourcingResult,
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
    isAuthInitializing,
    hasCachedSession,
    isVerifiedAuth,
    workspaceAccessScope,
  };
}
