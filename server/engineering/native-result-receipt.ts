import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { verifyStoredNativeCandidate, type RegisteredResultObject, type ResultReadAdmission } from "./native-result-bytes";

const SCHEMA = "overdrafter.native-verification-receipt.v2";
const ROLES = ["assembly", "target", "companion", "result", "identity", "preservation", "native"] as const;

/** The adapter must load only private registry rows and enforce current attempt
 * eligibility again after the byte reads. Its object reader may resolve only
 * registered Storage IDs; it must never accept a worker URL or path. */
export type NativeResultRepository = Readonly<{
  loadAdmission: (taskId: string, attemptId: string) => Promise<ResultReadAdmission | null>;
  readRegisteredObject: (id: string, signal: AbortSignal) => Promise<Response>;
  isCurrent: (admission: ResultReadAdmission) => Promise<boolean>;
}>;

export type NativeVerificationReceiptPayload = Readonly<{
  schema: typeof SCHEMA;
  taskId: string; attemptId: string; fence: number;
  organizationId: string; projectId: string;
  inputSnapshotId: string; candidateSnapshotId: string;
  contextSha256: string; candidateContextSha256: string; jobSha256: string; resultSha256: string;
  policy: string; issuedAt: string;
  objects: readonly Readonly<{ role: RegisteredResultObject["role"]; id: string; bytes: number; sha256: string }>[];
}>;
export type NativeVerificationReceipt = Readonly<{
  payload: NativeVerificationReceiptPayload;
  signature: string;
}>;

function keyBytes(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new TypeError("Verifier receipt key must be at least 32 bytes.");
  return Buffer.from(key);
}
function signature(payload: NativeVerificationReceiptPayload, key: Uint8Array): string {
  return createHmac("sha256", keyBytes(key)).update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Verify the receipt's exact signed content. A consumer must also recheck its
 * task/attempt/fence and registry rows inside its own finalization transaction. */
export function verifyNativeVerificationReceipt(receipt: NativeVerificationReceipt, key: Uint8Array): boolean {
  if (!receipt || receipt.payload?.schema !== SCHEMA || typeof receipt.signature !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.signature)) return false;
  const expected = Buffer.from(signature(receipt.payload, key), "hex");
  return timingSafeEqual(expected, Buffer.from(receipt.signature, "hex"));
}

/** Read every registered byte, run the existing seven-check validator, recheck
 * current eligibility, then issue a signed receipt for OVD-561 to consume.
 * This source-only service has no route or production key wiring. */
export async function produceNativeVerificationReceipt(input: {
  taskId: string; attemptId: string; repository: NativeResultRepository;
  key: Uint8Array; now?: () => Date;
}): Promise<NativeVerificationReceipt> {
  keyBytes(input.key);
  const loaded = await input.repository.loadAdmission(input.taskId, input.attemptId);
  if (loaded?.taskId !== input.taskId || loaded?.active.attemptId !== input.attemptId) {
    throw new TypeError("Registered native attempt unavailable.");
  }
  const admission = structuredClone(loaded);
  const verified = await verifyStoredNativeCandidate(admission, input.repository.readRegisteredObject);
  if (!(await input.repository.isCurrent(admission))) throw new TypeError("Native attempt became stale during verification.");
  const objects = ROLES.map((role) => {
    const object = verified.objects.find((entry) => entry.role === role);
    if (!object) throw new TypeError("Registered native object missing.");
    return Object.freeze({ role, id: object.id, bytes: object.bytes, sha256: object.sha256 });
  });
  const payload: NativeVerificationReceiptPayload = Object.freeze({
    schema: SCHEMA,
    taskId: admission.taskId,
    attemptId: admission.active.attemptId,
    fence: admission.active.fence,
    organizationId: admission.active.scope.organizationId,
    projectId: admission.active.scope.projectId,
    inputSnapshotId: admission.active.inputSnapshotId,
    candidateSnapshotId: admission.active.outputSnapshotId,
    contextSha256: admission.active.contextSha256,
    candidateContextSha256: createHash("sha256").update(JSON.stringify(verified.context), "utf8").digest("hex"),
    jobSha256: createHash("sha256").update(admission.jobText, "utf8").digest("hex"),
    resultSha256: verified.resultSha256,
    policy: verified.policy,
    issuedAt: (input.now ?? (() => new Date()))().toISOString(),
    objects: Object.freeze(objects),
  });
  return Object.freeze({ payload, signature: signature(payload, input.key) });
}
