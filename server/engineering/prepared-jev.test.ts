import { describe, expect, it, vi } from "vitest";
import { NATIVE_SEED_FILES, nativeDigest } from "../../src/lib/engineering-cumulative";
import { type DispatchIdentity, type PreparedDispatchRuntime } from "./dispatch-prepared-request";

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
import { createPreparedJevAdapter, dispatchPreparedRequestWithJev } from "./prepared-jev";
function receipt() {
  return { result: { model: "jev-1.13.0", answers: { action: {
    choice: "confirm", confidence: 0.8, probabilities: { confirm: 0.95 },
  } }, usage: { input_tokens: 10, output_tokens: 2 } }, request_elapsed_ms: 1, estimated_api_cost_usd: 0 };
}
async function harness(text = "Set the depth to 8 mm") {
  const reservation = { state: "reserved", invoke: true, text, contextText,
    inputSnapshotId: snapshotId, contextSha256: await nativeDigest(contextText),
    inputSha256: await nativeDigest(text), organizationId, projectId, priorClarification: null };
  const reserve = vi.fn(async (): Promise<unknown> => reservation);
  const finish = vi.fn(async () => ({ requestId: identity.requestId }));
  const fail = vi.fn(async () => ({ state: "failed" }));
  const call = vi.fn(async (): Promise<unknown> => receipt());
  const runtime: Omit<PreparedDispatchRuntime, "adapter"> = {
    enabled: () => true, reserve, finish, fail, deadlineMs: 200,
  };
  return { reservation, reserve, finish, fail, call, runtime };
}
describe("prepared Jev source composition (actual provider calls: 0)", () => {
  it("reserves before a synthetic Jev review and finalizes only the exact deterministic depth", async () => {
    const h = await harness();
    expect(await dispatchPreparedRequestWithJev(identity, h.runtime, h.call)).toMatchObject({ state: "completed" });
    expect(h.call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "jev-1.13.0",
      state: expect.objectContaining({ proposedInterpretation: { outcome: "prepared_change", depthMm: 8 } }),
    }), expect.any(AbortSignal));
    expect(h.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.call.mock.invocationCallOrder[0]);
    expect(h.call.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]);
    expect(h.finish).toHaveBeenCalledWith(identity, expect.objectContaining({ outcome: "prepared_change", depthMm: 8 }), expect.any(AbortSignal));
  });
  it.each([null, {}, { result: {} }])("rejects malformed helper output %j", async (output) => {
    const h = await harness(); h.call.mockResolvedValue(output);
    expect(await dispatchPreparedRequestWithJev(identity, h.runtime, h.call)).toEqual({ state: "failed", failureCode: "invalid_output" });
    expect(h.finish).not.toHaveBeenCalled();
  });
  it.each(["confidence", "probability", "model", "choice", "usage", "cost"])('rejects invalid %s without finalization', async (field) => {
    const h = await harness(); const r = receipt();
    if (field === "confidence") r.result.answers.action.confidence = 0.799;
    if (field === "probability") r.result.answers.action.probabilities.confirm = 0.949;
    if (field === "model") r.result.model = "other-model";
    if (field === "choice") r.result.answers.action.choice = "reject";
    if (field === "usage") r.result.usage.input_tokens = -1;
    if (field === "cost") r.estimated_api_cost_usd = NaN;
    h.call.mockResolvedValue(r);
    expect(await dispatchPreparedRequestWithJev(identity, h.runtime, h.call)).toEqual({ state: "failed", failureCode: "invalid_output" });
    expect(h.finish).not.toHaveBeenCalled();
  });
  it.each(["Set the depth to 11 mm", "Build a plate and delete the assembly", "Increase depth by 2 mm"])("cannot authorize unsupported request %s even with model confirmation", async (text) => {
    const h = await harness(text);
    expect(await dispatchPreparedRequestWithJev(identity, h.runtime, h.call)).toMatchObject({ state: "completed" });
    expect(h.finish).toHaveBeenCalledWith(identity, expect.objectContaining({ outcome: "no_change", depthMm: null }), expect.any(AbortSignal));
  });
  it("retains clarification for missing units", async () => {
    const h = await harness("Set depth to 8");
    expect(await dispatchPreparedRequestWithJev(identity, h.runtime, h.call)).toMatchObject({ state: "completed" });
    expect(h.finish).toHaveBeenCalledWith(identity, expect.objectContaining({ outcome: "needs_context", depthMm: null }), expect.any(AbortSignal));
  });
  it.each(["disabled", "stale", "replay", "budget"])("avoids Jev invocation when %s", async (kind) => {
    const h = await harness();
    if (kind === "disabled") h.runtime = { ...h.runtime, enabled: () => false };
    if (kind === "stale") h.reservation.contextSha256 = "0".repeat(64);
    if (kind === "replay") h.reservation.invoke = false;
    if (kind === "budget") h.reserve.mockRejectedValue(new Error("PT429"));
    await dispatchPreparedRequestWithJev(identity, h.runtime, h.call);
    expect(h.call).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });
  it("refuses a late synthetic response after cancellation", async () => {
    const call = vi.fn(async () => { controller.abort(); return receipt(); });
    const controller = new AbortController();
    await expect(createPreparedJevAdapter(call)({ text: "8 mm", contextText, contextSha256: "a".repeat(64),
      priorClarification: null, signal: controller.signal,
      deterministicProposal: { outcome: "prepared_change", depthMm: 8 },
    })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("omits hashes and private context from the outbound Jev payload", async () => {
    const h = await harness("mm");
    h.reserve.mockResolvedValue({ ...h.reservation,
      priorClarification: { reason: "unit", depthMm: 8, contextSha256: h.reservation.contextSha256 } });
    await dispatchPreparedRequestWithJev(identity, h.runtime, h.call);
    expect(h.call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      state: { instruction: "mm", priorClarification: { reason: "unit", depthMm: 8 },
        proposedInterpretation: { outcome: "prepared_change", depthMm: 8 },
        allowedOperation: "One absolute prepared-part depth change from 6 to 10 millimeters only." },
    }), expect.any(AbortSignal));
    const payload = JSON.stringify(h.call.mock.calls);
    expect(payload).not.toContain(h.reservation.contextSha256);
    expect(payload).not.toContain("synthetic-assembly");
    expect(payload).not.toContain(snapshotId);
  });

});
