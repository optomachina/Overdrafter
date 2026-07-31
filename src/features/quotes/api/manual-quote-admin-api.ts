import type {
  ManualQuoteArtifactInput,
  ManualQuoteOfferInput,
} from "@/features/quotes/types";
import type {
  JobStatus,
  QuoteRequestStatus,
  QuoteRunStatus,
  VendorName,
  VendorStatus,
} from "@/integrations/supabase/types";
import { callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export type AdminManualQuoteRequest = {
  requestId: string;
  organizationId: string;
  organizationName: string;
  projectId: string | null;
  projectName: string | null;
  jobId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  quoteRunId: string | null;
  quoteRunStatus: QuoteRunStatus | null;
  requestStatus: QuoteRequestStatus;
  requestedByUserId: string;
  requestedByEmail: string | null;
  partCount: number;
  partIds: string[];
  createdAt: string;
  updatedAt: string;
  requestAgeSeconds: number;
  isStale: boolean;
  staleReason: string | null;
};

export type AdminManualQuoteRequestPage = {
  items: AdminManualQuoteRequest[];
  nextCursor: string | null;
};

export type AdminManualQuoteCompletionResult = {
  quoteRequestId: string;
  quoteRunId: string;
  jobId: string;
  partId: string;
  vendorQuoteResultId: string;
  requestStatus: "received";
  quoteRunStatus: "completed";
  jobStatus: "internal_review";
  eventId: string;
  replayed: boolean;
};

export type ManualQuoteOperatorAccess = {
  hasCapability: boolean;
  hasAal2: boolean;
};

type UnknownRecord = Record<string, unknown>;

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }

  return value as UnknownRecord;
}

