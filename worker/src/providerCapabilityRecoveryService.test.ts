// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRecoveryService } from "./providerCapabilityRecoveryService.js";
import { projectCapabilityAttention, type CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import type { CapabilityRetentionPort } from "./providerCapabilityRetention.js";
const now = Date.parse("2026-10-02T14:00:00.000Z");
const requestKey = "11111111-1111-4111-8111-111111111111";
const completionKey = "22222222-2222-4222-8222-222222222222";
const fence = "33333333-3333-4333-8333-333333333333";
const windowKey = `canary:${"a".repeat(64)}`;
const metadata: CapabilityAttentionMetadata = { provider: "xometry", route: "quote_home", surface: "account_quote_modal",
  surfaceRevision: "surface.v1", policyRevision: "policy.v1", adapterRevision: "adapter.v1", workerBuild: null };
function retained() {
  return { request: { windowKey, resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey,
    provider: metadata.provider, route: metadata.route, surface: metadata.surface, surfaceRevision: metadata.surfaceRevision,
    windowStart: "2026-10-02T12:00:00.000Z", windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 5 }, completionKey };
}
function completion() {
  return { windowKey, requestKey, completionKey, fence, resourceReleased: true as const, candidate: {
    provider: metadata.provider, route: metadata.route, surface: metadata.surface, revision: metadata.surfaceRevision,
    state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true,
    observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T12:01:00.000Z", actorKind: "scheduled_canary" as const,
    sourceKind: "scheduled_canary" as const, sourceVersion: "capability-canary-offline.v1", evidenceReference: "issue:OVD-415", idempotencyKey: windowKey,
  } };
}
function attention() {
  const result = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: new Date(now).toISOString() });
  if (result.state !== "projected") throw Error();
  return { expectedVersion: 0, evaluationKey: requestKey, cursor: result.cursor, item: result.item, intent: result.intent, evidence: null };
}
function budget() { return { signal: new AbortController().signal, deadlineMs: now + 4000 }; }
function fixture() {
  const port = { readClaim: vi.fn().mockResolvedValue(retained()), readCompletion: vi.fn().mockResolvedValue(completion()),
    readAttention: vi.fn().mockResolvedValue(attention()), listClaims: vi.fn(), listAttention: vi.fn() };
  const status = vi.fn().mockResolvedValue({ status: "completed", windowKey, owner: requestKey, fence, generation: 1,
    observationRevision: 17, deadline: "2026-10-02T12:00:05.000Z" });
  const complete = vi.fn().mockResolvedValue({ status: "completed", windowKey, observationRevision: 17 });
  const attentionReplay = vi.fn().mockResolvedValue({ state: "committed" });
  const options = { enabled: true, port: port as unknown as CapabilityRetentionPort, reviewedWindows: [windowKey],
    reviewedMetadata: [metadata], now: () => now, status, complete, attentionReplay };
  return { port, status, complete, attentionReplay, options, create: () => createCapabilityRecoveryService(options) };
}

