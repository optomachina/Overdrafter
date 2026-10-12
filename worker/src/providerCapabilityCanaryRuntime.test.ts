// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { capabilityCanaryPlanDigest, createCapabilityCanaryRuntime, type CanaryRuntimeDependencies } from "./providerCapabilityCanaryRuntime.js";
import { XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX } from "./adapters/persistentProfileLock.js";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const envelope = { provider: "xometry" as const, route: "quote_home", surface: "account_quote_modal", revision: "xometry-account-quote-modal.v1",
  extensions: ["step"], policyRevision: "xometry-controlled-beta-2026-08-17.v1", evidenceReference: "OVD-373" };
const scope = { provider: envelope.provider, route: envelope.route, surface: envelope.surface, revision: envelope.revision };
const config = { enabled: false, scope, probeMode: "capability_inspection_no_upload", startAt: new Date(now).toISOString(), intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 2 };
const admission = { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry", admission_state: "controlled_beta_only",
  policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference, permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"],
  accepted_file_extensions: ["step"], session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" };
const snapshot = { state: "fresh" as const, extensions: ["step"], mimeTypes: [], acceptAttributePresent: true };
const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function setup() {
  const prepared = prepareCapabilityCanaryPlan(config, [envelope]);
  if (prepared.state !== "prepared_plan") throw new Error("fixture invalid");
  const plan = prepared.plan;
  const claim = { windowKey: plan.windows[0].idempotencyKey, observationRevision: 17 };
  const request = { plan: config, windowIndex: 0,
    scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: capabilityCanaryPlanDigest(plan), expiresAt: "2026-10-02T13:00:00.000Z" },
    triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: claim.windowKey, expiresAt: "2026-10-02T13:00:00.000Z" } };
  const stop = vi.fn(async () => undefined);
  const startReadOnlyProbe = vi.fn(() => ({ result: Promise.resolve(snapshot), stop }));
  const reserveWindow = vi.fn(async () => ({ state: "reserved" as const, claim, admission }));
  const recordObservation = vi.fn(async () => ({ state: "recorded" as const, observationRevision: 17 }));
  const withProfileLock = vi.fn(async (_profile: string, operation: () => Promise<import("./providerCapabilityCanaryRuntime.js").CanaryRuntimeResult>) => operation());
  const deps: CanaryRuntimeDependencies = { bindings: [{ envelope, profilePath: "/synthetic/profile", reviewReference: "issue:OVD-415", validUntil: "2026-10-02T13:00:00.000Z", startReadOnlyProbe }],
    now: Date.now, reserveWindow, recordObservation, withProfileLock };
  return { request, deps, claim, stop, startReadOnlyProbe, reserveWindow, recordObservation, withProfileLock };
}

