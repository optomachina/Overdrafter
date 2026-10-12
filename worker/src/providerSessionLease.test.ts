// @vitest-environment node

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderSessionLeaseManager,
  deriveProviderAccountRef,
  deriveProviderSessionBindingRef,
  isProviderSessionIdentity,
  PROVIDER_SESSION_BLOCKING_OUTCOMES,
  PROVIDER_SESSION_OUTCOME_DISPOSITION,
  ProviderSessionLease,
  ProviderSessionLeaseLostError,
  ProviderSessionOutcomeError,
  providerSessionOutcomeForError,
  type ProviderSessionIdentity,
  type ProviderSessionLeaseLogEvent,
  type ProviderSessionLeasePolicy,
  type ProviderSessionLeaseStore,
} from "./providerSessionLease";
import { createProviderSessionLeaseMemoryStore } from "./providerSessionLeaseMemoryStore";
import { VendorAutomationError } from "./types";

// Synthetic material only. These strings stand in for things that must never leak.
const NAMESPACE_KEY = new Uint8Array(32).fill(7);
const RAW_ACCOUNT = "buyer.synthetic@example.test";
const RAW_COOKIE = "sessionid=synthetic-cookie-value-462";
const RAW_PROFILE_PATH = "/var/lib/overdrafter/profiles/xometry/buyer.synthetic";
const OPERATOR = { actorRef: "ops-oncall-1", reasonRef: "OVD-462-runbook" };

function identityFor(
  provider = "xometry",
  environment: ProviderSessionIdentity["environment"] = "test",
  account = RAW_ACCOUNT,
  slot = "primary",
): ProviderSessionIdentity {
  const accountRef = deriveProviderAccountRef(NAMESPACE_KEY, provider, account);
  return {
    provider,
    accountRef,
    environment,
    sessionBindingRef: deriveProviderSessionBindingRef(NAMESPACE_KEY, { provider, accountRef, environment }, slot),
  };
}

const POLICY: Partial<ProviderSessionLeasePolicy> = {
  ttlSeconds: 30,
  maxRenewals: 5,
  maxDurationSeconds: 600,
  safetyMarginMs: 5_000,
  heartbeatIntervalMs: 10_000,
};

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `46200000-0000-4000-8000-${String(tokenCounter).padStart(12, "0")}`;
}

function setup(overrides: { policy?: Partial<ProviderSessionLeasePolicy>; store?: ProviderSessionLeaseStore; now?: () => number } = {}) {
  const clock = fakeClock();
  const now = overrides.now ?? clock.now;
  const memory = createProviderSessionLeaseMemoryStore({ now });
  const logs: ProviderSessionLeaseLogEvent[] = [];
  const store = overrides.store ?? memory;
  const manager = createProviderSessionLeaseManager({
    store,
    policy: { ...POLICY, ...overrides.policy },
    now,
    log: (event) => logs.push(event),
    holderToken: nextToken,
  });
  return { clock, memory, manager, logs };
}

async function mustAcquire(manager: ReturnType<typeof setup>["manager"], identity: ProviderSessionIdentity, taskRef: string) {
  const result = await manager.acquire({ identity, taskRef });
  if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
  return result.lease;
}

