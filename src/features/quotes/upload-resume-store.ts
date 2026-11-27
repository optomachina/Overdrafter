import { useSyncExternalStore } from "react";

/**
 * The last multi-file upload, kept in tab storage so a reload can still say
 * which files never landed and which project they belong to.
 * Records older than 24 hours are ignored.
 */
export const UPLOAD_RESUME_KEY = "ovd.uploadResume";
export const UPLOAD_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type UploadResumeRecord = {
  projectId: string;
  expectedNames: string[];
  doneNames: string[];
  startedAt: number;
};

const listeners = new Set<() => void>();
let snapshot: UploadResumeRecord | null = null;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function tabStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isUploadResumeRecord(value: unknown): value is UploadResumeRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as UploadResumeRecord;
  return typeof record.projectId === "string"
    && record.projectId.length > 0
    && Array.isArray(record.expectedNames)
    && record.expectedNames.every((name) => typeof name === "string")
    && Array.isArray(record.doneNames)
    && record.doneNames.every((name) => typeof name === "string")
    && typeof record.startedAt === "number"
    && Number.isFinite(record.startedAt);
}

function parseStored(raw: string | null, now: number): UploadResumeRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isUploadResumeRecord(parsed)) {
      return null;
    }
    if (now - parsed.startedAt > UPLOAD_RESUME_MAX_AGE_MS) {
      return null;
    }
    return {
      projectId: parsed.projectId,
      expectedNames: [...parsed.expectedNames],
      doneNames: [...parsed.doneNames],
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

function sameRecord(left: UploadResumeRecord | null, right: UploadResumeRecord | null): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.projectId === right.projectId
    && left.startedAt === right.startedAt
    && left.expectedNames.length === right.expectedNames.length
    && left.doneNames.length === right.doneNames.length
    && left.expectedNames.every((name, index) => name === right.expectedNames[index])
    && left.doneNames.every((name, index) => name === right.doneNames[index]);
}

function persist(record: UploadResumeRecord | null): void {
  const storage = tabStorage();
  try {
    if (storage) {
      if (record) {
        storage.setItem(UPLOAD_RESUME_KEY, JSON.stringify(record));
      } else {
        storage.removeItem(UPLOAD_RESUME_KEY);
      }
    }
  } catch {
    return;
  }
  snapshot = record;
  emit();
}

export function readUploadResume(now = Date.now()): UploadResumeRecord | null {
  return parseStored(tabStorage()?.getItem(UPLOAD_RESUME_KEY) ?? null, now);
}

export function beginUploadResume(input: {
  projectId: string;
  expectedNames: readonly string[];
}): void {
  if (!input.projectId) {
    return;
  }
  persist({
    projectId: input.projectId,
    expectedNames: [...input.expectedNames],
    doneNames: [],
    startedAt: Date.now(),
  });
}

/** Replace the finished names. The start time stays on the record opened for this batch. */
export function noteUploadResumeProgress(doneNames: readonly string[]): void {
  const current = readUploadResume();
  if (!current) {
    return;
  }
  persist({
    ...current,
    doneNames: [...doneNames],
  });
}

export function clearUploadResume(): void {
  persist(null);
}

export function unfinishedUploadNames(record: UploadResumeRecord): string[] {
  const done = new Set(record.doneNames);
  return record.expectedNames.filter((name) => !done.has(name));
}

export function formatUnfinishedUploadMessage(names: readonly string[]): string {
  const label = names.length === 1 ? "file" : "files";
  return `${names.length} ${label} from your last upload didn't finish: ${names.join(", ")}`;
}

export function getUploadResumeSnapshot(): UploadResumeRecord | null {
  const next = readUploadResume();
  if (sameRecord(snapshot, next)) {
    return snapshot;
  }
  snapshot = next;
  return snapshot;
}

export function subscribeUploadResume(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUploadResumeRecord(): UploadResumeRecord | null {
  return useSyncExternalStore(subscribeUploadResume, getUploadResumeSnapshot, () => null);
}

export function resetUploadResumeStoreForTests(): void {
  try {
    tabStorage()?.removeItem(UPLOAD_RESUME_KEY);
  } catch {
    // The tab storage is already unavailable.
  }
  snapshot = null;
  emit();
}
