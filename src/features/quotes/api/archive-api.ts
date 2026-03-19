import { supabase } from "@/integrations/supabase/client";
import type { ArchivedJobDeleteResult } from "@/features/quotes/types";
import type { Json } from "@/integrations/supabase/types";
import { FunctionsHttpError } from "@supabase/supabase-js";
import {
  ARCHIVED_DELETE_EDGE_NOT_DEPLOYED_MESSAGE,
  ARCHIVED_DELETE_EDGE_UNREACHABLE_MESSAGE,
  type ArchivedDeleteReporting,
  getArchivedDeleteErrorMessage,
  getArchivedDeleteReporting,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "@/features/quotes/archive-delete-errors";
import { getEdgeFunctionDebugInfo } from "@/features/quotes/edge-function-debug";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";
import {
  isMissingFunctionError,
  isMissingJobArchivingSchemaError,
  isMissingProjectCollaborationSchemaError,
} from "./shared/schema-errors";
import {
  ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE,
  JOB_ARCHIVING_UNAVAILABLE_MESSAGE,
  markJobArchivingSchemaAvailability,
} from "./shared/schema-runtime";

export class ArchivedDeleteCapabilityError extends Error {
  readonly dependency: "api_delete_archived_jobs" | "api_delete_archived_job";
  readonly reason: "missing_function" | "missing_schema";

  constructor(
    dependency: "api_delete_archived_jobs" | "api_delete_archived_job",
    reason: "missing_function" | "missing_schema",
    message = ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE,
  ) {
    super(message);
    this.name = "ArchivedDeleteCapabilityError";
    this.dependency = dependency;
    this.reason = reason;
  }
}

export function isArchivedDeleteCapabilityError(error: unknown): error is ArchivedDeleteCapabilityError {
  return error instanceof ArchivedDeleteCapabilityError;
}

async function invokeJobArchivingFallback(
  action: "archive" | "unarchive" | "delete",
  jobId: string,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("job-archive-fallback", {
    body: {
      action,
      jobId,
    },
  });

  if (error) {
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      let message = error.message;
      let hasResponseBody = false;

      try {
        const body = (await error.context.clone().json()) as { error?: unknown; message?: unknown };
        hasResponseBody = true;
        message =
          typeof body.error === "string"
            ? body.error
            : typeof body.message === "string"
              ? body.message
              : error.message;
      } catch {
        // Keep the original edge-function error when the body is not valid JSON.
      }

      throw withArchivedDeleteReporting(
        new Error(message),
        classifyArchivedDeleteEdgeFallbackError({
          error,
          message,
          functionName: "job-archive-fallback",
          httpStatus: error.context.status,
          hasResponseBody,
        }),
      );
    }

    throw withArchivedDeleteReporting(
      error,
      classifyArchivedDeleteEdgeFallbackError({
        error,
        message: getArchivedDeleteErrorMessage(error),
        functionName: "job-archive-fallback",
        httpStatus:
          typeof (error as { status?: unknown })?.status === "number"
            ? ((error as { status: number }).status as number)
            : null,
        hasResponseBody: false,
      }),
    );
  }

  if (!data || typeof data !== "object" || !("jobId" in data) || typeof data.jobId !== "string") {
    throw new Error("Expected a jobId from job-archive-fallback.");
  }

  return data.jobId;
}

