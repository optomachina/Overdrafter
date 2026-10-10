// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanaryFencedAttempt } from "./providerCapabilityCanaryFenced.js";
import type { CapabilityRecordInput } from "./providerUploadCapabilityPersistence.js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest, createCapabilityCanaryRuntime, type CanaryRuntimeDependencies } from "./providerCapabilityCanaryRuntime.js";

// Synthetic service boundary fixtures only: no database durability or provider execution.
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const OWNER = "11111111-1111-4111-8111-111111111111";
const FENCE = "22222222-2222-4222-8222-222222222222";
const COMPLETION = "33333333-3333-4333-8333-333333333333";
const envelope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal",
  revision: "xometry-account-quote-modal.v1", extensions: ["step"],
  policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
const scope = { provider: envelope.provider, route: envelope.route, surface: envelope.surface, revision: envelope.revision };
const config = { enabled: false, scope, probeMode: "capability_inspection_no_upload", startAt: new Date(NOW).toISOString(),
  intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 2 };
function claimInput() {
  const prepared = prepareCapabilityCanaryPlan(config, [envelope]);
  if (prepared.state !== "prepared_plan") throw new Error("invalid synthetic fixture");
  return { windowKey: prepared.plan.windows[0].idempotencyKey, resourceKey: "a".repeat(64),
    configDigest: capabilityCanaryPlanDigest(prepared.plan), requestKey: OWNER,
    provider: scope.provider, route: scope.route, surface: scope.surface, surfaceRevision: scope.revision,
    windowStart: prepared.plan.windows[0].startAt, windowEnd: prepared.plan.windows[0].endAt, leaseSeconds: 2 };
}
function receipt(status = "claimed") {
  return { status, windowKey: claimInput().windowKey, fence: FENCE, generation: 1,
    owner: OWNER, observationRevision: 17, deadline: new Date(NOW + 2000).toISOString() };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function candidate(): Omit<CapabilityRecordInput, "observationRevision"> {
  return { ...scope, state: "fresh", extensions: ["step"], mimeTypes: [], acceptAttributePresent: true,
    observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3600_000).toISOString(),
    actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: "capability-canary-offline.v1",
    evidenceReference: "issue:OVD-415", idempotencyKey: claimInput().windowKey };
}
function fixture() {
  const transport = {
    claim: vi.fn().mockResolvedValue(receipt()), get: vi.fn().mockResolvedValue({ status: "unknown" }),
    complete: vi.fn().mockResolvedValue({ status: "completed", windowKey: claimInput().windowKey, observationRevision: 17 }),
  };
  const request = claimInput();
  const attempt = createCanaryFencedAttempt({ transport, request, completionKey: COMPLETION });
  const signal = new AbortController().signal;
  return { transport, request, attempt, signal };
}

