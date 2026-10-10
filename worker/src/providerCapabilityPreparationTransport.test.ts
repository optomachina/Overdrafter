// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityPreparationTransport } from "./providerCapabilityPreparationTransport.js";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
import type { CapabilityRetentionPort, PreparedCapabilityClaim } from "./providerCapabilityRetention.js";
import type { CapabilityAttentionCommit, CapabilityWindowCompletion } from "./providerCapabilityRuntimePersistence.js";
const id = "11111111-1111-4111-8111-111111111111", completionKey = "22222222-2222-4222-8222-222222222222";
const claim: PreparedCapabilityClaim = { request: { windowKey: "canary:" + "a".repeat(64), resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey: id,
  provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1", windowStart: "2026-10-02T12:00:00.000Z", windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 30 }, completionKey };
const completion: CapabilityWindowCompletion = { windowKey: claim.request.windowKey, requestKey: id, completionKey, fence: "33333333-3333-4333-8333-333333333333", resourceReleased: true,
  candidate: { provider: "xometry", route: claim.request.route, surface: claim.request.surface, revision: claim.request.surfaceRevision, state: "fresh", extensions: ["step"], mimeTypes: [], acceptAttributePresent: true, observedAt: claim.request.windowStart, expiresAt: claim.request.windowEnd, actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: "capability-canary-offline.v1", evidenceReference: "issue:OVD-415", idempotencyKey: claim.request.windowKey } };
function attention(): CapabilityAttentionCommit {
  const metadata = { provider: "xometry" as const, route: claim.request.route, surface: claim.request.surface, surfaceRevision: claim.request.surfaceRevision, policyRevision: "policy.v1", adapterRevision: null, workerBuild: null };
  const projection = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: claim.request.windowStart });
  if (projection.state !== "projected") throw Error("fixture");
  return { expectedVersion: 0, evaluationKey: completionKey, cursor: projection.cursor, item: projection.item, intent: projection.intent, evidence: null };
}
const empty = { entries: [], nextCursor: null, hasMore: false };
const signal = () => new AbortController().signal;
function fixture(data: unknown, options: { enabled?: boolean; budgetMs?: number } = { enabled: true }) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
  const client = createClient("https://synthetic.invalid", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  const factory = vi.fn(() => client);
  const config = { ...options, createClient: factory };
  return { fetch, factory, client, config, port: createCapabilityPreparationTransport(config) };
}
afterEach(() => vi.useRealTimers());
describe("exact canonical preparation SDK transport", () => {
  const evaluation = attention();
  const cases: Array<{ name: string; data: unknown; wire: unknown; run: (p: CapabilityRetentionPort) => Promise<unknown> }> = [
    { name: "api_prepare_capability_claim", data: { state: "created", retained: claim }, wire: { p_input: claim }, run: p => p.prepareClaim(claim, signal()) },
    { name: "api_read_prepared_capability_claim", data: claim, wire: { p_request_key: id }, run: p => p.readClaim(id, signal()) },
    { name: "api_prepare_capability_completion", data: { state: "existing", retained: completion }, wire: { p_input: completion }, run: p => p.prepareCompletion(completion, signal()) },
    { name: "api_read_prepared_capability_completion", data: completion, wire: { p_completion_key: completionKey }, run: p => p.readCompletion(completionKey, signal()) },
    { name: "api_prepare_capability_attention", data: { state: "created", retained: evaluation }, wire: { p_input: evaluation }, run: p => p.prepareAttention(evaluation, signal()) },
    { name: "api_read_prepared_capability_attention", data: evaluation, wire: { p_evaluation_key: completionKey }, run: p => p.readAttention(completionKey, signal()) },
    { name: "api_list_prepared_capability_claims", data: empty, wire: { p_window_key: claim.request.windowKey, p_after_cursor: null, p_limit: 100 }, run: p => p.listClaims({ windowKey: claim.request.windowKey, afterCursor: null, limit: 100 }, signal()) },
    { name: "api_list_prepared_capability_attention", data: empty, wire: { p_scope_key: evaluation.cursor.scopeKey, p_after_cursor: null, p_limit: 100 }, run: p => p.listAttention({ scopeKey: evaluation.cursor.scopeKey, afterCursor: null, limit: 100 }, signal()) },
  ];
  it.each(cases)("maps $name once through actual SDK and unwraps canonical result", async c => {
    const f = fixture(c.data); expect(f.factory).not.toHaveBeenCalled();
    expect(await c.run(f.port)).toEqual(c.data);
    expect(f.factory).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    const [url, init] = f.fetch.mock.calls[0];
    expect(String(url)).toContain(`/rest/v1/rpc/${c.name}`); expect(JSON.parse(init!.body as string)).toEqual(c.wire);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it("does not construct clients when disabled, invalid or already aborted", async () => {
    const disabled = fixture(null, {}); await expect(disabled.port.readClaim(id, signal())).rejects.toThrow(); expect(disabled.factory).not.toHaveBeenCalled();
    const f = fixture(null); await expect(f.port.readClaim("invalid", signal())).rejects.toThrow();
    await expect(f.port.prepareClaim({ ...claim, request: { ...claim.request, leaseSeconds: 0 } }, signal())).rejects.toThrow();
    await expect(f.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: "9223372036854775808", limit: 1 }, signal())).rejects.toThrow();
    const c = new AbortController(); c.abort(); await expect(f.port.readClaim(id, c.signal)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("captures factory/method references and reuses one lazily constructed client", async () => {
    const f = fixture(null); const replacement = vi.fn(); f.config.createClient = replacement;
    expect(await f.port.readClaim(id, signal())).toBeNull(); f.client.rpc = replacement as never;
    expect(await f.port.readClaim(id, signal())).toBeNull(); expect(replacement).not.toHaveBeenCalled(); expect(f.factory).toHaveBeenCalledOnce();
  });
  it.each([null, { state: "created" }, { state: "created", retained: { ...claim, completionKey: id } }, { state: "created", retained: claim, private: "secret" }])("rejects malformed or substituted ack %j", async data => {
    const f = fixture(data); await expect(f.port.prepareClaim(claim, signal())).rejects.toThrow("capability_preparation_unavailable"); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("denied SDK response is bounded and never retried", async () => {
    const f = fixture(null); f.fetch.mockResolvedValue(new Response(JSON.stringify({ message: "private" }), { status: 403 }));
    await expect(f.port.readClaim(id, signal())).rejects.toThrow("capability_preparation_unavailable"); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("preserves exact signed-bigint cursor boundary without Number conversion", async () => {
    const page = { entries: [{ cursor: "9223372036854775807", input: claim }], nextCursor: "9223372036854775807", hasMore: false };
    const f = fixture(page);
    expect(await f.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: "9223372036854775806", limit: 1 }, signal())).toEqual(page);
    const g = fixture({ ...page, nextCursor: "9223372036854775808" });
    await expect(g.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: null, limit: 1 }, signal())).rejects.toThrow();
  });
  it("aborts the actual fetch signal and ignores late acknowledgement without retry", async () => {
    const f = fixture(null); let transportSignal!: AbortSignal; let done!: (r: Response) => void;
    f.fetch.mockImplementation((_url, init) => { transportSignal = init!.signal!; return new Promise(resolve => { done = resolve; }); });
    const controller = new AbortController(); const pending = f.port.readClaim(id, controller.signal); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce()); controller.abort(); await rejected;
    expect(transportSignal.aborted).toBe(true); done(new Response("null", { status: 200 })); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("bounds a non-cooperative SDK and blocks factory-triggered abort before dispatch", async () => {
    vi.useFakeTimers(); const f = fixture(null, { enabled: true, budgetMs: 10 }); f.fetch.mockImplementation(() => new Promise(() => undefined));
    const pending = f.port.readClaim(id, signal()); const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10); await rejected; expect(vi.getTimerCount()).toBe(0);
    const g = fixture(null); const controller = new AbortController(); g.factory.mockImplementation(() => { controller.abort(); return g.client; });
    await expect(g.port.readClaim(id, controller.signal)).rejects.toThrow(); expect(g.fetch).not.toHaveBeenCalled();
  });
});