function classifyArchivedDeleteEdgeFallbackError(input: {
  error: unknown;
  message: string;
  functionName: "job-archive-fallback";
  httpStatus: number | null;
  hasResponseBody: boolean;
}): ArchivedDeleteReporting {
  const normalizedMessage = input.message.trim();
  const lowerMessage = normalizedMessage.toLowerCase();
  const status = input.httpStatus;
  const debugInfo = getEdgeFunctionDebugInfo(input.functionName);
  const rawErrorName =
    input.error instanceof Error
      ? input.error.name
      : typeof (input.error as { name?: unknown })?.name === "string"
        ? ((input.error as { name: string }).name as string)
        : null;
  const rawErrorMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof (input.error as { message?: unknown })?.message === "string"
        ? ((input.error as { message: string }).message as string)
        : null;
  const rawErrorStatus =
    typeof (input.error as { status?: unknown })?.status === "number"
      ? ((input.error as { status: number }).status as number)
      : status;

  if (
    status === 404 ||
    lowerMessage.includes("function not found") ||
    lowerMessage.includes("could not find the function") ||
    lowerMessage.includes("cleanup service is not deployed")
  ) {
    return {
      operation: "archived_delete",
      fallbackPath: "job-archive-fallback",
      failureCategory: "edge_not_deployed",
      failureSummary: ARCHIVED_DELETE_EDGE_NOT_DEPLOYED_MESSAGE,
      likelyCause: "The job-archive-fallback Edge Function is unavailable in the active Supabase project.",
      recommendedChecks: [
        debugInfo.supabaseProjectRef
          ? `Verify that job-archive-fallback is deployed to Supabase project ${debugInfo.supabaseProjectRef}.`
          : "Verify that job-archive-fallback is deployed to the active Supabase project.",
        debugInfo.functionUrl
          ? `Confirm the app is pointed at ${debugInfo.supabaseOrigin} and expects ${debugInfo.functionUrl}.`
          : "Confirm the app is pointed at the same Supabase project where the function was deployed.",
      ],
      supabaseOrigin: debugInfo.supabaseOrigin,
      supabaseProjectRef: debugInfo.supabaseProjectRef,
      functionName: input.functionName,
      functionPath: debugInfo.functionPath,
      functionUrl: debugInfo.functionUrl,
      httpStatus: status,
      hasResponseBody: input.hasResponseBody,
      rawErrorName,
      rawErrorMessage,
      rawErrorStatus,
    };
  }

  if (
    lowerMessage.includes("service_role") ||
    lowerMessage.includes("service role") ||
    lowerMessage.includes("supabase_db_url") ||
    lowerMessage.includes("missing supabase function environment configuration") ||
    lowerMessage.includes("requires supabase_service_role_key")
  ) {
    return {
      operation: "archived_delete",
      fallbackPath: "job-archive-fallback",
      failureCategory: "edge_misconfigured",
      failureSummary: normalizedMessage,
      likelyCause: "The archived delete cleanup function is deployed but missing required environment configuration.",
      recommendedChecks: [
        debugInfo.supabaseProjectRef
          ? `Verify SUPABASE_DB_URL is configured for job-archive-fallback in Supabase project ${debugInfo.supabaseProjectRef}.`
          : "Verify SUPABASE_DB_URL is configured for job-archive-fallback.",
        debugInfo.supabaseProjectRef
          ? `Verify SUPABASE_SERVICE_ROLE_KEY is configured for job-archive-fallback in Supabase project ${debugInfo.supabaseProjectRef}.`
          : "Verify SUPABASE_SERVICE_ROLE_KEY is configured for job-archive-fallback.",
      ],
      supabaseOrigin: debugInfo.supabaseOrigin,
      supabaseProjectRef: debugInfo.supabaseProjectRef,
      functionName: input.functionName,
      functionPath: debugInfo.functionPath,
      functionUrl: debugInfo.functionUrl,
      httpStatus: status,
      hasResponseBody: input.hasResponseBody,
      rawErrorName,
      rawErrorMessage,
      rawErrorStatus,
    };
  }

  if (
    !input.hasResponseBody ||
    lowerMessage.includes("failed to send a request to the edge function") ||
    lowerMessage.includes("failed to fetch") ||
    lowerMessage.includes("networkerror") ||
    lowerMessage.includes("network request failed")
  ) {
    return {
      operation: "archived_delete",
      fallbackPath: "job-archive-fallback",
      failureCategory: "edge_unreachable",
      failureSummary: ARCHIVED_DELETE_EDGE_UNREACHABLE_MESSAGE,
      likelyCause: "The app could not reach the job-archive-fallback Edge Function endpoint.",
      recommendedChecks: [
        debugInfo.supabaseProjectRef
          ? `Verify Edge Function deployment status for job-archive-fallback in Supabase project ${debugInfo.supabaseProjectRef}.`
          : "Verify Edge Function deployment status for job-archive-fallback.",
        debugInfo.functionUrl
          ? `Verify the Supabase function endpoint ${debugInfo.functionUrl} is reachable from the current environment.`
          : "Verify the Supabase function endpoint is reachable from the current environment.",
      ],
      supabaseOrigin: debugInfo.supabaseOrigin,
      supabaseProjectRef: debugInfo.supabaseProjectRef,
      functionName: input.functionName,
      functionPath: debugInfo.functionPath,
      functionUrl: debugInfo.functionUrl,
      httpStatus: status,
      hasResponseBody: input.hasResponseBody,
      rawErrorName,
      rawErrorMessage,
      rawErrorStatus,
    };
  }

  return {
    operation: "archived_delete",
    fallbackPath: "job-archive-fallback",
    failureCategory: "edge_http_error",
    failureSummary: normalizedMessage || ARCHIVED_DELETE_EDGE_UNREACHABLE_MESSAGE,
    likelyCause: "The cleanup service returned an HTTP error during archived part deletion.",
    recommendedChecks: [
      "Inspect the raw event/error details included in the copied diagnostics report.",
    ],
    supabaseOrigin: debugInfo.supabaseOrigin,
    supabaseProjectRef: debugInfo.supabaseProjectRef,
    functionName: input.functionName,
    functionPath: debugInfo.functionPath,
    functionUrl: debugInfo.functionUrl,
    httpStatus: status,
    hasResponseBody: input.hasResponseBody,
    rawErrorName,
    rawErrorMessage,
    rawErrorStatus,
  };
}

