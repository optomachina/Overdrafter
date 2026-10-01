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
 * exact replay. Adapters should honor the signal, but aborting an in-flight
 * write does not establish rollback: callers must reconcile via exact replay,
 * never automatically retry. This slice supplies no credential or upload route. */
export type NativeRegistrationRepository = Readonly<{
  loadAdmission: (taskId: string, attemptId: string, role: NativeResultRole, signal: AbortSignal) => Promise<NativeRegistrationAdmission | null>;
  readUploadedObject: (storageObjectId: string, signal: AbortSignal) => Promise<Response>;
  registerMeasuredObject: (registration: MeasuredNativeRegistration, signal: AbortSignal) => Promise<boolean>;
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
  repository: NativeRegistrationRepository; timeoutMs?: number; signal?: AbortSignal;
}): Promise<boolean> {
  const limit = NATIVE_RESULT_ROLE_LIMITS[input.role];
  if (!limit || !Number.isSafeInteger(input.timeoutMs ?? 30_000)
    || (input.timeoutMs ?? 30_000) < 1 || (input.timeoutMs ?? 30_000) > 30_000) {
    throw new TypeError("Native registration bounds invalid.");
  }
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const disconnected = () => controller.abort();
  input.signal?.addEventListener("abort", disconnected, { once: true });
  if (input.signal?.aborted) disconnected();
  let writeStarted = false;
  const interrupted = () => new Error(writeStarted
    ? "Native registration write interrupted; delivery may be unknown."
    : "Native registration read interrupted.");
  const ensureWithinDeadline = () => {
    if (performance.now() >= deadline) controller.abort();
    if (controller.signal.aborted) throw interrupted();
  };
  // Accept a thunk so no successor can begin after abort or a synchronous
  // deadline overrun, even when a noncooperative adapter settles late.
  const bounded = <T>(start: () => Promise<T>, discard?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
    const cleanup = () => controller.signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(interrupted()); };
    const settle = (finish: () => void, dispose?: () => void) => {
      cleanup();
      try { ensureWithinDeadline(); finish(); } catch (error) { dispose?.(); reject(error); }
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      ensureWithinDeadline();
      start().then((value) => settle(() => resolve(value), () => discard?.(value)), (error) => settle(() => reject(error)));
      ensureWithinDeadline();
    } catch (error) { settle(() => reject(error)); }
  });
  try {
    const loaded = await bounded(() => input.repository.loadAdmission(input.taskId, input.attemptId,
      input.role, controller.signal));
    if (!loaded) throw new TypeError("Native registration admission unavailable.");
    const admission = structuredClone(loaded);
    validAdmission(admission, input.taskId, input.attemptId, input.role);
    const response = await bounded(() => input.repository.readUploadedObject(admission.storageObjectId, controller.signal),
      (late) => { void late.body?.cancel().catch(() => undefined); });
    if (response.status !== 200 || response.redirected || !response.body) throw new TypeError("Native registration object response invalid.");
    const reader = response.body.getReader(), digest = createHash("sha256");
    let byteLength = 0, chunks = 0, complete = false;
    try {
      while (true) {
        const part = await bounded(() => reader.read());
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
    const registration = Object.freeze({ ...admission, byteLength, sha256: digest.digest("hex") });
    return await bounded(() => {
      writeStarted = true;
      return input.repository.registerMeasuredObject(registration, controller.signal);
    });
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", disconnected); controller.abort();
  }
}
