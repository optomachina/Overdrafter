// @vitest-environment node
import { createCanaryFencedAttempt } from "./providerCapabilityCanaryFenced.js";
import { createCapabilityAttentionService } from "./providerCapabilityAttentionService.js";
import { projectCapabilityAttention, type CapabilityAttentionEvidence } from "./providerCapabilityAttention.js";
import { createCapabilityCanaryService, type CanaryServiceDependencies } from "./providerCapabilityCanaryService.js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest } from "./providerCapabilityCanaryRuntime.js";
import { createCapabilityPersistenceTransport } from "./providerCapabilityPersistenceTransport.js";
import { claimCapabilityWindow } from "./providerCapabilityRuntimePersistence.js";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real installed SDK, exclusively synthetic fetch. This is not durable-backend evidence.
const now = Date.parse("2026-10-02T12:00:00.000Z");
const owner = "11111111-1111-4111-8111-111111111111";
const fence = "22222222-2222-4222-8222-222222222222";
const completionKey = "33333333-3333-4333-8333-333333333333";
const claimRequest = {
  windowKey: "canary:" + "a".repeat(64), resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey: owner,
  provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1",
  windowStart: new Date(now).toISOString(), windowEnd: new Date(now + 3600_000).toISOString(), leaseSeconds: 30,
};
const claimed = { status: "claimed", windowKey: claimRequest.windowKey, owner, fence, generation: 1,
  observationRevision: 17, deadline: "2026-10-02T12:00:30.001000+00:00" };
