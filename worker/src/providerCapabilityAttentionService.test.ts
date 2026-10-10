// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCapabilityAttentionService } from "./providerCapabilityAttentionService.js";
import { projectCapabilityAttention, type CapabilityAttentionEvidence, type CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import type { CanaryPlan } from "./providerCapabilityCanary.js";
import type { PreparedCapabilityAttentionCommit } from "./providerCapabilityAttentionStoreAdapter.js";

const metadata: CapabilityAttentionMetadata = {
  provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1",
  policyRevision: "policy.v1", adapterRevision: "adapter.v1", workerBuild: null,
};
const evidence: CapabilityAttentionEvidence = {
  decision: { contractVersion: "provider-upload-capability.v1", classification: "format_added", allowedExtensions: ["step"],
    reportedAddedExtensions: ["pdf"], reportedRemovedExtensions: [], evidenceRefs: [], normalizedObservedMimeTypes: [] },
  observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T12:10:00.000Z", observationRevision: 1,
};
const time = Date.parse("2026-10-02T12:01:00.000Z");
const key = "00000000-0000-4000-8000-000000000591";
const plan = { releaseEnvelope: { provider: metadata.provider, route: metadata.route, surface: metadata.surface,
  revision: metadata.surfaceRevision, policyRevision: metadata.policyRevision } } as CanaryPlan;
function budget() { return { signal: new AbortController().signal, deadlineMs: time + 4000 }; }
function snapshot() {
  const projection = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence, previous: null, now: new Date(time).toISOString() });
  if (projection.state !== "projected") throw Error("fixture invalid");
  return { version: 1, item: projection.item, cursor: projection.cursor, evidence: structuredClone(evidence) };
}
function fixture() {
  const transport = {
    readAttention: vi.fn(async () => null as ReturnType<typeof snapshot> | null),
    commitAttention: vi.fn(async (_input: unknown, _signal: AbortSignal) => ({ status: "committed" as const, version: 1 })),
    listDueAttention: vi.fn(async () => [] as ReturnType<typeof snapshot>[]),
  };
  const onPrepared = vi.fn(async (_handle: PreparedCapabilityAttentionCommit, _signal: AbortSignal) => undefined);
  const issueEvaluationKey = vi.fn(() => key);
  const now = vi.fn(() => time);
  const options = { enabled: true, transport, reviewedMetadata: [metadata], onPrepared, issueEvaluationKey, now };
  return { transport, onPrepared, issueEvaluationKey, now, options, create: () => createCapabilityAttentionService(options) };
}

