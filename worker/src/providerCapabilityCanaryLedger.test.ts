// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { recordCapabilityCanaryObservation, recordCapabilityCanaryWithAttention, type CanaryLedgerInput } from "./providerCapabilityCanaryLedger.js";

const instant = Date.parse("2026-10-02T12:01:00.000Z");
const scope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1" };
const envelope = { ...scope, extensions: ["step", "stp"], policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
const config = { enabled: false as const, scope, probeMode: "capability_inspection_no_upload" as const,
  startAt: "2026-10-02T12:00:00.000Z", intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 60 };
const plan = prepareCapabilityCanaryPlan(config, [envelope]);
if (plan.state !== "prepared_plan") throw Error("synthetic plan invalid");
const input: CanaryLedgerInput = {
  config, reviewed: [envelope], nowMs: instant,
  claim: { windowKey: plan.plan.windows[0].idempotencyKey, observationRevision: 7 },
  observation: { ...scope, state: "fresh", extensions: [".STEP", "stp"], mimeTypes: ["MODEL/STEP"],
    acceptAttributePresent: true, observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T13:00:00.000Z", observationRevision: 7, windowIndex: 0 },
  admission: { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry",
    admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference,
    permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step", "stp"],
    session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" },
};
afterEach(() => vi.useRealTimers());
function clock() { vi.useFakeTimers(); vi.setSystemTime(instant); }
function client(response: unknown = { data: 7, error: null }) {
  const abortSignal = vi.fn().mockResolvedValue(response);
  const rpc = vi.fn(() => ({ abortSignal }));
  return { service: { rpc } as unknown as SupabaseClient, rpc, abortSignal };
}

describe("canary service-ledger bridge", () => {
  it("writes one sanitized existing RPC with claim-bound key/revision and shared classification", async () => {
    clock();
    const c = client();
    const result = await recordCapabilityCanaryObservation(c.service, input);
    expect(result).toMatchObject({ state: "recorded", observationRevision: 7, evidence: {
      observedAt: "2026-10-02T12:00:00.000Z", decision: { classification: "matches_policy", allowedExtensions: ["step", "stp"] },
    } });
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith("api_record_capability_observation", expect.objectContaining({
      p_observation_revision: 7, p_idempotency_key: input.claim.windowKey,
      p_actor_kind: "scheduled_canary", p_source_kind: "scheduled_canary",
      p_evidence_reference: "issue:OVD-415", p_observed_extensions: ["step", "stp"], p_observed_mime_types: ["model/step"],
    }));
    expect(c.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toMatch(/canary:|session_owner|idempotency|controlled_beta_only/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { config: { enabled: false } }, { config: { ...config, enabled: true } },
    { claim: { ...input.claim, windowKey: "canary:other" } }, { claim: { ...input.claim, observationRevision: 8 } },
    { claim: { ...input.claim, secret: "private" } }, { claim: null },
    { observation: { ...(input.observation as object), rawHtml: "secret" } },
    { observation: { ...(input.observation as object), observedAt: "2026-02-30T12:00:00.000Z" } },
  ])("rejects invalid/disabled/unbound input before RPC %j", async (patch) => {
    clock();
    const c = client();
    const result = await recordCapabilityCanaryObservation(c.service, { ...input, ...patch } as CanaryLedgerInput);
    expect(result.state).toBe("rejected");
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("preserves generic accept_missing and reviewed Xometry exception without inventing permission", async () => {
    clock();
    const c = client();
    const missing = { ...(input.observation as object), acceptAttributePresent: false };
    expect(await recordCapabilityCanaryObservation(c.service, { ...input, observation: missing }))
      .toMatchObject({ state: "recorded", evidence: { decision: { classification: "reviewed_missing_accept_xometry" } } });
    const otherScope = { ...scope, revision: "other-reviewed.v1" };
    const otherConfig = { ...config, scope: otherScope };
    const otherEnvelope = { ...envelope, ...otherScope };
    const otherPlan = prepareCapabilityCanaryPlan(otherConfig, [otherEnvelope]);
    if (otherPlan.state !== "prepared_plan") throw Error("fixture");
    expect(await recordCapabilityCanaryObservation(c.service, { ...input, config: otherConfig, reviewed: [otherEnvelope],
      claim: { ...input.claim, windowKey: otherPlan.plan.windows[0].idempotencyKey }, observation: { ...missing, ...otherScope } }))
      .toMatchObject({ state: "recorded", evidence: { decision: { classification: "accept_missing", allowedExtensions: [] } } });
  });

  it.each([{ data: 7, error: { message: "secret denied" } }, { data: 8, error: null }, null])(
    "withholds success on failed or malformed write response %j", async (response) => {
      clock(); const c = client(response);
      expect(await recordCapabilityCanaryObservation(c.service, input)).toEqual({ state: "uncertain", reasonCode: "record_outcome_unknown" });
      expect(c.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("never invokes RPC for a pre-aborted call", async () => {
    clock(); const c = client();
    expect(await recordCapabilityCanaryObservation(c.service, { ...input, signal: AbortSignal.abort() }))
      .toEqual({ state: "rejected", reasonCode: "aborted_before_record" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("bounds a hung write, requests abort and ignores late success without retry", async () => {
    clock(); const c = client();
    let finish!: (value: unknown) => void;
    c.abortSignal.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = recordCapabilityCanaryObservation(c.service, input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ state: "uncertain", reasonCode: "record_outcome_unknown" });
    expect(c.abortSignal.mock.calls[0][0].aborted).toBe(true);
    finish({ data: 7, error: null });
    await Promise.resolve();
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delegates exact replay and conflict to the existing ledger, retaining original payload", async () => {
    clock();
    const retained = new Map<string, string>(); // Synthetic RPC model only, NOT durable storage.
    const rpc = vi.fn((_name: string, args: Record<string, unknown>) => ({ abortSignal: async () => {
      const key = String(args.p_idempotency_key), bytes = JSON.stringify(args);
      if (retained.has(key) && retained.get(key) !== bytes) return { data: null, error: { message: "conflict" } };
      retained.set(key, bytes); return { data: args.p_observation_revision, error: null };
    } }));
    const service = { rpc } as unknown as SupabaseClient;
    expect((await recordCapabilityCanaryObservation(service, input)).state).toBe("recorded");
    expect((await recordCapabilityCanaryObservation(service, input)).state).toBe("recorded");
    expect(retained.size).toBe(1);
    const changed = { ...input, observation: { ...(input.observation as object), observedAt: "2026-10-02T12:00:01.000Z" } };
    expect((await recordCapabilityCanaryObservation(service, changed)).state).toBe("uncertain");
    expect(retained.size).toBe(1);
    expect(rpc.mock.calls.every(([name]) => name === "api_record_capability_observation")).toBe(true);
  });
});


describe("record-and-attention runner dependency", () => {
  const metadata = { provider: scope.provider, route: scope.route, surface: scope.surface,
    surfaceRevision: scope.revision, policyRevision: envelope.policyRevision, adapterRevision: null, workerBuild: null };
  function setup() {
    const load = vi.fn().mockResolvedValue(null);
    const compareAndSwap = vi.fn().mockResolvedValue("committed");
    return { load, compareAndSwap, options: { store: { load, compareAndSwap }, metadata, reviewedMetadata: [metadata], now: () => instant } };
  }
  it.each(["conflict", "committed", "lost_reply"])("exposes attention %s after exactly one record", async (status) => {
    clock(); const c = client(); const f = setup();
    if (status === "lost_reply") f.compareAndSwap.mockRejectedValue(Error("private"));
    else f.compareAndSwap.mockResolvedValue(status);
    expect(await recordCapabilityCanaryWithAttention(c.service, input, f.options)).toMatchObject({ state: "recorded",
      attention: { state: status === "lost_reply" ? "uncertain" : status } });
    expect(c.rpc).toHaveBeenCalledTimes(1); expect(f.compareAndSwap).toHaveBeenCalledTimes(1);
  });
  it("never accesses attention storage after rejected or uncertain records", async () => {
    clock(); const f = setup();
    for (const [c, value] of [[client(), { ...input, claim: { ...input.claim, observationRevision: 8 } }],
      [client({ data: null, error: { message: "private" } }), input]] as const) {
      expect(await recordCapabilityCanaryWithAttention(c.service, value, f.options)).toMatchObject({ attention: { state: "not_attempted" } });
    }
    expect(f.load).not.toHaveBeenCalled(); expect(f.compareAndSwap).not.toHaveBeenCalled();
  });
  it("retains confirmed record with explicit missing backend and invalid context outcomes", async () => {
    clock(); const c = client(); const f = setup();
    expect(await recordCapabilityCanaryWithAttention(c.service, input, { ...f.options, store: null }))
      .toMatchObject({ state: "recorded", attention: { state: "dependency_unavailable" } });
    const other = { ...metadata, surfaceRevision: "other.v1" };
    expect(await recordCapabilityCanaryWithAttention(c.service, input, { ...f.options, metadata: other, reviewedMetadata: [other] }))
      .toMatchObject({ state: "recorded", attention: { state: "rejected", reasonCode: "invalid_attention_context" } });
    expect(f.load).not.toHaveBeenCalled();
  });
  it("passes cancellation after record to attention without starting a CAS", async () => {
    clock(); const c = client(); const f = setup(); const controller = new AbortController();
    expect(await recordCapabilityCanaryWithAttention(c.service, { ...input, signal: controller.signal }, {
      ...f.options, now: () => { controller.abort(); return instant; },
    })).toMatchObject({ state: "recorded", attention: { state: "rejected", reasonCode: "aborted_before_store" } });
    expect(f.load).not.toHaveBeenCalled(); expect(f.compareAndSwap).not.toHaveBeenCalled();
  });
});

import { createCanaryFencedAttempt } from "./providerCapabilityCanaryFenced.js";
import { completeCapabilityCanaryObservation } from "./providerCapabilityCanaryLedger.js";
async function fencedInput() {
  const owner = "11111111-1111-1111-1111-111111111111";
  const receipt = { status: "claimed", windowKey: input.claim.windowKey, owner, fence: "22222222-2222-2222-2222-222222222222",
    generation: 1, observationRevision: 7, deadline: "2026-10-02T12:02:00.000Z" };
  const complete = vi.fn(async () => ({ status: "completed", windowKey: input.claim.windowKey, observationRevision: 7 }));
  const attempt = createCanaryFencedAttempt({ request: { windowKey: input.claim.windowKey, resourceKey: "a".repeat(64), configDigest: "b".repeat(64), requestKey: owner,
    provider: scope.provider, route: scope.route, surface: scope.surface, surfaceRevision: scope.revision,
    windowStart: config.startAt, windowEnd: "2026-10-02T13:00:00.000Z", leaseSeconds: 60 }, completionKey: "33333333-3333-3333-3333-333333333333",
    transport: { claim: async () => receipt, get: async () => ({ ...receipt, status: "completed" }), complete } });
  const claimed = await attempt.claim(instant, new AbortController().signal);
  if (claimed.state !== "claimed") throw Error("claim fixture");
  return { complete, value: { ...input, mode: "fenced" as const, attempt, claim: claimed.claim, resourceReleased: true as const } };
}
describe("atomic fenced ledger bridge", () => {
  it("preserves canonical shared candidate and confirms evidence only from direct completion", async () => {
    const f = await fencedInput();
    expect(await completeCapabilityCanaryObservation(f.value)).toMatchObject({ state: "recorded", observationRevision: 7,
      evidence: { decision: { classification: "matches_policy" } } });
    const retained = f.value.attempt.recovery().completion!;
    expect(retained.candidate.extensions).toEqual(["step", "stp"]);
    expect(retained.candidate).not.toHaveProperty("observationRevision");
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(await completeCapabilityCanaryObservation(f.value)).toMatchObject({ state: "rejected" });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
  it("rejects fenced contamination at the legacy boundary before RPC", async () => {
    const f = await fencedInput(); const c = client();
    expect(await recordCapabilityCanaryObservation(c.service, f.value)).toMatchObject({ state: "rejected", reasonCode: "invalid_claim" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("requires actual retained full receipt and confirmed disposal", async () => {
    const f = await fencedInput();
    expect(await completeCapabilityCanaryObservation({ ...f.value, claim: { ...f.value.claim } })).toMatchObject({ state: "rejected" });
    expect(await completeCapabilityCanaryObservation({ ...f.value, resourceReleased: false as never })).toMatchObject({ state: "rejected" });
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("reply loss retains frozen payload and status returns no candidate-derived evidence", async () => {
    const f = await fencedInput(); f.complete.mockRejectedValue(Error("private backend details"));
    expect(await completeCapabilityCanaryObservation(f.value)).toEqual({ state: "uncertain", reasonCode: "record_outcome_unknown" });
    const recovery = f.value.attempt.recovery();
    expect(Object.isFrozen(recovery.completion!.candidate.extensions)).toBe(true);
    expect(await f.value.attempt.reconcile(instant + 7200000, new AbortController().signal)).toEqual({ state: "completion_known" });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
});
