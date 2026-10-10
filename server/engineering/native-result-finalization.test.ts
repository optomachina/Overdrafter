// @vitest-environment node
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { storedNativeFixture } from "./native-result-fixture";
import { createNativeResultFinalizer, type NativeFinalizationEnvelope,
  type NativeFinalizationRepository, type NativeFinalizationReceipt } from "./native-result-finalization";

function setup(enabled = true) {
  const fixture = storedNativeFixture(), key = randomBytes(32);
  let pending: NativeFinalizationEnvelope | null = null;
  const receipt: NativeFinalizationReceipt = { outcome: "finalized", taskId: fixture.admission.taskId,
    attemptId: fixture.admission.active.attemptId, fence: fixture.admission.active.fence,
    snapshotId: fixture.admission.active.outputSnapshotId, inputAdmissionId: "44444444-4444-4444-8444-444444444444", successorTaskId: null };
  const repository: NativeFinalizationRepository = {
    loadAdmission: vi.fn(async () => fixture.admission), readRegisteredObject: vi.fn(fixture.reader),
    isCurrent: vi.fn(async () => true), loadPending: vi.fn(async () => pending),
    persistPending: vi.fn(async (_task: string, _attempt: string, envelope: NativeFinalizationEnvelope) => { pending ??= envelope; return pending; }),
    finalize: vi.fn(async () => receipt),
  };
  const config = { repository, key, now: () => new Date("2026-09-26T00:00:00.000Z"), ...(enabled ? { enabled: true } : {}) };
  const service = createNativeResultFinalizer(config);
  const ids = [fixture.admission.taskId, fixture.admission.active.attemptId] as const;
  return { fixture, key, repository, receipt, service, config, ids,
    pending: () => pending!, replace: (value: NativeFinalizationEnvelope) => { pending = value; } };
}
describe("source-only native finalization bridge", () => {
  it("stays default-off without reading admission or persistence", async () => {
    const s = setup(false);
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("disabled");
    await expect(s.service.replay(...s.ids)).rejects.toThrow("disabled");
    expect(s.repository.loadPending).not.toHaveBeenCalled();
    expect(s.repository.readRegisteredObject).not.toHaveBeenCalled();
  });
  it("verifies seven registered objects and persists exact SQL arguments before one delivery", async () => {
    const s = setup();
    vi.mocked(s.repository.finalize).mockImplementation(async (envelope) => {
      expect(s.pending()).toEqual(envelope);
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(createHmac("sha256", s.key).update(envelope.p_payload_text).digest("hex")).toBe(envelope.p_signature);
      const payload = JSON.parse(envelope.p_payload_text);
      expect(payload.candidateContextSha256).toBe(createHash("sha256").update(envelope.p_candidate_context_text).digest("hex"));
      expect(JSON.parse(envelope.p_candidate_context_text).snapshotId).toBe(s.receipt.snapshotId);
      return s.receipt;
    });
    await expect(s.service.finalize(...s.ids)).resolves.toEqual(s.receipt);
    expect(s.repository.readRegisteredObject).toHaveBeenCalledTimes(7);
    expect(s.repository.finalize).toHaveBeenCalledTimes(1);
  });
  it("recovers a committed lost response after restart with exact bytes and no verification rerun", async () => {
    const s = setup();
    vi.mocked(s.repository.finalize).mockRejectedValueOnce(new Error("response lost after commit"));
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("outcome unknown");
    const before = s.pending();
    expect(s.repository.finalize).toHaveBeenCalledTimes(1);
    const restarted = createNativeResultFinalizer({ ...s.config, now: () => new Date("2030-01-01") });
    await expect(restarted.finalize(...s.ids)).rejects.toThrow("explicit replay");
    await expect(restarted.replay(...s.ids)).resolves.toEqual(s.receipt);
    expect(s.repository.finalize).toHaveBeenLastCalledWith(before, expect.any(AbortSignal));
    expect(s.repository.readRegisteredObject).toHaveBeenCalledTimes(7);
    expect(s.repository.persistPending).toHaveBeenCalledTimes(1);
    expect(s.repository.isCurrent).toHaveBeenCalledTimes(1);
  });
  it.each(["payload", "context", "signature", "identity"])("rejects persisted %s substitution before delivery", async (part) => {
    const s = setup(); await s.service.finalize(...s.ids);
    const changed = { ...s.pending() };
    if (part === "payload") changed.p_payload_text += " ";
    if (part === "context") changed.p_candidate_context_text += " ";
    if (part === "signature") changed.p_signature = "0".repeat(64);
    if (part === "identity") {
      const payload = JSON.parse(changed.p_payload_text); payload.taskId = "33333333-3333-4333-8333-333333333333";
      changed.p_payload_text = JSON.stringify(payload);
      changed.p_signature = createHmac("sha256", s.key).update(changed.p_payload_text).digest("hex");
    }
    s.replace(changed);
    await expect(s.service.replay(...s.ids)).rejects.toThrow(/mismatch/);
    expect(s.repository.finalize).toHaveBeenCalledTimes(1);
  });
  it("treats a mismatched completion as unknown and retains its replay envelope", async () => {
    const s = setup();
    vi.mocked(s.repository.finalize).mockResolvedValueOnce({ ...s.receipt, fence: s.receipt.fence + 1 });
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("outcome unknown");
    await expect(s.service.replay(...s.ids)).resolves.toEqual(s.receipt);
    expect(s.repository.persistPending).toHaveBeenCalledTimes(1);
  });
  it("retains a durable envelope when the persistence acknowledgment is lost", async () => {
    const s = setup();
    vi.mocked(s.repository.persistPending).mockImplementation(async (_t, _a, envelope) => {
      s.replace(envelope); throw new Error("persistence response lost");
    });
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("persistence response lost");
    expect(s.repository.finalize).not.toHaveBeenCalled();
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("explicit replay");
    await expect(s.service.replay(...s.ids)).resolves.toEqual(s.receipt);
    expect(s.repository.readRegisteredObject).toHaveBeenCalledTimes(7);
  });
  it.each(["inputAdmissionId", "successorTaskId"])("rejects coerced %s completion IDs", async (field) => {
    const s = setup();
    vi.mocked(s.repository.finalize).mockResolvedValueOnce({ ...s.receipt,
      [field]: [s.receipt.inputAdmissionId] } as unknown as NativeFinalizationReceipt);
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("outcome unknown");
  });
  it("bounds a never-settling finalization as unknown without retry", async () => {
    // The 100 ms deadline expires only once delivery has been dispatched: fake
    // setTimeout/performance advance in a microtask queued by the finalize mock,
    // so the seven reads, verification and persistence cannot consume it under
    // load and the finalizer's deadline timer is what interrupts delivery.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const s = setup();
      vi.mocked(s.repository.finalize).mockImplementation(() => {
        void Promise.resolve().then(() => vi.advanceTimersByTime(100));
        return new Promise(() => {});
      });
      await expect(s.service.finalize(...s.ids, { timeoutMs: 100 })).rejects.toThrow("outcome unknown");
      expect(s.repository.finalize).toHaveBeenCalledTimes(1);
      expect(s.pending()).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  it("does not deliver after a canceled persistence resolves late", async () => {
    const s = setup(), controller = new AbortController();
    let finish!: () => void;
    vi.mocked(s.repository.persistPending).mockImplementation(async (_t, _a, envelope) => {
      s.replace(envelope);
      await new Promise<void>((resolve) => { finish = resolve; controller.abort(); });
      return envelope;
    });
    await expect(s.service.finalize(...s.ids, { signal: controller.signal })).rejects.toThrow("interrupted");
    finish(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.repository.finalize).not.toHaveBeenCalled();
    await expect(s.service.replay(...s.ids)).resolves.toEqual(s.receipt);
  });
  it("cancels a stalled registered response body promptly when caller aborts", async () => {
    const s = setup(), controller = new AbortController(), cancel = vi.fn();
    let wasReading = false;
    // highWaterMark 0: pull() (and its abort timer) starts only on the
    // verifier's first read, not at stream construction, so the test does
    // not depend on how quickly the finalizer reaches that read under load.
    const response = new Response(new ReadableStream({
      pull() {
        setTimeout(() => { wasReading = response.body!.locked; controller.abort(); }, 5);
        return new Promise(() => {});
      }, cancel,
    }, { highWaterMark: 0 }));
    vi.mocked(s.repository.readRegisteredObject).mockResolvedValue(response);
    await expect(s.service.finalize(...s.ids, { signal: controller.signal })).rejects.toThrow("interrupted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wasReading).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(s.repository.persistPending).not.toHaveBeenCalled();
  });
  it("bounds an unresponsive admission and rejects already canceled calls before reads", async () => {
    const s = setup(); vi.mocked(s.repository.loadAdmission).mockImplementation(() => new Promise(() => {}));
    await expect(s.service.finalize(...s.ids, { timeoutMs: 10 })).rejects.toThrow("interrupted");
    expect(s.repository.persistPending).not.toHaveBeenCalled();
    const canceled = setup(), controller = new AbortController(); controller.abort();
    await expect(canceled.service.finalize(...canceled.ids, { signal: controller.signal })).rejects.toThrow("interrupted");
    expect(canceled.repository.loadPending).not.toHaveBeenCalled();
  });
  it("never regenerates absent replay evidence", async () => {
    const s = setup(); await expect(s.service.replay(...s.ids)).rejects.toThrow("unavailable");
    expect(s.repository.loadAdmission).not.toHaveBeenCalled();
  });
  it("allows one concurrent preparation winner and replays that exact durable envelope", async () => {
    const s = setup();
    let ready = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(s.repository.loadPending).mockImplementation(async () => {
      if (++ready === 2) release();
      await gate; return null;
    });
    const outcomes = await Promise.allSettled([s.service.finalize(...s.ids), s.service.finalize(...s.ids)]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(s.repository.persistPending).toHaveBeenCalledTimes(2);
    expect(s.repository.finalize).toHaveBeenCalledTimes(1);
    const saved = s.pending();
    vi.mocked(s.repository.loadPending).mockResolvedValue(saved);
    await expect(s.service.replay(...s.ids)).resolves.toEqual(s.receipt);
    expect(s.repository.finalize).toHaveBeenLastCalledWith(saved, expect.any(AbortSignal));
  });
  it("does not deliver when durable persistence fails or a concurrent writer wins", async () => {
    const s = setup(); vi.mocked(s.repository.persistPending).mockRejectedValue(new Error("disk unavailable"));
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("disk unavailable");
    expect(s.repository.finalize).not.toHaveBeenCalled();
    vi.mocked(s.repository.persistPending).mockImplementation(async (_t, _a, envelope) => ({ ...envelope, p_key: "33333333-3333-4333-8333-333333333333" }));
    await expect(s.service.finalize(...s.ids)).rejects.toThrow("persistence conflict");
    expect(s.repository.finalize).not.toHaveBeenCalled();
  });
  it.each(["bytes", "eligibility"])("does not persist or finalize failed %s verification", async (failure) => {
    const s = setup();
    if (failure === "bytes") s.fixture.bytes.assembly[0] ^= 1;
    else vi.mocked(s.repository.isCurrent).mockResolvedValue(false);
    await expect(s.service.finalize(...s.ids)).rejects.toThrow();
    expect(s.repository.persistPending).not.toHaveBeenCalled();
    expect(s.repository.finalize).not.toHaveBeenCalled();
  });
});
