// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { type CanaryServiceDependencies } from "./providerCapabilityCanaryService.js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest } from "./providerCapabilityCanaryRuntime.js";
import { createCapabilityPreparedService } from "./providerCapabilityPreparedService.js";
const now = Date.parse("2026-10-02T12:00:00.000Z");
const envelope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1", extensions: ["step"], policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
const scope = { provider: envelope.provider, route: envelope.route, surface: envelope.surface, revision: envelope.revision };
const config = { enabled: false, scope, probeMode: "capability_inspection_no_upload", startAt: new Date(now).toISOString(), intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 2 };
const admission = { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry", admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference, permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step"], session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" };
function setup() {
  const prepared = prepareCapabilityCanaryPlan(config, [envelope]); if (prepared.state !== "prepared_plan") throw Error("fixture");
  const key = prepared.plan.windows[0].idempotencyKey;
  const request = { plan: config, windowIndex: 0, scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: capabilityCanaryPlanDigest(prepared.plan), expiresAt: "2026-10-02T13:00:00.000Z" }, triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: key, expiresAt: "2026-10-02T13:00:00.000Z" } };
  const order: string[] = []; const owner = "11111111-1111-4111-8111-111111111111";
  let existing = false;
  let attentionFailure = false;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const name = String(url).split("/").at(-1)!;
    order.push(name);
    const args = JSON.parse(String(init?.body));
    let data: unknown;
    if (name.startsWith("api_prepare_")) data = { state: existing ? "existing" : "created", retained: args.p_input };
    else if (name === "api_claim_capability_window") data = { status: "claimed", windowKey: key, fence: "22222222-2222-4222-8222-222222222222", generation: 1, owner, observationRevision: 7, deadline: "2026-10-02T12:00:02.001+00:00" };
    else if (name === "api_complete_capability_window") data = { status: "completed", windowKey: key, observationRevision: 7 };
    else if (name === "api_read_capability_attention") data = null;
    else if (name === "api_commit_capability_attention") {
      if (attentionFailure) throw Error("synthetic lost reply");
      data = { status: "committed", version: args.p_input.expectedVersion + 1 };
    } else if (name === "api_list_due_capability_attention") data = [];
    else if (name === "api_list_prepared_capability_claims") data = { entries: [], nextCursor: null, hasMore: false };
    else throw Error(`unexpected synthetic operation ${name}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const createClientFixture = vi.fn(() => createClient("https://synthetic.invalid", "synthetic", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } }));
  const startReadOnlyProbe = vi.fn(() => { order.push("probe"); return { result: Promise.resolve({ state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true }), stop: async () => { order.push("stop"); } }; });
  const retain = vi.fn<NonNullable<CanaryServiceDependencies["retainBeforeDispatch"]>>(async entry => { expect(Object.isFrozen(entry)).toBe(true); order.push(entry.kind); return { state: "created" }; });
  const resolveAdmission = vi.fn(async () => admission);
  const deps: CanaryServiceDependencies = { bindings: [{ envelope, profilePath: "/synthetic/profile", reviewReference: "issue:OVD-415", validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe }], now: () => now, createClient: createClientFixture, retainBeforeDispatch: retain,
    withProfileLock: async (_p, operation) => operation(), fenced: { resourceKey: "a".repeat(64), requestKey: owner, completionKey: "33333333-3333-4333-8333-333333333333", leaseSeconds: 2, resolveAdmission, retainAttempt: () => undefined } };
  const options = { enabled: true, createClient: createClientFixture, now: () => now, canary: deps,
    reviewedWindows: [key], reviewedMetadata: [{ provider: envelope.provider, route: envelope.route, surface: envelope.surface,
      surfaceRevision: envelope.revision, policyRevision: envelope.policyRevision, adapterRevision: "adapter.v1", workerBuild: null }],
    issueEvaluationKey: () => "44444444-4444-4444-8444-444444444444" };
  return { options, request, key, fetch, createClientFixture, resolveAdmission, startReadOnlyProbe, order,
    setExisting: () => { existing = true; }, failAttention: () => { attentionFailure = true; } };
}
describe("actual prepared service composition", () => {
  it("creates one client only after admission and durably prepares before claim, completion and attention CAS", async () => {
    const f = setup(); const service = createCapabilityPreparedService(f.options);
    expect(f.createClientFixture).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await service.runCanary(f.request)).toEqual({ state: "recorded" });
    expect(f.createClientFixture).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["api_prepare_capability_claim", "api_claim_capability_window", "probe", "stop",
      "api_prepare_capability_completion", "api_complete_capability_window", "api_read_capability_attention",
      "api_prepare_capability_attention", "api_commit_capability_attention"]);
    expect(f.resolveAdmission).toHaveBeenCalledTimes(3);
    expect(await service.runCanary(f.request)).toEqual({ state: "window_already_attempted" });
  });
  it.each(["default_off", "empty_bindings", "operator_off", "admission_denied"])("%s keeps client and all helpers unopened", async scenario => {
    const f = setup();
    if (scenario === "default_off") delete (f.options as { enabled?: boolean }).enabled;
    if (scenario === "empty_bindings") f.options.canary.bindings = [];
    if (scenario === "operator_off") f.request.scheduleAuthorization.enabled = false;
    if (scenario === "admission_denied") f.resolveAdmission.mockResolvedValue({ ...admission, provider_admitted: false });
    await createCapabilityPreparedService(f.options).runCanary(f.request);
    expect(f.createClientFixture).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("existing claim preparation permits recovery only, including a new factory instance", async () => {
    const f = setup(); f.setExisting();
    for (let i = 0; i < 2; i++) expect(await createCapabilityPreparedService(f.options).runCanary(f.request)).toEqual({ state: "reservation_rejected" });
    expect(f.order).toEqual(["api_prepare_capability_claim", "api_prepare_capability_claim"]);
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("preserves confirmed ledger when the attention write reply is lost", async () => {
    const f = setup(); f.failAttention();
    expect(await createCapabilityPreparedService(f.options).runCanary(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(f.order.filter(x => x === "api_complete_capability_window")).toHaveLength(1);
    expect(f.order.filter(x => x === "api_commit_capability_attention")).toHaveLength(1);
  });
  it("captures reviewed configuration, factory and bindings before caller mutation", async () => {
    const f = setup(); const service = createCapabilityPreparedService(f.options);
    f.options.createClient = vi.fn(() => { throw Error("changed client"); });
    f.options.canary.bindings[0].envelope.extensions.push("pdf");
    f.options.canary.bindings = [];
    f.options.reviewedMetadata[0].adapterRevision = "changed";
    expect(await service.runCanary(f.request)).toEqual({ state: "recorded" });
    expect(f.createClientFixture).toHaveBeenCalledTimes(1);
    expect(f.options.createClient).not.toHaveBeenCalled();
  });
  it("shares the lazy client with explicit sweep and recovery without starting a canary", async () => {
    const f = setup(); const service = createCapabilityPreparedService(f.options);
    const budget = { signal: new AbortController().signal, deadlineMs: now + 4000 };
    expect((await service.attention.sweep({ ...budget, limit: 1 })).state).toBe("swept");
    expect(await service.recovery.listClaims({ ...budget, windowKey: f.key, afterCursor: null, limit: 1 })).toEqual({ state: "page", page: { entries: [], nextCursor: null, hasMore: false } });
    expect(f.createClientFixture).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["api_list_due_capability_attention", "api_list_prepared_capability_claims"]);
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("empty attention and recovery registries cause zero SDK operations", async () => {
    const f = setup(); f.options.reviewedMetadata = []; f.options.reviewedWindows = [];
    const service = createCapabilityPreparedService(f.options);
    const budget = { signal: new AbortController().signal, deadlineMs: now + 4000 };
    expect(await service.attention.sweep({ ...budget, limit: 1 })).toEqual({ state: "disabled" });
    expect(await service.recovery.listClaims({ ...budget, windowKey: f.key, afterCursor: null, limit: 1 })).toEqual({ state: "invalid_request" });
    expect(f.createClientFixture).not.toHaveBeenCalled();
  });
});