function spyStore(inner: ProviderSessionLeaseStore) {
  const calls: Array<{ method: string; identity: ProviderSessionIdentity }> = [];
  const wrap = <K extends keyof ProviderSessionLeaseStore>(method: K) =>
    (async (request: Parameters<ProviderSessionLeaseStore[K]>[0]) => {
      calls.push({ method, identity: { ...request.identity } });
      return (inner[method] as (r: typeof request) => Promise<unknown>)(request);
    }) as ProviderSessionLeaseStore[K];
  const store: ProviderSessionLeaseStore = {
    acquire: wrap("acquire"),
    renew: wrap("renew"),
    release: wrap("release"),
    reportOutcome: wrap("reportOutcome"),
  };
  return { store, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AC1: exactly one task holds a provider/account/environment binding", () => {
  it("grants exactly one of many concurrent contenders", async () => {
    const { manager, memory } = setup();
    const identity = identityFor();
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => manager.acquire({ identity, taskRef: `task-${i}` })),
    );
    expect(results.filter((r) => r.kind === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "contended")).toHaveLength(99);
    expect(memory.rows().filter((row) => row.state === "active")).toHaveLength(1);
  });

  it("grants the next owner a strictly higher generation only after release", async () => {
    const { manager } = setup();
    const identity = identityFor();
    const first = await mustAcquire(manager, identity, "task-a");
    expect((await manager.acquire({ identity, taskRef: "task-b" })).kind).toBe("contended");
    await first.release();
    const second = await mustAcquire(manager, identity, "task-b");
    expect(second.generation).toBe(first.generation + 1);
  });

  it("keeps different bindings for one account in another slot exclusive at the account level", async () => {
    const { manager } = setup();
    await mustAcquire(manager, identityFor("xometry", "test", RAW_ACCOUNT, "primary"), "task-a");
    const other = await manager.acquire({ identity: identityFor("xometry", "test", RAW_ACCOUNT, "secondary"), taskRef: "task-b" });
    expect(other.kind).toBe("contended");
  });
});

describe("AC2: cross-provider/account/environment/task/generation/expired reuse is rejected", () => {
  it("adopts the permit's reserved lease:<permit id> identifier as task ownership", async () => {
    const { manager } = setup();
    const identity = identityFor();
    const permitTask = "lease:46200000-0000-4000-8000-00000000a001";
    const lease = await mustAcquire(manager, identity, permitTask);
    expect(lease.toJSON().taskRef).toBe(permitTask);
    expect((await manager.acquire({ identity, taskRef: "lease:46200000-0000-4000-8000-00000000a002" })).kind).toBe("contended");
  });

  it("rejects a session binding reused under another provider, account or environment", async () => {
    const { manager } = setup();
    const identity = identityFor();
    await mustAcquire(manager, identity, "task-a");
    const otherAccountRef = deriveProviderAccountRef(NAMESPACE_KEY, "xometry", "someone-else");
    for (const crossed of [
      { ...identity, provider: "fictiv" },
      { ...identity, accountRef: otherAccountRef },
      { ...identity, environment: "production" as const },
    ]) {
      expect(await manager.acquire({ identity: crossed, taskRef: "task-b" })).toEqual({ kind: "rejected", reason: "binding_mismatch" });
    }
  });

  it("isolates providers and environments from each other", async () => {
    const { manager } = setup();
    const a = await mustAcquire(manager, identityFor("xometry", "test"), "task-a");
    const b = await mustAcquire(manager, identityFor("xometry", "production"), "task-b");
    const c = await mustAcquire(manager, identityFor("fictiv", "test"), "task-c");
    expect([a.generation, b.generation, c.generation]).toEqual([1, 1, 1]);
    expect(identityFor("xometry", "test").sessionBindingRef).not.toBe(identityFor("fictiv", "test").sessionBindingRef);
    expect(identityFor("xometry", "test").sessionBindingRef).not.toBe(identityFor("xometry", "production").sessionBindingRef);
  });

  it("rejects every wrong-owner mutation without changing the owner's lease", async () => {
    const { manager, memory } = setup();
    const identity = identityFor();
    const lease = await mustAcquire(manager, identity, "task-a");
    const owner = { identity, taskRef: "task-a", holderToken: `46200000-0000-4000-8000-${String(tokenCounter).padStart(12, "0")}`, generation: lease.generation };
    const wrong = [
      { ...owner, taskRef: "task-b" },
      { ...owner, holderToken: "46200000-0000-4000-8000-999999999999" },
      { ...owner, generation: owner.generation + 1 },
      { ...owner, generation: owner.generation - 1 },
      { ...owner, identity: { ...identity, provider: "fictiv" } },
      { ...owner, identity: { ...identity, environment: "production" as const } },
      { ...owner, identity: { ...identity, sessionBindingRef: identityFor("xometry", "test", RAW_ACCOUNT, "other").sessionBindingRef } },
    ];
    for (const request of wrong) {
      expect(await memory.renew(request)).toEqual({ status: "rejected", reason: "not_owner" });
      expect(await memory.release(request)).toEqual({ status: "rejected", reason: "not_owner" });
      expect(await memory.reportOutcome({ ...request, outcome: "login_required" })).toEqual({ status: "rejected", reason: "not_owner" });
    }
    expect(await memory.renew(owner)).toMatchObject({ status: "renewed" });
    expect(lease.isHeld()).toBe(true);
  });

  it("rejects reuse of an expired lease", async () => {
    const { manager, clock } = setup();
    const identity = identityFor();
    const lease = await mustAcquire(manager, identity, "task-a");
    clock.advance(30_000);
    expect(() => lease.assertHeld()).toThrow(ProviderSessionLeaseLostError);
    expect(await lease.renew()).toEqual({ kind: "lost", outcome: "lease_lost" });
  });

  it("rejects non-opaque or over-specified identities before reaching the store", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const { store, calls } = spyStore(memory);
    const { manager } = setup({ store });
    const valid = identityFor();
    const invalid: unknown[] = [
      { ...valid, accountRef: RAW_ACCOUNT },
      { ...valid, sessionBindingRef: RAW_PROFILE_PATH },
      { ...valid, sessionBindingRef: "default" },
      { ...valid, provider: "generic" + "!" },
      { ...valid, environment: "prod" },
      { ...valid, storageState: { cookies: [RAW_COOKIE] } },
      { provider: valid.provider, environment: valid.environment, sessionBindingRef: valid.sessionBindingRef },
      null,
    ];
    for (const identity of invalid) {
      expect(await manager.acquire({ identity: identity as ProviderSessionIdentity, taskRef: "task-a" }))
        .toEqual({ kind: "rejected", reason: "invalid_identity" });
    }
    expect(await manager.acquire({ identity: valid, taskRef: "has/slash" })).toEqual({ kind: "rejected", reason: "invalid_identity" });
    expect(calls).toHaveLength(0);
    expect(isProviderSessionIdentity(valid)).toBe(true);
  });
});

