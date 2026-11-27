import { useSyncExternalStore } from "react";

export type UploadGroupFailure = {
  fileNames: string[];
  reason: string;
};

export type UploadBatchResult = {
  jobIds: string[];
  projectId: string | null;
  failed: UploadGroupFailure[];
  warnings: string[];
};

export type UploadBatchSnapshot = {
  phase: "running" | "complete";
  totalGroups: number;
  finishedGroups: number;
  result: UploadBatchResult;
};

let snapshot: UploadBatchSnapshot | null = null;
const listeners = new Set<() => void>();
// A sign-out or dismiss advances the seal. A batch that started under an older
// seal cannot publish over whatever the next user is looking at.
let seal = 0;
let nextId = 0;
let activeId = 0;

export function readUploadBatchSeal(): number {
  return seal;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getUploadBatchSnapshot(): UploadBatchSnapshot | null {
  return snapshot;
}

export function subscribeUploadBatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUploadBatchSnapshot(): UploadBatchSnapshot | null {
  return useSyncExternalStore(subscribeUploadBatch, getUploadBatchSnapshot, () => null);
}

export function beginUploadBatch(
  sealAtStart: number,
  input: {
    totalGroups: number;
    warnings: string[];
    projectId: string | null;
  },
): number | null {
  if (sealAtStart !== seal) {
    return null;
  }
  const id = ++nextId;
  activeId = id;
  snapshot = {
    phase: "running",
    totalGroups: input.totalGroups,
    finishedGroups: 0,
    result: {
      jobIds: [],
      projectId: input.projectId,
      failed: [],
      warnings: input.warnings,
    },
  };
  emit();
  return id;
}

function isActiveBatch(id: number): boolean {
  return id === activeId && snapshot !== null;
}

export function publishUploadBatchProgress(
  id: number,
  input: {
    finishedGroups: number;
    projectId: string | null;
    jobIds: string[];
    failed: UploadGroupFailure[];
  },
): void {
  if (!isActiveBatch(id) || !snapshot || snapshot.phase !== "running") {
    return;
  }
  snapshot = {
    ...snapshot,
    finishedGroups: input.finishedGroups,
    result: {
      ...snapshot.result,
      projectId: input.projectId,
      jobIds: [...input.jobIds],
      failed: input.failed.map((failure) => ({
        fileNames: [...failure.fileNames],
        reason: failure.reason,
      })),
    },
  };
  emit();
}

export function completeUploadBatch(result: UploadBatchResult, id?: number): void {
  if (id !== undefined && !isActiveBatch(id)) {
    return;
  }
  const totalGroups = snapshot?.totalGroups ?? result.jobIds.length + result.failed.length;
  snapshot = {
    phase: "complete",
    totalGroups,
    finishedGroups: totalGroups,
    result,
  };
  emit();
}

export function clearUploadBatch(id?: number): void {
  if (id !== undefined && id !== activeId) {
    return;
  }
  seal += 1;
  activeId = 0;
  snapshot = null;
  emit();
}

export function resetUploadBatchStoreForTests(): void {
  seal = 0;
  nextId = 0;
  activeId = 0;
  snapshot = null;
  emit();
}

export function uploadLocationKey(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return `${window.location.pathname}${window.location.search}`;
}

/** Where to send the user who is still on the page that started the batch. */
export function pathAfterUploadBatch(result: {
  jobIds: readonly string[];
  projectId: string | null;
  failed?: readonly unknown[];
}): string | null {
  const firstJobId = result.jobIds[0];
  if (!firstJobId) {
    return null;
  }
  const failedCount = result.failed?.length ?? 0;
  if (result.projectId && (result.jobIds.length > 1 || failedCount > 0)) {
    return `/projects/${result.projectId}`;
  }
  return `/parts/${firstJobId}`;
}

/**
 * In-app navigation while the batch is running keeps the stored result and
 * does not pull the user back to the upload page.
 */
export function navigationPathAfterUploadBatch(
  result: {
    jobIds: readonly string[];
    projectId: string | null;
    failed?: readonly unknown[];
  },
  locationAtStart: string,
): string | null {
  if (uploadLocationKey() !== locationAtStart) {
    return null;
  }
  return pathAfterUploadBatch(result);
}

export function formatUploadBatchMessage(batch: UploadBatchSnapshot): string {
  if (batch.phase === "running") {
    return `Uploading ${batch.finishedGroups} of ${batch.totalGroups}.`;
  }
  const uploaded = batch.result.jobIds.length;
  const failedCount = batch.result.failed.length;
  if (failedCount === 0) {
    return `Uploaded ${uploaded} of ${batch.totalGroups}.`;
  }
  const details = batch.result.failed
    .map((failure) => {
      const names = failure.fileNames.join(", ");
      return failure.reason ? `${names} (${failure.reason})` : names;
    })
    .join("; ");
  return `Uploaded ${uploaded} of ${batch.totalGroups}. ${failedCount} didn't finish: ${details}`;
}