describe("bounded canary runtime", () => {
  it("defaults off and rejects unknown fields without any dependency calls", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not use network"));
    const f = setup(); const run = createCapabilityCanaryRuntime(f.deps);
    expect(await run(undefined)).toEqual({ state: "disabled" });
    expect(await run({ ...f.request, upload: "/customer.step" })).toEqual({ state: "invalid_configuration" });
    expect(f.withProfileLock).not.toHaveBeenCalled(); expect(f.reserveWindow).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.recordObservation).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["scheduleAuthorization", "triggerAuthorization"] as const)("requires independent %s gate and exact unexpired receipt", async (key) => {
    const f = setup(); const run = createCapabilityCanaryRuntime(f.deps);
    expect(await run({ ...f.request, [key]: { ...f.request[key], enabled: false } })).toEqual({ state: "disabled" });
    expect(await run({ ...f.request, [key]: { ...f.request[key], expiresAt: new Date(now).toISOString() } })).toEqual({ state: "authorization_rejected" });
    const changed = key === "scheduleAuthorization" ? { planDigest: "wrong" } : { windowKey: "wrong" };
    expect(await run({ ...f.request, [key]: { ...f.request[key], ...changed } })).toEqual({ state: "authorization_rejected" });
    expect(f.withProfileLock).not.toHaveBeenCalled();
  });
  it.each(["reserveWindow", "recordObservation"] as const)("requires %s before profile or probe access", async (key) => {
    const f = setup(); delete f.deps[key];
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: key === "reserveWindow" ? "durable_reservation_unavailable" : "ledger_unavailable" });
    expect(f.withProfileLock).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("requires reviewed binding and refuses arbitrary module config", async () => {
    const f = setup(); f.deps.bindings = [];
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "reviewed_probe_unavailable" });
    expect(f.reserveWindow).not.toHaveBeenCalled(); expect(f.withProfileLock).not.toHaveBeenCalled();
  });
  it("records exactly once after durable claim and confirmed cleanup, then rejects local reentry", async () => {
    const f = setup(); const order: string[] = [];
    f.stop.mockImplementation(async () => { order.push("stop"); });
    f.recordObservation.mockImplementation(async () => { order.push("record"); return { state: "recorded", observationRevision: 17 }; });
    const run = createCapabilityCanaryRuntime(f.deps);
    expect(await run(f.request)).toEqual({ state: "recorded" });
    expect(order).toEqual(["stop", "record"]);
    expect(f.recordObservation).toHaveBeenCalledTimes(1);
    const saved = (f.recordObservation.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(saved).toMatchObject({ claim: f.claim, observation: { ...scope, ...snapshot, windowIndex: 0, observationRevision: 17 } });
    expect(await run(f.request)).toEqual({ state: "window_already_attempted" });
    expect(f.startReadOnlyProbe).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid claim and revoked binding before starting", async () => {
    const f = setup(); f.claim.windowKey = "other-window";
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "reservation_rejected" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
    const g = setup(); g.reserveWindow.mockImplementation(async () => { g.deps.bindings[0].validUntil = new Date(now).toISOString(); return { state: "reserved", claim: g.claim, admission }; });
    expect(await createCapabilityCanaryRuntime(g.deps)(g.request)).toEqual({ state: "authorization_rejected" });
    expect(g.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("discards raw fields before any ledger write", async () => {
    const f = setup(); f.startReadOnlyProbe.mockReturnValue({ result: Promise.resolve({ ...snapshot, html: "secret" }), stop: f.stop });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "invalid_observation" });
    expect(f.recordObservation).not.toHaveBeenCalled();
  });
  it("stops timed-out probes once, discards late results and never retries", async () => {
    const f = setup(); let resolve!: (value: typeof snapshot) => void;
    f.startReadOnlyProbe.mockReturnValue({ result: new Promise((done) => { resolve = done; }), stop: f.stop });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual({ state: "timed_out" });
    resolve(snapshot); await Promise.resolve();
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.recordObservation).not.toHaveBeenCalled();
  });
  it("does not launch after a delayed lock callback misses the deadline", async () => {
    const f = setup(); let operation!: () => Promise<import("./providerCapabilityCanaryRuntime.js").CanaryRuntimeResult>;
    f.withProfileLock.mockImplementation(async (_profile, callback) => { operation = callback; return new Promise(() => undefined); });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ state: "timed_out" });
    expect(await operation()).toEqual({ state: "timed_out" });
    expect(f.reserveWindow).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
  it("reports an unresolved record as uncertain without retry or late success", async () => {
    const f = setup(); f.recordObservation.mockImplementation(async () => new Promise(() => undefined));
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual({ state: "record_uncertain" });
    expect(f.recordObservation).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it("retains the actual profile sidecar when cleanup cannot be confirmed", async () => {
    const f = setup(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canary-lock-fixture-")); dirs.push(dir);
    f.deps.bindings[0].profilePath = path.join(dir, "profile"); delete f.deps.withProfileLock;
    let started!: () => void; const startedPromise = new Promise<void>((done) => { started = done; });
    f.startReadOnlyProbe.mockImplementation(() => { started(); return { result: Promise.resolve(snapshot), stop: async () => { throw new Error("private cleanup error"); } }; });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request); await startedPromise;
    expect(await result).toEqual({ state: "cleanup_unconfirmed" });
    const lockDir = f.deps.bindings[0].profilePath + XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX;
    expect((await fs.readdir(lockDir)).some((name) => name.startsWith("owner-"))).toBe(true);
    expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it.each([{ provider_admitted: false }, { expires_at: "2026-10-02T12:00:00.000Z" },
    { reviewed_at: "2099-01-01T00:00:00.000Z" }, { policy_revision: "unreviewed.v1" }])("rejects invalid admission before any probe: %j", async (patch) => {
    const f = setup();
    f.reserveWindow.mockResolvedValue({ state: "reserved", claim: f.claim, admission: { ...admission, ...patch } } as never);
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "admission_rejected" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it("contains a probe on explicit revocation without deleting evidence or recording", async () => {
    const f = setup(); const revoke = new AbortController(); f.deps.revocationSignal = revoke.signal;
    let started!: () => void; const active = new Promise<void>((done) => { started = done; });
    f.startReadOnlyProbe.mockImplementation(() => { started(); return { result: new Promise(() => undefined), stop: f.stop }; });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await active; revoke.abort();
    expect(await result).toEqual({ state: "disabled" });
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it("bounds hung cleanup and withholds lock release until it is acknowledged", async () => {
    const f = setup(); let released = false; let stopped!: () => void;
    f.stop.mockImplementation(async () => new Promise<void>((done) => { stopped = done; }));
    f.withProfileLock.mockImplementation(async (_profile, operation) => { const result = await operation(); released = true; return result; });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ state: "cleanup_unconfirmed" }); expect(released).toBe(false);
    stopped(); await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true); expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it("fences late durable reservation completion after timeout", async () => {
    const f = setup(); let complete!: () => void;
    f.reserveWindow.mockImplementation(async () => new Promise((done) => { complete = () => done({ state: "reserved", claim: f.claim, admission }); }));
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toEqual({ state: "timed_out" });
    complete(); await vi.advanceTimersByTimeAsync(0);
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it("does not infer success from wrong revision or lost record reply", async () => {
    const f = setup(); f.recordObservation.mockResolvedValue({ state: "recorded", observationRevision: 18 });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "record_uncertain" });
    const g = setup(); g.recordObservation.mockRejectedValue(new Error("private transport response"));
    expect(await createCapabilityCanaryRuntime(g.deps)(g.request)).toEqual({ state: "record_uncertain" });
    expect(g.recordObservation).toHaveBeenCalledTimes(1);
  });

  it("requires the durable service to arbitrate concurrent runtime instances", async () => {
    const f = setup(); let reserved = false;
    f.deps.reserveWindow = vi.fn(async () => {
      if (reserved) return { state: "already_reserved" as const };
      reserved = true; return { state: "reserved" as const, claim: f.claim, admission };
    });
    const results = await Promise.all([createCapabilityCanaryRuntime(f.deps)(f.request), createCapabilityCanaryRuntime(f.deps)(f.request)]);
    expect(results.map((result) => result.state).sort()).toEqual(["recorded", "reservation_rejected"]);
    expect(f.startReadOnlyProbe).toHaveBeenCalledTimes(1); expect(f.recordObservation).toHaveBeenCalledTimes(1);
    // This atomic fake demonstrates the required interface, not a deployed durable backend.
  });

  it.each(["dependency_unavailable", "conflict", "uncertain", "failed"])("surfaces recorded-but-attention-%s without a second record", async (state) => {
    const f = setup(); f.recordObservation.mockResolvedValue({ state: "recorded", observationRevision: 17, attention: { state } } as never);
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(f.recordObservation).toHaveBeenCalledTimes(1);
  });

  it("cleans up a rejected probe and scrubs its error", async () => {
    const f = setup(); f.startReadOnlyProbe.mockImplementation(() => ({ result: Promise.reject(new Error("customer.step secret token")), stop: f.stop }));
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "probe_failed" });
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.recordObservation).not.toHaveBeenCalled();
  });

  it("preserves observation time across cleanup latency", async () => {
    const f = setup(); f.stop.mockImplementation(async () => { vi.setSystemTime(now + 100); });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded" });
    expect(f.recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: now + 100, observation: expect.objectContaining({ observedAt: new Date(now).toISOString() }),
    }));
  });

  it.each([{ timeoutSeconds: 0 }, { timeoutSeconds: 61 }, { intervalSeconds: 1 }, { taskRetries: 1 }, { url: "https://unreviewed.example" }])("rejects malformed or widened plan before effects: %j", async (patch) => {
    const f = setup();
    expect(await createCapabilityCanaryRuntime(f.deps)({ ...f.request, plan: { ...config, ...patch } })).toEqual({ state: "invalid_configuration" });
    expect(f.withProfileLock).not.toHaveBeenCalled(); expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
  });
});

import type { CanaryFencedAttempt } from "./providerCapabilityCanaryFenced.js";
function fencedSetup() {
  const f = setup();
  const owner = "11111111-1111-1111-1111-111111111111";
  const receipt = { status: "claimed", windowKey: f.claim.windowKey, owner, fence: "22222222-2222-2222-2222-222222222222",
    generation: 1, observationRevision: 17, deadline: new Date(now + 1000).toISOString() };
  const claim = vi.fn(async () => receipt);
  const get = vi.fn(async () => ({ ...receipt, status: "completed" }));
  const complete = vi.fn(async () => ({ status: "completed", windowKey: receipt.windowKey, observationRevision: 17 }));
  let retained: CanaryFencedAttempt | undefined;
  const resolveAdmission = vi.fn(async () => admission);
  f.deps.fenced = { mode: "fenced", resourceKey: "a".repeat(64), requestKey: owner, completionKey: "33333333-3333-3333-3333-333333333333",
    leaseSeconds: 1, transport: { claim, get, complete }, resolveAdmission, retainAttempt: attempt => { retained = attempt; } };
  return { ...f, receipt, transport: { claim, get, complete }, resolveAdmission, recovery: () => retained! };
}
describe("fenced runtime", () => {
  it("claims, checks admission, stops and atomically completes without legacy append; attention is pending", async () => {
    const f = fencedSetup();
    f.transport.complete.mockImplementation(async () => {
      expect(f.stop).toHaveBeenCalledTimes(1);
      return { status: "completed", windowKey: f.claim.windowKey, observationRevision: 17 };
    });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(f.resolveAdmission).toHaveBeenCalledTimes(2);
    expect(f.reserveWindow).not.toHaveBeenCalled(); expect(f.recordObservation).not.toHaveBeenCalled();
    expect(f.recovery().recovery().completion).toMatchObject({ resourceReleased: true, candidate: { actorKind: "scheduled_canary", idempotencyKey: f.claim.windowKey } });
    expect(f.recovery().recovery().completion!.candidate).not.toHaveProperty("observationRevision");
    expect(f.startReadOnlyProbe).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: now + 500 }));
  });
  it.each(["replay", "expired", "completed", "busy"])("never probes on %s", async status => {
    const f = fencedSetup(); f.transport.claim.mockResolvedValue({ ...f.receipt, status });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "reservation_rejected" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("rejects missing fenced dependencies without falling back", async () => {
    const f = fencedSetup(); f.deps.fenced!.resolveAdmission = undefined as never;
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "invalid_configuration" });
    expect(f.reserveWindow).not.toHaveBeenCalled(); expect(f.transport.claim).not.toHaveBeenCalled();
  });
  it("rejects admission revoked after stop, keeping claim recovery and no fabricated completion", async () => {
    const f = fencedSetup(); f.resolveAdmission.mockResolvedValueOnce(admission).mockResolvedValueOnce({ ...admission, provider_admitted: false });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "admission_rejected" });
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.transport.complete).not.toHaveBeenCalled();
    expect(f.recovery().recovery().claim).not.toBeNull();
  });
  it("retains binding and request snapshot across claim await", async () => {
    const f = fencedSetup(); const intruder = vi.fn();
    f.transport.claim.mockImplementation(async () => {
      f.deps.bindings[0] = { ...f.deps.bindings[0], startReadOnlyProbe: intruder };
      f.deps.fenced!.requestKey = "44444444-4444-4444-4444-444444444444";
      return f.receipt;
    });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(intruder).not.toHaveBeenCalled(); expect(f.recovery().recovery().request!.requestKey).toBe(f.receipt.owner);
  });
  it("contains a lease-expired probe without completion", async () => {
    const f = fencedSetup(); f.startReadOnlyProbe.mockReturnValue({ result: new Promise(() => undefined), stop: f.stop });
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ state: "timed_out" });
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("late claim never starts a probe; completed reconciliation never creates evidence", async () => {
    const f = fencedSetup(); let reply!: (value: typeof f.receipt) => void;
    f.transport.claim.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    const result = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ state: "timed_out" });
    reply(f.receipt); await Promise.resolve();
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled();
    expect(await f.recovery().reconcile(now + 7200000, new AbortController().signal)).toEqual({ state: "completion_known" });
    expect(f.recovery().recovery().completion).toBeNull();
  });
  it("uncertain atomic completion keeps exact recovery payload without automatic replay", async () => {
    const f = fencedSetup(); f.transport.complete.mockRejectedValue(new Error("private reply loss"));
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "record_uncertain" });
    expect(f.recovery().recovery().completion).not.toBeNull();
    expect(await f.recovery().reconcile(now + 7200000, new AbortController().signal)).toEqual({ state: "completion_known" });
    expect(f.transport.complete).toHaveBeenCalledOnce(); expect(f.startReadOnlyProbe).toHaveBeenCalledOnce();
  });
});