function requireString(record: UnknownRecord, key: string, label: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing ${key}.`);
  }

  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeManualQuoteRequest(value: unknown): AdminManualQuoteRequest {
  const record = requireRecord(value, "manual quote request");
  const partIds = Array.isArray(record.partIds)
    ? record.partIds.filter((partId): partId is string => typeof partId === "string")
    : [];
  const partCount = Number(record.partCount);
  const requestAgeSeconds = Number(record.requestAgeSeconds);

  if (!Number.isInteger(partCount) || partCount < 0) {
    throw new Error("Manual quote request has an invalid partCount.");
  }

  if (!Number.isFinite(requestAgeSeconds) || requestAgeSeconds < 0) {
    throw new Error("Manual quote request has an invalid requestAgeSeconds.");
  }

  return {
    requestId: requireString(record, "requestId", "Manual quote request"),
    organizationId: requireString(record, "organizationId", "Manual quote request"),
    organizationName: requireString(record, "organizationName", "Manual quote request"),
    projectId: nullableString(record.projectId),
    projectName: nullableString(record.projectName),
    jobId: requireString(record, "jobId", "Manual quote request"),
    jobTitle: requireString(record, "jobTitle", "Manual quote request"),
    jobStatus: requireString(record, "jobStatus", "Manual quote request") as JobStatus,
    quoteRunId: nullableString(record.quoteRunId),
    quoteRunStatus: nullableString(record.quoteRunStatus) as QuoteRunStatus | null,
    requestStatus: requireString(
      record,
      "requestStatus",
      "Manual quote request",
    ) as QuoteRequestStatus,
    requestedByUserId: requireString(
      record,
      "requestedByUserId",
      "Manual quote request",
    ),
    requestedByEmail: nullableString(record.requestedByEmail),
    partCount,
    partIds,
    createdAt: requireString(record, "createdAt", "Manual quote request"),
    updatedAt: requireString(record, "updatedAt", "Manual quote request"),
    requestAgeSeconds,
    isStale: record.isStale === true,
    staleReason: nullableString(record.staleReason),
  };
}

function normalizeManualQuoteRequestPage(value: unknown): AdminManualQuoteRequestPage {
  const record = requireRecord(value, "manual quote request page");

  if (!Array.isArray(record.items)) {
    throw new TypeError("Manual quote request page is missing items.");
  }

  return {
    items: record.items.map(normalizeManualQuoteRequest),
    nextCursor: nullableString(record.nextCursor),
  };
}

function normalizeManualQuoteCompletion(
  value: unknown,
): AdminManualQuoteCompletionResult {
  const record = requireRecord(value, "manual quote completion");
  const requestStatus = requireString(
    record,
    "requestStatus",
    "Manual quote completion",
  );
  const quoteRunStatus = requireString(
    record,
    "quoteRunStatus",
    "Manual quote completion",
  );
  const jobStatus = requireString(record, "jobStatus", "Manual quote completion");

  if (
    requestStatus !== "received"
    || quoteRunStatus !== "completed"
    || jobStatus !== "internal_review"
  ) {
    throw new Error("Manual quote completion returned an unexpected lifecycle state.");
  }

  return {
    quoteRequestId: requireString(
      record,
      "quoteRequestId",
      "Manual quote completion",
    ),
    quoteRunId: requireString(record, "quoteRunId", "Manual quote completion"),
    jobId: requireString(record, "jobId", "Manual quote completion"),
    partId: requireString(record, "partId", "Manual quote completion"),
    vendorQuoteResultId: requireString(
      record,
      "vendorQuoteResultId",
      "Manual quote completion",
    ),
    requestStatus,
    quoteRunStatus,
    jobStatus,
    eventId: requireString(record, "eventId", "Manual quote completion"),
    replayed: record.replayed === true,
  };
}

/**
 * Resolves the current user's server-provisioned manual-quote operator access.
 *
 * Listing requires the billing-admin capability. Exact completion additionally
 * requires an AAL2 session, which is enforced again by the completion RPC.
 */
export async function fetchManualQuoteOperatorAccess(): Promise<ManualQuoteOperatorAccess> {
  const [capabilityResult, aal2Result] = await Promise.all([
    callUntypedRpc("current_user_has_commercial_capability", {
      p_capability: "billing_admin",
    }),
    callUntypedRpc("current_user_has_aal2"),
  ]);

  const capability = ensureData(
    capabilityResult.data,
    capabilityResult.error,
  );
  const aal2 = ensureData(aal2Result.data, aal2Result.error);

  return {
    hasCapability: capability === true,
    hasAal2: aal2 === true,
  };
}

/**
 * Loads one capability-scoped page of active manual quote requests.
 *
 * The continuation token is intentionally opaque and must be returned
 * unchanged to the server.
 */
export async function fetchAdminManualQuoteRequests(input: {
  cursor?: string | null;
  limit?: number;
} = {}): Promise<AdminManualQuoteRequestPage> {
  const { data, error } = await callUntypedRpc(
    "api_admin_list_manual_quote_requests",
    {
      p_cursor: input.cursor ?? null,
      p_limit: input.limit ?? 25,
    },
  );

  return normalizeManualQuoteRequestPage(ensureData(data, error));
}

/**
 * Records a vendor quote and completes one exact manual request/run/job lineage.
 *
 * The server enforces billing-admin AAL2, lifecycle validity, and idempotency;
 * callers should reuse the same key only when retrying the identical intent.
 */
export async function completeAdminManualQuoteRequest(input: {
  quoteRequestId: string;
  quoteRunId: string;
  jobId: string;
  partId: string;
  vendor: VendorName;
  reason: string;
  idempotencyKey: string;
  status?: VendorStatus;
  summaryNote?: string;
  sourceText?: string;
  quoteUrl?: string;
  offers: ManualQuoteOfferInput[];
  artifacts?: ManualQuoteArtifactInput[];
}): Promise<AdminManualQuoteCompletionResult> {
  const { data, error } = await callUntypedRpc(
    "api_admin_complete_manual_quote_request",
    {
      p_quote_request_id: input.quoteRequestId,
      p_quote_run_id: input.quoteRunId,
      p_job_id: input.jobId,
      p_part_id: input.partId,
      p_vendor: input.vendor,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
      p_status: input.status ?? "official_quote_received",
      p_summary_note: input.summaryNote ?? null,
      p_source_text: input.sourceText ?? null,
      p_quote_url: input.quoteUrl ?? null,
      p_offers: input.offers,
      p_artifacts: input.artifacts ?? [],
    },
  );

  return normalizeManualQuoteCompletion(ensureData(data, error));
}
