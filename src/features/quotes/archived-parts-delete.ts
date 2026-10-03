import { toast } from "sonner";

import { deleteArchivedJobs, isArchivedDeleteCapabilityError } from "@/features/quotes/api/archive-api";
import {
  logArchivedDeleteFailure,
  toArchivedDeleteError,
  withArchivedDeleteReporting,
} from "@/features/quotes/archive-delete-errors";

type DeleteArchivedPartsOptions = {
  jobIds: string[];
  organizationId: string | undefined;
  userId: string | undefined;
  /** Controller-specific cache invalidation, run after the delete call resolves. */
  invalidate: (normalizedIds: string[]) => Promise<unknown>;
};

/** Shared archived-part delete flow (toasts, reporting, logging) for the client controllers. */
export async function deleteArchivedPartsWithFeedback({
  jobIds,
  organizationId,
  userId,
  invalidate,
}: DeleteArchivedPartsOptions): Promise<void> {
  const normalizedIds = [...new Set(jobIds)];

  if (normalizedIds.length === 0) {
    toast.error("No archived parts selected.");
    return;
  }

  try {
    const result = await deleteArchivedJobs(normalizedIds);
    await invalidate(normalizedIds);

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
            partIds: failure.reporting.partIds?.length ? failure.reporting.partIds : normalizedIds,
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
        organizationId,
        userId,
      });
    }
    toast.error(surfacedError.message);
    throw surfacedError;
  }
}
