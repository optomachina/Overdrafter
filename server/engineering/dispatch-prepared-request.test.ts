import { describe, expect, it, vi } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
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
  const reserve = vi.fn(async (): Promise<unknown> => ({
    state: "reserved", invoke: true, text, contextText, inputSnapshotId: snapshotId,
    contextSha256: await nativeDigest(contextText), inputSha256: await nativeDigest(text),
    organizationId, projectId, priorClarification: null,
  }));
  const finish = vi.fn(async () => ({ requestId: identity.requestId, outcome: "prepared_change" }));
  const fail = vi.fn(async () => ({ state: "failed" }));
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
  it("records an explicit stale-finalization conflict", async () => {
    const h = await harness();
    h.finish.mockRejectedValueOnce(new Error("PT409"));
    expect(await dispatchPreparedRequest(identity, h.runtime)).toEqual({ state: "conflict" });
    expect(h.fail).toHaveBeenCalledWith(identity, "conflict", expect.any(AbortSignal));
  });
});
