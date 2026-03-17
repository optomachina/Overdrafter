import { getUserFacingErrorMessage, toUserFacingError } from "@/lib/error-message";

const ARCHIVED_DELETE_FALLBACK_MESSAGE = "Failed to delete archived part.";
const ARCHIVED_DELETE_RELATED_RECORDS_MESSAGE =
  "Failed to delete archived part because related records still exist.";
const ARCHIVED_DELETE_EDGE_UNREACHABLE_MESSAGE =
  "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.";
const ARCHIVED_DELETE_EDGE_NOT_DEPLOYED_MESSAGE =
  "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.";

export type ArchivedDeleteFailureCategory =
  | "edge_unreachable"
  | "edge_not_deployed"
  | "edge_http_error"
  | "edge_misconfigured"
  | "related_records"
  | "unknown";

export type ArchivedDeleteReporting = {
  operation: "archived_delete";
  fallbackPath: "job-archive-fallback";
  failureCategory: ArchivedDeleteFailureCategory;
  failureSummary: string;
  likelyCause: string;
  recommendedChecks: string[];
  supabaseOrigin?: string | null;
  supabaseProjectRef?: string | null;
  functionName?: string | null;
  functionPath?: string | null;
  functionUrl?: string | null;
  httpStatus?: number | null;
  hasResponseBody?: boolean | null;
  rawErrorName?: string | null;
  rawErrorMessage?: string | null;
  rawErrorStatus?: number | null;
  partIds?: string[];
  organizationId?: string | null;
  userId?: string | null;
};