function normalizeArchivedJobDeleteResult(data: Json | null): ArchivedJobDeleteResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected archived job delete results from api_delete_archived_jobs.");
  }

  const payload = data as Record<string, unknown>;

  if (!Array.isArray(payload.deletedJobIds)) {
    throw new Error("api_delete_archived_jobs returned an invalid deletedJobIds field.");
  }

  if (!Array.isArray(payload.failures)) {
    throw new Error("api_delete_archived_jobs returned an invalid failures field.");
  }

  const deletedJobIds = payload.deletedJobIds.filter((value): value is string => typeof value === "string");
  const failures = payload.failures.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }

    const jobId = typeof value.jobId === "string" ? value.jobId : null;
    const message = typeof value.message === "string" ? value.message : null;
    const reporting = getArchivedDeleteReporting(value);

    return jobId && message ? [{ jobId, message, ...(reporting ? { reporting } : {}) }] : [];
  });

  return {
    deletedJobIds,
    failures,
  };
}

function logArchivedDeleteCapabilityIssue(context: {
  operation: "single" | "bulk";
  jobIds: string[];
  reason: string;
  error: unknown;
}): void {
  const message =
    context.error instanceof Error
      ? context.error.message
      : typeof context.error === "object" && context.error !== null && "message" in context.error
        ? String((context.error as { message?: unknown }).message)
        : String(context.error);

  console.error("Archived delete capability unavailable", {
    operation: context.operation,
    jobIds: context.jobIds,
    reason: context.reason,
    error: context.error,
    message,
  });
}

type ArchivedDeleteLegacySuccess = {
  ok: true;
  jobId: string;
};

type ArchivedDeleteLegacyFailure = {
  ok: false;
  kind: "missing_legacy_rpc" | "missing_archive_schema" | "failure";
  error: unknown;
  message: string;
};

type ArchivedDeleteLegacyCapabilityFailure = {
  ok: false;
  kind: "missing_legacy_rpc" | "missing_archive_schema";
  error: unknown;
  message: string;
};

type ArchivedDeleteLegacyAttempt = ArchivedDeleteLegacySuccess | ArchivedDeleteLegacyFailure;

const ARCHIVED_DELETE_LEGACY_BATCH_SIZE = 10;
const DIRECT_STORAGE_DELETE_DISALLOWED_MESSAGE =
  "Direct deletion from storage tables is not allowed. Use the Storage API instead.";

function isArchivedDeleteLegacyCapabilityFailure(
  result: ArchivedDeleteLegacyAttempt,
): result is ArchivedDeleteLegacyCapabilityFailure {
  if ("jobId" in result) {
    return false;
  }

  return result.kind === "missing_legacy_rpc" || result.kind === "missing_archive_schema";
}

