// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
import { createCapabilityRecoveryService } from "./providerCapabilityRecoveryService.js";
import { createCapabilityRetentionHooks } from "./providerCapabilityRetention.js";

const request = { windowKey: "canary:" + "a".repeat(64), resourceKey: "b".repeat(64), configDigest: "c".repeat(64),
  requestKey: "11111111-1111-4111-8111-111111111111", provider: "xometry", route: "quote_home", surface: "account_quote_modal",
  surfaceRevision: "surface.v1", windowStart: "2026-10-02T12:00:00.000Z", windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 30 };
const completionKey = "22222222-2222-4222-8222-222222222222";
const preparedClaim = { request, completionKey };
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function hooksFixture() {
  const port = { prepareClaim: vi.fn(async () => ({ state: "created", retained: structuredClone(preparedClaim) })),
    prepareCompletion: vi.fn(), prepareAttention: vi.fn() };
  const hooks = createCapabilityRetentionHooks({ enabled: true, port });
  return { port, hooks, entry: { kind: "claim_request" as const, ...preparedClaim } };
}

describe("retention acknowledgement adversarial boundary", () => {
  it.each([
    { request: { ...request, requestKey: completionKey }, completionKey },
    { request: { ...request, windowKey: "canary:" + "d".repeat(64) }, completionKey },
    { request: { ...request, resourceKey: "d".repeat(64) }, completionKey },
    { request: { ...request, configDigest: "d".repeat(64) }, completionKey },
    { request, completionKey: request.requestKey },
  ])("refuses a retained association different from the submitted payload %j", async retained => {
    const f = hooksFixture(); f.port.prepareClaim.mockResolvedValue({ state: "created", retained });
    await expect(f.hooks.retainBeforeDispatch(f.entry, signal())).rejects.toThrow();
    expect(f.port.prepareClaim).toHaveBeenCalledTimes(1);
  });
  it("keeps exact existing acknowledgement distinct from new claim permission", async () => {
    const f = hooksFixture(); f.port.prepareClaim.mockResolvedValue({ state: "existing", retained: structuredClone(preparedClaim) });
    expect(await f.hooks.retainBeforeDispatch(f.entry, signal())).toEqual({ state: "existing" });
    expect(f.port.prepareCompletion).not.toHaveBeenCalled();
  });
  it("late acknowledgement after cancellation never becomes dispatch permission", async () => {
    const f = hooksFixture(); let finish!: (value: { state: string; retained: typeof preparedClaim }) => void;
    f.port.prepareClaim.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); const running = f.hooks.retainBeforeDispatch(f.entry, controller.signal);
    const rejected = expect(running).rejects.toThrow(); await Promise.resolve(); controller.abort(); await rejected;
    finish({ state: "created", retained: structuredClone(preparedClaim) }); await Promise.resolve();
    expect(f.port.prepareClaim).toHaveBeenCalledTimes(1); expect(f.port.prepareCompletion).not.toHaveBeenCalled();
  });
});

const completedInput = { windowKey: request.windowKey, requestKey: request.requestKey, completionKey,
  fence: "33333333-3333-4333-8333-333333333333", resourceReleased: true as const,
  candidate: { provider: "xometry" as const, route: request.route, surface: request.surface, revision: request.surfaceRevision,
    state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true,
    observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T12:10:00.000Z",
    actorKind: "scheduled_canary" as const, sourceKind: "scheduled_canary" as const, sourceVersion: "capability-canary-offline.v1",
    evidenceReference: "issue:OVD-415", idempotencyKey: request.windowKey } };

it("refuses a completion acknowledgement that rewrites its retained fence", async () => {
  const f = hooksFixture(); f.port.prepareCompletion.mockResolvedValue({ state: "existing", retained: { ...completedInput, fence: completionKey } });
  await expect(f.hooks.retainBeforeDispatch({ kind: "completion", input: completedInput }, signal())).rejects.toThrow();
  expect(f.port.prepareCompletion).toHaveBeenCalledTimes(1);
});