describe("AC3: idempotent acquire/release for the exact owner; bounded non-owning contention", () => {
  it("returns the same generation when the exact owner re-acquires", async () => {
    const clock = fakeClock();
    const memory = createProviderSessionLeaseMemoryStore({ now: clock.now });
    const request = { identity: identityFor(), taskRef: "task-a", holderToken: nextToken(), ttlSeconds: 30, maxRenewals: 2, maxDurationSeconds: 120 };
    const first = await memory.acquire(request);
    const again = await memory.acquire(request);
    expect(first).toMatchObject({ status: "acquired", generation: 1, idempotent: false });
    expect(again).toMatchObject({ status: "acquired", generation: 1, idempotent: true });
    expect(memory.rows()).toHaveLength(1);
  });

  it("recovers a lost acquire response without creating a second owner", async () => {
    const clock = fakeClock();
    const memory = createProviderSessionLeaseMemoryStore({ now: clock.now });
    let dropNextResponse = true;
    const flaky: ProviderSessionLeaseStore = {
      ...memory,
      acquire: async (request) => {
        const response = await memory.acquire(request);
        if (dropNextResponse) {
          dropNextResponse = false;
          throw new Error("network dropped after commit");
        }
        return response;
      },
    };
    const { manager } = setup({ store: flaky, now: clock.now });
    const lease = await mustAcquire(manager, identityFor(), "task-a");
    expect(lease.generation).toBe(1);
    expect(memory.rows().filter((row) => row.state === "active")).toHaveLength(1);
  });

  it("returns unavailable after the bounded attempt budget when the store is down", async () => {
    let attempts = 0;
    const down: ProviderSessionLeaseStore = {
      acquire: async () => { attempts += 1; throw new Error("down"); },
      renew: async () => { throw new Error("down"); },
      release: async () => { throw new Error("down"); },
      reportOutcome: async () => { throw new Error("down"); },
    };
    const { manager } = setup({ store: down, policy: { acquireAttempts: 2 } });
    expect(await manager.acquire({ identity: identityFor(), taskRef: "task-a" })).toEqual({ kind: "unavailable" });
    expect(attempts).toBe(2);
  });

  it("makes release idempotent and harmless to later owners", async () => {
    const { manager, memory } = setup();
    const identity = identityFor();
    const first = await mustAcquire(manager, identity, "task-a");
    expect(await first.release()).toEqual({ kind: "released" });
    expect(await first.release()).toEqual({ kind: "released" });
    const second = await mustAcquire(manager, identity, "task-b");
    expect(await first.release()).toEqual({ kind: "released" });
    expect(second.isHeld()).toBe(true);
    expect(memory.rows().map((row) => row.state)).toEqual(["released", "active"]);
  });

  it("gives contenders a bounded retry hint and no owner details", async () => {
    const { manager, clock } = setup();
    const identity = identityFor();
    await mustAcquire(manager, identity, "task-a");
    clock.advance(29_999);
    const nearExpiry = await manager.acquire({ identity, taskRef: "task-b" });
    expect(nearExpiry).toEqual({ kind: "contended", retryAfterMs: 1 });
    const result = await manager.acquire({ identity, taskRef: "task-c" });
    expect(Object.keys(result).sort()).toEqual(["kind", "retryAfterMs"]);
  });

  it("clamps a misbehaving store's retry hint to the ttl", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const store: ProviderSessionLeaseStore = { ...memory, acquire: async () => ({ status: "contended", retryAfterMs: 10_000_000 }) };
    const { manager } = setup({ store });
    expect(await manager.acquire({ identity: identityFor(), taskRef: "task-a" })).toEqual({ kind: "contended", retryAfterMs: 30_000 });
  });
});

