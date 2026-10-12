import { describe, expect, it, vi } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
import * as cumulative from "../../src/lib/engineering-cumulative";
import { dispatchPreparedRequest, type DispatchIdentity, type PreparedDispatchRuntime } from "./dispatch-prepared-request";

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const identity: DispatchIdentity = {
  requestId: "44444444-4444-4444-8444-444444444444",
  expectedQueueRevision: 0,
  idempotencyKey: "55555555-5555-4555-8555-555555555555",
};
const contextText = JSON.stringify({
  schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
  scope: { organizationId, projectId }, snapshotId, seedSnapshotId: snapshotId,
  sequence: 0, producer: null, createdAt: "2026-09-10T00:00:00.000Z",
  configuration: "Default", assemblyPath: "synthetic-assembly.SLDASM",
  files: NATIVE_SEED_FILES, depthMm: 5, checks: [],
});
async function harness(text = "Set the depth to 8 mm") {
  const reserve = vi.fn(async (_identity: DispatchIdentity, _signal: AbortSignal): Promise<unknown> => ({
    state: "reserved", invoke: true, text, contextText, inputSnapshotId: snapshotId,
    contextSha256: await nativeDigest(contextText), inputSha256: await nativeDigest(text),
    organizationId, projectId, priorClarification: null,
  }));
  const finish = vi.fn(async () => ({ requestId: identity.requestId, outcome: "prepared_change" }));
  const fail = vi.fn(async (_identity: DispatchIdentity, code: string, _signal: AbortSignal): Promise<unknown> => ({
    requestId: identity.requestId, state: "failed", failureCode: code,
  }));
  const adapter = vi.fn(async (): Promise<unknown> => ({
    schema: "overdrafter.prepared-interpretation.v1",
    outcome: "prepared_change", depthMm: 8,
  }));
  const runtime: PreparedDispatchRuntime = {
    enabled: () => true, reserve, finish, fail, adapter, deadlineMs: 200,
  };
  return { reserve, finish, fail, adapter, runtime };
}

