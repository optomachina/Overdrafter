import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { produceNativeVerificationEnvelope, type NativeResultRepository } from "./native-result-receipt";

/** Exact arguments to staged engineering_private.finalize_native_result.
 * p_key is an idempotency UUID, never a signing key. */
export type NativeFinalizationEnvelope = Readonly<{
  p_payload_text: string; p_signature: string; p_candidate_context_text: string; p_key: string;
}>;
export type NativeFinalizationReceipt = Readonly<{
  outcome: "finalized"; taskId: string; attemptId: string; fence: number;
  snapshotId: string; inputAdmissionId: string; successorTaskId: string | null;
}>;
/** Trusted private adapters only. persistPending must atomically insert-if-absent
 * by task/attempt and return the immutable stored envelope (including on a race).
 * It must durably commit before resolving. finalize must call the existing
 * owner-only OVD-561 transaction, not reproduce its authority checks in JS.
 * No public RPC, grant, production connection or key loader is provided here. */
export type NativeFinalizationRepository = NativeResultRepository & Readonly<{
  loadPending: (taskId: string, attemptId: string, signal: AbortSignal) => Promise<NativeFinalizationEnvelope | null>;
  persistPending: (taskId: string, attemptId: string, envelope: NativeFinalizationEnvelope, signal: AbortSignal) => Promise<NativeFinalizationEnvelope>;
  finalize: (envelope: NativeFinalizationEnvelope, signal: AbortSignal) => Promise<NativeFinalizationReceipt>;
}>;
export type NativeFinalizationOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Source-only, default-off service. Provisioning and qualification remain
 * separate. Every call identifies one exact task/attempt; there is no dispatch,
 * CAD operation, occupancy release or successor claim in this bridge. */