type ArchivedDeleteErrorWithReporting = Error & {
  reporting?: ArchivedDeleteReporting;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  statusText?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRelatedRecordsConstraintError(error: unknown, message: string): boolean {
  if (isRecord(error) && error.code === "23503") {
    return true;
  }

  return (
    message.includes("violates foreign key constraint") || message.includes("is still referenced from table")
  );
}

function isArchivedDeleteFailureCategory(value: unknown): value is ArchivedDeleteFailureCategory {
  return (
    value === "edge_unreachable" ||
    value === "edge_not_deployed" ||
    value === "edge_http_error" ||
    value === "edge_misconfigured" ||
    value === "related_records" ||
    value === "unknown"
  );
}

function normalizeArchivedDeleteReporting(reporting: unknown): ArchivedDeleteReporting | null {
  if (!isRecord(reporting)) {
    return null;
  }

  if (
    reporting.operation !== "archived_delete" ||
    reporting.fallbackPath !== "job-archive-fallback" ||
    !isArchivedDeleteFailureCategory(reporting.failureCategory) ||
    typeof reporting.failureSummary !== "string" ||
    typeof reporting.likelyCause !== "string" ||
    !isStringArray(reporting.recommendedChecks)
  ) {
    return null;
  }

  return {
    operation: "archived_delete",
    fallbackPath: "job-archive-fallback",
    failureCategory: reporting.failureCategory,
    failureSummary: reporting.failureSummary,
    likelyCause: reporting.likelyCause,
    recommendedChecks: reporting.recommendedChecks,
    supabaseOrigin: typeof reporting.supabaseOrigin === "string" ? reporting.supabaseOrigin : null,
    supabaseProjectRef: typeof reporting.supabaseProjectRef === "string" ? reporting.supabaseProjectRef : null,
    functionName: typeof reporting.functionName === "string" ? reporting.functionName : null,
    functionPath: typeof reporting.functionPath === "string" ? reporting.functionPath : null,
    functionUrl: typeof reporting.functionUrl === "string" ? reporting.functionUrl : null,
    httpStatus: typeof reporting.httpStatus === "number" ? reporting.httpStatus : null,
    hasResponseBody: typeof reporting.hasResponseBody === "boolean" ? reporting.hasResponseBody : null,
    rawErrorName: typeof reporting.rawErrorName === "string" ? reporting.rawErrorName : null,
    rawErrorMessage: typeof reporting.rawErrorMessage === "string" ? reporting.rawErrorMessage : null,
    rawErrorStatus: typeof reporting.rawErrorStatus === "number" ? reporting.rawErrorStatus : null,
    partIds: isStringArray(reporting.partIds) ? reporting.partIds : [],
    organizationId: typeof reporting.organizationId === "string" ? reporting.organizationId : null,
    userId: typeof reporting.userId === "string" ? reporting.userId : null,
  };
}

export function getArchivedDeleteReporting(error: unknown): ArchivedDeleteReporting | null {
  if (error instanceof Error && isRecord(error)) {
    return normalizeArchivedDeleteReporting(error.reporting);
  }

  if (isRecord(error)) {
    return normalizeArchivedDeleteReporting(error.reporting);
  }

  return null;
}

export function withArchivedDeleteReporting(error: unknown, reporting: ArchivedDeleteReporting): Error {
  const wrapped = toArchivedDeleteError(error, reporting.failureSummary) as ArchivedDeleteErrorWithReporting;
  wrapped.reporting = reporting;

  if (wrapped.status == null && reporting.httpStatus != null) {
    wrapped.status = reporting.httpStatus;
  }

  return wrapped;
}

function normalizeArchivedDeleteErrorMessage(error: unknown, fallback: string): string {
  const reporting = getArchivedDeleteReporting(error);

  if (reporting) {
    return reporting.failureSummary;
  }

  const message = getUserFacingErrorMessage(error, fallback);

  if (isRelatedRecordsConstraintError(error, message)) {
    return ARCHIVED_DELETE_RELATED_RECORDS_MESSAGE;
  }

  return message;
}

export function toArchivedDeleteError(error: unknown, fallback = ARCHIVED_DELETE_FALLBACK_MESSAGE): Error {
  const normalizedMessage = normalizeArchivedDeleteErrorMessage(error, fallback);
  const reporting = getArchivedDeleteReporting(error);

  if (error instanceof Error && error.message.trim() && error.message === normalizedMessage) {
    if (reporting) {
      (error as ArchivedDeleteErrorWithReporting).reporting = reporting;
    }
    return error;
  }

  const wrapped = toUserFacingError(error, fallback);
  wrapped.message = normalizedMessage;
  if (reporting) {
    (wrapped as ArchivedDeleteErrorWithReporting).reporting = reporting;
  }
  return wrapped;
}

export function getArchivedDeleteErrorMessage(
  error: unknown,
  fallback = ARCHIVED_DELETE_FALLBACK_MESSAGE,
): string {
  return normalizeArchivedDeleteErrorMessage(error, fallback);
}

export function logArchivedDeleteFailure(input: {
  error: unknown;
  jobIds: string[];
  organizationId?: string | null;
  userId?: string | null;
}): void {
  const surfacedError = toArchivedDeleteError(input.error);
  const surfacedErrorWithStatus = surfacedError as Error & { status?: unknown };
  const existingReporting = getArchivedDeleteReporting(input.error) ?? getArchivedDeleteReporting(surfacedError);
  const reporting: ArchivedDeleteReporting = existingReporting ?? {
    operation: "archived_delete",
    fallbackPath: "job-archive-fallback",
    failureCategory: "unknown",
    failureSummary: surfacedError.message,
    likelyCause: "The archived delete flow failed outside the expected RPC or edge fallback categories.",
    recommendedChecks: ["Inspect the raw error payload and recent diagnostics events in the copied report."],
    supabaseOrigin: null,
    supabaseProjectRef: null,
    functionName: null,
    functionPath: null,
    functionUrl: null,
    httpStatus: null,
    hasResponseBody: null,
    rawErrorName: surfacedError.name,
    rawErrorMessage: surfacedError.message,
    rawErrorStatus: typeof surfacedErrorWithStatus.status === "number" ? surfacedErrorWithStatus.status : null,
    partIds: input.jobIds,
    organizationId: input.organizationId ?? null,
    userId: input.userId ?? null,
  };

  console.error("Archived part delete failed", {
    error: input.error,
    jobIds: input.jobIds,
    organizationId: input.organizationId ?? null,
    userId: input.userId ?? null,
    message: surfacedError.message,
    reporting: {
      ...reporting,
      partIds: input.jobIds,
      organizationId: input.organizationId ?? null,
      userId: input.userId ?? null,
    },
  });
}

export {
  ARCHIVED_DELETE_EDGE_NOT_DEPLOYED_MESSAGE,
  ARCHIVED_DELETE_EDGE_UNREACHABLE_MESSAGE,
  ARCHIVED_DELETE_FALLBACK_MESSAGE,
};