describe("OVD-518 bounded dispatch", () => {
  it.each([4_999, 5_000, 5_001])("bounds failure acknowledgement to its separate cleanup budget at %i ms", async (elapsed) => {
    const h = await harness();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    h.adapter.mockRejectedValueOnce(new Error("adapter unavailable"));
    h.fail.mockImplementationOnce(async (_identity, code, signal) => {
      expect(signal.aborted).toBe(false);
      now = elapsed;
      return { requestId: identity.requestId, state: "failed", failureCode: code };
    });
    expect(await dispatchPreparedRequest(identity, { ...h.runtime, deadlineMs: 15_000 })).toEqual({
      state: elapsed < 5_000 ? "failed" : "unknown", failureCode: "adapter_error",
    });
    expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "adapter_error", expect.any(AbortSignal));
    expect(h.finish).not.toHaveBeenCalled();
  });
  it.each(["reserve", "context", "adapter", "finish"].flatMap((phase) =>
    [14_999, 15_000, 15_001].map((elapsed) => ({ phase, elapsed }))))(
    "checks elapsed time at $phase with $elapsed ms and the timer still pending", async ({ phase, elapsed }) => {
      const h = await harness();
      const reservation = await h.reserve(identity, new AbortController().signal);
      h.reserve.mockClear();
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const originalDigest = cumulative.nativeDigest;
      vi.spyOn(cumulative, "nativeDigest").mockImplementation(async (text) => {
        const digest = await originalDigest(text);
        if (phase === "context" && text === contextText) now = elapsed;
        return digest;
      });
      let dispatchSignal!: AbortSignal;
      const advance = (currentPhase: string) => {
        expect(dispatchSignal.aborted).toBe(false);
        if (phase === currentPhase) now = elapsed;
      };
      h.reserve.mockImplementationOnce(async (_identity, signal) => {
        dispatchSignal = signal;
        advance("reserve");
        return reservation;
      });
      h.adapter.mockImplementationOnce(async () => {
        advance("adapter");
        return { schema: "overdrafter.prepared-interpretation.v1", outcome: "prepared_change", depthMm: 8 };
      });
      h.finish.mockImplementationOnce(async () => {
        advance("finish");
        return { requestId: identity.requestId, outcome: "prepared_change" };
      });
      const result = await dispatchPreparedRequest(identity, { ...h.runtime, deadlineMs: 15_000 });
      const expired = elapsed >= 15_000;
      const ambiguous = phase === "reserve" || phase === "finish";
      expect(result).toMatchObject(!expired ? { state: "completed" }
        : ambiguous ? { state: "unknown" } : { state: "failed", failureCode: "timed_out" });
      expect(h.adapter).toHaveBeenCalledTimes(expired && (phase === "reserve" || phase === "context") ? 0 : 1);
      expect(h.finish).toHaveBeenCalledTimes(expired && phase !== "finish" ? 0 : 1);
      expect(dispatchSignal.aborted).toBe(expired);
      expect(h.reserve).toHaveBeenCalledExactlyOnceWith(identity, dispatchSignal);
      if (expired && !ambiguous) {
        expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "timed_out", expect.any(AbortSignal));
        const cleanupSignal = h.fail.mock.calls[0][2];
        expect(cleanupSignal).not.toBe(dispatchSignal);
        expect(cleanupSignal.aborted).toBe(false);
      } else expect(h.fail).not.toHaveBeenCalled();
    },
  );
  it.each(["reserve", "adapter", "finish"])("keeps an overdue %s rejection within deadline semantics", async (phase) => {
    const h = await harness();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const rejectLate = async () => { now = 15_001; throw new Error("PT409"); };
    if (phase === "reserve") h.reserve.mockImplementationOnce(rejectLate);
    else if (phase === "adapter") h.adapter.mockImplementationOnce(rejectLate);
    else h.finish.mockImplementationOnce(rejectLate);
    expect(await dispatchPreparedRequest(identity, { ...h.runtime, deadlineMs: 15_000 })).toEqual(
      phase === "adapter" ? { state: "failed", failureCode: "timed_out" } : { state: "unknown" },
    );
    if (phase === "adapter") expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "timed_out", expect.any(AbortSignal));
    else expect(h.fail).not.toHaveBeenCalled();
    if (phase !== "finish") expect(h.finish).not.toHaveBeenCalled();
  });
  it("refuses disabled dispatch before reservation or adapter invocation", async () => {
    const h = await harness();
    expect(await dispatchPreparedRequest(identity, { ...h.runtime, enabled: () => false })).toEqual({ state: "disabled" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.adapter).not.toHaveBeenCalled();
  });
  it("persists only classifier-approved structured intent under the reserved identity", async () => {
    const h = await harness();
    expect(await dispatchPreparedRequest(identity, h.runtime)).toMatchObject({ state: "completed" });
    expect(h.adapter).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledWith(identity, expect.objectContaining({
      outcome: "prepared_change", depthMm: 8,
    }), expect.any(AbortSignal));
    expect(h.fail).not.toHaveBeenCalled();
  });
  it("passes the bound prior clarification to the adapter for a unit-only reply", async () => {
    const h = await harness("mm");
    const contextSha256 = await nativeDigest(contextText);
    const priorClarification = { reason: "unit" as const, contextSha256, depthMm: 8 };
    h.reserve.mockResolvedValueOnce({
      state: "reserved", invoke: true, text: "mm", contextText, inputSnapshotId: snapshotId,
      contextSha256, inputSha256: await nativeDigest("mm"), organizationId, projectId,
      priorClarification,
    });
    expect(await dispatchPreparedRequest(identity, h.runtime)).toMatchObject({ state: "completed" });
    expect(h.adapter).toHaveBeenCalledWith(expect.objectContaining({ priorClarification }));
  });
  it("never invokes the adapter for a previously reserved or completed delivery", async () => {
    const h = await harness();
    h.reserve.mockResolvedValueOnce({ state: "reserved", invoke: false });
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "reserved" });
    expect(h.adapter).not.toHaveBeenCalled();
  });
  it("returns budget refusal before invoking the model adapter", async () => {
    const h = await harness();
    h.reserve.mockRejectedValueOnce(new Error("PT429"));
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "budget_exhausted" });
    expect(h.adapter).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  });
  it("rejects executable or mismatched model data before durable resolution", async () => {
    const h = await harness();
    h.adapter.mockResolvedValueOnce({
      schema: "overdrafter.prepared-interpretation.v1",
      outcome: "prepared_change", depthMm: 8, code: "run native CAD",
    });
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "failed", failureCode: "invalid_output" });
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledWith(identity, "invalid_output", expect.any(AbortSignal));
  });
  it("fails a changed context before invoking the adapter", async () => {
    const h = await harness();
    h.reserve.mockResolvedValueOnce({
      state: "reserved", invoke: true, text: "Set the depth to 8 mm", contextText,
      inputSnapshotId: snapshotId, contextSha256: "0".repeat(64),
      inputSha256: await nativeDigest("Set the depth to 8 mm"),
      organizationId, projectId, priorClarification: null,
    });
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "failed", failureCode: "invalid_output" });
    expect(h.adapter).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  });
  it("records a finite failure when the adapter never settles", async () => {
    const h = await harness();
    let entered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.adapter.mockImplementationOnce(() => { entered(); return new Promise(() => undefined); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const result = dispatchPreparedRequest(identity, { ...h.runtime, deadlineMs: 5 });
      // Let real digest validation finish without racing the adapter deadline.
      await adapterEntered;
      expect(h.adapter).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4);
      expect(h.fail).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({ state: "failed", failureCode: "timed_out" });
      expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "timed_out", expect.any(AbortSignal));
      expect(h.finish).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(["request", "context"])("does not start the adapter after the deadline expires during %s validation", async (phase) => {
    const h = await harness();
    const reservation = await h.reserve(identity, new AbortController().signal);
    h.reserve.mockResolvedValueOnce(reservation);
    const delayedText = phase === "request" ? "Set the depth to 8 mm" : contextText;
    const delayedSha256 = await nativeDigest(delayedText);
    const originalDigest = cumulative.nativeDigest;
    let releaseDigest!: (digest: string) => void;
    let entered!: () => void;
    const digestEntered = new Promise<void>((resolve) => { entered = resolve; });
    const digest = vi.spyOn(cumulative, "nativeDigest").mockImplementation((text) => {
      if (text !== delayedText) return originalDigest(text);
      entered();
      return new Promise<string>((resolve) => { releaseDigest = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const result = dispatchPreparedRequest(identity, { ...h.runtime, deadlineMs: 5 });
      await digestEntered;
      await vi.advanceTimersByTimeAsync(5);
      releaseDigest(delayedSha256);
      expect(await result).toEqual({ state: "failed", failureCode: "timed_out" });
      expect(h.adapter).not.toHaveBeenCalled();
      expect(h.finish).not.toHaveBeenCalled();
      expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "timed_out", expect.any(AbortSignal));
    } finally {
      digest.mockRestore();
      vi.useRealTimers();
    }
  });
  it("records an explicit stale-finalization conflict", async () => {
    const h = await harness();
    h.finish.mockRejectedValueOnce(new Error("PT409"));
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "conflict" });
    expect(h.fail).toHaveBeenCalledWith(identity, "conflict", expect.any(AbortSignal));
  });
  it("reports the database timeout override consistently with an exact replay", async () => {
    const h = await harness();
    h.adapter.mockRejectedValueOnce(new Error("adapter unavailable"));
    h.fail.mockResolvedValueOnce({ requestId: identity.requestId, state: "failed", failureCode: "timed_out" });
    const first = await dispatchPreparedRequest(identity, h.runtime);
    expect(first).toEqual({ state: "failed", failureCode: "timed_out" });
    h.reserve.mockResolvedValueOnce({ state: "failed", invoke: false, failureCode: "timed_out" });
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual(first);
    expect(h.reserve).toHaveBeenNthCalledWith(2, identity, expect.any(AbortSignal));
    expect(h.adapter).toHaveBeenCalledTimes(1);
    expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "adapter_error", expect.any(AbortSignal));
    expect(h.finish).not.toHaveBeenCalled();
  });
  it("reports an acknowledged adapter failure under the original identity", async () => {
    const h = await harness();
    h.adapter.mockRejectedValueOnce(new Error("adapter unavailable"));
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "failed", failureCode: "adapter_error" });
    expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "adapter_error", expect.any(AbortSignal));
    expect(h.finish).not.toHaveBeenCalled();
  });
  it("keeps lost finalization unknown without recording a replacement failure", async () => {
    const h = await harness();
    h.finish.mockRejectedValueOnce(new Error("reply lost"));
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "unknown" });
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(identity, expect.any(Object), expect.any(AbortSignal));
  });
  it.each([
    null,
    { state: "failed" },
    { requestId: projectId, state: "failed", failureCode: "adapter_error" },
    { requestId: identity.requestId, state: "completed", failureCode: "adapter_error" },
    { requestId: identity.requestId, state: "failed", failureCode: "invalid_output" },
  ])("keeps failure persistence unknown for an unbound acknowledgement: %j", async (receipt) => {
    const h = await harness();
    h.adapter.mockRejectedValueOnce(new Error("adapter unavailable"));
    h.fail.mockResolvedValueOnce(receipt);
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "unknown", failureCode: "adapter_error" });
    expect(h.fail).toHaveBeenCalledExactlyOnceWith(identity, "adapter_error", expect.any(AbortSignal));
    expect(h.adapter).toHaveBeenCalledTimes(1);
    expect(h.finish).not.toHaveBeenCalled();
  });
});
