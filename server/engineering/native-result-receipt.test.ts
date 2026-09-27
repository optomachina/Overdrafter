// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyStoredNativeCandidate } from "./native-result-bytes";
import { storedNativeFixture } from "./native-result-fixture";
import { produceNativeVerificationReceipt, verifyNativeVerificationReceipt,
  type NativeResultRepository } from "./native-result-receipt";

function setup() {
  const fixture = storedNativeFixture(), key = randomBytes(32);
  const repository: NativeResultRepository = {
    loadAdmission: vi.fn(async () => fixture.admission),
    readRegisteredObject: vi.fn(fixture.reader),
    isCurrent: vi.fn(async () => true),
  };
  const request = { taskId: fixture.admission.taskId, attemptId: fixture.admission.active.attemptId,
    repository, key, now: () => new Date("2026-09-26T00:00:00.000Z") };
  return { fixture, key, repository, request };
}

describe("trusted native result receipt producer", () => {
  it("issues a signed exact-byte receipt only after all seven registered objects pass", async () => {
    const { fixture, repository, request, key } = setup();
    const receipt = await produceNativeVerificationReceipt(request);
    expect(repository.readRegisteredObject).toHaveBeenCalledTimes(7);
    expect(repository.isCurrent).toHaveBeenCalledTimes(1);
    expect(receipt.payload).toMatchObject({ taskId: fixture.admission.taskId,
      attemptId: fixture.admission.active.attemptId, fence: fixture.admission.active.fence,
      inputSnapshotId: fixture.admission.active.inputSnapshotId,
      candidateSnapshotId: fixture.admission.active.outputSnapshotId });
    const verified = await verifyStoredNativeCandidate(fixture.admission, fixture.reader);
    expect(receipt.payload).toHaveProperty("candidateContextSha256",
      createHash("sha256").update(JSON.stringify(verified.context), "utf8").digest("hex"));
    expect(receipt.payload.objects).toHaveLength(7);
    expect(verifyNativeVerificationReceipt(receipt, key)).toBe(true);
  });
  it("rejects forged and modified receipts", async () => {
    const { request, key } = setup(), receipt = await produceNativeVerificationReceipt(request);
    expect(verifyNativeVerificationReceipt({ ...receipt, signature: "0".repeat(64) }, key)).toBe(false);
    expect(verifyNativeVerificationReceipt({ ...receipt, payload: { ...receipt.payload, fence: receipt.payload.fence + 1 } }, key)).toBe(false);
    expect(verifyNativeVerificationReceipt(receipt, randomBytes(32))).toBe(false);
  });
  it("rejects a foreign task before reading objects", async () => {
    const { request, repository } = setup();
    await expect(produceNativeVerificationReceipt({ ...request, taskId: "33333333-3333-4333-8333-333333333333" }))
      .rejects.toThrow("unavailable");
    expect(repository.readRegisteredObject).not.toHaveBeenCalled();
  });
  it("rejects a stale fence and mismatched registry binding before reading objects", async () => {
    const { fixture, request, repository } = setup();
    fixture.objects[0] = { ...fixture.objects[0], fence: fixture.objects[0].fence + 1 };
    await expect(produceNativeVerificationReceipt(request)).rejects.toThrow("registry scope");
    expect(repository.readRegisteredObject).not.toHaveBeenCalled();
  });
  it("does not sign if attempt becomes stale while bytes are read", async () => {
    const { request, repository } = setup();
    vi.mocked(repository.isCurrent).mockResolvedValue(false);
    await expect(produceNativeVerificationReceipt(request)).rejects.toThrow("became stale");
    expect(repository.readRegisteredObject).toHaveBeenCalledTimes(7);
  });
  it("rejects substituted and oversized bytes without a receipt", async () => {
    const { fixture, request, repository } = setup();
    fixture.bytes.assembly[0] ^= 1;
    await expect(produceNativeVerificationReceipt(request)).rejects.toThrow("stored digest mismatch");
    expect(repository.isCurrent).not.toHaveBeenCalled();
    const oversize = setup();
    vi.mocked(oversize.repository.readRegisteredObject).mockResolvedValue(new Response(new Uint8Array(16_000_001)));
    await expect(produceNativeVerificationReceipt(oversize.request)).rejects.toThrow("exceeds registered size");
    expect(oversize.repository.isCurrent).not.toHaveBeenCalled();
  });
});
