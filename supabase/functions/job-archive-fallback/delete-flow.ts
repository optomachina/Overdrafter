export const ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE =
  "Archived part deletion failed during storage cleanup. No records were deleted. Please retry.";

export class ArchivedDeleteFlowError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type StorageCandidate = {
  bucket: string;
  path: string;
};

export type ArchivedDeletePlan = {
  job: {
    id: string;
  };
  orphanBlobIds: string[];
  storageCandidates: StorageCandidate[];
};

export async function executeArchivedDelete(input: {
  deletePlan: ArchivedDeletePlan;
  hasStorageServiceRoleKey: boolean;
  missingServiceRoleMessage: string;
  storageCleanupFailureMessage?: string;
  removeStorageCandidates: (
    jobId: string,
    storageCandidates: StorageCandidate[],
  ) => Promise<boolean>;
  commitDelete: (deletePlan: ArchivedDeletePlan) => Promise<void>;
}): Promise<string> {
  const {
    deletePlan,
    hasStorageServiceRoleKey,
    missingServiceRoleMessage,
    storageCleanupFailureMessage = ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE,
    removeStorageCandidates,
    commitDelete,
  } = input;

  if (deletePlan.storageCandidates.length > 0) {
    if (!hasStorageServiceRoleKey) {
      throw new ArchivedDeleteFlowError(500, missingServiceRoleMessage);
    }

    const storageCleanupSucceeded = await removeStorageCandidates(
      deletePlan.job.id,
      deletePlan.storageCandidates,
    );

    if (!storageCleanupSucceeded) {
      throw new ArchivedDeleteFlowError(500, storageCleanupFailureMessage);
    }
  }

  await commitDelete(deletePlan);
  return deletePlan.job.id;
}
