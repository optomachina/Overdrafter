import { supabase } from "@/integrations/supabase/client";
import type {
  ArchivedJobSummary,
  ClientActivityEvent,
  ClientQuoteWorkspaceItem,
  DrawingPreviewAssetRecord,
  JobFileRecord,
  PartDetailAggregate,
  PartRecord,
  QuoteDataStatus,
  QuoteDiagnostics,
  QuoteRequestRecord,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { normalizeDrawingPreview } from "@/features/quotes/utils";
import {
  buildClientQuoteSelectionResult,
  summarizeQuoteDiagnostics,
} from "@/features/quotes/selection";
import { callRpc } from "./shared/rpc";
import { emptyResponse, ensureData } from "./shared/response";
import {
  isMissingClientActivitySchemaError,
  isMissingDrawingPreviewSchemaError,
  isMissingFunctionError,
  isMissingQuoteRequestSchemaError,
  isNoRowsError,
} from "./shared/schema-errors";
import {
  isClientActivityFeedUnavailable,
  isJobArchivingSchemaUnavailable,
  markClientActivityFeedAvailability,
} from "./shared/schema-runtime";
import { buildClientPartAggregateFromMetadata } from "./shared/normalizers";
import {
  fetchAccessibleJobs,
  fetchAllAccessibleJobs,
  fetchClientPartMetadataByJobIds,
  fetchClientQuoteWorkspaceProjectionByJobIds,
  fetchDrawingPreviewAssetsByPartId,
  fetchJobPartSummariesByJobIds,
  fetchJobPartSummariesByOrganization,
  fetchJobsByIds,
} from "./jobs-api";
import { fetchProjectJobMembershipsByJobIds } from "./projects-api";

const EMPTY_QUOTE_DIAGNOSTICS: QuoteDiagnostics = {
  rawQuoteRowCount: 0,
  rawOfferCount: 0,
  plottableOfferCount: 0,
  excludedOfferCount: 0,
  excludedOffers: [],
  excludedReasonCounts: [],
};

function resolveQuoteWorkspaceHealth(input: {
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  vendorQuotes: VendorQuoteAggregate[];
}): {
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  quoteDiagnostics: QuoteDiagnostics;
} {
  if (input.quoteDataStatus === "schema_unavailable") {
    return {
      quoteDataStatus: input.quoteDataStatus,
      quoteDataMessage: input.quoteDataMessage,
      quoteDiagnostics: EMPTY_QUOTE_DIAGNOSTICS,
    };
  }

  const { diagnostics } = buildClientQuoteSelectionResult({
    vendorQuotes: input.vendorQuotes,
  });
  const quoteDataStatus =
    diagnostics.rawQuoteRowCount > 0 &&
    diagnostics.plottableOfferCount === 0 &&
    diagnostics.excludedOfferCount > 0
      ? "invalid_for_plotting"
      : input.quoteDataStatus;

  return {
    quoteDataStatus,
    quoteDataMessage:
      quoteDataStatus === "invalid_for_plotting"
        ? summarizeQuoteDiagnostics(diagnostics)
        : input.quoteDataMessage,
    quoteDiagnostics: diagnostics,
  };
}

export type ResolvedClientPartDetailRoute = {
  routeId: string;
  jobId: string;
  source: "job" | "part";
};

async function fetchLatestQuoteRequestsByJobIds(jobIds: string[]): Promise<Map<string, QuoteRequestRecord>> {
  if (jobIds.length === 0) {
    return new Map();
  }

  let data: QuoteRequestRecord[] | null = null;
  let error: { message: string } | null | undefined;

  try {
    const response = await supabase
      .from("quote_requests")
      .select("*")
      .in("job_id", jobIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    data = response.data as QuoteRequestRecord[] | null;
    error = response.error;
  } catch (queryError) {
    if (isMissingQuoteRequestSchemaError(queryError)) {
      return new Map();
    }

    throw queryError;
  }

  if (error && isMissingQuoteRequestSchemaError(error)) {
    return new Map();
  }

  const requests = ensureData(data, error) as QuoteRequestRecord[];
  const requestsByRecency = [...requests].sort((left, right) => {
    const createdAtComparison = right.created_at.localeCompare(left.created_at);

    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return right.id.localeCompare(left.id);
  });
  const latestByJobId = new Map<string, QuoteRequestRecord>();

  requestsByRecency.forEach((request) => {
    if (!latestByJobId.has(request.job_id)) {
      latestByJobId.set(request.job_id, request);
    }
  });

  return latestByJobId;
}

export async function resolveClientPartDetailRoute(candidateId: string): Promise<ResolvedClientPartDetailRoute | null> {
  if (!candidateId) {
    return null;
  }

  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return {
      routeId: candidateId,
      jobId: candidateId,
      source: "job",
    };
  }

  const directJobs = await fetchJobsByIds([candidateId], {
    archived: false,
  });

  if (directJobs.length > 0) {
    return {
      routeId: candidateId,
      jobId: candidateId,
      source: "job",
    };
  }

  const { data, error } = await supabase
    .from("parts")
    .select("job_id")
    .eq("id", candidateId)
    .maybeSingle();

  if (error) {
    if (isNoRowsError(error)) {
      return null;
    }

    throw error;
  }

  const row = data as { job_id?: string | null } | null;

  return typeof row?.job_id === "string"
    ? {
        routeId: candidateId,
        jobId: row.job_id,
        source: "part",
      }
    : null;
}

export async function fetchClientActivityEventsByJobIds(
  jobIds: string[],
  limitPerJob = 6,
): Promise<ClientActivityEvent[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchClientActivityEventsByJobIds(jobIds, limitPerJob);
  }

  if (jobIds.length === 0) {
    return [];
  }

  if (isClientActivityFeedUnavailable()) {
    return [];
  }

  const { data, error } = await callRpc("api_list_client_activity_events", {
    p_job_ids: jobIds,
    p_limit_per_job: limitPerJob,
  });

  if (error) {
    if (
      isMissingFunctionError(error, "api_list_client_activity_events") ||
      isMissingClientActivitySchemaError(error)
    ) {
      markClientActivityFeedAvailability("unavailable");
      return [];
    }

    throw error;
  }

  markClientActivityFeedAvailability("available");
  const events = ensureData(data, null);

  if (!Array.isArray(events)) {
    throw new Error("Expected client activity events to be returned as an array.");
  }

  return events as ClientActivityEvent[];
}