function requiresStorageApiArchivedDeleteFallback(error: unknown): boolean {
  return getArchivedDeleteErrorMessage(error).includes(DIRECT_STORAGE_DELETE_DISALLOWED_MESSAGE);
}

async function deleteArchivedJobsViaEdgeFallback(jobIds: string[]): Promise<ArchivedJobDeleteResult> {
  const deletedJobIds: string[] = [];
  const failures: ArchivedJobDeleteResult["failures"] = [];

  for (let index = 0; index < jobIds.length; index += ARCHIVED_DELETE_LEGACY_BATCH_SIZE) {
    const batchJobIds = jobIds.slice(index, index + ARCHIVED_DELETE_LEGACY_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batchJobIds.map(async (jobId) => {
        const deletedJobId = await invokeJobArchivingFallback("delete", jobId);
        return {
          requestedJobId: jobId,
          deletedJobId,
        };
      }),
    );

    batchResults.forEach((result, batchIndex) => {
      const jobId = batchJobIds[batchIndex];

      if (result.status === "fulfilled") {
        deletedJobIds.push(result.value.deletedJobId);
        return;
      }

      failures.push({
        jobId,
        message: toArchivedDeleteError(result.reason).message,
        reporting: getArchivedDeleteReporting(result.reason) ?? undefined,
      });
    });
  }

  return {
    deletedJobIds,
    failures,
  };
}

async function deleteArchivedJobLegacy(jobId: string): Promise<ArchivedDeleteLegacyAttempt> {
  const { data, error } = await callRpc("api_delete_archived_job", {
    p_job_id: jobId,
  });

  if (!error) {
    markJobArchivingSchemaAvailability("available");
    return {
      ok: true,
      jobId: ensureData(data, null),
    };
  }

  if (isMissingFunctionError(error, "api_delete_archived_job")) {
    return {
      ok: false,
      kind: "missing_legacy_rpc",
      error,
      message: ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE,
    };
  }

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");
    return {
      ok: false,
      kind: "missing_archive_schema",
      error,
      message: ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE,
    };
  }

  if (requiresStorageApiArchivedDeleteFallback(error)) {
    try {
      const deletedJobId = await invokeJobArchivingFallback("delete", jobId);
      return {
        ok: true,
        jobId: deletedJobId,
      };
    } catch (fallbackError) {
      return {
        ok: false,
        kind: "failure",
        error: fallbackError,
        message: toArchivedDeleteError(fallbackError).message,
      };
    }
  }

  return {
    ok: false,
    kind: "failure",
    error,
    message: toArchivedDeleteError(error).message,
  };
}

export async function archiveJob(jobId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.archiveJob(jobId);
  }

  const { data, error } = await callRpc("api_archive_job", {
    p_job_id: jobId,
  });

  if (!error) {
    markJobArchivingSchemaAvailability("available");
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_archive_job") || isMissingProjectCollaborationSchemaError(error)) {
    try {
      const archivedJobId = await invokeJobArchivingFallback("archive", jobId);
      markJobArchivingSchemaAvailability("available");
      return archivedJobId;
    } catch (fallbackError) {
      if (isMissingJobArchivingSchemaError(fallbackError)) {
        markJobArchivingSchemaAvailability("unavailable");
        throw new Error(JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
      }

      throw fallbackError;
    }
  }

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");
    throw new Error(JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
  }

  throw error;
}

export async function unarchiveJob(jobId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.unarchiveJob(jobId);
  }

  const { data, error } = await callRpc("api_unarchive_job", {
    p_job_id: jobId,
  });

  if (!error) {
    markJobArchivingSchemaAvailability("available");
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_unarchive_job")) {
    try {
      const restoredJobId = await invokeJobArchivingFallback("unarchive", jobId);
      markJobArchivingSchemaAvailability("available");
      return restoredJobId;
    } catch (fallbackError) {
      if (isMissingJobArchivingSchemaError(fallbackError)) {
        markJobArchivingSchemaAvailability("unavailable");
        throw new Error(JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
      }

      throw fallbackError;
    }
  }

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");
    throw new Error(JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
  }

  throw error;
}