export function createNativeResultFinalizer(config: {
  enabled?: boolean; repository: NativeFinalizationRepository; key: Uint8Array; now?: () => Date;
}) {
  const enabled = config.enabled === true, repository = config.repository;
  const key = Buffer.from(config.key), now = config.now;
  if (key.byteLength < 32) throw new TypeError("Verifier receipt key must be at least 32 bytes.");
  const guard = (taskId: string, attemptId: string) => {
    if (!enabled) throw new Error("Native result finalization disabled.");
    if (![taskId, attemptId].every((id) => typeof id === "string" && uuid.test(id))) throw new TypeError("Invalid finalization identity.");
  };
  const validate = (envelope: NativeFinalizationEnvelope, taskId: string, attemptId: string) => {
    if (!envelope || typeof envelope.p_payload_text !== "string" || typeof envelope.p_candidate_context_text !== "string"
      || Buffer.byteLength(envelope.p_payload_text, "utf8") > 16384
      || Buffer.byteLength(envelope.p_candidate_context_text, "utf8") > 65536
      || typeof envelope.p_key !== "string" || !uuid.test(envelope.p_key)
      || typeof envelope.p_signature !== "string" || !/^[0-9a-f]{64}$/.test(envelope.p_signature)) {
      throw new TypeError("Invalid persisted native finalization envelope.");
    }
    const expected = createHmac("sha256", key).update(envelope.p_payload_text, "utf8").digest();
    if (!timingSafeEqual(expected, Buffer.from(envelope.p_signature, "hex"))) {
      throw new TypeError("Native finalization signature mismatch.");
    }
    const payload = JSON.parse(envelope.p_payload_text);
    if (payload.schema !== "overdrafter.native-verification-receipt.v2" || payload.taskId !== taskId
      || payload.attemptId !== attemptId || payload.candidateContextSha256 !== createHash("sha256")
        .update(envelope.p_candidate_context_text, "utf8").digest("hex")) {
      throw new TypeError("Native finalization context or identity mismatch.");
    }
    return payload;
  };
  const invoke = async (taskId: string, attemptId: string, replay: boolean, options: NativeFinalizationOptions) => {
    guard(taskId, attemptId);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Invalid finalization deadline.");
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let deliveryStarted = false;
    const interrupted = () => new Error(deliveryStarted
      ? "Native finalization outcome unknown; reconcile by exact replay."
      : "Native finalization interrupted; inspect persisted envelope before explicit replay.");
    const ensure = () => {
      if (performance.now() >= deadline) controller.abort();
      if (controller.signal.aborted) throw interrupted();
    };
    const bounded = <T>(start: () => Promise<T>, discard?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
      const stopped = () => { controller.signal.removeEventListener("abort", stopped); reject(interrupted()); };
      controller.signal.addEventListener("abort", stopped, { once: true });
      try {
        ensure();
        start().then((value) => {
          try { ensure(); resolve(value); } catch (error) { discard?.(value); reject(error); }
        }, reject)
          .catch(reject).finally(() => controller.signal.removeEventListener("abort", stopped));
        ensure();
      } catch (error) { controller.signal.removeEventListener("abort", stopped); reject(error); }
    });
    const deliver = async (envelope: NativeFinalizationEnvelope) => {
      const payload = validate(envelope, taskId, attemptId);
      // There is deliberately one delivery only. A rejection, timeout or lost
      // response does not establish rollback. Reconcile with replay(), never a
      // regenerated receipt or another verification/native run.
      try {
        const result = await bounded(() => { deliveryStarted = true; return repository.finalize(envelope, controller.signal); });
        if (!result || result.outcome !== "finalized" || result.taskId !== taskId || result.attemptId !== attemptId
          || !Number.isSafeInteger(result.fence) || result.fence < 1 || result.fence !== payload.fence || result.snapshotId !== payload.candidateSnapshotId
          || typeof result.inputAdmissionId !== "string" || !uuid.test(result.inputAdmissionId)
          || (result.successorTaskId !== null && (typeof result.successorTaskId !== "string" || !uuid.test(result.successorTaskId)))) {
          throw new TypeError("Native finalization completion identity mismatch.");
        }
        return Object.freeze({ ...result });
      }
      catch (cause) { throw new Error("Native finalization outcome unknown; reconcile by exact replay.", { cause }); }
    };
    try {
      const pending = await bounded(() => repository.loadPending(taskId, attemptId, controller.signal));
      if (replay) {
        if (!pending) throw new Error("Native finalization replay unavailable.");
        return await deliver(Object.freeze({ ...pending }));
      }
      if (pending) throw new Error("Native finalization already prepared; explicit replay required.");
      const verified = await bounded(() => produceNativeVerificationEnvelope({ taskId, attemptId, key, now, signal: controller.signal,
        repository: {
          loadAdmission: (task, attempt) => bounded(() => repository.loadAdmission(task, attempt)),
          readRegisteredObject: (id, signal) => bounded(() => repository.readRegisteredObject(id, signal),
            (late) => { void late.body?.cancel().catch(() => undefined); }),
          isCurrent: (admission) => bounded(() => repository.isCurrent(admission)),
        },
      }));
      const envelope: NativeFinalizationEnvelope = Object.freeze({ p_payload_text: verified.payloadText,
        p_signature: verified.receipt.signature, p_candidate_context_text: verified.candidateContextText, p_key: randomUUID() });
      validate(envelope, taskId, attemptId);
      const stored = await bounded(() => repository.persistPending(taskId, attemptId, envelope, controller.signal));
      if (!stored || Object.keys(envelope).some((name) => stored[name as keyof NativeFinalizationEnvelope] !== envelope[name as keyof NativeFinalizationEnvelope])) {
        throw new Error("Native finalization persistence conflict; explicit replay required.");
      }
      return await deliver(envelope);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
    }
  };
  return Object.freeze({
    finalize: (taskId: string, attemptId: string, options: NativeFinalizationOptions = {}) => invoke(taskId, attemptId, false, options),
    replay: (taskId: string, attemptId: string, options: NativeFinalizationOptions = {}) => invoke(taskId, attemptId, true, options),
  });
}
