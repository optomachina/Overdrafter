import { getUserFacingErrorMessage, toUserFacingError } from "@/lib/error-message";

const ARCHIVED_DELETE_FALLBACK_MESSAGE = "Failed to delete archived part.";

export function toArchivedDeleteError(error: unknown, fallback = ARCHIVED_DELETE_FALLBACK_MESSAGE): Error {
  return error instanceof Error ? error : toUserFacingError(error, fallback);
}

export function getArchivedDeleteErrorMessage(
  error: unknown,
  fallback = ARCHIVED_DELETE_FALLBACK_MESSAGE,
): string {
  return getUserFacingErrorMessage(error, fallback);
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
