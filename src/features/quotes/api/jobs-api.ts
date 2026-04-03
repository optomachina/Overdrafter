import { supabase } from "@/integrations/supabase/client";
import type {
  ClientDraftInput,
  ClientPartMetadataRecord,
  ClientPartRequestUpdateInput,
  DebugExtractionRunRecord,
  DrawingExtractionRecord,
  DrawingPreviewAssetRecord,
  JobAggregate,
  JobFileRecord,
  JobPartSummary,
  JobRecord,
  PartRecord,
  PublishedQuoteOptionRecord,
  PublishedQuotePackageRecord,
  QuoteRequestRecord,
  QuoteRunRecord,
  ServiceRequestLineItemRecord,
  VendorQuoteAggregate,
  VendorQuoteArtifactRecord,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
  WorkQueueRecord,
} from "@/features/quotes/types";
import type {
  ApprovedPartRequirementRecord,
  ClientSelectionRecord,
  PricingPolicyRecord,
  QuoteRunAggregate,
} from "@/features/quotes/types";
import type {
  JobFileKind,
  Json,
} from "@/integrations/supabase/types";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { parsePartReference } from "@/features/quotes/part-reference";
import { normalizeRequestedQuoteQuantities } from "@/features/quotes/request-intake";
import { normalizeRequestedServiceIntent } from "@/features/quotes/service-intent";
import { normalizeClientPartMetadata } from "@/features/quotes/utils";
import { emptyResponse, ensureData, ensureOptionalRows } from "./shared/response";
import { callRpc, callUntypedRpc } from "./shared/rpc";
import {
  isMissingClientIntakeSchemaError,
  isMissingClientPartMetadataSchemaError,
  isMissingClientQuoteWorkspaceSchemaError,
  isMissingDebugExtractionSchemaError,
  isMissingDrawingPreviewSchemaError,
  isMissingFunctionError,
  isMissingJobArchivingSchemaError,
  isMissingServiceRequestLineItemSchemaError,
} from "./shared/schema-errors";
import {
  CLIENT_QUOTE_WORKSPACE_DRIFT_MESSAGE,
  JOB_SELECTION_COLUMN_SETS,
  getClientIntakeSchemaAvailability,
  isJobArchivingSchemaUnavailable,
  markClientIntakeSchemaAvailability,
  markJobArchivingSchemaAvailability,
} from "./shared/schema-runtime";
import {
  type ClientQuoteWorkspaceProjection,
  normalizeClientQuoteWorkspaceProjection,
} from "./shared/normalizers";
import { toClientIntakeCompatibilityError } from "./compatibility-api";
import { fetchAppSessionData } from "./session-api";

type JobFileSummaryRow = {
  job_id: string;
  normalized_name: string;
  original_name: string;
  file_kind: JobFileKind;
};

type JobSelectedOfferRow = {
  id: string;
  selected_vendor_quote_offer_id: string | null;
  requested_quote_quantities: number[];
  requested_by_date: string | null;
  requested_service_kinds: string[] | null;
  primary_service_kind: string | null;
  service_notes: string | null;
};

type JobRequestMetadata = {
  requestedServiceKinds: string[];
  primaryServiceKind: string | null;
  serviceNotes: string | null;
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
};

type JobSelectionState = {
  selectedOffersByJobId: Map<string, VendorQuoteOfferRecord>;
  requestByJobId: Map<string, JobRequestMetadata>;
};

type JobSelectionScope =
  | {
      kind: "jobIds";
      jobIds: string[];
    }
  | {
      kind: "organizationId";
      organizationId: string;
    };

type CreateJobInput = {
  organizationId: string;
  title: string;
  description?: string;
  source: string;
  tags?: string[];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
};

type CreateClientDraftRpcInput = {
  title: string;
  description?: string;
  projectId?: string | null;
  tags?: string[];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
};

function buildJobPartSummaryFromMetadata(
  input: {
    metadata: ClientPartMetadataRecord;
    existing: JobPartSummary | undefined;
    requestedServiceKinds: string[];
    primaryServiceKind: string | null;
    serviceNotes: string | null;
    requestedQuoteQuantities: number[];
    requestedByDate: string | null;
  },
): JobPartSummary {
  const serviceIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds: input.requestedServiceKinds,
    primaryServiceKind: input.primaryServiceKind,
    serviceNotes: input.serviceNotes,
  });
  const normalizedQuoteQuantities = normalizeRequestedQuoteQuantities(
    input.metadata.requirement.quoteQuantities,
    input.metadata.requirement.quantity,
  );

  return {
    jobId: input.metadata.jobId,
    partNumber: input.metadata.requirement.partNumber,
    revision: input.metadata.requirement.revision,
    description: input.metadata.requirement.description,
    requestedServiceKinds: serviceIntent.requestedServiceKinds,
    primaryServiceKind: serviceIntent.primaryServiceKind,
    serviceNotes: serviceIntent.serviceNotes,
    quantity: input.metadata.requirement.quantity,
    requestedQuoteQuantities:
      normalizedQuoteQuantities.length > 0 ? normalizedQuoteQuantities : input.requestedQuoteQuantities,
    requestedByDate: input.metadata.requirement.requestedByDate ?? input.requestedByDate ?? null,
    importedBatch: input.existing?.importedBatch ?? null,
    selectedSupplier: input.existing?.selectedSupplier ?? null,
    selectedPriceUsd: input.existing?.selectedPriceUsd ?? null,
    selectedLeadTimeBusinessDays: input.existing?.selectedLeadTimeBusinessDays ?? null,
  };
}