const replayTime = Date.parse("2026-10-03T12:00:00.000Z");
function recoveryFixture() {
  const port = { readClaim: vi.fn().mockResolvedValue(preparedClaim), readCompletion: vi.fn().mockResolvedValue(completedInput),
    readAttention: vi.fn().mockResolvedValue(null), listClaims: vi.fn(), listAttention: vi.fn() };
  const receipt = { status: "completed", windowKey: request.windowKey, owner: request.requestKey, fence: completedInput.fence,
    generation: 1, observationRevision: 17, deadline: "2026-10-02T12:00:30.000Z" };
  const status = vi.fn().mockResolvedValue(receipt);
  const complete = vi.fn().mockResolvedValue({ status: "completed", windowKey: request.windowKey, observationRevision: 17 });
  const attentionReplay = vi.fn().mockResolvedValue({ state: "committed" });
  const service = createCapabilityRecoveryService({ enabled: true, port, reviewedWindows: [request.windowKey], reviewedMetadata: [],
    now: () => replayTime, status, complete, attentionReplay });
  const budget = { signal: signal(), deadlineMs: replayTime + 5000 };
  return { port, status, complete, attentionReplay, receipt, service, budget,
    query: { ...budget, windowKey: request.windowKey, afterCursor: null as string | null, limit: 4 },
    replay: { ...budget, windowKey: request.windowKey, requestKey: request.requestKey, completionKey } };
}
function row(cursor: string, index = 1) {
  return { cursor, input: { request: { ...request, requestKey: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` },
    completionKey: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}` } };
}

describe("decimal discovery page boundaries", () => {
  it("preserves numeric cursor order beyond JS safe integers without rounding or lexical comparison", async () => {
    const f = recoveryFixture(); const entries = ["9", "10", "9007199254740992", "9007199254740993"].map((value, index) => row(value, index + 1));
    const page = { entries, nextCursor: "9007199254740993", hasMore: false };
    f.port.listClaims.mockResolvedValue(page);
    expect(await f.service.listClaims(f.query)).toEqual({ state: "page", page });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled();
  });
  it("accepts a nonempty short page with hasMore without inventing a fullness contract", async () => {
    const f = recoveryFixture(); const page = { entries: [row("9007199254740993")], nextCursor: "9007199254740993", hasMore: true };
    f.port.listClaims.mockResolvedValue(page);
    expect(await f.service.listClaims({ ...f.query, afterCursor: "9007199254740992" })).toEqual({ state: "page", page });
  });
  it.each([
    { entries: [], nextCursor: null, hasMore: true },
    { entries: [], nextCursor: "10", hasMore: false },
    { entries: [row("10")], nextCursor: null, hasMore: false },
    { entries: [row("10")], nextCursor: "11", hasMore: false },
    { entries: [row("10"), row("10", 2)], nextCursor: "10", hasMore: false },
    { entries: [row("10"), row("9", 2)], nextCursor: "9", hasMore: false },
    { entries: [row("9007199254740993"), row("9007199254740992", 2)], nextCursor: "9007199254740992", hasMore: false },
    { entries: [row("01")], nextCursor: "01", hasMore: false },
    { entries: [row("0")], nextCursor: "0", hasMore: false },
    { entries: Array.from({ length: 5 }, (_, i) => row(String(i + 1), i + 1)), nextCursor: "5", hasMore: false },
  ])("rejects malformed page atomically without dispatch: %j", async page => {
    const f = recoveryFixture(); f.port.listClaims.mockResolvedValue(page);
    expect(await f.service.listClaims(f.query)).toEqual({ state: "invalid_response" });
    expect(f.status).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it("rejects repeated cursor across explicit page requests and wrong window associations", async () => {
    const f = recoveryFixture(); f.port.listClaims.mockResolvedValue({ entries: [row("9007199254740993")], nextCursor: "9007199254740993", hasMore: false });
    expect(await f.service.listClaims({ ...f.query, afterCursor: "9007199254740993" })).toEqual({ state: "invalid_response" });
    f.port.listClaims.mockResolvedValue({ entries: [{ cursor: "1", input: { ...preparedClaim, request: { ...request, windowKey: "canary:" + "d".repeat(64) } } }], nextCursor: "1", hasMore: false });
    expect(await f.service.listClaims(f.query)).toEqual({ state: "invalid_response" });
  });
});

describe("explicit completion recovery authority", () => {
  it("replays historical exact completion once after lease expiry, reports pending attention without reconstructing evidence", async () => {
    const f = recoveryFixture();
    expect(await f.service.replayCompletion(f.replay)).toEqual({ state: "recorded_attention_pending" });
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.complete.mock.calls[0][0]).toEqual(completedInput);
    expect(f.attentionReplay).not.toHaveBeenCalled();
  });
  it.each([{ owner: completionKey }, { fence: completionKey }, { windowKey: "canary:" + "d".repeat(64) },
    { generation: 2 }, { observationRevision: Number.MAX_SAFE_INTEGER + 1 }, { status: "claimed" }])(
    "refuses substituted authoritative status %j before completion", async patch => {
      const f = recoveryFixture(); f.status.mockResolvedValue({ ...f.receipt, ...patch });
      expect(await f.service.replayCompletion(f.replay)).toEqual({ state: "invalid_response" }); expect(f.complete).not.toHaveBeenCalled();
    },
  );
  it.each([{ completionKey: request.requestKey }, { requestKey: completionKey }, { candidate: { ...completedInput.candidate, revision: "other.v1" } }])(
    "refuses saved completion association substitution %j", async patch => {
      const f = recoveryFixture(); f.port.readCompletion.mockResolvedValue({ ...completedInput, ...patch });
      expect(await f.service.replayCompletion(f.replay)).toEqual({ state: "invalid_response" }); expect(f.complete).not.toHaveBeenCalled();
    },
  );
  it("reconciliation grants no executable claim and does not complete", async () => {
    const f = recoveryFixture();
    expect(await f.service.reconcileClaim(f.replay)).toEqual({ state: "reconciled", status: "completion_known" });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.attentionReplay).not.toHaveBeenCalled();
  });
  it("lost explicit completion reply remains uncertain with no automatic repeat or attention", async () => {
    const f = recoveryFixture(); f.complete.mockRejectedValue(Error("private"));
    expect(await f.service.replayCompletion(f.replay)).toEqual({ state: "uncertain" });
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.attentionReplay).not.toHaveBeenCalled();
  });
});