describe("AC4: renewal is finite and lease loss stops execution without fallback", () => {
  it("ends the lease once the renewal budget is exhausted and stops calling the store", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const { store, calls } = spyStore(memory);
    const { manager } = setup({ store, policy: { maxRenewals: 2 } });
    const lease = await mustAcquire(manager, identityFor(), "task-a");
    expect(await lease.renew()).toEqual({ kind: "renewed", renewalsRemaining: 1 });
    expect(await lease.renew()).toEqual({ kind: "renewed", renewalsRemaining: 0 });
    expect(await lease.renew()).toEqual({ kind: "lost", outcome: "lease_lost" });
    const renewCalls = calls.filter((c) => c.method === "renew").length;
    expect(await lease.renew()).toEqual({ kind: "lost", outcome: "lease_lost" });
    expect(calls.filter((c) => c.method === "renew")).toHaveLength(renewCalls);
    expect(() => lease.assertHeld()).toThrow(ProviderSessionLeaseLostError);
  });

  it("enforces the hard lifetime cap even with renewals left", async () => {
    const { manager, clock } = setup({ policy: { ttlSeconds: 30, maxRenewals: 100, maxDurationSeconds: 60 } });
    const lease = await mustAcquire(manager, identityFor(), "task-a");
    clock.advance(20_000);
    expect((await lease.renew()).kind).toBe("renewed");
    clock.advance(20_000);
    expect((await lease.renew()).kind).toBe("renewed");
    clock.advance(20_000);
    expect(await lease.renew()).toEqual({ kind: "lost", outcome: "lease_lost" });
  });

  it("aborts the operation on lease loss and never tries another session", async () => {
    vi.useFakeTimers({ now: 0 });
    const memory = createProviderSessionLeaseMemoryStore({ now: () => Date.now() });
    const { store, calls } = spyStore(memory);
    const manager = createProviderSessionLeaseManager({ store, policy: POLICY, log: () => undefined, holderToken: nextToken });
    const identity = identityFor();
    let actions = 0;
    const run = manager.runWithLease({ identity, taskRef: "task-a" }, async ({ assertHeld, signal }) => {
      for (;;) {
        assertHeld();
        actions += 1;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await memory.revokeBinding(identity, OPERATOR);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await run;
    expect(result).toEqual({ kind: "lease_lost", outcome: "owner_revoked" });
    const actionsAtLoss = actions;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions).toBe(actionsAtLoss);
    expect(actions).toBeLessThanOrEqual(21);
    expect(calls.every((call) => JSON.stringify(call.identity) === JSON.stringify(identity))).toBe(true);
    expect(calls.filter((call) => call.method === "acquire")).toHaveLength(1);
  });

  it("stops at the local deadline, before the server expiry, when renewals cannot be confirmed", async () => {
    vi.useFakeTimers({ now: 0 });
    const memory = createProviderSessionLeaseMemoryStore({ now: () => Date.now() });
    const store: ProviderSessionLeaseStore = { ...memory, renew: async () => { throw new Error("store unreachable"); } };
    const manager = createProviderSessionLeaseManager({ store, policy: POLICY, log: () => undefined, holderToken: nextToken });
    let stoppedAt = -1;
    const run = manager.runWithLease({ identity: identityFor(), taskRef: "task-a" }, async ({ signal, assertHeld }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      stoppedAt = Date.now();
      assertHeld();
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await run).toEqual({ kind: "lease_lost", outcome: "lease_lost" });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThanOrEqual(30_000 - 5_000);
  });

  it("does not run the operation or fall back when the binding is contended", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const { store, calls } = spyStore(memory);
    const { manager } = setup({ store });
    const identity = identityFor();
    await mustAcquire(manager, identity, "task-a");
    const operation = vi.fn(async () => "ran");
    const result = await manager.runWithLease({ identity, taskRef: "task-b" }, operation);
    expect(result.kind).toBe("contended");
    expect(operation).not.toHaveBeenCalled();
    expect(calls.every((call) => JSON.stringify(call.identity) === JSON.stringify(identity))).toBe(true);
  });

  it("completes and releases when the lease stays held", async () => {
    const { manager, memory } = setup();
    const result = await manager.runWithLease({ identity: identityFor(), taskRef: "task-a" }, async ({ assertHeld }) => {
      assertHeld();
      return 42;
    });
    expect(result).toEqual({ kind: "completed", value: 42 });
    expect(memory.rows().map((row) => row.state)).toEqual(["released"]);
  });

  it("releases and rethrows ordinary operation failures", async () => {
    const { manager, memory } = setup();
    await expect(manager.runWithLease({ identity: identityFor(), taskRef: "task-a" }, async () => {
      throw new Error("upload failed");
    })).rejects.toThrow("upload failed");
    expect(memory.rows().map((row) => row.state)).toEqual(["released"]);
  });
});

describe("AC5: session failures map to bounded terminal/manual-follow-up outcomes", () => {
  it("defines a closed disposition for every outcome", () => {
    expect(Object.keys(PROVIDER_SESSION_OUTCOME_DISPOSITION).sort()).toEqual(
      [...PROVIDER_SESSION_BLOCKING_OUTCOMES, "lease_lost"].sort(),
    );
    for (const outcome of PROVIDER_SESSION_BLOCKING_OUTCOMES) {
      expect(PROVIDER_SESSION_OUTCOME_DISPOSITION[outcome]).toEqual({ disposition: "manual_follow_up", blocksBinding: true });
    }
    expect(PROVIDER_SESSION_OUTCOME_DISPOSITION.lease_lost).toEqual({ disposition: "terminal", blocksBinding: false });
  });

  it.each(["missing_session", "login_required", "challenge_required", "corrupt_state"] as const)(
    "%s blocks the binding until an operator clears it",
    async (outcome) => {
      const { manager, memory } = setup();
      const identity = identityFor();
      const result = await manager.runWithLease({ identity, taskRef: "task-a" }, async () => {
        throw new ProviderSessionOutcomeError(outcome);
      });
      expect(result).toEqual({ kind: "manual_follow_up", outcome });
      expect(await manager.acquire({ identity, taskRef: "task-b" })).toEqual({ kind: "manual_follow_up", outcome });
      const blocked = memory.rows().find((row) => row.state === "blocked")!;
      expect(await memory.clearBlock(identity, blocked.generation, OPERATOR)).toEqual({ status: "cleared" });
      expect(memory.rows().find((row) => row.generation === blocked.generation)?.clearedBy).toEqual(OPERATOR);
      expect((await manager.acquire({ identity, taskRef: "task-b" })).kind).toBe("acquired");
    },
  );

  it("maps existing adapter login and challenge failures", () => {
    expect(providerSessionOutcomeForError(new VendorAutomationError("x", "login_required"))).toBe("login_required");
    expect(providerSessionOutcomeForError(new VendorAutomationError("x", "captcha"))).toBe("challenge_required");
    expect(providerSessionOutcomeForError(new VendorAutomationError("x", "anti_detection_block"))).toBe("challenge_required");
    expect(providerSessionOutcomeForError(new VendorAutomationError("x", "upload_failure"))).toBeNull();
    expect(providerSessionOutcomeForError(new Error("login required"))).toBeNull();
  });

  it("reports a VendorAutomationError login failure as manual follow-up", async () => {
    const { manager } = setup();
    const result = await manager.runWithLease({ identity: identityFor(), taskRef: "task-a" }, async () => {
      throw new VendorAutomationError("Sign in to continue", "login_required");
    });
    expect(result).toEqual({ kind: "manual_follow_up", outcome: "login_required" });
  });

  it("surfaces operator revocation as owner_revoked and blocks future grants", async () => {
    const { manager, memory } = setup();
    const identity = identityFor();
    const lease = await mustAcquire(manager, identity, "task-a");
    expect(await memory.revokeBinding(identity, OPERATOR)).toEqual({ status: "blocked", outcome: "owner_revoked", generation: 1 });
    expect(memory.rows()[0].revokedBy).toEqual(OPERATOR);
    expect(await lease.renew()).toEqual({ kind: "lost", outcome: "owner_revoked" });
    expect(() => lease.assertHeld()).toThrow(expect.objectContaining({ outcome: "owner_revoked" }));
    expect(await manager.acquire({ identity, taskRef: "task-b" })).toEqual({ kind: "manual_follow_up", outcome: "owner_revoked" });
  });

  it("requires opaque operator attribution and the holder's session binding to revoke", async () => {
    const { manager, memory } = setup();
    const identity = identityFor();
    const lease = await mustAcquire(manager, identity, "task-a");
    for (const audit of [{ actorRef: "", reasonRef: "OVD-462" }, { actorRef: "ops", reasonRef: "" },
      { actorRef: RAW_ACCOUNT, reasonRef: "OVD-462" }, { ...OPERATOR, extra: "x" }]) {
      expect(await memory.revokeBinding(identity, audit as typeof OPERATOR)).toEqual({ status: "rejected", reason: "invalid_actor" });
    }
    const otherSlot = identityFor("xometry", "test", RAW_ACCOUNT, "secondary");
    expect(await memory.revokeBinding(otherSlot, OPERATOR)).toEqual({ status: "rejected", reason: "binding_mismatch" });
    expect(await memory.revokeBinding(identityFor("fictiv"), OPERATOR)).toEqual(expect.objectContaining({ status: "blocked" }));
    const fictivSlot = identityFor("fictiv");
    expect(await memory.revokeBinding({ ...identity, sessionBindingRef: fictivSlot.sessionBindingRef }, OPERATOR))
      .toEqual({ status: "rejected", reason: "binding_mismatch" });
    expect((await lease.renew()).kind).toBe("renewed");
    expect(await memory.clearBlock(identity, 1, { actorRef: "ops", reasonRef: "" })).toEqual({ status: "rejected", reason: "invalid_actor" });
  });

  it("rejects an unknown outcome as invalid_outcome", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const identity = identityFor();
    const acquired = await memory.acquire({ identity, taskRef: "task-a", holderToken: nextToken(), ttlSeconds: 30, maxRenewals: 1, maxDurationSeconds: 60 });
    const holderToken = memory.rows()[0].holderToken!;
    expect(acquired.status).toBe("acquired");
    expect(await memory.reportOutcome({ identity, taskRef: "task-a", holderToken, generation: 1, outcome: "not_an_outcome" as never }))
      .toEqual({ status: "rejected", reason: "invalid_outcome" });
  });

  it("rejects a self-reported owner_revoked as invalid_outcome; only the operator may revoke", async () => {
    const memory = createProviderSessionLeaseMemoryStore();
    const identity = identityFor();
    await memory.acquire({ identity, taskRef: "task-a", holderToken: nextToken(), ttlSeconds: 30, maxRenewals: 1, maxDurationSeconds: 60 });
    const holderToken = memory.rows()[0].holderToken!;
    expect(await memory.reportOutcome({ identity, taskRef: "task-a", holderToken, generation: 1, outcome: "owner_revoked" as never }))
      .toEqual({ status: "rejected", reason: "invalid_outcome" });
    expect(memory.rows().map((row) => [row.state, row.outcome])).toEqual([["active", null]]);

    const { manager } = setup();
    const lease = await mustAcquire(manager, identityFor(), "task-b");
    await expect(lease.reportOutcome("owner_revoked" as never)).rejects.toThrow("Unknown provider session outcome.");
    expect(lease.isHeld()).toBe(true);
  });

  it("does not record an outcome after the lease was already lost", async () => {
    const { manager, clock, memory } = setup();
    const lease = await mustAcquire(manager, identityFor(), "task-a");
    clock.advance(31_000);
    expect(await lease.reportOutcome("login_required")).toEqual({ kind: "lost", outcome: "lease_lost", recorded: false });
    expect(memory.rows().some((row) => row.state === "blocked")).toBe(false);
    expect(lease.outcome).toBe("lease_lost");
  });
});