function buildNormalizedJobRequestMetadata(job: Partial<JobSelectedOfferRow> | null | undefined): JobRequestMetadata {
  return {
    ...normalizeRequestedServiceIntent({
      requestedServiceKinds: job?.requested_service_kinds ?? [],
      primaryServiceKind: job?.primary_service_kind ?? null,
      serviceNotes: job?.service_notes ?? null,
    }),
    requestedQuoteQuantities: normalizeRequestedQuoteQuantities(job?.requested_quote_quantities ?? []),
    requestedByDate: job?.requested_by_date ?? null,
  };
}

function emptyJobSelectionState(): JobSelectionState {
  return {
    selectedOffersByJobId: new Map<string, VendorQuoteOfferRecord>(),
    requestByJobId: new Map<string, JobRequestMetadata>(),
  };
}

async function fetchJobSelectionRows(scope: JobSelectionScope): Promise<JobSelectedOfferRow[]> {
  const availability = getClientIntakeSchemaAvailability();
  const columnSets =
    availability === "legacy"
      ? JOB_SELECTION_COLUMN_SETS.slice(1)
      : availability === "unavailable"
        ? JOB_SELECTION_COLUMN_SETS.slice(-1)
        : JOB_SELECTION_COLUMN_SETS;
  const applyScope = (columns: (typeof JOB_SELECTION_COLUMN_SETS)[number]) => {
    const query = supabase.from("jobs").select(columns);

    return scope.kind === "jobIds"
      ? query.in("id", scope.jobIds)
      : query.eq("organization_id", scope.organizationId);
  };

  let jobsWithSelection: JobSelectedOfferRow[] = [];
  let selectionQueryError: unknown = null;

  for (const [index, columnSet] of columnSets.entries()) {
    const { data: jobsData, error: jobsError } = await applyScope(columnSet);

    if (!jobsError) {
      jobsWithSelection = ensureData(jobsData as unknown as JobSelectedOfferRow[] | null, null);
      if (columnSet !== JOB_SELECTION_COLUMN_SETS[0]) {
        markClientIntakeSchemaAvailability("legacy");
      }
      selectionQueryError = null;
      break;
    }

    if (!isMissingClientIntakeSchemaError(jobsError) || index === columnSets.length - 1) {
      selectionQueryError = jobsError;
      break;
    }

    markClientIntakeSchemaAvailability("legacy");
  }

  if (selectionQueryError) {
    throw selectionQueryError;
  }

  return jobsWithSelection;
}

async function fetchJobSelectionState(scope: JobSelectionScope): Promise<JobSelectionState> {
  if (scope.kind === "jobIds" && scope.jobIds.length === 0) {
    return emptyJobSelectionState();
  }

  const jobsWithSelection = await fetchJobSelectionRows(scope);
  const offerIds = jobsWithSelection
    .map((job) => job.selected_vendor_quote_offer_id)
    .filter((value): value is string => Boolean(value));

  if (offerIds.length === 0) {
    return {
      ...emptyJobSelectionState(),
      requestByJobId: new Map(
        jobsWithSelection.map((job) => [job.id, buildNormalizedJobRequestMetadata(job)]),
      ),
    };
  }

  const quoteWorkspaceByJobId = await fetchClientQuoteWorkspaceProjectionByJobIds(
    jobsWithSelection.map((job) => job.id),
  );

  return {
    selectedOffersByJobId: new Map(
      jobsWithSelection.flatMap((job) => {
        if (!job.selected_vendor_quote_offer_id) {
          return [];
        }

        const offer = quoteWorkspaceByJobId.get(job.id)?.selectedOffer ?? null;
        return offer ? [[job.id, offer] as const] : [];
      }),
    ),
    requestByJobId: new Map(
      jobsWithSelection.map((job) => [job.id, buildNormalizedJobRequestMetadata(job)]),
    ),
  };
}

async function fetchJobSelectionStateByJobIds(jobIds: string[]) {
  return fetchJobSelectionState({
    kind: "jobIds",
    jobIds,
  });
}

async function fetchJobSelectionStateByOrganization(organizationId: string) {
  return fetchJobSelectionState({
    kind: "organizationId",
    organizationId,
  });
}

export async function fetchClientPartMetadataByJobIds(jobIds: string[]): Promise<ClientPartMetadataRecord[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_list_client_part_metadata", {
    p_job_ids: jobIds,
  });

  if (error) {
    if (isMissingClientPartMetadataSchemaError(error)) {
      return [];
    }

    throw error;
  }

  const rows = ensureData(data, null);

  if (!Array.isArray(rows)) {
    throw new Error("Expected client part metadata to be returned as an array.");
  }

  return rows
    .map((row) => normalizeClientPartMetadata(row as Json))
    .filter((row): row is ClientPartMetadataRecord => Boolean(row));
}