describe("confirmed attention service", () => {
  it("defaults off and empty reviewed scopes perform no operations", async () => {
    const f = fixture();
    for (const options of [{ ...f.options, enabled: false }, { ...f.options, reviewedMetadata: [] }]) {
      expect(await createCapabilityAttentionService(options).onConfirmedObservation({ plan, evidence, ...budget() })).toEqual({ state: "disabled" });
    }
    expect(f.transport.readAttention).not.toHaveBeenCalled();
    expect(f.onPrepared).not.toHaveBeenCalled();
  });
  it("requires explicit qualified retention before any SDK read or write", async () => {
    const f = fixture();
    const service = createCapabilityAttentionService({ ...f.options, onPrepared: null });
    expect(await service.sweep({ ...budget(), limit: 1 })).toEqual({ state: "dependency_unavailable" });
    expect(f.transport.listDueAttention).not.toHaveBeenCalled();
  });
  it("retains before a single commit using captured reviewed metadata and transport methods", async () => {
    const f = fixture();
    const original = f.transport.commitAttention;
    const service = f.create();
    f.options.reviewedMetadata[0] = { ...metadata, adapterRevision: "changed" };
    f.onPrepared.mockImplementation(async () => { f.transport.commitAttention = vi.fn(); });
    expect(await service.onConfirmedObservation({ plan, evidence, ...budget() })).toEqual({ state: "committed" });
    expect(original).toHaveBeenCalledTimes(1);
    expect(f.onPrepared.mock.invocationCallOrder[0]).toBeLessThan(original.mock.invocationCallOrder[0]);
    expect(f.onPrepared.mock.calls[0][0].p_input.item.metadata).toEqual(metadata);
  });
  it("does not manufacture metadata for an unmatched confirmed release", async () => {
    const f = fixture();
    const other = { ...plan, releaseEnvelope: { ...plan.releaseEnvelope, revision: "unreviewed" } };
    expect(await f.create().onConfirmedObservation({ plan: other, evidence, ...budget() })).toEqual({ state: "invalid_context" });
    expect(f.transport.readAttention).not.toHaveBeenCalled();
  });
  it("retention failure leaves confirmed evidence pending without dispatch", async () => {
    const f = fixture();
    f.onPrepared.mockRejectedValue(Error("private journal detail"));
    expect(await f.create().onConfirmedObservation({ plan, evidence, ...budget() })).toEqual({ state: "pending" });
    expect(f.transport.commitAttention).not.toHaveBeenCalled();
  });
  it("lost reply remains pending and explicit replay retains exact UUID/payload", async () => {
    const f = fixture();
    f.transport.commitAttention.mockRejectedValueOnce(Error("lost reply"));
    expect(await f.create().onConfirmedObservation({ plan, evidence, ...budget() })).toEqual({ state: "pending" });
    expect(f.transport.commitAttention).toHaveBeenCalledTimes(1);
    const handle = JSON.parse(JSON.stringify(f.onPrepared.mock.calls[0][0])) as PreparedCapabilityAttentionCommit;
    expect(await f.create().replayPrepared(handle, budget())).toEqual({ state: "committed" });
    expect(f.transport.commitAttention.mock.calls[1][0]).toEqual(f.transport.commitAttention.mock.calls[0][0]);
    expect(f.issueEvaluationKey).toHaveBeenCalledTimes(1);
  });
  it("cancels a hung retention barrier without dispatch", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.onPrepared.mockImplementation(() => new Promise(() => undefined));
      const result = f.create().onConfirmedObservation({ plan, evidence, ...budget() });
      await vi.advanceTimersByTimeAsync(4000);
      expect(await result).toEqual({ state: "cancelled" });
      expect(f.transport.commitAttention).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("bounded authoritative stale sweep", () => {
  it("reloads reviewed scopes, preserves original evidence time, and deduplicates discovery", async () => {
    const f = fixture();
    const saved = snapshot();
    f.now.mockReturnValue(time + 600000);
    f.transport.listDueAttention.mockResolvedValue([saved, saved, { ...saved, cursor: { ...saved.cursor, scopeKey: "f".repeat(64) } }]);
    f.transport.readAttention.mockResolvedValue(saved);
    f.transport.commitAttention.mockResolvedValue({ status: "committed", version: 2 });
    const result = await f.create().sweep({ signal: budget().signal, deadlineMs: time + 604000, limit: 3 });
    expect(result).toEqual({ state: "swept", visited: 1, committed: 1, pending: 0, skipped: 2 });
    const retained = f.onPrepared.mock.calls[0][0].p_input;
    expect(retained.evidence).toEqual(evidence);
    expect(retained.item.severity).toBe("unknown");
    expect(f.transport.readAttention).toHaveBeenCalledTimes(1);
  });
  it("does not use due-row evidence as authoritative or self-review its metadata", async () => {
    const f = fixture();
    f.transport.listDueAttention.mockResolvedValue([snapshot()]);
    expect(await f.create().sweep({ ...budget(), limit: 1 })).toEqual({ state: "swept", visited: 1, committed: 1, pending: 0, skipped: 0 });
    expect(f.onPrepared.mock.calls[0][0].p_input.evidence).toBeNull();
  });
  it("visits separate reviewed scopes sequentially and keeps conflicts finite", async () => {
    const f = fixture();
    const second = { ...metadata, adapterRevision: "adapter.v2" };
    f.options.reviewedMetadata.push(second);
    const projection = projectCapabilityAttention({ metadata: second, reviewedMetadata: f.options.reviewedMetadata,
      evidence, previous: null, now: new Date(time).toISOString() });
    if (projection.state !== "projected") throw Error("fixture invalid");
    f.transport.listDueAttention.mockResolvedValue([snapshot(), { version: 1, cursor: projection.cursor, item: projection.item, evidence }]);
    let counter = 0;
    f.issueEvaluationKey.mockImplementation(() => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`);
    const events: string[] = [];
    f.transport.readAttention.mockImplementation(async () => { events.push("read"); return null; });
    f.onPrepared.mockImplementation(async () => { events.push("retained"); });
    f.transport.commitAttention.mockImplementation(async () => { events.push("commit"); return { status: "conflict" } as never; });
    expect(await f.create().sweep({ ...budget(), limit: 2 })).toEqual({ state: "swept", visited: 2, committed: 0, pending: 2, skipped: 0 });
    expect(events).toEqual(["read", "retained", "commit", "read", "retained", "commit"]);
  });
  it("captures the original deadline before the list await", async () => {
    const f = fixture();
    const input = { ...budget(), limit: 1 };
    f.transport.listDueAttention.mockImplementation(async () => {
      input.deadlineMs += 60000;
      f.now.mockReturnValue(time + 4001);
      return [snapshot()];
    });
    expect(await f.create().sweep(input)).toEqual({ state: "cancelled" });
    expect(f.transport.readAttention).not.toHaveBeenCalled();
  });
  it("canonical list failure stops the batch without partial reads", async () => {
    const f = fixture();
    f.transport.listDueAttention.mockRejectedValue(Error("invalid_response"));
    expect(await f.create().sweep({ ...budget(), limit: 3 })).toEqual({ state: "list_failed" });
    expect(f.transport.readAttention).not.toHaveBeenCalled();
  });
  it.each([0, 101, 1.5])("rejects invalid limit %s before listing", async (limit) => {
    const f = fixture();
    expect(await f.create().sweep({ ...budget(), limit })).toEqual({ state: "invalid_request" });
    expect(f.transport.listDueAttention).not.toHaveBeenCalled();
  });
  it("stops before reload when cancellation arrives during listing", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.transport.listDueAttention.mockImplementation(async () => { controller.abort(); return [snapshot()]; });
    expect(await f.create().sweep({ signal: controller.signal, deadlineMs: time + 4000, limit: 1 })).toEqual({ state: "cancelled" });
    expect(f.transport.readAttention).not.toHaveBeenCalled();
  });
});
