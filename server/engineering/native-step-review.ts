import { createHash } from "node:crypto";
import { cumulativePreviewSource } from "../../src/lib/engineering-cumulative-preview";
import { verifyStoredNativePreview, type NativePreviewAdmission } from "./native-preview-bytes";
import type { RegisteredObjectReader } from "./native-result-bytes";

export type FinalizedStepCandidate = Readonly<{
  taskId: string;
  payloadText: string;
  candidateContextText: string;
}>;

export type StepReviewAssociation = Readonly<{
  taskId: string; sourceSnapshotId: string; candidateSnapshotId: string;
  candidateContextSha256: string; resultSha256: string; exportId: string;
  sourceCommit: string; reportSha256: string; stepSha256: string; stepBytes: Uint8Array;
}>;

/** The repository loads only private finalized/admitted records by task identity.
 * storeAssociation invokes the owner-only SQL function, never a public API role.
 */
export type StepReviewRepository = Readonly<{
  loadFinalization: (taskId: string) => Promise<FinalizedStepCandidate | null>;
  loadPreviewAdmission: (taskId: string, candidateSnapshotId: string) => Promise<NativePreviewAdmission | null>;
  readRegisteredObject: RegisteredObjectReader;
  storeAssociation: (association: StepReviewAssociation) => Promise<boolean>;
}>;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
function sha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Consume the exact OVD-561 finalization and independently admitted OVD-502
 * export. SQL rechecks the finalized lineage and measured bytes under lock.
 * Missing geometry is a distinct outcome; malformed evidence fails closed.
 */
export async function associateFinalizedStepReview(taskId: string, repository: StepReviewRepository): Promise<"associated" | "already_associated" | "unavailable"> {
  if (!uuid(taskId)) throw new TypeError("Step review task identity invalid.");
  const finalized = await repository.loadFinalization(taskId);
  if (!finalized || finalized.taskId !== taskId) throw new TypeError("Finalized step candidate unavailable.");
  if (finalized.payloadText.length > 16384 || finalized.candidateContextText.length > 65536) {
    throw new TypeError("Finalized step candidate exceeds bounds.");
  }
  const payload: unknown = JSON.parse(finalized.payloadText);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Finalized step payload invalid.");
  const p = payload as Record<string, unknown>;
  if (p.schema !== "overdrafter.native-verification-receipt.v2" || p.taskId !== taskId
    || !uuid(p.inputSnapshotId) || !uuid(p.candidateSnapshotId)
    || !sha(p.candidateContextSha256) || !sha(p.resultSha256)
    || digest(new TextEncoder().encode(finalized.candidateContextText)) !== p.candidateContextSha256) {
    throw new TypeError("Finalized step lineage invalid.");
  }
  const admission = await repository.loadPreviewAdmission(taskId, p.candidateSnapshotId);
  const verified = await verifyStoredNativePreview(finalized.candidateContextText, admission,
    repository.readRegisteredObject);
  if (verified.status === "unavailable") return "unavailable";
  const preview = verified.preview;
  if (verified.snapshotId !== p.candidateSnapshotId
    || verified.contextSha256 !== p.candidateContextSha256
    || preview.resultSha256 !== p.resultSha256 || preview.export.sourceCommit === null) {
    throw new TypeError("Verified STEP export differs from finalized result.");
  }
  const stepBytes = await cumulativePreviewSource(preview).loadStepBuffer();
  if (digest(stepBytes) !== preview.step.sha256 || stepBytes.length !== preview.step.bytes) {
    throw new TypeError("Verified STEP bytes changed before association.");
  }
  const associated = await repository.storeAssociation(Object.freeze({
    taskId, sourceSnapshotId: p.inputSnapshotId, candidateSnapshotId: p.candidateSnapshotId,
    candidateContextSha256: p.candidateContextSha256, resultSha256: p.resultSha256,
    exportId: verified.exportId, sourceCommit: preview.export.sourceCommit,
    reportSha256: preview.export.reportSha256, stepSha256: preview.step.sha256,
    stepBytes: new Uint8Array(stepBytes),
  }));
  return associated ? "associated" : "already_associated";
}