export async function fetchClientQuoteWorkspaceProjectionByJobIds(
  jobIds: string[],
): Promise<Map<string, ClientQuoteWorkspaceProjection>> {
  if (jobIds.length === 0) {
    return new Map();
  }

  // Keep this untyped for compatibility with environments lagging the latest
  // workspace RPC migration; drift handling below maps missing-schema errors.
  const { data, error } = await callUntypedRpc("api_list_client_quote_workspace", {
    p_job_ids: jobIds,
  });

  if (error) {
    if (
      isMissingFunctionError(error, "api_list_client_quote_workspace") ||
      isMissingClientQuoteWorkspaceSchemaError(error)
    ) {
      return new Map(
        jobIds.map((jobId) => [
          jobId,
          {
            jobId,
            latestQuoteRun: null,
            selectedOffer: null,
            vendorQuotes: [],
            quoteDataStatus: "schema_unavailable",
            quoteDataMessage: CLIENT_QUOTE_WORKSPACE_DRIFT_MESSAGE,
          } satisfies ClientQuoteWorkspaceProjection,
        ]),
      );
    }

    throw error;
  }

  const rows = ensureData(data, null);

  if (!Array.isArray(rows)) {
    throw new Error("Expected client quote workspace projection to be returned as an array.");
  }

  return new Map(
    rows
      .map((row) => normalizeClientQuoteWorkspaceProjection(row as Json))
      .filter((row): row is ClientQuoteWorkspaceProjection => Boolean(row))
      .map((row) => [row.jobId, row] as const),
  );
}

export async function fetchDrawingPreviewAssetsByPartId(partId: string): Promise<DrawingPreviewAssetRecord[]> {
  const { data, error } = await supabase
    .from("drawing_preview_assets")
    .select("*")
    .eq("part_id", partId)
    .order("page_number", {
      ascending: true,
    });

  if (isMissingDrawingPreviewSchemaError(error)) {
    return [];
  }

  return ensureData(data, error) as DrawingPreviewAssetRecord[];
}

export async function fetchAllAccessibleJobs(options: { archived?: boolean } = {}): Promise<JobRecord[]> {
  if (isJobArchivingSchemaUnavailable()) {
    if (options.archived) {
      return [];
    }

    const fallbackResult = await supabase.from("jobs").select("*").order("created_at", { ascending: false });
    return ensureData(fallbackResult.data, fallbackResult.error);
  }

  const query = supabase
    .from("jobs")
    .select("*")
    .order(options.archived ? "archived_at" : "created_at", { ascending: false });

  const { data, error } = await (options.archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null));

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");

    if (options.archived) {
      return [];
    }

    const fallbackResult = await supabase.from("jobs").select("*").order("created_at", { ascending: false });
    return ensureData(fallbackResult.data, fallbackResult.error) as JobRecord[];
  }

  markJobArchivingSchemaAvailability("available");
  return ensureData(data, error);
}

export async function fetchJobsByIds(jobIds: string[], options: { archived: boolean }): Promise<JobRecord[]> {
  if (jobIds.length === 0) {
    return [];
  }

  if (isJobArchivingSchemaUnavailable()) {
    if (options.archived) {
      return [];
    }

    const fallbackResult = await supabase.from("jobs").select("*").in("id", jobIds);
    return ensureData(fallbackResult.data, fallbackResult.error) as JobRecord[];
  }

  const query = supabase.from("jobs").select("*").in("id", jobIds);
  const { data, error } = await (options.archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null));

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");

    if (options.archived) {
      return [];
    }

    const fallbackResult = await supabase.from("jobs").select("*").in("id", jobIds);
    return ensureData(fallbackResult.data, fallbackResult.error) as JobRecord[];
  }

  markJobArchivingSchemaAvailability("available");
  return ensureData(data, error) as JobRecord[];
}

