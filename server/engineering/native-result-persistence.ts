import { createHash } from "node:crypto";
import type { NativeFinalizationEnvelope, NativeFinalizationReceipt, NativeFinalizationRepository } from "./native-result-finalization";
import { createNativeFinalizationExecutor, type NativeOwnerSqlPool } from "./native-result-executor";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function identity(taskId: unknown, attemptId: unknown): void {
  if (!isUuid(taskId) || !isUuid(attemptId)) throw new TypeError("Invalid pending finalization identity.");
}
function envelope(value: unknown, taskId?: string, attemptId?: string): NativeFinalizationEnvelope {
  if (!record(value) || Object.keys(value).length !== 4 || !isUuid(value.p_key)
    || typeof value.p_signature !== "string" || !/^[0-9a-f]{64}$/.test(value.p_signature)
    || typeof value.p_payload_text !== "string" || Buffer.byteLength(value.p_payload_text, "utf8") < 1
    || Buffer.byteLength(value.p_payload_text, "utf8") > 16384
    || typeof value.p_candidate_context_text !== "string" || Buffer.byteLength(value.p_candidate_context_text, "utf8") < 1
    || Buffer.byteLength(value.p_candidate_context_text, "utf8") > 65536) throw new TypeError("Invalid pending finalization envelope.");
  const payload: unknown = JSON.parse(value.p_payload_text);
  if (!record(payload) || payload.schema !== "overdrafter.native-verification-receipt.v2"
    || !isUuid(payload.taskId) || !isUuid(payload.attemptId)
    || (taskId !== undefined && payload.taskId !== taskId) || (attemptId !== undefined && payload.attemptId !== attemptId)
    || payload.candidateContextSha256 !== createHash("sha256").update(value.p_candidate_context_text, "utf8").digest("hex")) {
    throw new TypeError("Pending finalization binding mismatch.");
  }
  // Preserve text verbatim, including JSON whitespace and property order. This
  // validates transport shape only; HMAC verification remains in the finalizer
  // and existing SQL transaction, never a caller boolean or a new authority.
  return Object.freeze({ p_payload_text: value.p_payload_text, p_signature: value.p_signature,
    p_candidate_context_text: value.p_candidate_context_text, p_key: value.p_key });
}
function receipt(value: unknown, request: NativeFinalizationEnvelope): NativeFinalizationReceipt {
  const payload = JSON.parse(request.p_payload_text);
  if (!record(value) || value.outcome !== "finalized" || value.taskId !== payload.taskId || value.attemptId !== payload.attemptId
    || !Number.isSafeInteger(value.fence) || (value.fence as number) < 1 || value.fence !== payload.fence
    || value.snapshotId !== payload.candidateSnapshotId || !isUuid(value.snapshotId) || !isUuid(value.inputAdmissionId)
    || !(value.successorTaskId === null || isUuid(value.successorTaskId))) throw new TypeError("Invalid native finalization receipt.");
  return Object.freeze({ outcome: "finalized", taskId: payload.taskId, attemptId: payload.attemptId, fence: value.fence as number,
    snapshotId: value.snapshotId, inputAdmissionId: value.inputAdmissionId, successorTaskId: value.successorTaskId });
}

/** Concrete private PostgreSQL persistence/executor adapter. Tables/functions
 * are staged in ovd561-pending-forward.sql. No connection string, signing key,
 * role change, migration application or public/service-role RPC is supplied. */
export function createNativeFinalizationPersistence(config: {
  pool: NativeOwnerSqlPool; enabled?: boolean; timeoutMs?: number;
}): Pick<NativeFinalizationRepository, "loadPending" | "persistPending" | "finalize"> {
  const execute = createNativeFinalizationExecutor(config);
  return Object.freeze({
    async loadPending(taskId, attemptId, signal) {
      identity(taskId, attemptId);
      const value = await execute("load", [taskId, attemptId], signal);
      return value === null ? null : envelope(value, taskId, attemptId);
    },
    async persistPending(taskId, attemptId, proposed, signal) {
      identity(taskId, attemptId);
      const prepared = envelope(proposed, taskId, attemptId);
      // SQL returns the immutable winning envelope, not an invented boolean or
      // caller object. The finalizer compares it and rejects a concurrent loser.
      const value = await execute("persist", [taskId, attemptId, prepared.p_payload_text, prepared.p_signature,
        prepared.p_candidate_context_text, prepared.p_key], signal);
      try { return envelope(value, taskId, attemptId); }
      catch (cause) { throw new Error("Native SQL write outcome unknown; explicit reconciliation required.", { cause }); }
    },
    async finalize(proposed, signal) {
      const prepared = envelope(proposed);
      const value = await execute("finalize", [prepared.p_payload_text, prepared.p_signature,
        prepared.p_candidate_context_text, prepared.p_key], signal);
      try { return receipt(value, prepared); }
      catch (cause) { throw new Error("Native SQL write outcome unknown; explicit reconciliation required.", { cause }); }
    },
  });
}
