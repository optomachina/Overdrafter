// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
import { createCapabilityPreparationTransport } from "./providerCapabilityPreparationTransport.js";
import { createCapabilityPreparedService } from "./providerCapabilityPreparedService.js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest } from "./providerCapabilityCanaryRuntime.js";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const owner = "11111111-1111-4111-8111-111111111111", completionKey = "22222222-2222-4222-8222-222222222222";
const fence = "33333333-3333-4333-8333-333333333333", evaluationKey = "44444444-4444-4444-8444-444444444444";
const scope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1" };
const envelope = { ...scope, extensions: ["step"], policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
const config = { enabled: false, scope, probeMode: "capability_inspection_no_upload", startAt: new Date(now).toISOString(), intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 2 };
const prepared = prepareCapabilityCanaryPlan(config, [envelope]); if (prepared.state !== "prepared_plan") throw Error("fixture");
const plan = prepared.plan;
const claim = { request: { windowKey: plan.windows[0].idempotencyKey, resourceKey: "b".repeat(64), configDigest: capabilityCanaryPlanDigest(plan),
  requestKey: owner, provider: scope.provider, route: scope.route, surface: scope.surface, surfaceRevision: scope.revision, windowStart: plan.windows[0].startAt, windowEnd: plan.windows[0].endAt, leaseSeconds: 30 }, completionKey };
const completion = { windowKey: claim.request.windowKey, requestKey: owner, completionKey, fence, resourceReleased: true as const,
  candidate: { ...scope, state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true,
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString(), actorKind: "scheduled_canary" as const,
    sourceKind: "scheduled_canary" as const, sourceVersion: "capability-canary-offline.v1", evidenceReference: "issue:OVD-415", idempotencyKey: claim.request.windowKey } };
const metadata = { provider: scope.provider, route: scope.route, surface: scope.surface, surfaceRevision: scope.revision,
  policyRevision: envelope.policyRevision, adapterRevision: null, workerBuild: null };
const projection = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: new Date(now).toISOString() });
if (projection.state !== "projected") throw Error("fixture");
const attention = { expectedVersion: 0, evaluationKey, cursor: projection.cursor, item: projection.item, intent: projection.intent, evidence: null };
const receipt = { status: "claimed", windowKey: claim.request.windowKey, owner, fence, generation: 1, observationRevision: 17,
  deadline: "2026-10-02T12:00:30.001000+00:00" };
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const operations: string[] = [];
  const response = vi.fn((operation: string, args: Record<string, unknown>): unknown => {
    if (operation.startsWith("api_prepare_")) return { state: "created", retained: args.p_input };
    if (operation === "api_read_prepared_capability_claim") return claim;
    if (operation === "api_read_prepared_capability_completion") return completion;
    if (operation === "api_read_prepared_capability_attention") return attention;
    if (operation === "api_list_prepared_capability_claims") return { entries: [{ cursor: "9223372036854775807", input: claim }], nextCursor: "9223372036854775807", hasMore: false };
    if (operation === "api_list_prepared_capability_attention") return { entries: [{ cursor: "9223372036854775807", input: attention }], nextCursor: "9223372036854775807", hasMore: false };
    if (operation === "api_claim_capability_window") return receipt;
    if (operation === "api_get_capability_window") return { ...receipt, status: "completed" };
    if (operation === "api_complete_capability_window") return { status: "completed", windowKey: claim.request.windowKey, observationRevision: 17 };
    if (operation === "api_read_capability_attention") return null;
    if (operation === "api_commit_capability_attention") return { status: "committed", version: 1 };
    throw Error("unhandled synthetic RPC");
  });
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const operation = String(url).split("/").at(-1)!; operations.push(operation);
    return new Response(JSON.stringify(response(operation, JSON.parse(init!.body as string))), { headers: { "Content-Type": "application/json" } });
  });
  const factory = vi.fn(() => createClient("https://synthetic.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  }));
  return { operations, response, fetch, factory, port: createCapabilityPreparationTransport({ enabled: true, createClient: factory }) };
}

describe("canonical eight-helper preparation transport", () => {
  it("uses all eight actual helper/SDK methods and preserves max bigint cursors as strings", async () => {
    const f = fixture(); const s = signal();
    expect(await f.port.prepareClaim(claim, s)).toEqual({ state: "created", retained: claim });
    expect(await f.port.readClaim(owner, s)).toEqual(claim);
    expect(await f.port.prepareCompletion(completion, s)).toEqual({ state: "created", retained: completion });
    expect(await f.port.readCompletion(completionKey, s)).toEqual(completion);
    expect(await f.port.prepareAttention(attention, s)).toEqual({ state: "created", retained: attention });
    expect(await f.port.readAttention(evaluationKey, s)).toEqual(attention);
    expect((await f.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: "9007199254740993", limit: 1 }, s)).nextCursor).toBe("9223372036854775807");
    expect((await f.port.listAttention({ scopeKey: attention.cursor.scopeKey, afterCursor: "9007199254740993", limit: 1 }, s)).nextCursor).toBe("9223372036854775807");
    expect(f.operations).toHaveLength(8); expect(new Set(f.operations).size).toBe(8); expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it.each(["9223372036854775808", "01", "0"])("rejects canonical helper cursor %s before creating a client", async cursor => {
    const f = fixture();
    await expect(f.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: cursor, limit: 1 }, signal())).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["short_nonterminal", "above_max", "rounded_order"])("rejects invalid actual helper page %s", async kind => {
    const f = fixture(); const cursor = kind === "above_max" ? "9223372036854775808" : "9007199254740993";
    f.response.mockReturnValue({ entries: [{ cursor, input: claim }], nextCursor: cursor, hasMore: kind === "short_nonterminal" });
    await expect(f.port.listClaims({ windowKey: claim.request.windowKey, afterCursor: kind === "rounded_order" ? "9007199254740993" : null, limit: 2 }, signal())).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});


function serviceFixture() {
  const f = fixture();
  const stop = vi.fn(async () => undefined);
  const probe = vi.fn(() => ({ result: Promise.resolve({ state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true }), stop }));
  const admission = { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry",
    admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference,
    permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step"],
    session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" };
  const resolveAdmission = vi.fn(async () => admission); const issueEvaluationKey = vi.fn(() => evaluationKey);
  const options = { enabled: true, createClient: f.factory, now: Date.now, reviewedMetadata: [metadata], reviewedWindows: [claim.request.windowKey], issueEvaluationKey,
    canary: { bindings: [{ envelope, profilePath: "/synthetic/profile", reviewReference: "issue:OVD-415", validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe: probe }],
      fenced: { resourceKey: claim.request.resourceKey, requestKey: owner, completionKey, leaseSeconds: 30, retainAttempt: () => undefined, resolveAdmission },
      withProfileLock: async (_path: string, action: () => Promise<import("./providerCapabilityCanaryRuntime.js").CanaryRuntimeResult>) => action() } };
  const request = { plan: config, windowIndex: 0,
    scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: capabilityCanaryPlanDigest(plan), expiresAt: "2026-10-02T13:00:00.000Z" },
    triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: claim.request.windowKey, expiresAt: "2026-10-02T13:00:00.000Z" } };
  return { ...f, options, request, probe, stop, resolveAdmission, issueEvaluationKey };
}
function clock() { vi.useFakeTimers(); vi.setSystemTime(now); }

describe("actual prepared service factory", () => {
  it.each(["disabled", "empty", "operator", "admission"])("%s gate prevents even preparation-client construction", async guard => {
    clock(); const f = serviceFixture();
    if (guard === "disabled") f.options.enabled = false;
    if (guard === "empty") f.options.canary.bindings = [];
    if (guard === "operator") f.request.triggerAuthorization.enabled = false;
    if (guard === "admission") f.resolveAdmission.mockResolvedValue({ ...(await f.resolveAdmission()), provider_admitted: false });
    await createCapabilityPreparedService(f.options).runCanary(f.request);
    expect(f.factory).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("orders actual preparation before claim/completion/attention writes on one shared SDK client", async () => {
    clock(); const f = serviceFixture(); const service = createCapabilityPreparedService(f.options);
    expect(f.factory).not.toHaveBeenCalled();
    expect(await service.runCanary(f.request)).toEqual({ state: "recorded" });
    expect(f.operations).toEqual(["api_prepare_capability_claim", "api_claim_capability_window", "api_prepare_capability_completion",
      "api_complete_capability_window", "api_read_capability_attention", "api_prepare_capability_attention", "api_commit_capability_attention"]);
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it.each(["existing", "mismatch"])("%s retained claim reply never grants authority across fresh factory instances", async mode => {
    clock(); const f = serviceFixture();
    f.response.mockImplementation((_operation, args) => ({ state: mode === "existing" ? "existing" : "created",
      retained: mode === "existing" ? args.p_input : { ...(args.p_input as object), completionKey: owner } }));
    for (let index = 0; index < 2; index++) expect((await createCapabilityPreparedService(f.options).runCanary(f.request)).state).not.toBe("recorded");
    expect(f.operations).toEqual(["api_prepare_capability_claim", "api_prepare_capability_claim"]); expect(f.probe).not.toHaveBeenCalled();
  });
  it("cancelled SDK preparation cannot proceed to claim when its fetch resolves late", async () => {
    clock(); const f = serviceFixture(); let finish!: (value: Response) => void;
    f.fetch.mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const service = createCapabilityPreparedService({ ...f.options, canary: { ...f.options.canary, revocationSignal: controller.signal } });
    const running = service.runCanary(f.request); await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect((await running).state).not.toBe("recorded");
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
    finish(new Response(JSON.stringify({ state: "created", retained: claim }), { headers: { "Content-Type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(0); expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.probe).not.toHaveBeenCalled();
  });
  it("historical completion recovery uses exact helper reads and replay without a new probe", async () => {
    clock(); vi.setSystemTime(now + 86400_000); const f = serviceFixture();
    const service = createCapabilityPreparedService(f.options);
    expect(await service.recovery.replayCompletion({ windowKey: claim.request.windowKey, requestKey: owner, completionKey,
      signal: signal(), deadlineMs: now + 86401_000 })).toEqual({ state: "recorded_attention_pending" });
    expect(f.operations).toEqual(["api_read_prepared_capability_claim", "api_read_prepared_capability_completion", "api_get_capability_window", "api_complete_capability_window"]);
    expect(f.probe).not.toHaveBeenCalled(); expect(f.issueEvaluationKey).not.toHaveBeenCalled();
  });
  it("explicit attention replay keeps the prepared evaluation UUID and projection unchanged", async () => {
    clock(); const f = serviceFixture();
    const original = f.response.getMockImplementation()!;
    f.response.mockImplementation((operation, args) => operation === "api_prepare_capability_attention"
      ? { state: "existing", retained: args.p_input } : original(operation, args));
    const service = createCapabilityPreparedService(f.options);
    expect(await service.recovery.replayAttention({ scopeKey: attention.cursor.scopeKey, evaluationKey, signal: signal(), deadlineMs: now + 1000 })).toEqual({ state: "committed" });
    expect(f.operations).toEqual(["api_read_prepared_capability_attention", "api_prepare_capability_attention", "api_commit_capability_attention"]);
    expect(f.response.mock.calls[1][1]).toEqual({ p_input: attention }); expect(f.response.mock.calls[2][1]).toEqual({ p_input: attention });
    expect(f.issueEvaluationKey).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
});


it("confirmed ledger remains pending when actual attention prepare helper rejects a changed retained payload", async () => {
  clock(); const f = serviceFixture(); const original = f.response.getMockImplementation()!;
  f.response.mockImplementation((operation, args) => operation === "api_prepare_capability_attention"
    ? { state: "existing", retained: { ...(args.p_input as object), expectedVersion: 1 } } : original(operation, args));
  expect(await createCapabilityPreparedService(f.options).runCanary(f.request)).toEqual({ state: "recorded_attention_pending" });
  expect(f.operations.filter(operation => operation === "api_complete_capability_window")).toHaveLength(1);
  expect(f.operations).not.toContain("api_commit_capability_attention"); expect(f.probe).toHaveBeenCalledTimes(1);
});