export async function fetchJobsByOrganization(organizationId: string): Promise<JobRecord[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchJobPartSummariesByOrganization(
  organizationId: string,
): Promise<JobPartSummary[]> {
  const [partsResult, filesResult, metadataRows, jobSelectionState] = await Promise.all([
    supabase
      .from("parts")
      .select("id, job_id, quantity")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    fetchClientPartMetadataByJobIds(
      (await fetchJobsByOrganization(organizationId)).map((job) => job.id),
    ),
    fetchJobSelectionStateByOrganization(organizationId),
  ]);

  const parts = ensureData(
    partsResult.data as Array<Pick<PartRecord, "id" | "job_id" | "quantity">> | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);
  const { selectedOffersByJobId, requestByJobId } = jobSelectionState;

  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const metadata of metadataRows) {
    const selectedOffer = selectedOffersByJobId.get(metadata.jobId) ?? null;
    const requestDefaults = requestByJobId.get(metadata.jobId) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
    summariesByJobId.set(metadata.jobId, {
      ...buildJobPartSummaryFromMetadata({
        metadata,
        existing: summariesByJobId.get(metadata.jobId),
        requestedServiceKinds: requestDefaults.requestedServiceKinds,
        primaryServiceKind: requestDefaults.primaryServiceKind,
        serviceNotes: requestDefaults.serviceNotes,
        requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
        requestedByDate: requestDefaults.requestedByDate,
      }),
      selectedSupplier: selectedOffer?.supplier ?? null,
      selectedPriceUsd: selectedOffer?.total_price_usd ?? null,
      selectedLeadTimeBusinessDays: selectedOffer?.lead_time_business_days ?? null,
    });
  }

  for (const row of parts) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary) {
      continue;
    }

    const requestDefaults = requestByJobId.get(row.job_id) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: null,
      revision: null,
      description: null,
      requestedServiceKinds: requestDefaults.requestedServiceKinds,
      primaryServiceKind: requestDefaults.primaryServiceKind,
      serviceNotes: requestDefaults.serviceNotes,
      quantity: row.quantity ?? null,
      requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
      requestedByDate: requestDefaults.requestedByDate,
      importedBatch: null,
      selectedSupplier: null,
      selectedPriceUsd: null,
      selectedLeadTimeBusinessDays: null,
    });
  }

  for (const row of fileRows) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary?.partNumber) {
      continue;
    }

    const parsedReference =
      parsePartReference(row.normalized_name) ?? parsePartReference(row.original_name);

    if (!parsedReference && existingSummary) {
      continue;
    }

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: parsedReference?.partNumber ?? existingSummary?.partNumber ?? null,
      revision: parsedReference?.revision ?? existingSummary?.revision ?? null,
      description: existingSummary?.description ?? null,
      requestedServiceKinds:
        existingSummary?.requestedServiceKinds ?? requestByJobId.get(row.job_id)?.requestedServiceKinds ?? [],
      primaryServiceKind:
        existingSummary?.primaryServiceKind ?? requestByJobId.get(row.job_id)?.primaryServiceKind ?? null,
      serviceNotes:
        existingSummary?.serviceNotes ?? requestByJobId.get(row.job_id)?.serviceNotes ?? null,
      quantity: existingSummary?.quantity ?? null,
      requestedQuoteQuantities:
        existingSummary?.requestedQuoteQuantities ?? requestByJobId.get(row.job_id)?.requestedQuoteQuantities ?? [],
      requestedByDate: existingSummary?.requestedByDate ?? requestByJobId.get(row.job_id)?.requestedByDate ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
      selectedSupplier: existingSummary?.selectedSupplier ?? null,
      selectedPriceUsd: existingSummary?.selectedPriceUsd ?? null,
      selectedLeadTimeBusinessDays: existingSummary?.selectedLeadTimeBusinessDays ?? null,
    });
  }

  return Array.from(summariesByJobId.values());
}

export async function fetchJobPartSummariesByJobIds(jobIds: string[]): Promise<JobPartSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchJobPartSummariesByJobIds(jobIds);
  }

  if (jobIds.length === 0) {
    return [];
  }

  const [partsResult, filesResult, metadataRows, jobSelectionState] = await Promise.all([
    supabase
      .from("parts")
      .select("id, job_id, quantity")
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
    fetchClientPartMetadataByJobIds(jobIds),
    fetchJobSelectionStateByJobIds(jobIds),
  ]);

  const parts = ensureData(
    partsResult.data as Array<Pick<PartRecord, "id" | "job_id" | "quantity">> | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);
  const { selectedOffersByJobId, requestByJobId } = jobSelectionState;
  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const metadata of metadataRows) {
    const selectedOffer = selectedOffersByJobId.get(metadata.jobId) ?? null;
    const requestDefaults = requestByJobId.get(metadata.jobId) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
    summariesByJobId.set(metadata.jobId, {
      ...buildJobPartSummaryFromMetadata({
        metadata,
        existing: summariesByJobId.get(metadata.jobId),
        requestedServiceKinds: requestDefaults.requestedServiceKinds,
        primaryServiceKind: requestDefaults.primaryServiceKind,
        serviceNotes: requestDefaults.serviceNotes,
        requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
        requestedByDate: requestDefaults.requestedByDate,
      }),
      selectedSupplier: selectedOffer?.supplier ?? null,
      selectedPriceUsd: selectedOffer?.total_price_usd ?? null,
      selectedLeadTimeBusinessDays: selectedOffer?.lead_time_business_days ?? null,
    });
  }

  for (const row of parts) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary) {
      continue;
    }

    const requestDefaults = requestByJobId.get(row.job_id) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: null,
      revision: null,
      description: null,
      requestedServiceKinds: requestDefaults.requestedServiceKinds,
      primaryServiceKind: requestDefaults.primaryServiceKind,
      serviceNotes: requestDefaults.serviceNotes,
      quantity: row.quantity ?? null,
      requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
      requestedByDate: requestDefaults.requestedByDate,
      importedBatch: null,
      selectedSupplier: null,
      selectedPriceUsd: null,
      selectedLeadTimeBusinessDays: null,
    });
  }

  for (const row of fileRows) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary?.partNumber) {
      continue;
    }

    const parsedReference =
      parsePartReference(row.normalized_name) ?? parsePartReference(row.original_name);

    if (!parsedReference && existingSummary) {
      continue;
    }

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: parsedReference?.partNumber ?? existingSummary?.partNumber ?? null,
      revision: parsedReference?.revision ?? existingSummary?.revision ?? null,
      description: existingSummary?.description ?? null,
      requestedServiceKinds:
        existingSummary?.requestedServiceKinds ?? requestByJobId.get(row.job_id)?.requestedServiceKinds ?? [],
      primaryServiceKind:
        existingSummary?.primaryServiceKind ?? requestByJobId.get(row.job_id)?.primaryServiceKind ?? null,
      serviceNotes:
        existingSummary?.serviceNotes ?? requestByJobId.get(row.job_id)?.serviceNotes ?? null,
      quantity: existingSummary?.quantity ?? null,
      requestedQuoteQuantities:
        existingSummary?.requestedQuoteQuantities ?? requestByJobId.get(row.job_id)?.requestedQuoteQuantities ?? [],
      requestedByDate: existingSummary?.requestedByDate ?? requestByJobId.get(row.job_id)?.requestedByDate ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
      selectedSupplier: existingSummary?.selectedSupplier ?? null,
      selectedPriceUsd: existingSummary?.selectedPriceUsd ?? null,
      selectedLeadTimeBusinessDays: existingSummary?.selectedLeadTimeBusinessDays ?? null,
    });
  }

  return Array.from(summariesByJobId.values());
}