describe("bounded restart discovery", () => {
  it("defaults off and cannot read unreviewed windows or scopes", async () => {
    const f = fixture();
    expect(await createCapabilityRecoveryService({ ...f.options, enabled: false }).readClaim({ ...budget(), windowKey, requestKey })).toEqual({ state: "disabled" });
    expect(await f.create().listAttention({ ...budget(), scopeKey: "f".repeat(64), afterCursor: null, limit: 1 })).toEqual({ state: "invalid_request" });
    expect(f.port.readClaim).not.toHaveBeenCalled();
    expect(f.port.listAttention).not.toHaveBeenCalled();
  });
  it("returns one detached immutable page with explicit continuation and no dispatch", async () => {
    const f = fixture();
    const value = { entries: [{ cursor: "9007199254740993", input: retained() }], nextCursor: "9007199254740993", hasMore: true };
    f.port.listClaims.mockResolvedValue(value);
    const result = await f.create().listClaims({ ...budget(), windowKey, afterCursor: "9007199254740992", limit: 2 });
    expect(result).toEqual({ state: "page", page: value });
    value.entries[0].input.request.provider = "changed";
    if (result.state !== "page") throw Error();
    expect(result.page.entries[0].input.request.provider).toBe("xometry");
    expect(Object.isFrozen(result.page.entries[0].input.request)).toBe(true);
    expect(f.port.listClaims).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });
  it.each([
    { entries: [], nextCursor: "1", hasMore: false }, { entries: [], nextCursor: null, hasMore: true },
    { entries: [{ cursor: "01", input: retained() }], nextCursor: "01", hasMore: false },
    { entries: [{ cursor: "2", input: retained() }], nextCursor: null, hasMore: false },
  ])("rejects malformed whole page %j", async page => {
    const f = fixture(); f.port.listClaims.mockResolvedValue(page);
    expect(await f.create().listClaims({ ...budget(), windowKey, afterCursor: null, limit: 1 })).toEqual({ state: "invalid_response" });
  });
  it("keeps request and completion UUID uniqueness in separate namespaces", async () => {
    const f = fixture();
    const first = { ...retained(), completionKey: requestKey };
    const second = { ...retained(), request: { ...retained().request, requestKey: completionKey }, completionKey };
    f.port.listClaims.mockResolvedValue({ entries: [{ cursor: "1", input: first }, { cursor: "2", input: second }], nextCursor: "2", hasMore: false });
    expect((await f.create().listClaims({ ...budget(), windowKey, afterCursor: null, limit: 2 })).state).toBe("page");
  });
  it("freezes even the terminal empty entries array", async () => {
    const f = fixture(); f.port.listClaims.mockResolvedValue({ entries: [], nextCursor: null, hasMore: false });
    const result = await f.create().listClaims({ ...budget(), windowKey, afterCursor: null, limit: 1 });
    if (result.state !== "page") throw Error();
    expect(Object.isFrozen(result.page.entries)).toBe(true);
  });
  it("rejects sparse entries disguised by a numeric non-index property", async () => {
    const f = fixture();
    const entries = new Array(1);
    Object.defineProperty(entries, "4294967295", { value: { cursor: "1", input: retained() }, enumerable: true });
    f.port.listClaims.mockResolvedValue({ entries, nextCursor: null, hasMore: false });
    expect(await f.create().listClaims({ ...budget(), windowKey, afterCursor: null, limit: 1 })).toEqual({ state: "invalid_response" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.status).not.toHaveBeenCalled();
  });
  it("does not invoke accessor input or return a partial page", async () => {
    const f = fixture(); const getter = vi.fn(() => retained());
    f.port.listClaims.mockResolvedValue({ entries: [{ cursor: "1", get input() { return getter(); } }], nextCursor: "1", hasMore: false });
    expect(await f.create().listClaims({ ...budget(), windowKey, afterCursor: null, limit: 1 })).toEqual({ state: "invalid_response" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("distinguishes absent from malformed reads and never grants authority on reconciliation", async () => {
    const f = fixture();
    f.port.readClaim.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    const service = f.create();
    expect(await service.readClaim({ ...budget(), windowKey, requestKey })).toEqual({ state: "absent" });
    expect(await service.readClaim({ ...budget(), windowKey, requestKey })).toEqual({ state: "invalid_response" });
    expect(await service.reconcileClaim({ ...budget(), windowKey, requestKey })).toEqual({ state: "reconciled", status: "completion_known" });
    expect(f.complete).not.toHaveBeenCalled();
  });
});
describe("explicit replay only", () => {
  it("replays an expired retained exact completion once and reports attention pending", async () => {
    const f = fixture();
    expect(await f.create().replayCompletion({ ...budget(), windowKey, requestKey, completionKey })).toEqual({ state: "recorded_attention_pending" });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.calls[0][0]).toEqual(completion());
    expect(f.attentionReplay).not.toHaveBeenCalled();
  });
  it.each([{ owner: completionKey }, { fence: requestKey }, { status: "claimed" }, { generation: 2 }, { observationRevision: "17" }])("rejects mismatched authoritative receipt %j", async patch => {
    const f = fixture(); f.status.mockResolvedValue({ ...await f.status(), ...patch });
    expect(await f.create().replayCompletion({ ...budget(), windowKey, requestKey, completionKey })).toEqual({ state: "invalid_response" });
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("rejects open candidate shapes on reads before status or dispatch", async () => {
    const f = fixture();
    f.port.readCompletion.mockResolvedValue({ ...completion(), candidate: { ...completion().candidate, privateExtra: "not retained contract" } });
    expect(await f.create().readCompletion({ ...budget(), windowKey, requestKey, completionKey })).toEqual({ state: "invalid_response" });
    expect(f.status).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("never retries a lost completion reply", async () => {
    const f = fixture(); f.complete.mockRejectedValue(Error("private detail"));
    expect(await f.create().replayCompletion({ ...budget(), windowKey, requestKey, completionKey })).toEqual({ state: "uncertain" });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it("reads attention without replay then explicitly reuses the same retained UUID/payload", async () => {
    const f = fixture(); const service = f.create();
    const input = { ...budget(), scopeKey: attention().cursor.scopeKey, evaluationKey: requestKey };
    expect((await service.readAttention(input)).state).toBe("value");
    expect(f.attentionReplay).not.toHaveBeenCalled();
    expect(await service.replayAttention(input)).toEqual({ state: "committed" });
    expect(f.attentionReplay.mock.calls[0][0]).toEqual({ p_input: attention() });
  });
  it("rechecks the captured clock deadline before dispatch without waiting for a timer", async () => {
    const f = fixture(); let clock = now;
    f.options.now = () => clock;
    const input = { ...budget(), windowKey, requestKey, completionKey };
    f.status.mockImplementation(async () => {
      clock += 5000;
      input.deadlineMs += 60000;
      return { status: "completed", windowKey, owner: requestKey, fence, generation: 1, observationRevision: 17, deadline: "2026-10-02T12:00:05.000Z" };
    });
    expect(await f.create().replayCompletion(input)).toEqual({ state: "cancelled" });
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("cancellation during retained read prevents later completion dispatch", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let finish!: (value: ReturnType<typeof retained>) => void;
      f.port.readClaim.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const result = f.create().replayCompletion({ ...budget(), windowKey, requestKey, completionKey });
      await vi.advanceTimersByTimeAsync(4000);
      expect(await result).toEqual({ state: "cancelled" });
      finish(retained()); await Promise.resolve(); await Promise.resolve();
      expect(f.port.readCompletion).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("captured recovery deadline without a timer turn", () => {
  it.each(["readCompletion", "replayCompletion", "reconcileClaim"] as const)("%s stops after a claim read consumes the budget", async method => {
    const f = fixture(); let clock = now; f.options.now = () => clock;
    const input = { ...budget(), windowKey, requestKey, completionKey };
    f.port.readClaim.mockImplementation(async () => { clock = input.deadlineMs; input.deadlineMs += 60000; return retained(); });
    expect(await f.create()[method](input)).toEqual({ state: "cancelled" });
    expect(f.port.readCompletion).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it("does not start status after a completion read consumes the budget", async () => {
    const f = fixture(); let clock = now; f.options.now = () => clock;
    f.port.readCompletion.mockImplementation(async () => { clock = now + 4000; return completion(); });
    expect(await f.create().replayCompletion({ ...budget(), windowKey, requestKey, completionKey })).toEqual({ state: "cancelled" });
    expect(f.status).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it.each(["completion", "attention"])("late %s write reply stays uncertain without retry", async kind => {
    const f = fixture(); let clock = now; f.options.now = () => clock;
    f.complete.mockImplementation(async () => { clock = now + 4000; return { status: "completed", windowKey, observationRevision: 17 }; });
    f.attentionReplay.mockImplementation(async () => { clock = now + 4000; return { state: "committed" }; });
    const service = f.create();
    const result = kind === "completion" ? await service.replayCompletion({ ...budget(), windowKey, requestKey, completionKey })
      : await service.replayAttention({ ...budget(), scopeKey: attention().cursor.scopeKey, evaluationKey: requestKey });
    expect(result).toEqual({ state: "uncertain" });
    expect(kind === "completion" ? f.complete : f.attentionReplay).toHaveBeenCalledTimes(1);
  });
  it.each(["readClaim", "readAttention", "listClaims", "listAttention"] as const)("%s does not publish a late read result", async method => {
    const f = fixture(); let clock = now; f.options.now = () => clock;
    f.port[method].mockImplementation(async () => { clock = now + 4000; return method.startsWith("list") ? { entries: [], nextCursor: null, hasMore: false } : null; });
    expect(await f.create()[method]({ ...budget(), windowKey, requestKey, scopeKey: attention().cursor.scopeKey, evaluationKey: requestKey, afterCursor: null, limit: 1 })).toEqual({ state: "cancelled" });
  });
});