describe("AC6: credentials, cookies, storage state, account identifiers and profile contents never leak", () => {
  it("keeps references and holder tokens out of logs, permits, diagnostics and errors", async () => {
    const { manager, memory, logs, clock } = setup();
    const identity = identityFor();
    const lease = await mustAcquire(manager, identity, "task-a");
    await manager.acquire({ identity, taskRef: "task-b" });
    await lease.renew();
    await memory.revokeBinding(identity, OPERATOR);
    await lease.renew();
    let thrown: unknown;
    try {
      lease.assertHeld();
    } catch (error) {
      thrown = error;
    }
    await manager.acquire({ identity: { ...identity, storageState: { cookies: [RAW_COOKIE] } } as unknown as ProviderSessionIdentity, taskRef: "task-c" });
    clock.advance(1);
    const holderTokens = memory.rows().map((row) => row.holderToken).filter(Boolean) as string[];
    const surfaces = [
      JSON.stringify(logs),
      JSON.stringify(lease),
      JSON.stringify({ permit: lease.toJSON() }),
      inspect(lease, { depth: 10, showHidden: true }),
      String(thrown),
      JSON.stringify(thrown),
      Object.keys(lease).join(","),
    ];
    const forbidden = [RAW_ACCOUNT, RAW_COOKIE, RAW_PROFILE_PATH, identity.accountRef, identity.sessionBindingRef, ...holderTokens];
    for (const surface of surfaces) {
      for (const secret of forbidden) expect(surface).not.toContain(secret);
    }
    expect(lease.toJSON()).toEqual({
      schema: "provider-session-lease.v1",
      provider: "xometry",
      environment: "test",
      bindingTag: expect.stringMatching(/^[0-9a-f]{12}$/),
      generation: 1,
      taskRef: "task-a",
    });
    for (const event of logs) {
      expect(Object.keys(event).every((key) =>
        ["event", "provider", "environment", "bindingTag", "generation", "outcome", "reason", "retryAfterMs", "renewalsRemaining"].includes(key))).toBe(true);
    }
  });

  it("derives opaque references that do not contain the account material", () => {
    const accountRef = deriveProviderAccountRef(NAMESPACE_KEY, "xometry", RAW_ACCOUNT);
    expect(accountRef).toMatch(/^acct_[0-9a-f]{32}$/);
    expect(accountRef).not.toContain("buyer");
    expect(deriveProviderAccountRef(NAMESPACE_KEY, "fictiv", RAW_ACCOUNT)).not.toBe(accountRef);
    expect(() => deriveProviderAccountRef(new Uint8Array(8), "xometry", RAW_ACCOUNT)).toThrow(/at least 32 bytes/);
    try {
      deriveProviderAccountRef(NAMESPACE_KEY, "Not A Provider", RAW_ACCOUNT);
    } catch (error) {
      expect(String(error)).not.toContain(RAW_ACCOUNT);
    }
  });

  it("does not expose private lease state as enumerable properties", () => {
    expect(Object.keys(ProviderSessionLease.prototype)).toEqual([]);
  });
});