export async function fetchJobAggregate(jobId: string): Promise<JobAggregate> {
  const { data: jobData, error: jobError } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  const job = ensureData(jobData as JobRecord | null, jobError);

  const [
    filesResult,
    partsResult,
    quoteRequestsResult,
    quoteRunsResult,
    serviceRequestLineItemsResult,
    packagesResult,
    workQueueResult,
  ] = await Promise.all([
    supabase.from("job_files").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("parts").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("quote_requests").select("*").eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase.from("quote_runs").select("*").eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase
      .from("service_request_line_items")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
    supabase
      .from("published_quote_packages")
      .select("*")
      .eq("job_id", jobId)
      .order("published_at", { ascending: false }),
    supabase
      .from("work_queue")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
  ]);

  const files = ensureData(filesResult.data, filesResult.error) as JobFileRecord[];
  const parts = ensureData(partsResult.data, partsResult.error) as PartRecord[];
  const quoteRequests = ensureData(quoteRequestsResult.data, quoteRequestsResult.error) as QuoteRequestRecord[];
  const quoteRuns = ensureData(quoteRunsResult.data, quoteRunsResult.error) as QuoteRunRecord[];
  const serviceRequestLineItems = ensureOptionalRows(
    serviceRequestLineItemsResult.data,
    serviceRequestLineItemsResult.error,
    isMissingServiceRequestLineItemSchemaError,
  ) as ServiceRequestLineItemRecord[];
  const packages = ensureData(packagesResult.data, packagesResult.error) as PublishedQuotePackageRecord[];
  const workQueue = ensureData(workQueueResult.data, workQueueResult.error) as WorkQueueRecord[];

  const partIds = parts.map((part) => part.id);
  const quoteRunIds = quoteRuns.map((run) => run.id);
  const packageIds = packages.map((pkg) => pkg.id);

  const [
    extractionResult,
    previewAssetResult,
    approvedResult,
    debugExtractionRunsResult,
    vendorQuoteResult,
    optionResult,
    selectionResult,
  ] = await Promise.all([
    partIds.length > 0
      ? supabase.from("drawing_extractions").select("*").in("part_id", partIds)
      : emptyResponse<DrawingExtractionRecord>(),
    partIds.length > 0
      ? supabase.from("drawing_preview_assets").select("*").in("part_id", partIds)
      : emptyResponse<DrawingPreviewAssetRecord>(),
    partIds.length > 0
      ? supabase.from("approved_part_requirements").select("*").in("part_id", partIds)
      : emptyResponse<ApprovedPartRequirementRecord>(),
    partIds.length > 0
      ? supabase
          .from("debug_extraction_runs")
          .select("*")
          .in("part_id", partIds)
          .order("created_at", { ascending: false })
      : emptyResponse<DebugExtractionRunRecord>(),
    quoteRunIds.length > 0
      ? supabase.from("vendor_quote_results").select("*").in("quote_run_id", quoteRunIds)
      : emptyResponse<VendorQuoteResultRecord>(),
    packageIds.length > 0
      ? supabase.from("published_quote_options").select("*").in("package_id", packageIds)
      : emptyResponse<PublishedQuoteOptionRecord>(),
    packageIds.length > 0
      ? supabase.from("client_selections").select("*").in("package_id", packageIds).order("created_at", { ascending: false })
      : emptyResponse<ClientSelectionRecord>(),
  ]);

  const pricingPolicyId = job.active_pricing_policy_id;

  const pricingPolicyPromise = pricingPolicyId
    ? supabase.from("pricing_policies").select("*").eq("id", pricingPolicyId).single()
    : supabase
        .from("pricing_policies")
        .select("*")
        .eq("organization_id", job.organization_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  const pricingPolicyResult = pricingPolicyId
    ? ((await pricingPolicyPromise) as PostgrestSingleResponse<PricingPolicyRecord>)
    : ((await pricingPolicyPromise) as PostgrestSingleResponse<PricingPolicyRecord | null>);

  const extractions = ensureData(extractionResult.data, extractionResult.error) as DrawingExtractionRecord[];
  const drawingPreviewAssets = ensureOptionalRows(
    previewAssetResult.data,
    previewAssetResult.error,
    isMissingDrawingPreviewSchemaError,
  ) as DrawingPreviewAssetRecord[];
  const approvedRequirements = ensureData(
    approvedResult.data,
    approvedResult.error,
  ) as ApprovedPartRequirementRecord[];
  const debugExtractionRuns = ensureOptionalRows(
    debugExtractionRunsResult.data,
    debugExtractionRunsResult.error,
    isMissingDebugExtractionSchemaError,
  ) as DebugExtractionRunRecord[];
  const vendorQuotes = ensureData(
    vendorQuoteResult.data,
    vendorQuoteResult.error,
  ) as VendorQuoteResultRecord[];
  const vendorQuoteIds = vendorQuotes.map((quote) => quote.id);
  const vendorArtifactResultResolved =
    vendorQuoteIds.length > 0
      ? await supabase.from("vendor_quote_artifacts").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : await emptyResponse<VendorQuoteArtifactRecord>();
  const vendorOffersResultResolved =
    vendorQuoteIds.length > 0
      ? await supabase.from("vendor_quote_offers").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : await emptyResponse<VendorQuoteOfferRecord>();
  const vendorArtifacts = ensureData(
    vendorArtifactResultResolved.data,
    vendorArtifactResultResolved.error,
  ) as VendorQuoteArtifactRecord[];
  const vendorOffers = ensureData(
    vendorOffersResultResolved.data,
    vendorOffersResultResolved.error,
  ) as VendorQuoteOfferRecord[];
  const options = ensureData(
    optionResult.data,
    optionResult.error,
  ) as PublishedQuoteOptionRecord[];
  const selections = ensureData(
    selectionResult.data,
    selectionResult.error,
  ) as ClientSelectionRecord[];
  const pricingPolicy = pricingPolicyResult.data as PricingPolicyRecord | null;

  const fileMap = new Map(files.map((file) => [file.id, file]));
  const extractionMap = new Map(extractions.map((item) => [item.part_id, item]));
  const approvedMap = new Map(approvedRequirements.map((item) => [item.part_id, item]));
  const quoteRequestById = new Map(quoteRequests.map((request) => [request.id, request]));
  const serviceRequestLineItemById = new Map(serviceRequestLineItems.map((lineItem) => [lineItem.id, lineItem]));
  const offerMap = new Map<string, VendorQuoteOfferRecord[]>();
  const artifactMap = new Map<string, VendorQuoteArtifactRecord[]>();

  vendorOffers.forEach((offer) => {
    const current = offerMap.get(offer.vendor_quote_result_id) ?? [];
    current.push(offer);
    offerMap.set(offer.vendor_quote_result_id, current);
  });

  vendorArtifacts.forEach((artifact) => {
    const current = artifactMap.get(artifact.vendor_quote_result_id) ?? [];
    current.push(artifact);
    artifactMap.set(artifact.vendor_quote_result_id, current);
  });

  const vendorQuoteAggregates: VendorQuoteAggregate[] = vendorQuotes.map((quote) => ({
    ...quote,
    artifacts: [...(artifactMap.get(quote.id) ?? [])].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    ),
    offers:
      (offerMap.get(quote.id) ?? []).sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      }),
  })).sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    if (left.part_id !== right.part_id) {
      return left.part_id.localeCompare(right.part_id);
    }

    return left.vendor.localeCompare(right.vendor);
  });
  const sortedOptions = [...options].sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    return left.created_at.localeCompare(right.created_at);
  });

  const partsWithRelations = parts.map((part) => ({
    ...part,
    cadFile: part.cad_file_id ? fileMap.get(part.cad_file_id) ?? null : null,
    drawingFile: part.drawing_file_id ? fileMap.get(part.drawing_file_id) ?? null : null,
    extraction: extractionMap.get(part.id) ?? null,
    approvedRequirement: approvedMap.get(part.id) ?? null,
    vendorQuotes: vendorQuoteAggregates.filter((quote) => quote.part_id === part.id),
  }));

  const quoteRunsWithResults: QuoteRunAggregate[] = quoteRuns.map((run) => {
    const quoteRequest = run.quote_request_id ? quoteRequestById.get(run.quote_request_id) ?? null : null;
    const serviceRequestLineItem =
      quoteRequest?.service_request_line_item_id
        ? serviceRequestLineItemById.get(quoteRequest.service_request_line_item_id) ?? null
        : null;

    return {
      ...run,
      vendorQuotes: vendorQuoteAggregates.filter((quote) => quote.quote_run_id === run.id),
      quoteRequest,
      serviceRequestLineItem,
    };
  });

  const packagesWithOptions = packages.map((pkg) => ({
    ...pkg,
    options: sortedOptions.filter((option) => option.package_id === pkg.id),
    selections: selections.filter((selection) => selection.package_id === pkg.id),
  }));

  return {
    job,
    files,
    parts: partsWithRelations,
    quoteRuns: quoteRunsWithResults,
    quoteRequests,
    serviceRequestLineItems,
    packages: packagesWithOptions,
    pricingPolicy,
    workQueue,
    drawingPreviewAssets,
    debugExtractionRuns,
  };
}