export async function fetchClientQuoteWorkspaceByJobIds(
  jobIds: string[],
): Promise<ClientQuoteWorkspaceItem[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchClientQuoteWorkspaceByJobIds(jobIds);
  }

  if (jobIds.length === 0) {
    return [];
  }

  const [
    jobs,
    filesResult,
    partsResult,
    summaries,
    projectMemberships,
    latestQuoteRequestsByJobId,
    quoteWorkspaceByJobId,
  ] = await Promise.all([
    fetchJobsByIds(jobIds, {
      archived: false,
    }),
    supabase.from("job_files").select("*").in("job_id", jobIds).order("created_at", { ascending: true }),
    supabase.from("parts").select("*").in("job_id", jobIds).order("created_at", { ascending: true }),
    fetchJobPartSummariesByJobIds(jobIds),
    fetchProjectJobMembershipsByJobIds(jobIds),
    fetchLatestQuoteRequestsByJobIds(jobIds),
    fetchClientQuoteWorkspaceProjectionByJobIds(jobIds),
  ]);

  const files = ensureData(filesResult.data, filesResult.error) as JobFileRecord[];
  const parts = ensureData(partsResult.data, partsResult.error) as PartRecord[];
  const metadataRows = await fetchClientPartMetadataByJobIds(jobIds);
  const previewPartIds = [...new Set([...parts.map((part) => part.id), ...metadataRows.map((item) => item.partId)])];
  const previewResult =
    previewPartIds.length > 0
      ? await supabase
          .from("drawing_preview_assets")
          .select("*")
          .in("part_id", previewPartIds)
          .order("page_number", { ascending: true })
      : await emptyResponse<DrawingPreviewAssetRecord>();

  const previewAssets = isMissingDrawingPreviewSchemaError(previewResult.error)
    ? []
    : (ensureData(previewResult.data, previewResult.error) as DrawingPreviewAssetRecord[]);

  const summariesByJobId = new Map(summaries.map((summary) => [summary.jobId, summary]));
  const filesByJobId = new Map<string, JobFileRecord[]>();
  const partsByJobId = new Map<string, PartRecord[]>();
  const metadataByPartId = new Map(metadataRows.map((item) => [item.partId, item]));
  const previewAssetsByPartId = new Map<string, DrawingPreviewAssetRecord[]>();
  const fileById = new Map(files.map((file) => [file.id, file]));
  const projectIdsByJobId = new Map<string, string[]>();

  files.forEach((file) => {
    const jobFiles = filesByJobId.get(file.job_id) ?? [];
    jobFiles.push(file);
    filesByJobId.set(file.job_id, jobFiles);
  });

  parts.forEach((part) => {
    const jobParts = partsByJobId.get(part.job_id) ?? [];
    jobParts.push(part);
    partsByJobId.set(part.job_id, jobParts);
  });

  previewAssets.forEach((asset) => {
    const assets = previewAssetsByPartId.get(asset.part_id) ?? [];
    assets.push(asset);
    previewAssetsByPartId.set(asset.part_id, assets);
  });

  projectMemberships.forEach((membership) => {
    const projectIds = projectIdsByJobId.get(membership.job_id) ?? [];
    if (!projectIds.includes(membership.project_id)) {
      projectIds.push(membership.project_id);
    }
    projectIdsByJobId.set(membership.job_id, projectIds);
  });

  const jobById = new Map(jobs.map((job) => [job.id, job]));

  return jobIds.flatMap((jobId) => {
    const job = jobById.get(jobId);

    if (!job) {
      return [];
    }

    const jobFiles = filesByJobId.get(jobId) ?? [];
    const jobParts = partsByJobId.get(jobId) ?? [];
    const quoteWorkspace = quoteWorkspaceByJobId.get(jobId) ?? {
      jobId,
      latestQuoteRun: null,
      selectedOffer: null,
      vendorQuotes: [],
      quoteDataStatus: "available" as const,
      quoteDataMessage: null,
    };
    const primaryPart = jobParts[0] ?? null;
    const fallbackMetadata = metadataRows.find((item) => item.jobId === jobId) ?? null;
    const partWithRelations =
      primaryPart === null
        ? fallbackMetadata
          ? buildClientPartAggregateFromMetadata({
              job,
              metadata: fallbackMetadata,
              files: jobFiles,
              vendorQuotes: quoteWorkspace.vendorQuotes,
            })
          : null
        : {
            ...primaryPart,
            cadFile: primaryPart.cad_file_id ? fileById.get(primaryPart.cad_file_id) ?? null : null,
            drawingFile: primaryPart.drawing_file_id ? fileById.get(primaryPart.drawing_file_id) ?? null : null,
            extraction: null,
            approvedRequirement: null,
            clientRequirement: metadataByPartId.get(primaryPart.id)?.requirement ?? null,
            clientExtraction: metadataByPartId.get(primaryPart.id)?.extraction ?? null,
            vendorQuotes: quoteWorkspace.vendorQuotes.filter((quote) => quote.part_id === primaryPart.id),
          };
    const quoteWorkspaceHealth = resolveQuoteWorkspaceHealth({
      quoteDataStatus: quoteWorkspace.quoteDataStatus,
      quoteDataMessage: quoteWorkspace.quoteDataMessage,
      vendorQuotes: partWithRelations?.vendorQuotes ?? quoteWorkspace.vendorQuotes,
    });

    return [
      {
        job,
        files: jobFiles,
        summary: summariesByJobId.get(jobId) ?? null,
        part: partWithRelations,
        quoteDataStatus: quoteWorkspaceHealth.quoteDataStatus,
        quoteDataMessage: quoteWorkspaceHealth.quoteDataMessage,
        quoteDiagnostics: quoteWorkspaceHealth.quoteDiagnostics,
        projectIds: projectIdsByJobId.get(jobId) ?? [],
        drawingPreview:
          partWithRelations === null
            ? normalizeDrawingPreview(null, [])
            : normalizeDrawingPreview(
                metadataByPartId.get(partWithRelations.id)?.extraction ?? partWithRelations.clientExtraction ?? null,
                previewAssetsByPartId.get(partWithRelations.id) ?? [],
              ),
        latestQuoteRequest: latestQuoteRequestsByJobId.get(jobId) ?? null,
        latestQuoteRun: quoteWorkspace.latestQuoteRun,
      } satisfies ClientQuoteWorkspaceItem,
    ];
  });
}