export async function deleteArchivedJob(jobId: string): Promise<string> {
  const result = await deleteArchivedJobs([jobId]);

  if (result.deletedJobIds[0]) {
    return result.deletedJobIds[0];
  }

  if (result.failures[0]) {
    const failure = result.failures[0];

    throw failure.reporting
      ? withArchivedDeleteReporting(new Error(failure.message), {
          ...failure.reporting,
          partIds: failure.reporting.partIds.length > 0 ? failure.reporting.partIds : [jobId],
        })
      : new Error(failure.message);
  }

  throw new Error("Expected api_delete_archived_jobs to delete the archived part.");
}

export async function deleteArchivedJobs(jobIds: string[]): Promise<ArchivedJobDeleteResult> {
  const normalizedIds = [...new Set(jobIds.filter((jobId) => jobId.trim().length > 0))];
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (normalizedIds.length === 0) {
    return {
      deletedJobIds: [],
      failures: [],
    };
  }

  if (fixtureGateway) {
    return fixtureGateway.deleteArchivedJobs(normalizedIds);
  }

  const { data, error } = await callRpc("api_delete_archived_jobs", {
    p_job_ids: normalizedIds,
  });

  if (!error) {
    markJobArchivingSchemaAvailability("available");
    return normalizeArchivedJobDeleteResult(data);
  }

  if (isMissingFunctionError(error, "api_delete_archived_jobs")) {
    logArchivedDeleteCapabilityIssue({
      operation: normalizedIds.length > 1 ? "bulk" : "single",
      jobIds: normalizedIds,
      reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      error,
    });

    const legacyResults: ArchivedDeleteLegacyAttempt[] = [];

    for (let index = 0; index < normalizedIds.length; index += ARCHIVED_DELETE_LEGACY_BATCH_SIZE) {
      const batchJobIds = normalizedIds.slice(index, index + ARCHIVED_DELETE_LEGACY_BATCH_SIZE);
      legacyResults.push(...(await Promise.all(batchJobIds.map((jobId) => deleteArchivedJobLegacy(jobId)))));
    }

    const legacyCapabilityFailure = legacyResults.find(isArchivedDeleteLegacyCapabilityFailure);

    if (legacyCapabilityFailure) {
      logArchivedDeleteCapabilityIssue({
        operation: normalizedIds.length > 1 ? "bulk" : "single",
        jobIds: normalizedIds,
        reason:
          legacyCapabilityFailure.kind === "missing_legacy_rpc"
            ? "api_delete_archived_job unavailable; archive delete migrations missing or schema cache is stale"
            : "archive delete schema unavailable while resolving legacy single-delete contract",
        error: legacyCapabilityFailure.error,
      });

      throw new ArchivedDeleteCapabilityError(
        "api_delete_archived_job",
        legacyCapabilityFailure.kind === "missing_legacy_rpc" ? "missing_function" : "missing_schema",
      );
    }

    const deletedJobIds: string[] = [];
    const failures = legacyResults.flatMap((result, index) => {
      if ("jobId" in result) {
        deletedJobIds.push(result.jobId);
        return [];
      }

      return [
        {
          jobId: normalizedIds[index],
          message: result.message,
        },
      ];
    });

    if (deletedJobIds.length > 0 || failures.length > 0) {
      return {
        deletedJobIds,
        failures,
      };
    }

    throw new Error(ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE);
  }

  if (isMissingJobArchivingSchemaError(error)) {
    markJobArchivingSchemaAvailability("unavailable");
    logArchivedDeleteCapabilityIssue({
      operation: normalizedIds.length > 1 ? "bulk" : "single",
      jobIds: normalizedIds,
      reason: "archive delete schema unavailable while calling api_delete_archived_jobs",
      error,
    });
    throw new ArchivedDeleteCapabilityError("api_delete_archived_jobs", "missing_schema");
  }

  if (requiresStorageApiArchivedDeleteFallback(error)) {
    const fallbackResult = await deleteArchivedJobsViaEdgeFallback(normalizedIds);

    if (fallbackResult.deletedJobIds.length > 0 || fallbackResult.failures.length > 0) {
      return fallbackResult;
    }
  }

  throw toArchivedDeleteError(error);
}