export async function fetchAccessibleJobs(): Promise<JobRecord[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchAccessibleJobs();
  }

  return fetchAllAccessibleJobs({ archived: false });
}

export async function fetchUngroupedParts(): Promise<JobRecord[]> {
  const appSession = await fetchAppSessionData();
  const currentUser = appSession.user;

  if (!currentUser) {
    throw new Error("You must be signed in to continue.");
  }

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("created_by", currentUser.id)
    .is("project_id", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");
    const fallbackResult = await supabase
      .from("jobs")
      .select("*")
      .eq("created_by", currentUser.id)
      .is("project_id", null)
      .order("created_at", { ascending: false });
    return ensureData(fallbackResult.data, fallbackResult.error);
  }

  return ensureData(data, error);
}

export async function searchAccessibleParts(query: string): Promise<JobRecord[]> {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const jobs = await fetchAllAccessibleJobs();

  return jobs.filter((job) =>
    [job.title, job.description ?? "", job.tags.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

function buildCurrentCreateJobArgs(input: CreateJobInput) {
  return {
    p_organization_id: input.organizationId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_source: input.source,
    p_tags: input.tags ?? [],
    p_requested_service_kinds: input.requestedServiceKinds ?? [],
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
    p_requested_by_date: input.requestedByDate ?? null,
  };
}

async function callLegacyCreateJob(input: CreateJobInput): Promise<PostgrestSingleResponse<unknown>> {
  const attempts: Array<Record<string, unknown>> = [
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
      p_tags: input.tags ?? [],
      p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
      p_requested_by_date: input.requestedByDate ?? null,
    },
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
      p_tags: input.tags ?? [],
    },
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
    },
  ];

  let lastResponse: PostgrestSingleResponse<unknown> = {
    data: null,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  };

  for (const args of attempts) {
    const response = await callUntypedRpc("api_create_job", args);
    lastResponse = response;

    if (!response.error || !isMissingFunctionError(response.error, "api_create_job")) {
      return response;
    }
  }

  return lastResponse;
}

