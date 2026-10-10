// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityCanaryService, type CanaryServiceDependencies } from "./providerCapabilityCanaryService.js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest } from "./providerCapabilityCanaryRuntime.js";
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
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const claim = String(url).endsWith("api_claim_capability_window"); order.push(claim ? "claim" : "complete");
    const data = claim ? { status: "claimed", windowKey: key, fence: "22222222-2222-4222-8222-222222222222", generation: 1, owner, observationRevision: 7, deadline: "2026-10-02T12:00:02.001+00:00" } : { status: "completed", windowKey: key, observationRevision: 7 };
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const createClientFixture = vi.fn(() => createClient("https://synthetic.invalid", "synthetic", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } }));
  const startReadOnlyProbe = vi.fn(() => { order.push("probe"); return { result: Promise.resolve({ state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true }), stop: async () => { order.push("stop"); } }; });
  const retain = vi.fn<NonNullable<CanaryServiceDependencies["retainBeforeDispatch"]>>(async entry => { expect(Object.isFrozen(entry)).toBe(true); order.push(entry.kind); return { state: "created" }; });
  const resolveAdmission = vi.fn(async () => admission);
  const deps: CanaryServiceDependencies = { bindings: [{ envelope, profilePath: "/synthetic/profile", reviewReference: "issue:OVD-415", validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe }], now: () => now, createClient: createClientFixture, retainBeforeDispatch: retain,
    withProfileLock: async (_p, operation) => operation(), fenced: { resourceKey: "a".repeat(64), requestKey: owner, completionKey: "33333333-3333-4333-8333-333333333333", leaseSeconds: 2, resolveAdmission, retainAttempt: () => undefined } };
  return { deps, request, fetch, createClientFixture, retain, resolveAdmission, startReadOnlyProbe, order };
}
describe("SDK fenced service composition", () => {
  it("uses canonical helpers with immutable retention before each dispatch and confirmed stop before completion", async () => {
    const f = setup(); const run = createCapabilityCanaryService(f.deps);
    expect(await run(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(f.order).toEqual(["claim_request", "claim", "probe", "stop", "completion", "complete"]);
    expect(f.resolveAdmission).toHaveBeenCalledTimes(3); expect(f.createClientFixture).toHaveBeenCalledOnce();
    expect(await run(f.request)).toEqual({ state: "window_already_attempted" }); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("requires qualified retention, operator gates and reviewed bindings before any client", async () => {
    for (const scenario of ["missing_retention", "off", "empty"] as const) {
      const f = setup(); if (scenario === "missing_retention") f.deps.retainBeforeDispatch = null;
      if (scenario === "empty") f.deps.bindings = [];
      if (scenario === "off") f.request.scheduleAuthorization.enabled = false;
      const result = await createCapabilityCanaryService(f.deps)(f.request);
      expect(result.state).toBe(scenario === "missing_retention" ? "durable_reservation_unavailable" : scenario === "empty" ? "reviewed_probe_unavailable" : "disabled");
      expect(f.createClientFixture).not.toHaveBeenCalled(); expect(f.retain).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
    }
  });
  it("preflights provider admission before client, retention and reservation", async () => {
    const f = setup(); f.resolveAdmission.mockResolvedValue({ ...admission, provider_admitted: false });
    expect(await createCapabilityCanaryService(f.deps)(f.request)).toEqual({ state: "admission_rejected" });
    expect(f.createClientFixture).not.toHaveBeenCalled(); expect(f.retain).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("existing prepared attempt is recovery-only even in a new service instance", async () => {
    const f = setup(); f.retain.mockResolvedValue({ state: "existing" });
    expect(await createCapabilityCanaryService(f.deps)(f.request)).toEqual({ state: "reservation_rejected" });
    expect(await createCapabilityCanaryService(f.deps)(f.request)).toEqual({ state: "reservation_rejected" });
    expect(f.createClientFixture).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
});
