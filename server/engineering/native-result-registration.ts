import { createHash } from "node:crypto";
import { NATIVE_RESULT_ROLE_LIMITS, type NativeResultRole } from "./native-result-bytes";

/** These identities must come from a private attempt/Storage lookup. Worker
 * paths, URLs, digests and byte counts are never accepted as authority. */
export type NativeRegistrationAdmission = Readonly<{
  taskId: string; attemptId: string; organizationId: string; projectId: string;
  fence: number; inputSnapshotId: string; candidateSnapshotId: string;
  role: NativeResultRole; storageObjectId: string; bucketId: string;
  objectName: string; storageVersion: string; storageUpdatedAt: string;
}>;
export type MeasuredNativeRegistration = Readonly<NativeRegistrationAdmission & {
  byteLength: number; sha256: string;
}>;

/** The writer must call the owner-only SQL registration function, which locks
 * the attempt and checks tenant, fence, current attempt, Storage ID/version and
 * exact replay. This source slice supplies no credential or upload route. */
export type NativeRegistrationRepository = Readonly<{
  loadAdmission: (taskId: string, attemptId: string, role: NativeResultRole) => Promise<NativeRegistrationAdmission | null>;
  readUploadedObject: (storageObjectId: string, signal: AbortSignal) => Promise<Response>;
  registerMeasuredObject: (registration: MeasuredNativeRegistration) => Promise<boolean>;
}>;

function validAdmission(admission: NativeRegistrationAdmission, taskId: string, attemptId: string, role: NativeResultRole) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  if (admission.taskId !== taskId || admission.attemptId !== attemptId || admission.role !== role
    || ![admission.taskId, admission.attemptId, admission.organizationId, admission.projectId,
      admission.inputSnapshotId, admission.candidateSnapshotId, admission.storageObjectId].every((value) => uuid.test(value))
    || !Number.isSafeInteger(admission.fence) || admission.fence < 1
    || typeof admission.storageVersion !== "string" || admission.storageVersion.length < 1
    || typeof admission.bucketId !== "string" || admission.bucketId.length < 1
    || typeof admission.objectName !== "string" || admission.objectName.length < 1
    || Number.isNaN(Date.parse(admission.storageUpdatedAt))) {
    throw new TypeError("Native registration admission identity invalid.");
  }
}

/** Hash a bounded, complete Storage response before registration. The SQL
 * writer rechecks the Storage generation and attempt after this read; the
 * verifier independently rehashes the registered bytes at delivery. */
export async function registerMeasuredNativeResult(input: {
  taskId: string; attemptId: string; role: NativeResultRole;
  repository: NativeRegistrationRepository; timeoutMs?: number;
}): Promise<boolean> {
  const limit = NATIVE_RESULT_ROLE_LIMITS[input.role];
  if (!limit || !Number.isSafeInteger(input.timeoutMs ?? 30_000)
    || (input.timeoutMs ?? 30_000) < 1 || (input.timeoutMs ?? 30_000) > 30_000) {
    throw new TypeError("Native registration bounds invalid.");
  }
  const loaded = await input.repository.loadAdmission(input.taskId, input.attemptId, input.role);
  if (!loaded) throw new TypeError("Native registration admission unavailable.");
  const admission = structuredClone(loaded);
  validAdmission(admission, input.taskId, input.attemptId, input.role);
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const interrupted = () => new Error("Native registration read interrupted.");
  const ensureWithinDeadline = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw interrupted();
  };
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(interrupted());
    controller.signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      try { ensureWithinDeadline(); resolve(value); } catch (error) { reject(error); }
    }, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    try { ensureWithinDeadline(); } catch (error) { reject(error); }
  });
  try {
    const response = await bounded(input.repository.readUploadedObject(admission.storageObjectId, controller.signal));
    if (response.status !== 200 || response.redirected || !response.body) throw new TypeError("Native registration object response invalid.");
    const reader = response.body.getReader(), digest = createHash("sha256");
    let byteLength = 0, chunks = 0, complete = false;
    try {
      while (true) {
        const part = await bounded(reader.read());
        if (part.done) { complete = true; break; }
        if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0 || ++chunks > 4096) {
          throw new TypeError("Native registration stream progress invalid.");
        }
        byteLength += part.value.byteLength;
        if (byteLength > limit) throw new TypeError("Native registration object exceeds role size limit.");
        digest.update(part.value);
        ensureWithinDeadline();
      }
    } finally {
      if (complete) reader.releaseLock(); else void reader.cancel().catch(() => undefined);
    }
    if (byteLength === 0) throw interrupted();
    ensureWithinDeadline();
    return await input.repository.registerMeasuredObject(Object.freeze({ ...admission,
      byteLength, sha256: digest.digest("hex") }));
  } finally {
    clearTimeout(timer); controller.abort();
  }
}