function attentionRecoveryFixture() {
  const f = recoveryFixture();
  const metadata = { provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1",
    policyRevision: "policy.v1", adapterRevision: null, workerBuild: null };
  const projected = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: "2026-10-02T12:00:00.000Z" });
  if (projected.state !== "projected") throw Error("fixture");
  const input = { expectedVersion: 0, evaluationKey: completionKey, cursor: projected.cursor, item: projected.item, intent: projected.intent, evidence: null };
  f.port.readAttention.mockResolvedValue(input);
  const service = createCapabilityRecoveryService({ enabled: true, port: f.port, reviewedWindows: [], reviewedMetadata: [metadata],
    now: () => replayTime, attentionReplay: f.attentionReplay });
  return { ...f, service, input, query: { ...f.budget, scopeKey: projected.cursor.scopeKey, evaluationKey: completionKey } };
}

describe("prepared attention recovery association", () => {
  it("preserves historical evaluation bytes without new clock projection on explicit replay", async () => {
    const f = attentionRecoveryFixture();
    expect(await f.service.replayAttention(f.query)).toEqual({ state: "committed" });
    expect(f.attentionReplay).toHaveBeenCalledTimes(1); expect(f.attentionReplay.mock.calls[0][0]).toEqual({ p_input: f.input });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled();
  });
  it.each(["scope", "evaluation"])("refuses wrong %s association before replay", async field => {
    const f = attentionRecoveryFixture();
    f.port.readAttention.mockResolvedValue(field === "scope" ? { ...f.input, cursor: { ...f.input.cursor, scopeKey: "e".repeat(64) } }
      : { ...f.input, evaluationKey: request.requestKey });
    expect(await f.service.replayAttention(f.query)).toEqual({ state: "invalid_response" }); expect(f.attentionReplay).not.toHaveBeenCalled();
  });
  it("preserves precise attention-page cursor and rejects duplicate evaluation identities", async () => {
    const f = attentionRecoveryFixture();
    const page = { entries: [{ cursor: "9007199254740993", input: f.input }], nextCursor: "9007199254740993", hasMore: false };
    f.port.listAttention.mockResolvedValue(page);
    const query = { ...f.query, afterCursor: "9007199254740992", limit: 2 };
    expect(await f.service.listAttention(query)).toEqual({ state: "page", page });
    f.port.listAttention.mockResolvedValue({ entries: [...page.entries, { cursor: "9007199254740994", input: f.input }], nextCursor: "9007199254740994", hasMore: false });
    expect(await f.service.listAttention(query)).toEqual({ state: "invalid_response" }); expect(f.attentionReplay).not.toHaveBeenCalled();
  });
  it("cancellation during recovery read prevents a late retained evaluation from replaying", async () => {
    const f = attentionRecoveryFixture(); let finish!: (value: unknown) => void;
    f.port.readAttention.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const running = f.service.replayAttention({ ...f.query, signal: controller.signal });
    await Promise.resolve(); controller.abort(); expect(await running).toEqual({ state: "cancelled" });
    finish(f.input); await Promise.resolve(); await Promise.resolve();
    expect(f.attentionReplay).not.toHaveBeenCalled();
  });
});

