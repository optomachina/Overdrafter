// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { associateFinalizedStepReview, type StepReviewAssociation, type StepReviewRepository } from "./native-step-review";
import type { NativePreviewAdmission } from "./native-preview-bytes";

const taskId = "11111111-1111-4111-8111-000000000010";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = "server/engineering/fixtures/preview-7mm/";
  const candidateContextText = readFileSync(root + "context.json", "utf8");
  const context = JSON.parse(candidateContextText);
  const bundle = new Uint8Array(readFileSync(root + "preview.json"));
  const report = new Uint8Array(readFileSync(root + "native-step.stdout.txt"));
  const parsed = JSON.parse(new TextDecoder().decode(bundle));
  const nativeReport = JSON.parse(new TextDecoder().decode(report));
  const sourceSnapshotId = context.producer.inputSnapshotId;
  const payload = {
    schema: "overdrafter.native-verification-receipt.v2", taskId,
    inputSnapshotId: sourceSnapshotId, candidateSnapshotId: context.snapshotId,
    candidateContextSha256: sha(candidateContextText), resultSha256: parsed.resultSha256,
  };
  const admission: NativePreviewAdmission = {
    exportId: "11111111-1111-4111-8111-000000000011", scope: context.scope,
    snapshotId: context.snapshotId, contextSha256: sha(candidateContextText),
    sourceCommit: parsed.export.sourceCommit,
    process: { nativePid: nativeReport.nativePid, nativeStartTicks: nativeReport.nativeStartTicks,
      helperPid: nativeReport.helperPid, candidateRoot: nativeReport.candidateRoot },
    objects: [
      { id: "11111111-1111-4111-8111-000000000012", role: "bundle", bytes: bundle.length, sha256: sha(bundle) },
      { id: "11111111-1111-4111-8111-000000000013", role: "report", bytes: report.length, sha256: sha(report) },
    ],
  };
  const storeAssociation = vi.fn(async (_association: StepReviewAssociation) => true);
  const repository: StepReviewRepository = {
    loadFinalization: vi.fn(async () => ({ taskId, payloadText: JSON.stringify(payload), candidateContextText })),
    loadPreviewAdmission: vi.fn(async () => admission),
    readRegisteredObject: vi.fn(async (id) => new Response(id === admission.objects[0].id ? bundle : report)),
    storeAssociation,
  };
  return { repository, admission, payload, bundle, storeAssociation };
}

describe("finalized exact STEP association", () => {
  it("associates measured bytes with finalized candidate and source snapshot", async () => {
    const f = fixture();
    expect(await associateFinalizedStepReview(taskId, f.repository)).toBe("associated");
    const value = f.storeAssociation.mock.calls[0][0];
    expect(value.taskId).toBe(taskId);
    expect(value.sourceSnapshotId).toBe(f.payload.inputSnapshotId);
    expect(value.candidateSnapshotId).toBe(f.payload.candidateSnapshotId);
    expect(sha(value.stepBytes)).toBe(value.stepSha256);
  });
  it("leaves an absent export unavailable without writing", async () => {
    const f = fixture();
    const repository = { ...f.repository, loadPreviewAdmission: async () => null };
    expect(await associateFinalizedStepReview(taskId, repository)).toBe("unavailable");
    expect(f.storeAssociation).not.toHaveBeenCalled();
  });
  it("rejects stale or substituted evidence before writing", async () => {
    const f = fixture();
    Object.assign(f.admission.objects[0], { sha256: "0".repeat(64) });
    await expect(associateFinalizedStepReview(taskId, f.repository)).rejects.toThrow(/identity/);
    expect(f.storeAssociation).not.toHaveBeenCalled();
    const other = fixture();
    other.payload.resultSha256 = "0".repeat(64);
    await expect(associateFinalizedStepReview(taskId, other.repository)).rejects.toThrow(/differs/);
    expect(other.storeAssociation).not.toHaveBeenCalled();
  });
});