describe("fenced attempt adversarial synthetic transport", () => {
  it("permits only the first direct claimed receipt and preserves one reserved revision", async () => {
    const f = fixture();
    expect(await f.attempt.claim(NOW, f.signal)).toMatchObject({ state: "claimed", claim: { observationRevision: 17 } });
    expect((await f.attempt.claim(NOW, f.signal)).state).not.toBe("claimed");
    expect(f.transport.claim).toHaveBeenCalledTimes(1);
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(true);
    expect(await f.attempt.complete(NOW, f.signal)).toEqual({ state: "completed", observationRevision: 17 });
    expect(f.transport.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["replay", "expired", "completed", "busy"])("never grants probe authority from %s", async (status) => {
    const f = fixture(); f.transport.claim.mockResolvedValue(status === "busy" ? { status } : receipt(status));
    expect((await f.attempt.claim(NOW, f.signal)).state).not.toBe("claimed");
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(false);
    expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it.each([
    { windowKey: "canary:" + "f".repeat(64) }, { owner: COMPLETION }, { fence: "invalid-fence" },
    { generation: 2 }, { observationRevision: 0 }, { observationRevision: Number.MAX_SAFE_INTEGER + 1 },
    { observationRevision: "17" }, { deadline: new Date(NOW).toISOString() },
    { deadline: new Date(NOW + 3600_001).toISOString() }, { deadline: "2026-10-02T12:00:02+01:00" },
    { unexpected: "private" },
  ])("rejects malformed or substituted claimed receipt %j", async (patch) => {
    const f = fixture(); f.transport.claim.mockResolvedValue({ ...receipt(), ...patch });
    expect((await f.attempt.claim(NOW, f.signal)).state).not.toBe("claimed");
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(false);
    expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it.each(["claimed", "replay", "expired", "completed", "unknown"])("lookup %s never acquires probe authority", async (status) => {
    const f = fixture(); f.transport.get.mockResolvedValue(status === "unknown" ? { status } : receipt(status));
    const result = await f.attempt.reconcile(NOW, f.signal);
    expect(result.state).not.toBe("claimed");
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(false);
    expect(f.transport.claim).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it("lost reservation reply requires lookup, never a second claim", async () => {
    const f = fixture(); f.transport.claim.mockRejectedValue(Error("private transport url"));
    expect(await f.attempt.claim(NOW, f.signal)).toEqual({ state: "uncertain" });
    f.transport.get.mockResolvedValue(receipt("replay"));
    expect((await f.attempt.reconcile(NOW, f.signal)).state).not.toBe("claimed");
    expect((await f.attempt.claim(NOW, f.signal)).state).not.toBe("claimed");
    expect(f.transport.claim).toHaveBeenCalledTimes(1); expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "fictiv" }, { route: "other_route" }, { surface: "other_surface" }, { revision: "other.v1" },
    { idempotencyKey: "canary:" + "b".repeat(64) }, { actorKind: "operator" }, { sourceKind: "provider_surface" },
    { observationRevision: 18 },
  ])("refuses completion scope or provenance substitution %j", async (patch) => {
    const f = fixture(); await f.attempt.claim(NOW, f.signal);
    expect(f.attempt.prepareCompletion({ ...candidate(), ...patch } as never, true)).toBe(false);
    expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it("requires confirmed disposal and refuses completion at the lease boundary", async () => {
    const f = fixture(); await f.attempt.claim(NOW, f.signal);
    expect(f.attempt.prepareCompletion(candidate(), false as never)).toBe(false);
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(true);
    expect((await f.attempt.complete(NOW + 2000, f.signal)).state).not.toBe("completed");
    expect(f.transport.complete).not.toHaveBeenCalled();
  });

  it.each([{ windowKey: "canary:" + "b".repeat(64) }, { observationRevision: 18 }, { observationRevision: "17" }, { extra: "private" }])(
    "withholds completion acknowledgement for wrong receipt %j", async (patch) => {
      const f = fixture(); await f.attempt.claim(NOW, f.signal); f.attempt.prepareCompletion(candidate(), true);
      f.transport.complete.mockResolvedValue({ status: "completed", windowKey: f.request.windowKey, observationRevision: 17, ...patch });
      expect((await f.attempt.complete(NOW, f.signal)).state).not.toBe("completed");
      expect(f.transport.complete).toHaveBeenCalledTimes(1);
    },
  );

  it("freezes a detached completion payload and reconciles lost replies without a fresh probe", async () => {
    const f = fixture(); await f.attempt.claim(NOW, f.signal);
    const original = candidate(); expect(f.attempt.prepareCompletion(original, true)).toBe(true);
    original.extensions.push("pdf"); original.observedAt = new Date(NOW + 1000).toISOString();
    f.transport.complete.mockRejectedValue(Error("private response"));
    expect(await f.attempt.complete(NOW, f.signal)).toEqual({ state: "uncertain" });
    const payload = f.transport.complete.mock.calls[0][0].p_input;
    expect(payload).toMatchObject({ requestKey: OWNER, fence: FENCE, completionKey: COMPLETION, resourceReleased: true,
      candidate: { extensions: ["step"], observedAt: new Date(NOW).toISOString() } });
    expect(Object.isFrozen(payload)).toBe(true); expect(Object.isFrozen(payload.candidate.extensions)).toBe(true);
    f.transport.get.mockResolvedValue(receipt("completed"));
    expect(await f.attempt.reconcile(NOW + 3000, f.signal)).toEqual({ state: "completion_known" });
    expect(f.transport.claim).toHaveBeenCalledTimes(1); expect(f.transport.complete).toHaveBeenCalledTimes(1);
  });
});


describe("fenced recovery and closed candidate edge cases", () => {
  it.each(["replay", "expired", "completed", "unknown"])("reconciliation %s permanently disables fresh claim authority on that attempt", async (status) => {
    const f = fixture(); f.transport.get.mockResolvedValue(status === "unknown" ? { status } : receipt(status));
    const reconciled = await f.attempt.reconcile(NOW, f.signal);
    expect(reconciled).toEqual({ state: status === "completed" ? "completion_known" : "not_authorized" });
    expect((await f.attempt.claim(NOW, f.signal)).state).not.toBe("claimed");
    expect(f.transport.claim).not.toHaveBeenCalled();
  });
  it.each(["ambiguous", "loading", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response"] as const)(
    "preserves maintained nonfresh state %s", async (state) => {
      const f = fixture(); await f.attempt.claim(NOW, f.signal);
      expect(f.attempt.prepareCompletion({ ...candidate(), state, extensions: [], mimeTypes: [], acceptAttributePresent: null }, true)).toBe(true);
      expect(await f.attempt.complete(NOW, f.signal)).toEqual({ state: "completed", observationRevision: 17 });
      expect(f.transport.complete.mock.calls[0][0].p_input.candidate.state).toBe(state);
    },
  );
  it("keeps the first prepared payload when a changed candidate is offered", async () => {
    const f = fixture(); await f.attempt.claim(NOW, f.signal);
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(true);
    expect(f.attempt.prepareCompletion({ ...candidate(), extensions: ["pdf"] }, true)).toBe(false);
    expect(await f.attempt.complete(NOW, f.signal)).toEqual({ state: "completed", observationRevision: 17 });
    expect(f.transport.complete.mock.calls[0][0].p_input.candidate.extensions).toEqual(["step"]);
  });
  it.each(["sparse", "accessor", "extra"])("rejects %s token arrays as noncanonical data without reading accessors", async (kind) => {
    const f = fixture(); await f.attempt.claim(NOW, f.signal);
    const extensions: string[] = kind === "sparse" ? new Array(1) : ["step"];
    const getter = vi.fn(() => "step");
    if (kind === "accessor") Object.defineProperty(extensions, "0", { get: getter, enumerable: true });
    if (kind === "extra") Object.assign(extensions, { privateData: "secret" });
    expect(f.attempt.prepareCompletion({ ...candidate(), extensions }, true)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
});


describe("retained fenced identities and cancellation", () => {
  it("captures detached claim bindings before callers mutate request objects", async () => {
    const f = fixture(); const original = structuredClone(f.request);
    f.request.requestKey = COMPLETION; f.request.resourceKey = "b".repeat(64); f.request.configDigest = "c".repeat(64);
    expect(await f.attempt.claim(NOW, f.signal)).toMatchObject({ state: "claimed" });
    expect(f.transport.claim.mock.calls[0][0]).toEqual({ p_input: original });
    expect(Object.isFrozen(f.transport.claim.mock.calls[0][0].p_input)).toBe(true);
  });
  it.each([{ fence: COMPLETION }, { owner: COMPLETION }, { windowKey: "canary:" + "b".repeat(64) }, { observationRevision: 18 }])(
    "rejects identity substitution in reconciliation %j", async (patch) => {
      const f = fixture(); await f.attempt.claim(NOW, f.signal);
      f.transport.get.mockResolvedValue({ ...receipt("completed"), ...patch });
      expect(await f.attempt.reconcile(NOW + 3000, f.signal)).toEqual({ state: "rejected" });
      expect(f.transport.complete).not.toHaveBeenCalled();
    },
  );
  it("does not submit transport operations with a pre-aborted signal", async () => {
    const f = fixture(); const signal = AbortSignal.abort();
    expect(await f.attempt.claim(NOW, signal)).toEqual({ state: "rejected" });
    expect(await f.attempt.reconcile(NOW, signal)).toEqual({ state: "rejected" });
    expect(await f.attempt.complete(NOW, signal)).toEqual({ state: "rejected" });
    expect(f.transport.claim).not.toHaveBeenCalled(); expect(f.transport.get).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("bounds lost reservation reply and ignores a late claimed receipt", async () => {
    const f = fixture(); let reply!: (value: unknown) => void;
    f.transport.claim.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    const result = f.attempt.claim(NOW, f.signal); await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ state: "uncertain" });
    reply(receipt()); await Promise.resolve();
    expect(f.attempt.prepareCompletion(candidate(), true)).toBe(false);
    expect((await f.attempt.claim(NOW + 5000, f.signal)).state).not.toBe("claimed");
    expect(f.transport.claim).toHaveBeenCalledTimes(1);
  });
});


function runtimeFixture() {
  const f = fixture();
  const snapshot = { state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true };
  const admission = { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry",
    admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference,
    permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step"],
    session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" };
  const stop = vi.fn(async () => undefined);
  const probe = vi.fn(() => ({ result: Promise.resolve(snapshot), stop }));
  const retainAttempt = vi.fn(); const resolveAdmission = vi.fn().mockResolvedValue(admission);
  const legacyReserve = vi.fn(); const legacyRecord = vi.fn();
  const request = { plan: structuredClone(config), windowIndex: 0,
    scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: f.request.configDigest, expiresAt: "2026-10-02T13:00:00.000Z" },
    triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: f.request.windowKey, expiresAt: "2026-10-02T13:00:00.000Z" } };
  const deps: CanaryRuntimeDependencies = { now: Date.now,
    bindings: [{ envelope: structuredClone(envelope), profilePath: "/synthetic/adversarial-profile", reviewReference: "issue:OVD-415",
      validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe: probe }],
    withProfileLock: async (_path, action) => action(), reserveWindow: legacyReserve, recordObservation: legacyRecord,
    fenced: { mode: "fenced", resourceKey: f.request.resourceKey, requestKey: OWNER, completionKey: COMPLETION, leaseSeconds: 2,
      transport: f.transport, resolveAdmission, retainAttempt } };
  return { ...f, deps, runtimeRequest: request, probe, stop, retainAttempt, resolveAdmission, legacyReserve, legacyRecord };
}

describe("fenced runtime forbidden-effect counters", () => {
  it("retains attempt before claim, stops before completion, and never falls back to legacy", async () => {
    const f = runtimeFixture(); const order: string[] = [];
    f.retainAttempt.mockImplementation(() => { order.push("retain"); });
    f.transport.claim.mockImplementation(async () => { order.push("claim"); return receipt(); });
    f.stop.mockImplementation(async () => { order.push("stop"); });
    f.transport.complete.mockImplementation(async () => { order.push("complete"); return { status: "completed", windowKey: f.request.windowKey, observationRevision: 17 }; });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "recorded_attention_pending" });
    expect(order).toEqual(["retain", "claim", "stop", "complete"]);
    expect(f.probe).toHaveBeenCalledTimes(1); expect(f.resolveAdmission).toHaveBeenCalledTimes(2);
    expect(f.legacyReserve).not.toHaveBeenCalled(); expect(f.legacyRecord).not.toHaveBeenCalled();
  });
  it.each(["replay", "expired", "completed", "busy"])("%s receipt produces no probe, stop, or completion", async (status) => {
    const f = runtimeFixture(); f.transport.claim.mockResolvedValue(status === "busy" ? { status } : receipt(status));
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "reservation_rejected" });
    expect(f.probe).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it.each(["planDigest", "windowKey"])("substituted authorization %s closes before reservation", async (field) => {
    const f = runtimeFixture();
    if (field === "planDigest") f.runtimeRequest.scheduleAuthorization.planDigest = "b".repeat(64);
    else f.runtimeRequest.triggerAuthorization.windowKey = "canary:" + "b".repeat(64);
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "authorization_rejected" });
    expect(f.transport.claim).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("lost reservation reply never probes, retries, or falls back", async () => {
    const f = runtimeFixture(); f.transport.claim.mockRejectedValue(Error("private"));
    const run = createCapabilityCanaryRuntime(f.deps);
    expect((await run(f.runtimeRequest)).state).not.toBe("recorded");
    expect(await run(f.runtimeRequest)).toEqual({ state: "window_already_attempted" });
    expect(f.transport.claim).toHaveBeenCalledTimes(1); expect(f.probe).not.toHaveBeenCalled(); expect(f.legacyReserve).not.toHaveBeenCalled();
  });
  it("lost completion reply returns uncertain and never re-probes", async () => {
    const f = runtimeFixture(); f.transport.complete.mockRejectedValue(Error("private"));
    const run = createCapabilityCanaryRuntime(f.deps);
    expect(await run(f.runtimeRequest)).toEqual({ state: "record_uncertain" });
    expect(await run(f.runtimeRequest)).toEqual({ state: "window_already_attempted" });
    expect(f.probe).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1); expect(f.transport.complete).toHaveBeenCalledTimes(1);
  });
  it.each(["throw", "hang"])("unconfirmed disposal %s never completes", async (failure) => {
    const f = runtimeFixture();
    f.stop.mockImplementation(async () => { if (failure === "throw") throw Error("private"); await new Promise(() => undefined); });
    const running = createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await running).toEqual({ state: "cleanup_unconfirmed" }); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("lease expiration during admission never starts a probe", async () => {
    const f = runtimeFixture();
    f.resolveAdmission.mockImplementation(async () => { vi.setSystemTime(NOW + 2000); return {}; });
    expect((await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).state).not.toBe("recorded");
    expect(f.probe).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("closed registry and malformed fenced mode cannot invoke legacy paths", async () => {
    const f = runtimeFixture(); f.deps.fenced = { ...f.deps.fenced!, mode: "legacy" as never };
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "invalid_configuration" });
    f.deps.bindings = [];
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "reviewed_probe_unavailable" });
    expect(f.legacyReserve).not.toHaveBeenCalled(); expect(f.transport.claim).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
});

it("one runtime cannot reuse a completion UUID to execute a second distinct window", async () => {
  const f = runtimeFixture();
  const multiConfig = { ...config, windowCount: 2 };
  const prepared = prepareCapabilityCanaryPlan(multiConfig, [envelope]);
  if (prepared.state !== "prepared_plan") throw Error("fixture");
  const requestFor = (index: number) => ({ plan: multiConfig, windowIndex: index,
    scheduleAuthorization: { ...f.runtimeRequest.scheduleAuthorization, planDigest: capabilityCanaryPlanDigest(prepared.plan), expiresAt: "2026-10-02T15:00:00.000Z" },
    triggerAuthorization: { ...f.runtimeRequest.triggerAuthorization, windowKey: prepared.plan.windows[index].idempotencyKey, expiresAt: "2026-10-02T15:00:00.000Z" } });
  f.deps.bindings[0].validUntil = "2026-10-02T15:00:00.000Z";
  f.transport.claim.mockImplementation(async ({ p_input }) => ({ ...receipt(), windowKey: p_input.windowKey,
    deadline: new Date(Date.now() + 2000).toISOString() }));
  f.transport.complete.mockImplementation(async ({ p_input }) => ({ status: "completed", windowKey: p_input.windowKey, observationRevision: 17 }));
  const run = createCapabilityCanaryRuntime(f.deps);
  expect(await run(requestFor(0))).toEqual({ state: "recorded_attention_pending" });
  vi.setSystemTime(NOW + 3600_000);
  const second = await run(requestFor(1));
  expect(["recorded", "recorded_attention_pending"]).not.toContain(second.state);
  expect(f.transport.claim).toHaveBeenCalledTimes(1); expect(f.probe).toHaveBeenCalledTimes(1); expect(f.transport.complete).toHaveBeenCalledTimes(1);
});

it.each(["ambiguous", "loading", "route_or_selector_drift", "authentication_required", "anti_bot_or_challenge", "provider_error", "unclassified_response"] as const)(
  "runtime records legitimate nonfresh snapshot %s after containment", async (state) => {
    const f = runtimeFixture();
    f.probe.mockReturnValue({ result: Promise.resolve({ state, extensions: [], mimeTypes: [], acceptAttributePresent: null }), stop: f.stop } as never);
    expect(await createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest)).toEqual({ state: "recorded_attention_pending" });
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.transport.complete).toHaveBeenCalledTimes(1);
    expect(f.transport.complete.mock.calls[0][0].p_input.candidate.state).toBe(state);
  },
);

it("rejected probe with unconfirmed containment retains ownership and never completes", async () => {
  const f = runtimeFixture(); let stopped!: () => void; let released = false;
  f.stop.mockImplementation(() => new Promise<void>(resolve => { stopped = resolve; }));
  f.probe.mockImplementation(() => ({ result: Promise.reject(Error("private provider failure")), stop: f.stop }));
  f.deps.withProfileLock = async (_path, operation) => { const result = await operation(); released = true; return result; };
  const running = createCapabilityCanaryRuntime(f.deps)(f.runtimeRequest);
  await vi.advanceTimersByTimeAsync(2500);
  expect(await running).toEqual({ state: "cleanup_unconfirmed" }); expect(released).toBe(false);
  expect(f.transport.complete).not.toHaveBeenCalled();
  stopped(); await vi.advanceTimersByTimeAsync(0);
  expect(released).toBe(true); expect(f.transport.complete).not.toHaveBeenCalled();
});