it.each(["same_claim", "cross_claim"])("keeps request and completion UUID uniqueness in separate namespaces: %s", async mode => {
  const f = recoveryFixture(); const first = row("1");
  const entries = mode === "same_claim"
    ? [{ ...first, input: { ...first.input, completionKey: first.input.request.requestKey } }]
    : [first, { cursor: "2", input: { request: { ...request, requestKey: first.input.completionKey }, completionKey: first.input.request.requestKey } }];
  const page = { entries, nextCursor: entries.at(-1)!.cursor, hasMore: false };
  f.port.listClaims.mockResolvedValue(page);
  expect(await f.service.listClaims(f.query)).toEqual({ state: "page", page });
});

it("returns an immutable terminal empty page including its entries array", async () => {
  const f = recoveryFixture(); f.port.listClaims.mockResolvedValue({ entries: [], nextCursor: null, hasMore: false });
  const result = await f.service.listClaims(f.query);
  expect(result).toEqual({ state: "page", page: { entries: [], nextCursor: null, hasMore: false } });
  if (result.state !== "page") throw Error("expected page");
  expect(Object.isFrozen(result.page)).toBe(true); expect(Object.isFrozen(result.page.entries)).toBe(true);
});

it("checks captured deadline before completion when the clock advances without a timer turn", async () => {
  const f = recoveryFixture(); let clock = replayTime;
  const service = createCapabilityRecoveryService({ enabled: true, port: f.port, reviewedWindows: [request.windowKey],
    reviewedMetadata: [], now: () => clock, status: f.status, complete: f.complete });
  const input = { ...f.replay, deadlineMs: replayTime + 100 };
  f.status.mockImplementation(async () => {
    clock = replayTime + 101;
    input.deadlineMs = replayTime + 10_000; // Mutation cannot renew the captured budget.
    return f.receipt;
  });
  const result = await service.replayCompletion(input);
  expect(result.state).not.toBe("recorded_attention_pending"); expect(f.complete).not.toHaveBeenCalled();
});