async function callLegacyCreateClientDraft(
  input: CreateClientDraftRpcInput,
): Promise<PostgrestSingleResponse<unknown>> {
  const attempts: Array<Record<string, unknown>> = [
    {
      p_title: input.title,
      p_description: input.description ?? null,
      p_project_id: input.projectId ?? null,
      p_tags: input.tags ?? [],
      p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
      p_requested_by_date: input.requestedByDate ?? null,
    },
    {
      p_title: input.title,
      p_description: input.description ?? null,
      p_project_id: input.projectId ?? null,
      p_tags: input.tags ?? [],
    },
  ];

  let lastResponse: PostgrestSingleResponse<unknown> = {
    data: null,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  };

  for (const args of attempts) {
    const response = await callUntypedRpc("api_create_client_draft", args);
    lastResponse = response;

    if (!response.error || !isMissingFunctionError(response.error, "api_create_client_draft")) {
      return response;
    }
  }

  return lastResponse;
}

export async function createClientDraft(input: ClientDraftInput): Promise<string> {
  const { data, error } = await callRpc("api_create_client_draft", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_project_id: input.projectId ?? null,
    p_tags: input.tags ?? [],
    p_requested_service_kinds: input.requestedServiceKinds ?? [],
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
    p_requested_by_date: input.requestedByDate ?? null,
  });

  if (!error) {
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_client_draft")) {
    const legacyResponse = await callLegacyCreateClientDraft(input);

    if (!legacyResponse.error) {
      return ensureData(legacyResponse.data as string | null, null);
    }

    if (!input.projectId && isMissingFunctionError(legacyResponse.error, "api_create_client_draft")) {
      const appSession = await fetchAppSessionData();
      const fallbackMembership =
        appSession.memberships.find((membership) => membership.role === "client") ??
        appSession.memberships[0];

      if (!fallbackMembership) {
        throw legacyResponse.error;
      }

      return createJob({
        organizationId: fallbackMembership.organizationId,
        title: input.title,
        description: input.description,
        source: "client_home",
        tags: input.tags,
        requestedServiceKinds: input.requestedServiceKinds,
        primaryServiceKind: input.primaryServiceKind,
        serviceNotes: input.serviceNotes,
        requestedQuoteQuantities: input.requestedQuoteQuantities,
        requestedByDate: input.requestedByDate,
      });
    }

    if (isMissingClientIntakeSchemaError(legacyResponse.error)) {
      throw toClientIntakeCompatibilityError(legacyResponse.error);
    }

    throw legacyResponse.error;
  }

  if (!input.projectId && isMissingClientIntakeSchemaError(error)) {
    const appSession = await fetchAppSessionData();
    const fallbackMembership =
      appSession.memberships.find((membership) => membership.role === "client") ??
      appSession.memberships[0];

    if (!fallbackMembership) {
      throw error;
    }

    return createJob({
      organizationId: fallbackMembership.organizationId,
      title: input.title,
      description: input.description,
      source: "client_home",
      tags: input.tags,
      requestedServiceKinds: input.requestedServiceKinds,
      primaryServiceKind: input.primaryServiceKind,
      serviceNotes: input.serviceNotes,
      requestedQuoteQuantities: input.requestedQuoteQuantities,
      requestedByDate: input.requestedByDate,
    });
  }

  if (isMissingClientIntakeSchemaError(error)) {
    throw toClientIntakeCompatibilityError(error);
  }

  throw error;
}

