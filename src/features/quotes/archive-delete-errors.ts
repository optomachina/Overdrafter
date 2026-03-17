import { getUserFacingErrorMessage, toUserFacingError } from "@/lib/error-message";

const ARCHIVED_DELETE_FALLBACK_MESSAGE = "Failed to delete archived part.";
const ARCHIVED_DELETE_RELATED_RECORDS_MESSAGE =
  "Failed to delete archived part because related records still exist.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRelatedRecordsConstraintError(error: unknown, message: string): boolean {
  if (isRecord(error) && error.code === "23503") {
    return true;
  }

  return (
    message.includes("violates foreign key constraint") || message.includes("is still referenced from table")
  );
}

function normalizeArchivedDeleteErrorMessage(error: unknown, fallback: string): string {
  const message = getUserFacingErrorMessage(error, fallback);

  if (isRelatedRecordsConstraintError(error, message)) {
    return ARCHIVED_DELETE_RELATED_RECORDS_MESSAGE;
  }

  return message;
}

export function toArchivedDeleteError(error: unknown, fallback = ARCHIVED_DELETE_FALLBACK_MESSAGE): Error {
  const normalizedMessage = normalizeArchivedDeleteErrorMessage(error, fallback);

  if (error instanceof Error && error.message.trim() && error.message === normalizedMessage) {
    return error;
  }

  const wrapped = toUserFacingError(error, fallback);
  wrapped.message = normalizedMessage;
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
  console.error("Archived part delete failed", {
    error: input.error,
    jobIds: input.jobIds,
    organizationId: input.organizationId ?? null,
    userId: input.userId ?? null,
    message: getArchivedDeleteErrorMessage(input.error),
  });
}
