// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityRetentionHooks, type CapabilityRetentionPreparationPort, type PreparedCapabilityClaim } from "./providerCapabilityRetention.js";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
import type { CapabilityAttentionCommit, CapabilityWindowCompletion } from "./providerCapabilityRuntimePersistence.js";
const request: PreparedCapabilityClaim["request"] = { windowKey: "canary:" + "a".repeat(64), resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey: "11111111-1111-4111-8111-111111111111", provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1", windowStart: "2026-10-02T12:00:00.000Z", windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 30 };
const completionKey = "22222222-2222-4222-8222-222222222222";
const entry = { kind: "claim_request" as const, request, completionKey };
const completion: CapabilityWindowCompletion = { windowKey: request.windowKey, requestKey: request.requestKey, completionKey, fence: "33333333-3333-4333-8333-333333333333", resourceReleased: true,
  candidate: { provider: "xometry", route: request.route, surface: request.surface, revision: request.surfaceRevision, state: "fresh", extensions: ["step"], mimeTypes: [], acceptAttributePresent: true, observedAt: request.windowStart, expiresAt: request.windowEnd, actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: "capability-canary-offline.v1", evidenceReference: "issue:OVD-415", idempotencyKey: request.windowKey } };
function attention(): CapabilityAttentionCommit {
  const metadata = { provider: "xometry" as const, route: request.route, surface: request.surface, surfaceRevision: request.surfaceRevision, policyRevision: "policy.v1", adapterRevision: null, workerBuild: null };
  const result = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: request.windowStart });
  if (result.state !== "projected") throw Error("fixture");
  return { expectedVersion: 0, evaluationKey: completionKey, cursor: result.cursor, item: result.item, intent: result.intent, evidence: null };
}
function setup(state: "created" | "existing" = "created") {
  const port = { prepareClaim: vi.fn(async (input: PreparedCapabilityClaim) => ({ state, retained: structuredClone(input) })),
    prepareCompletion: vi.fn(async (input: CapabilityWindowCompletion) => ({ state, retained: structuredClone(input) })),
    prepareAttention: vi.fn(async (input: CapabilityAttentionCommit) => ({ state, retained: structuredClone(input) })) };
  return { port, hooks: createCapabilityRetentionHooks({ enabled: true, port }) };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
describe("canonical retention preparation hooks", () => {
  it.each(["created", "existing"] as const)("preserves %s for strict canary dispatch and accepts exact attention acknowledgement", async state => {
    const f = setup(state);
    expect(await f.hooks.retainBeforeDispatch(entry, signal())).toEqual({ state });
    expect(await f.hooks.retainBeforeDispatch({ kind: "completion", input: completion }, signal())).toEqual({ state });
    await expect(f.hooks.onPrepared({ p_input: attention() }, signal())).resolves.toBeUndefined();
    expect(f.port.prepareClaim).toHaveBeenCalledOnce(); expect(f.port.prepareCompletion).toHaveBeenCalledOnce(); expect(f.port.prepareAttention).toHaveBeenCalledOnce();
  });
  it("is default off and blocks missing ports or invalid budgets without preparation", async () => {
    const f = setup();
    for (const options of [{ port: f.port }, { enabled: true, port: null }, { enabled: true, port: f.port, budgetMs: 0 }, { enabled: true, port: f.port, budgetMs: 5001 }]) {
      await expect(createCapabilityRetentionHooks(options).retainBeforeDispatch(entry, signal())).rejects.toThrow("capability_retention_unavailable");
    }
    expect(f.port.prepareClaim).not.toHaveBeenCalled();
  });
  it("captures methods and freezes an independent exact payload before await", async () => {
    const f = setup(); const replacement = vi.fn(); f.port.prepareClaim = replacement as never;
    const mutable = structuredClone(entry); const pending = f.hooks.retainBeforeDispatch(mutable, signal()); mutable.request.resourceKey = "d".repeat(64);
    expect(await pending).toEqual({ state: "created" }); expect(replacement).not.toHaveBeenCalled();
    const g = setup(); await g.hooks.retainBeforeDispatch({ kind: "completion", input: completion }, signal());
    const saved = g.port.prepareCompletion.mock.calls[0][0]; expect(Object.isFrozen(saved.candidate.extensions)).toBe(true);
    expect(saved).not.toBe(completion);
  });
  it.each([null, {}, { state: "created" }, { state: "created", retained: { request, completionKey }, extra: "private" }, { state: "unknown", retained: { request, completionKey } }, { state: "created", retained: { request, completionKey: request.requestKey } }])("rejects malformed or unequal acknowledgement %j", async response => {
    const f = setup(); f.port.prepareClaim.mockResolvedValue(response as never);
    await expect(f.hooks.retainBeforeDispatch(entry, signal())).rejects.toThrow("capability_retention_unavailable");
  });
  it("compares full completion and attention payloads, not only operation UUID", async () => {
    const f = setup(); f.port.prepareCompletion.mockResolvedValue({ state: "existing", retained: { ...completion, candidate: { ...completion.candidate, extensions: ["iges"] } } });
    await expect(f.hooks.retainBeforeDispatch({ kind: "completion", input: completion }, signal())).rejects.toThrow();
    const value = attention(); f.port.prepareAttention.mockResolvedValue({ state: "existing", retained: { ...value, expectedVersion: 1 } });
    await expect(f.hooks.onPrepared({ p_input: value }, signal())).rejects.toThrow();
  });
  it("accepts JSON object-key reordering but not array changes", async () => {
    const f = setup(); f.port.prepareClaim.mockResolvedValue({ retained: { completionKey, request: Object.fromEntries(Object.entries(request).reverse()) as typeof request }, state: "created" });
    await expect(f.hooks.retainBeforeDispatch(entry, signal())).resolves.toEqual({ state: "created" });
  });
  it("rejects accessors, holes, symbols, private extras and cyclic input before port invocation", async () => {
    const f = setup(); const getter = vi.fn(() => request); const accessor = { kind: "claim_request", completionKey, get request() { return getter(); } };
    const cyclic = structuredClone(entry) as unknown as Record<string, unknown>; cyclic.request = cyclic;
    for (const value of [accessor, cyclic, { ...entry, extra: "private" }, { ...entry, [Symbol("private")]: true }, { kind: "completion", input: { ...completion, candidate: { ...completion.candidate, extensions: new Array(1) } } }]) {
      await expect(f.hooks.retainBeforeDispatch(value as never, signal())).rejects.toThrow("capability_retention_unavailable");
    }
    expect(getter).not.toHaveBeenCalled(); expect(f.port.prepareClaim).not.toHaveBeenCalled(); expect(f.port.prepareCompletion).not.toHaveBeenCalled();
  });
  it("propagates cancellation and ignores a late created acknowledgement", async () => {
    const f = setup(); let done!: (v: unknown) => void; let portSignal!: AbortSignal;
    f.port.prepareClaim.mockImplementation(((_input, s) => { portSignal = s; return new Promise(resolve => { done = resolve; }); }) as CapabilityRetentionPreparationPort["prepareClaim"]);
    const controller = new AbortController(); const pending = f.hooks.retainBeforeDispatch(entry, controller.signal);
    const rejected = expect(pending).rejects.toThrow("capability_retention_unavailable"); controller.abort(); await rejected;
    expect(portSignal.aborted).toBe(true); done({ state: "created", retained: { request, completionKey } });
    expect(f.port.prepareClaim).toHaveBeenCalledOnce();
  });
  it("bounds a hanging port and cleans up its abort listener/timer", async () => {
    vi.useFakeTimers(); const f = setup(); f.port.prepareClaim.mockImplementation(() => new Promise(() => undefined));
    const hooks = createCapabilityRetentionHooks({ enabled: true, port: f.port, budgetMs: 10 });
    const pending = hooks.retainBeforeDispatch(entry, signal()); const rejected = expect(pending).rejects.toThrow("capability_retention_unavailable");
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
});