export async function updateClientPartRequest(input: ClientPartRequestUpdateInput): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.updateClientPartRequest(input);
  }

  const currentArgs = {
    p_job_id: input.jobId,
    p_requested_service_kinds: input.requestedServiceKinds,
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_description: input.description ?? null,
    p_part_number: input.partNumber ?? null,
    p_revision: input.revision ?? null,
    p_material: input.material,
    p_finish: input.finish ?? null,
    p_threads: input.threads ?? null,
    p_tightest_tolerance_inch: input.tightestToleranceInch ?? null,
    p_process: input.process ?? null,
    p_notes: input.notes ?? null,
    p_quantity: input.quantity,
    p_requested_quote_quantities: input.requestedQuoteQuantities,
    p_requested_by_date: input.requestedByDate ?? null,
    p_shipping: input.shipping,
    p_certifications: input.certifications,
    p_sourcing: input.sourcing,
    p_release: input.release,
  };
  const { data, error } = await callRpc("api_update_client_part_request", currentArgs);

  if (error && isMissingFunctionError(error, "api_update_client_part_request")) {
    const legacyArgs = {
      p_job_id: input.jobId,
      p_requested_service_kinds: input.requestedServiceKinds,
      p_primary_service_kind: input.primaryServiceKind ?? null,
      p_service_notes: input.serviceNotes ?? null,
      p_description: input.description ?? null,
      p_part_number: input.partNumber ?? null,
      p_revision: input.revision ?? null,
      p_material: input.material,
      p_finish: input.finish ?? null,
      p_tightest_tolerance_inch: input.tightestToleranceInch ?? null,
      p_process: input.process ?? null,
      p_notes: input.notes ?? null,
      p_quantity: input.quantity,
      p_requested_quote_quantities: input.requestedQuoteQuantities,
      p_requested_by_date: input.requestedByDate ?? null,
      p_shipping: input.shipping,
      p_certifications: input.certifications,
      p_sourcing: input.sourcing,
      p_release: input.release,
    };
    console.warn("updateClientPartRequest: falling back to legacy RPC signature", {
      jobId: input.jobId,
      partNumber: input.partNumber ?? null,
      requestedServiceKinds: input.requestedServiceKinds,
      functionName: "api_update_client_part_request",
    });
    const legacyResponse = await callRpc("api_update_client_part_request", legacyArgs);

    if (legacyResponse.error) {
      if (isMissingClientIntakeSchemaError(legacyResponse.error)) {
        throw toClientIntakeCompatibilityError(legacyResponse.error);
      }

      throw legacyResponse.error;
    }

    return ensureData(legacyResponse.data, legacyResponse.error);
  }

  if (isMissingClientIntakeSchemaError(error)) {
    throw toClientIntakeCompatibilityError(error);
  }

  return ensureData(data, error);
}

export async function resetClientPartPropertyOverrides(input: {
  jobId: string;
  fields: Array<
    "description" | "partNumber" | "material" | "finish" | "tightestToleranceInch" | "threads"
  >;
}): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway?.resetClientPartPropertyOverrides) {
    return fixtureGateway.resetClientPartPropertyOverrides(input);
  }

  const { data, error } = await callRpc("api_reset_client_part_property_overrides", {
    p_job_id: input.jobId,
    p_fields: input.fields,
  });

  return ensureData(data, error);
}

export async function createJob(input: CreateJobInput): Promise<string> {
  const { data, error } = await callRpc("api_create_job", buildCurrentCreateJobArgs(input));

  if (!error) {
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_job")) {
    const legacyResponse = await callLegacyCreateJob(input);

    if (!legacyResponse.error) {
      return ensureData(legacyResponse.data as string | null, null);
    }

    if (isMissingClientIntakeSchemaError(legacyResponse.error)) {
      throw toClientIntakeCompatibilityError(legacyResponse.error);
    }

    throw legacyResponse.error;
  }

  if (isMissingClientIntakeSchemaError(error)) {
    throw toClientIntakeCompatibilityError(error);
  }

  throw error;
}