function sdk(response: unknown = claimed, status = 200) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(response), {
    status, headers: { "Content-Type": "application/json" },
  }));
  const client = createClient("https://synthetic.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  return { client, fetch };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });


describe("actual SDK canonical helper control cases", () => {
  it("exposes the successful PersistenceResult wrapper through synthetic fetch", async () => {
    const f = sdk();
    expect(await claimCapabilityWindow(f.client, claimRequest)).toEqual({ ok: true, value: claimed });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(String(f.fetch.mock.calls[0][0])).toContain("/rest/v1/rpc/api_claim_capability_window");
    expect(JSON.parse(f.fetch.mock.calls[0][1]!.body as string)).toEqual({ p_input: claimRequest });
  });
  it("maps actual SDK denied responses to bounded failure without leaking database text", async () => {
    const f = sdk({ code: "42501", message: "private database URL" }, 403);
    expect(await claimCapabilityWindow(f.client, claimRequest)).toEqual({ ok: false, reasonCode: "rpc_denied" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});


describe("actual SDK persistence facade", () => {
  it("unwraps the canonical helper exactly once before the fenced receipt validator", async () => {
    const f = sdk(); const transport = createCapabilityPersistenceTransport(f.client);
    expect(await transport.claim(claimRequest, new AbortController().signal)).toEqual(claimed);
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([403, 200])("fails closed for helper failure with HTTP %s", async status => {
    const f = sdk(status === 403 ? { code: "42501", message: "private SDK details" } : { status: "claimed", private: "secret" }, status);
    const transport = createCapabilityPersistenceTransport(f.client);
    await expect(transport.claim(claimRequest, new AbortController().signal)).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("pre-aborted transport never creates a lazy SDK fetch", async () => {
    const f = sdk(); const transport = createCapabilityPersistenceTransport(f.client);
    await expect(transport.claim(claimRequest, AbortSignal.abort())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("propagates cancellation into the actual lazy PostgREST builder", async () => {
    const f = sdk(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.fetch.mockImplementation(async (_url, init) => {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("synthetic abort", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    const running = createCapabilityPersistenceTransport(f.client).claim(claimRequest, controller.signal);
    const rejected = expect(running).rejects.toThrow();
    await started; controller.abort(); await rejected;
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});


function serviceFixture() {
  const f = sdk();
  const envelope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1",
    extensions: ["step"], policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
  const config = { enabled: false, scope: { provider: envelope.provider, route: envelope.route, surface: envelope.surface, revision: envelope.revision },
    probeMode: "capability_inspection_no_upload", startAt: new Date(now).toISOString(), intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 2 };
  const prepared = prepareCapabilityCanaryPlan(config, [envelope]); if (prepared.state !== "prepared_plan") throw Error("fixture");
  const plan = prepared.plan;
  const request = { plan: config, windowIndex: 0,
    scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: capabilityCanaryPlanDigest(plan), expiresAt: "2026-10-02T13:00:00.000Z" },
    triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: plan.windows[0].idempotencyKey, expiresAt: "2026-10-02T13:00:00.000Z" } };
  const stop = vi.fn(async () => undefined);
  const probe = vi.fn(() => ({ result: Promise.resolve({ state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true }), stop }));
  const retain = vi.fn(async () => ({ state: "created" as const }));
  const createClient = vi.fn(() => f.client);
  const onConfirmedObservation = vi.fn(async () => ({ state: "committed" }));
  const operations: string[] = [];
  f.fetch.mockImplementation(async (url, init) => {
    const operation = String(url).split("/").at(-1)!; operations.push(operation);
    const data = operation === "api_claim_capability_window"
      ? { ...claimed, windowKey: plan.windows[0].idempotencyKey }
      : { status: "completed", windowKey: JSON.parse(init!.body as string).p_input.windowKey, observationRevision: 17 };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  });
  const deps: CanaryServiceDependencies = { bindings: [{ envelope, profilePath: "/synthetic/profile", reviewReference: "issue:OVD-415",
    validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe: probe }], now: Date.now, createClient,
    fenced: { resourceKey: "b".repeat(64), requestKey: owner, completionKey, leaseSeconds: 30, retainAttempt: () => undefined,
      resolveAdmission: async () => ({ policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry",
        admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference,
        permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step"],
        session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" }) },
    retainBeforeDispatch: retain, onConfirmedObservation, withProfileLock: async (_profile, action) => action() };
  return { ...f, deps, request, plan, operations, probe, stop, retain, createClient, onConfirmedObservation };
}

describe("service retention and known ledger boundaries", () => {
  it.each(["off", "empty", "no_retention"])("%s creates no SDK client or remote operation", async guard => {
    const f = serviceFixture();
    if (guard === "empty") f.deps.bindings = [];
    if (guard === "no_retention") f.deps.retainBeforeDispatch = null;
    await createCapabilityCanaryService(f.deps)(guard === "off" ? undefined : f.request);
    expect(f.createClient).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("awaits claim capture before client construction and remote claim", async () => {
    const f = serviceFixture(); let acknowledge!: () => void;
    f.retain.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({ state: "created" }); }));
    const running = createCapabilityCanaryService(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.createClient).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
    acknowledge(); expect(await running).toEqual({ state: "recorded" });
    expect(f.operations).toEqual(["api_claim_capability_window", "api_complete_capability_window"]);
    expect(f.probe).toHaveBeenCalledTimes(1); expect(f.onConfirmedObservation).toHaveBeenCalledTimes(1);
  });
  it("a fresh service with existing durable intent cannot repeat a claim or probe", async () => {
    const f = serviceFixture(); f.retain.mockResolvedValue({ state: "existing" } as never);
    const first = await createCapabilityCanaryService(f.deps)(f.request);
    const second = await createCapabilityCanaryService(f.deps)(f.request);
    expect(first.state).not.toBe("recorded"); expect(second.state).not.toBe("recorded");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("holds completion dispatch behind retention after confirmed stop", async () => {
    const f = serviceFixture(); let acknowledge!: () => void;
    f.deps.retainBeforeDispatch = async entry => {
      if (entry.kind === "completion") return new Promise(resolve => { acknowledge = () => resolve({ state: "created" }); });
      return { state: "created" };
    };
    const running = createCapabilityCanaryService(f.deps)(f.request); await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.operations).toEqual(["api_claim_capability_window"]);
    expect(f.onConfirmedObservation).not.toHaveBeenCalled(); acknowledge();
    expect(await running).toEqual({ state: "recorded" }); expect(f.operations).toHaveLength(2);
  });
  it.each(["throw", "hang"])("confirmed ledger survives attention %s as pending", async failure => {
    const f = serviceFixture();
    f.onConfirmedObservation.mockImplementation(async () => { if (failure === "throw") throw Error("private"); return new Promise(() => undefined); });
    const running = createCapabilityCanaryService(f.deps)(f.request); await vi.advanceTimersByTimeAsync(2500);
    expect(await running).toEqual({ state: "recorded_attention_pending" });
    expect(f.operations).toEqual(["api_claim_capability_window", "api_complete_capability_window"]); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it("late durable acknowledgement after budget expiry never dispatches", async () => {
    const f = serviceFixture(); let acknowledge!: () => void;
    f.retain.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({ state: "created" }); }));
    const running = createCapabilityCanaryService(f.deps)(f.request); await vi.advanceTimersByTimeAsync(2500);
    expect((await running).state).not.toBe("recorded"); acknowledge(); await vi.advanceTimersByTimeAsync(0);
    expect(f.createClient).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
});


function attentionFixture(seed = true) {
  const f = sdk(); const source = serviceFixture();
  const release = source.plan.releaseEnvelope;
  const metadata = { provider: release.provider, route: release.route, surface: release.surface,
    surfaceRevision: release.revision, policyRevision: release.policyRevision, adapterRevision: null, workerBuild: null };
  const evidence: CapabilityAttentionEvidence = { decision: { contractVersion: "provider-upload-capability.v1", classification: "matches_policy",
    allowedExtensions: ["step"], reportedAddedExtensions: [], reportedRemovedExtensions: [], evidenceRefs: [], normalizedObservedMimeTypes: [] },
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString(), observationRevision: 17 };
  const projected = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence, previous: null, now: new Date(now).toISOString() });
  if (projected.state !== "projected") throw Error("fixture");
  let stored: { version: number; cursor: typeof projected.cursor; item: typeof projected.item; evidence: CapabilityAttentionEvidence | null } | null =
    seed ? { version: 1, cursor: projected.cursor, item: projected.item, evidence } : null;
  const intents = new Set<string>(); const operations: string[] = [];
  // Atomic response model and retention callback are synthetic, not a installed durable store.
  const retained = new Map<string, string>(); let serial = 0;
  const onPrepared = vi.fn(async (handle: { p_input: { evaluationKey: string } }) => {
    const key = handle.p_input.evaluationKey; const bytes = JSON.stringify(handle);
    if (retained.has(key) && retained.get(key) !== bytes) throw Error("synthetic immutable UUID conflict");
    retained.set(key, bytes);
  });
  f.fetch.mockImplementation(async (url, init) => {
    const operation = String(url).split("/").at(-1)!; operations.push(operation);
    let data: unknown;
    if (operation === "api_list_due_capability_attention") data = stored ? [stored] : [];
    else if (operation === "api_read_capability_attention") data = stored;
    else if (operation === "api_commit_capability_attention") {
      const input = JSON.parse(init!.body as string).p_input;
      if (input.expectedVersion !== (stored?.version ?? 0)) data = { status: "conflict" };
      else {
        stored = { version: input.expectedVersion + 1, cursor: input.cursor, item: input.item, evidence: input.evidence };
        if (input.intent) intents.add(input.intent.key);
        data = { status: "committed", version: stored.version };
      }
    } else throw Error("forbidden synthetic operation");
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  });
  const options = { enabled: true, transport: createCapabilityPersistenceTransport(f.client), reviewedMetadata: [metadata],
    onPrepared, issueEvaluationKey: () => `44444444-4444-4444-8444-${String(++serial).padStart(12, "0")}`, now: Date.now };
  return { ...f, options, source, operations, intents, retained, onPrepared, getStored: () => stored };
}

describe("actual SDK attention composition", () => {
  it("connects direct confirmed ledger evidence to actual attention read/capture/commit", async () => {
    const f = serviceFixture(); const attention = attentionFixture(false);
    f.deps.onConfirmedObservation = createCapabilityAttentionService(attention.options).onConfirmedObservation;
    expect(await createCapabilityCanaryService(f.deps)(f.request)).toEqual({ state: "recorded" });
    expect(attention.operations).toEqual(["api_read_capability_attention", "api_commit_capability_attention"]);
    expect(attention.onPrepared).toHaveBeenCalledTimes(1); expect(attention.getStored()?.evidence?.observationRevision).toBe(17);
    expect(f.operations).toEqual(["api_claim_capability_window", "api_complete_capability_window"]);
  });
  it("stale sweeps cross actual helpers and preserve one transition across fresh service instances", async () => {
    const f = attentionFixture(); vi.setSystemTime(now + 1000);
    const budget = { limit: 5, signal: new AbortController().signal, deadlineMs: now + 2000 };
    expect(await createCapabilityAttentionService(f.options).sweep(budget)).toMatchObject({ state: "swept", visited: 1, committed: 1 });
    expect(f.getStored()?.item.freshness).toBe("stale"); expect(f.intents.size).toBe(1);
    expect(await createCapabilityAttentionService(f.options).sweep(budget)).toMatchObject({ state: "swept", visited: 1, committed: 1 });
    expect(f.intents.size).toBe(1); expect(f.getStored()?.evidence?.observationRevision).toBe(17);
    expect(f.operations.every(name => ["api_list_due_capability_attention", "api_read_capability_attention", "api_commit_capability_attention"].includes(name))).toBe(true);
  });
  it.each(["disabled", "no_retention", "empty"])("attention %s makes no actual SDK calls", async guard => {
    const f = attentionFixture(); const options = { ...f.options, enabled: guard !== "disabled",
      reviewedMetadata: guard === "empty" ? [] : f.options.reviewedMetadata, onPrepared: guard === "no_retention" ? null : f.onPrepared };
    const result = await createCapabilityAttentionService(options).sweep({ limit: 5, signal: new AbortController().signal, deadlineMs: now + 1000 });
    expect(result.state).toBe(guard === "no_retention" ? "dependency_unavailable" : "disabled");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.onPrepared).not.toHaveBeenCalled();
  });
  it("does not dispatch CAS after pending retention outlives its budget", async () => {
    const f = attentionFixture(); vi.setSystemTime(now + 1000);
    let acknowledge!: () => void;
    const service = createCapabilityAttentionService({ ...f.options, onPrepared: async () => new Promise<void>(resolve => { acknowledge = resolve; }) });
    const running = service.sweep({ limit: 5, signal: new AbortController().signal, deadlineMs: now + 1200 });
    await vi.advanceTimersByTimeAsync(300); expect((await running).state).toBe("cancelled");
    acknowledge(); await vi.advanceTimersByTimeAsync(0);
    expect(f.operations).toEqual(["api_list_due_capability_attention", "api_read_capability_attention"]); expect(f.intents.size).toBe(0);
  });
});

it("uncertain SDK completion never invokes confirmed-evidence attention", async () => {
  const f = serviceFixture(); const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => String(url).endsWith("api_complete_capability_window")
    ? new Response(JSON.stringify({ code: "42501", message: "synthetic lost response" }), { status: 403, headers: { "Content-Type": "application/json" } })
    : original(url, init));
  expect(await createCapabilityCanaryService(f.deps)(f.request)).toEqual({ state: "record_uncertain" });
  expect(f.onConfirmedObservation).not.toHaveBeenCalled(); expect(f.probe).toHaveBeenCalledTimes(1);
});

it("fresh attention service replays the same retained evaluation after synthetic reply loss", async () => {
  const f = attentionFixture(); vi.setSystemTime(now + 1000);
  const original = f.fetch.getMockImplementation()!; let commits = 0; const payloads: unknown[] = [];
  f.fetch.mockImplementation(async (url, init) => {
    if (!String(url).endsWith("api_commit_capability_attention")) return original(url, init);
    payloads.push(JSON.parse(init!.body as string));
    if (++commits === 1) {
      await original(url, init); // Synthetic atomic commit succeeds, response is lost.
      return new Response(JSON.stringify({ code: "42501", message: "synthetic reply loss" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    // Synthetic exact evaluation replay models the agreed receipt, not another commit.
    return new Response(JSON.stringify({ status: "committed", version: 2 }), { headers: { "Content-Type": "application/json" } });
  });
  const budget = { signal: new AbortController().signal, deadlineMs: now + 2000 };
  expect(await createCapabilityAttentionService(f.options).sweep({ ...budget, limit: 5 })).toMatchObject({ state: "swept", pending: 1 });
  expect(commits).toBe(1); expect(f.retained.size).toBe(1);
  const handle = JSON.parse([...f.retained.values()][0]);
  expect(await createCapabilityAttentionService(f.options).replayPrepared(handle, budget)).toEqual({ state: "committed" });
  expect(payloads[1]).toEqual(payloads[0]); expect(f.intents.size).toBe(1); expect(f.retained.size).toBe(1);
});

it("unreviewed confirmation cannot turn unknown policy into attention evidence", async () => {
  const f = attentionFixture();
  const input = { plan: { ...f.source.plan, releaseEnvelope: { ...f.source.plan.releaseEnvelope, policyRevision: "unreviewed.v1" } },
    evidence: f.getStored()!.evidence!, signal: new AbortController().signal, deadlineMs: now + 1000 };
  expect(await createCapabilityAttentionService(f.options).onConfirmedObservation(input)).toEqual({ state: "invalid_context" });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.retained.size).toBe(0);
});


it("baseline raw canonical helper wrapper cannot authorize a fenced probe", async () => {
  const f = sdk();
  const attempt = createCanaryFencedAttempt({ request: claimRequest, completionKey, transport: {
    claim: args => claimCapabilityWindow(f.client, args.p_input),
    get: async () => ({ status: "unknown" }), complete: async () => { throw Error("must not complete"); },
  } });
  expect(await attempt.claim(now, new AbortController().signal)).toEqual({ state: "uncertain" });
  expect(attempt.recovery().claim).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(1);
});