describe("reconciliation closes pending executable authorization", () => {
  it.each(["replay", "expired", "completed", "unknown"])("never activates after %s reconciliation during claim", async status => {
    const f = fencedSetup();
    let reply!: (value: typeof f.receipt) => void;
    let started!: () => void;
    const barrier = new Promise<void>(resolve => { started = resolve; });
    f.transport.claim.mockImplementation(() => { started(); return new Promise(resolve => { reply = resolve; }); });
    f.transport.get.mockResolvedValue(status === "unknown" ? { status } as never : { ...f.receipt, status });
    const pending = createCapabilityCanaryRuntime(f.deps)(f.request);
    await barrier;
    await f.recovery().reconcile(now, new AbortController().signal);
    reply(f.receipt);
    expect(await pending).toEqual({ state: "reservation_rejected" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it.each(["replay", "expired", "completed", "unknown"])("never activates after %s reconciliation during admission", async status => {
    const f = fencedSetup();
    let reply!: (value: typeof admission) => void;
    let started!: () => void;
    const barrier = new Promise<void>(resolve => { started = resolve; });
    f.resolveAdmission.mockImplementation(() => { started(); return new Promise(resolve => { reply = resolve; }); });
    f.transport.get.mockResolvedValue(status === "unknown" ? { status } as never : { ...f.receipt, status });
    const pending = createCapabilityCanaryRuntime(f.deps)(f.request);
    await barrier;
    await f.recovery().reconcile(now, new AbortController().signal);
    reply(admission);
    expect(await pending).toEqual({ state: "reservation_rejected" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("reconciliation does not pretend an already-running probe stopped", async () => {
    const f = fencedSetup(); let reply!: (value: typeof snapshot) => void;
    let started!: () => void;
    const barrier = new Promise<void>(resolve => { started = resolve; });
    f.startReadOnlyProbe.mockImplementation(() => { started(); return { result: new Promise(resolve => { reply = resolve; }), stop: f.stop }; });
    const pending = createCapabilityCanaryRuntime(f.deps)(f.request);
    await barrier;
    await f.recovery().reconcile(now, new AbortController().signal);
    expect(f.stop).not.toHaveBeenCalled();
    reply(snapshot);
    expect(await pending).toEqual({ state: "record_failed" });
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
});

describe("server-clock deadline integration", () => {
  it("accepts UTC microseconds after 1ms request latency and never probes twice", async () => {
    const f = fencedSetup();
    f.transport.claim.mockImplementation(async () => {
      vi.setSystemTime(now + 1);
      return { ...f.receipt, deadline: "2026-10-02T12:00:01.001000+00:00" };
    });
    const run = createCapabilityCanaryRuntime(f.deps);
    expect(await run(f.request)).toEqual({ state: "recorded_attention_pending" });
    expect(await run(f.request)).toEqual({ state: "window_already_attempted" });
    expect(f.startReadOnlyProbe).toHaveBeenCalledTimes(1); expect(f.transport.complete).toHaveBeenCalledTimes(1);
  });
  it("refuses an already-expired wire deadline when the reply arrives before the local budget", async () => {
    const f = fencedSetup();
    f.transport.claim.mockImplementation(async () => {
      vi.setSystemTime(now + 1001);
      return { ...f.receipt, deadline: "2026-10-02T12:00:01+00:00" };
    });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "timed_out" });
    expect(f.startReadOnlyProbe).not.toHaveBeenCalled(); expect(f.transport.complete).not.toHaveBeenCalled();
  });
  it("a later server lease never extends the local probe budget", async () => {
    const f = fencedSetup();
    f.transport.claim.mockResolvedValue({ ...f.receipt, deadline: "2026-10-02T12:00:10.999999+00:00" });
    f.startReadOnlyProbe.mockReturnValue({ result: new Promise(() => undefined), stop: f.stop });
    const running = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await running).toEqual({ state: "timed_out" });
    expect(f.startReadOnlyProbe).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.transport.complete).not.toHaveBeenCalled();
  });
});

describe("confirmed ledger attention phase", () => {
  it("calls attention once with direct confirmed evidence, never replaying the ledger", async () => {
    const f = fencedSetup(); const callback = vi.fn(async () => ({ state: "committed" })); f.deps.onConfirmedObservation = callback;
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded" });
    expect(callback).toHaveBeenCalledOnce(); expect(f.transport.complete).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]).toEqual([expect.objectContaining({ evidence: expect.objectContaining({ observationRevision: 17 }), deadlineMs: now + 500 })]);
  });
  it("attention hangs only until the work deadline and retains known ledger completion", async () => {
    const f = fencedSetup(); f.deps.onConfirmedObservation = vi.fn(() => new Promise(() => undefined));
    const pending = createCapabilityCanaryRuntime(f.deps)(f.request);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ state: "recorded_attention_pending" });
    expect(f.transport.complete).toHaveBeenCalledOnce();
  });
  it("attention rejection stays pending and ledger uncertainty never calls attention", async () => {
    const f = fencedSetup(); f.deps.onConfirmedObservation = vi.fn(async () => { throw Error("private"); });
    expect(await createCapabilityCanaryRuntime(f.deps)(f.request)).toEqual({ state: "recorded_attention_pending" });
    const g = fencedSetup(); const callback = vi.fn(); g.deps.onConfirmedObservation = callback;
    g.transport.complete.mockRejectedValue(Error("reply loss"));
    expect(await createCapabilityCanaryRuntime(g.deps)(g.request)).toEqual({ state: "record_uncertain" });
    expect(callback).not.toHaveBeenCalled();
  });
});