describe("AC7: crash/expiry recovery never grants two simultaneous owners", () => {
  it("recovers a crashed holder only after expiry and fences the stale holder by generation", async () => {
    const { manager, clock, memory } = setup();
    const identity = identityFor();
    const crashed = await mustAcquire(manager, identity, "task-a");
    clock.advance(29_000);
    expect((await manager.acquire({ identity, taskRef: "task-b" })).kind).toBe("contended");
    clock.advance(1_000);
    const successor = await mustAcquire(manager, identity, "task-b");
    expect(successor.generation).toBe(crashed.generation + 1);
    expect(crashed.isHeld()).toBe(false);
    expect(await crashed.renew()).toEqual({ kind: "lost", outcome: "lease_lost" });
    await crashed.release();
    expect(successor.isHeld()).toBe(true);
    expect(memory.rows().filter((row) => row.state === "active")).toHaveLength(1);
  });

  it("does not let a restarted task with a new holder token become a second owner", async () => {
    const { manager } = setup();
    const identity = identityFor();
    await mustAcquire(manager, identity, "task-a");
    expect((await manager.acquire({ identity, taskRef: "task-a" })).kind).toBe("contended");
  });

  it("never has two locally-held leases at any instant across random crashes and renewals", async () => {
    const { manager, clock, memory } = setup({ policy: { ttlSeconds: 10, maxRenewals: 3, maxDurationSeconds: 40, safetyMarginMs: 2_000, heartbeatIntervalMs: 3_000 } });
    const identity = identityFor();
    let seed = 462;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const handles: ProviderSessionLease[] = [];
    for (let step = 0; step < 2_000; step += 1) {
      clock.advance(Math.floor(random() * 1_500));
      const roll = random();
      if (roll < 0.3) {
        const result = await manager.acquire({ identity, taskRef: `task-${step}` });
        if (result.kind === "acquired") handles.push(result.lease);
      } else if (roll < 0.7) {
        const held = handles.filter((h) => h.isHeld());
        if (held.length > 0) await held[Math.floor(random() * held.length)].renew();
      } else if (roll < 0.8) {
        const held = handles.filter((h) => h.isHeld());
        if (held.length > 0) await held[0].release();
      }
      // roll >= 0.8: the holder silently crashes (does nothing).
      expect(handles.filter((h) => h.isHeld()).length).toBeLessThanOrEqual(1);
      expect(memory.rows().filter((row) => row.state === "active").length).toBeLessThanOrEqual(1);
    }
    const generations = handles.map((h) => h.generation);
    expect(generations).toEqual([...generations].sort((a, b) => a - b));
    expect(new Set(generations).size).toBe(generations.length);
    expect(handles.length).toBeGreaterThan(10);
  });
});

describe("policy bounds", () => {
  it.each([
    { ttlSeconds: 4 },
    { ttlSeconds: 301 },
    { maxRenewals: 721 },
    { maxDurationSeconds: 14_401 },
    { safetyMarginMs: 20_000 },
    { heartbeatIntervalMs: 30_000 },
    { acquireAttempts: 10 },
  ])("rejects out-of-bounds policy %o", (policy) => {
    expect(() => createProviderSessionLeaseManager({ store: createProviderSessionLeaseMemoryStore(), policy: { ...POLICY, ...policy } })).toThrow(
      /out of bounds/,
    );
  });
});