export async function fetchArchivedJobs(): Promise<ArchivedJobSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchArchivedJobs();
  }

  if (isJobArchivingSchemaUnavailable()) {
    return [];
  }

  const jobs = await fetchAllAccessibleJobs({ archived: true });

  if (jobs.length === 0) {
    return [];
  }

  const jobIds = jobs.map((job) => job.id);
  const [summaries, projectMemberships] = await Promise.all([
    fetchJobPartSummariesByJobIds(jobIds),
    fetchProjectJobMembershipsByJobIds(jobIds),
  ]);

  const projectIds = [...new Set(projectMemberships.map((membership) => membership.project_id))];
  const projectNamesResult =
    projectIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("projects").select("id, name").in("id", projectIds);
  const projectNamesById =
    projectIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (ensureData(projectNamesResult.data, projectNamesResult.error) as Array<{ id: string; name: string }>).map(
            (project) => [project.id, project.name],
          ),
        );
  const summariesByJobId = new Map(summaries.map((summary) => [summary.jobId, summary]));

  return jobs.map((job) => ({
    job,
    summary: summariesByJobId.get(job.id) ?? null,
    projectNames: [
      ...new Set(
        projectMemberships
          .filter((membership) => membership.job_id === job.id)
          .map((membership) => projectNamesById.get(membership.project_id))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
  }));
}

export async function fetchPartDetailByJobId(jobId: string): Promise<PartDetailAggregate> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchPartDetail(jobId);
  }

  const [workspaceItems, projectMemberships] = await Promise.all([
    fetchClientQuoteWorkspaceByJobIds([jobId]),
    fetchProjectJobMembershipsByJobIds([jobId]),
  ]);
  const workspaceItem = workspaceItems[0] ?? null;

  if (!workspaceItem) {
    throw new Error("Part not found.");
  }

  if (workspaceItem.job.archived_at) {
    throw new Error("Archived parts are only available from the Archive panel.");
  }

  const part = workspaceItem.part ?? null;
  const previewAssets = part !== null ? await fetchDrawingPreviewAssetsByPartId(part.id) : [];
  const summary = workspaceItem.summary ?? null;
  const [allSummaries, activeJobs] = await Promise.all([
    fetchJobPartSummariesByOrganization(workspaceItem.job.organization_id),
    fetchAccessibleJobs(),
  ]);
  const activeJobIdSet = new Set(activeJobs.map((job) => job.id));
  const revisionSiblings =
    summary?.partNumber
      ? allSummaries
          .filter(
            (candidate) =>
              candidate.partNumber === summary.partNumber &&
              candidate.jobId !== jobId &&
              activeJobIdSet.has(candidate.jobId),
          )
          .map((candidate) => ({
            jobId: candidate.jobId,
            revision: candidate.revision,
            title: `${candidate.partNumber}${candidate.revision ? ` rev ${candidate.revision}` : ""}`,
          }))
          .sort((left, right) => (left.revision ?? "").localeCompare(right.revision ?? ""))
      : [];

  return {
    job: workspaceItem.job,
    files: workspaceItem.files,
    summary,
    packages: [],
    part,
    quoteDataStatus: workspaceItem.quoteDataStatus,
    quoteDataMessage: workspaceItem.quoteDataMessage,
    quoteDiagnostics: workspaceItem.quoteDiagnostics,
    projectIds: projectMemberships.map((membership) => membership.project_id),
    drawingPreview: normalizeDrawingPreview(part?.clientExtraction ?? null, previewAssets),
    latestQuoteRequest: workspaceItem.latestQuoteRequest,
    latestQuoteRun: workspaceItem.latestQuoteRun,
    revisionSiblings,
  };
}

export async function fetchPartDetail(routeId: string): Promise<PartDetailAggregate> {
  const resolvedRoute = await resolveClientPartDetailRoute(routeId);

  if (!resolvedRoute) {
    throw new Error("Part not found.");
  }

  return fetchPartDetailByJobId(resolvedRoute.jobId);
}
