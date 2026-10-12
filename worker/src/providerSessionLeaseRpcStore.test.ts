// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createProviderSessionLeaseManager,
  deriveProviderAccountRef,
  deriveProviderSessionBindingRef,
  type ProviderSessionIdentity,
} from "./providerSessionLease";
import { createProviderSessionLeaseMemoryStore } from "./providerSessionLeaseMemoryStore";
import {
  createProviderSessionLeaseOperatorRpcStore,
  createProviderSessionLeaseRpcStore,
  PROVIDER_SESSION_LEASE_OPERATOR_RPCS,
  PROVIDER_SESSION_LEASE_RPCS,
  ProviderSessionLeaseStoreError,
  type ProviderSessionLeaseRpcClient,
} from "./providerSessionLeaseRpcStore";

const KEY = new Uint8Array(32).fill(3);
const accountRef = deriveProviderAccountRef(KEY, "xometry", "synthetic-account");
const identity: ProviderSessionIdentity = {
  provider: "xometry",
  accountRef,
  environment: "test",
  sessionBindingRef: deriveProviderSessionBindingRef(KEY, { provider: "xometry", accountRef, environment: "test" }, "primary"),
};
const HOLDER = "46200000-0000-4000-8000-000000000001";
const owned = { identity, taskRef: "task-a", holderToken: HOLDER, generation: 1 };
const OPERATOR = { actorRef: "ops-oncall-1", reasonRef: "OVD-462-runbook" };

function fixedClient(data: unknown, error: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: ProviderSessionLeaseRpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return { data, error };
    },
  };
  return { client, calls };
}

const draft = readFileSync(new URL("../../docs/migration-drafts/ovd-462.sql", import.meta.url), "utf8");

describe("provider session lease RPC store", () => {
  it("calls only RPCs (and parameters) defined by the proposed migration", async () => {
    const { client, calls } = fixedClient({ status: "rejected", reason: "not_owner" });
    const store = createProviderSessionLeaseRpcStore(client);
    await store.renew(owned);
    await store.release(owned);
    await store.reportOutcome({ ...owned, outcome: "login_required" });
    const acquire = fixedClient({ status: "contended", retry_after_ms: 5 });
    await createProviderSessionLeaseRpcStore(acquire.client).acquire({ ...owned, ttlSeconds: 30, maxRenewals: 2, maxDurationSeconds: 60 });
    const revoke = fixedClient({ status: "rejected", reason: "binding_mismatch" });
    await createProviderSessionLeaseOperatorRpcStore(revoke.client).revokeBinding(identity, OPERATOR);
    const clear = fixedClient({ status: "rejected", reason: "not_blocked" });
    await createProviderSessionLeaseOperatorRpcStore(clear.client).clearBlock(identity, 3, OPERATOR);

    const all = [...calls, ...acquire.calls, ...revoke.calls, ...clear.calls];
    expect(new Set(all.map((c) => c.fn))).toEqual(
      new Set([...Object.values(PROVIDER_SESSION_LEASE_RPCS), ...Object.values(PROVIDER_SESSION_LEASE_OPERATOR_RPCS)]));
    for (const call of all) {
      const signature = new RegExp(`create function public\\.${call.fn}\\(([^)]*)\\)`).exec(draft);
      expect(signature, call.fn).not.toBeNull();
      const params = [...signature![1].matchAll(/(p_[a-z_]+)\s/g)].map((m) => m[1]).sort();
      expect(Object.keys(call.args).sort(), call.fn).toEqual(params);
    }
    expect(acquire.calls[0].args).toEqual({
      p_provider: "xometry",
      p_account_ref: identity.accountRef,
      p_environment: "test",
      p_session_binding_ref: identity.sessionBindingRef,
      p_task_ref: "task-a",
      p_holder_token: HOLDER,
      p_ttl_seconds: 30,
      p_max_renewals: 2,
      p_max_duration_seconds: 60,
    });
    expect(clear.calls[0].args).toEqual({
      p_provider: "xometry",
      p_account_ref: identity.accountRef,
      p_environment: "test",
      p_generation: 3,
      p_actor_ref: "ops-oncall-1",
      p_reason_ref: "OVD-462-runbook",
    });
  });

  it("keeps operator RPCs out of the worker store", () => {
    const { client } = fixedClient(null);
    const worker = createProviderSessionLeaseRpcStore(client);
    expect(Object.keys(worker).sort()).toEqual(["acquire", "release", "renew", "reportOutcome"]);
    expect(Object.keys(createProviderSessionLeaseOperatorRpcStore(client)).sort()).toEqual(["clearBlock", "revokeBinding"]);
    expect(Object.values(PROVIDER_SESSION_LEASE_RPCS)).not.toContain(PROVIDER_SESSION_LEASE_OPERATOR_RPCS.revokeBinding);
    expect(Object.values(PROVIDER_SESSION_LEASE_RPCS)).not.toContain(PROVIDER_SESSION_LEASE_OPERATOR_RPCS.clearBlock);
  });

  it("requires operator attribution before calling an operator RPC", async () => {
    const { client, calls } = fixedClient({ status: "cleared" });
    const operator = createProviderSessionLeaseOperatorRpcStore(client);
    expect(await operator.revokeBinding(identity, { actorRef: "", reasonRef: "OVD-462" })).toEqual({ status: "rejected", reason: "invalid_actor" });
    expect(await operator.clearBlock(identity, 1, { actorRef: "someone@example.com", reasonRef: "OVD-462" }))
      .toEqual({ status: "rejected", reason: "invalid_actor" });
    expect(calls).toHaveLength(0);
    expect(await createProviderSessionLeaseOperatorRpcStore(fixedClient({ status: "rejected", reason: "invalid_actor" }).client)
      .revokeBinding(identity, OPERATOR)).toEqual({ status: "rejected", reason: "invalid_actor" });
  });

  it.each([
    [{ status: "acquired", generation: 2, idempotent: false, expires_in_ms: 30_000, renewals_remaining: 4 },
      { status: "acquired", generation: 2, idempotent: false, expiresInMs: 30_000, renewalsRemaining: 4 }],
    [{ status: "contended", retry_after_ms: 1_200 }, { status: "contended", retryAfterMs: 1_200 }],
    [{ status: "manual_follow_up", outcome: "challenge_required" }, { status: "manual_follow_up", outcome: "challenge_required" }],
    [{ status: "rejected", reason: "binding_mismatch" }, { status: "rejected", reason: "binding_mismatch" }],
  ])("parses acquire response %o", async (data, expected) => {
    const store = createProviderSessionLeaseRpcStore(fixedClient(data).client);
    expect(await store.acquire({ ...owned, ttlSeconds: 30, maxRenewals: 4, maxDurationSeconds: 60 })).toEqual(expected);
  });

  it("parses renew, release and report responses", async () => {
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "renewed", expires_in_ms: 29_000, renewals_remaining: 1 }).client).renew(owned))
      .toEqual({ status: "renewed", expiresInMs: 29_000, renewalsRemaining: 1 });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "lost", reason: "blocked", outcome: "owner_revoked" }).client).renew(owned))
      .toEqual({ status: "lost", reason: "blocked", outcome: "owner_revoked" });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "lost", reason: "revoked", outcome: "owner_revoked" }).client).renew(owned))
      .toEqual({ status: "lost", reason: "revoked", outcome: "owner_revoked" });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "released", changed: false, final_state: "revoked" }).client).release(owned))
      .toEqual({ status: "released", changed: false, finalState: "revoked" });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "released", changed: false, final_state: "expired" }).client).release(owned))
      .toEqual({ status: "released", changed: false, finalState: "expired" });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "blocked", outcome: "corrupt_state", generation: 1 }).client)
      .reportOutcome({ ...owned, outcome: "corrupt_state" }))
      .toEqual({ status: "blocked", outcome: "corrupt_state", generation: 1 });
    expect(await createProviderSessionLeaseRpcStore(fixedClient({ status: "rejected", reason: "invalid_outcome" }).client)
      .reportOutcome({ ...owned, outcome: "corrupt_state" }))
      .toEqual({ status: "rejected", reason: "invalid_outcome" });
  });

  it.each([
    null,
    "acquired",
    { status: "acquired", generation: 0, idempotent: false, expires_in_ms: 1, renewals_remaining: 0 },
    { status: "acquired", generation: 1, idempotent: "no", expires_in_ms: 1, renewals_remaining: 0 },
    { status: "acquired", generation: 1, idempotent: false, expires_in_ms: 1, renewals_remaining: 0, account_ref: "leak" },
    { status: "contended", retry_after_ms: -1 },
    { status: "manual_follow_up", outcome: "retry_with_default_profile" },
    { status: "fallback", session: "default" },
  ])("fails closed on malformed acquire response %o", async (data) => {
    const store = createProviderSessionLeaseRpcStore(fixedClient(data).client);
    await expect(store.acquire({ ...owned, ttlSeconds: 30, maxRenewals: 4, maxDurationSeconds: 60 }))
      .rejects.toEqual(new ProviderSessionLeaseStoreError("malformed_response"));
  });

  it("replaces client errors with a fixed message that cannot echo arguments", async () => {
    const leaky = { message: `invalid input ${identity.accountRef}`, details: "cookie=synthetic" };
    const store = createProviderSessionLeaseRpcStore(fixedClient(null, leaky).client);
    const error = await store.renew(owned).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSessionLeaseStoreError);
    expect(JSON.stringify(error) + String(error)).not.toMatch(/acct_|cookie/);
    const throwing = createProviderSessionLeaseRpcStore({ rpc: async () => { throw new Error(`boom ${identity.accountRef}`); } });
    expect(String(await throwing.release(owned).catch((e: unknown) => e))).not.toContain("acct_");
  });

  it("drives the manager end to end through the RPC wire shape", async () => {
    // A fake PostgREST client that serves snake_case responses from the
    // in-memory store, so the manager runs over the exact RPC contract.
    const memory = createProviderSessionLeaseMemoryStore();
    const snake = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
    const client: ProviderSessionLeaseRpcClient = {
      rpc: async (fn, a) => {
        const id = { provider: a.p_provider, accountRef: a.p_account_ref, environment: a.p_environment, sessionBindingRef: a.p_session_binding_ref } as ProviderSessionIdentity;
        const own = { identity: id, taskRef: a.p_task_ref as string, holderToken: a.p_holder_token as string, generation: a.p_generation as number };
        const handlers: Record<string, () => Promise<Record<string, unknown>>> = {
          [PROVIDER_SESSION_LEASE_RPCS.acquire]: () => memory.acquire({ ...own, ttlSeconds: a.p_ttl_seconds as number, maxRenewals: a.p_max_renewals as number, maxDurationSeconds: a.p_max_duration_seconds as number }),
          [PROVIDER_SESSION_LEASE_RPCS.renew]: () => memory.renew(own),
          [PROVIDER_SESSION_LEASE_RPCS.release]: () => memory.release(own),
        };
        return { data: snake(await handlers[fn]()), error: null };
      },
    };
    const manager = createProviderSessionLeaseManager({ store: createProviderSessionLeaseRpcStore(client), log: () => undefined });
    const result = await manager.runWithLease({ identity, taskRef: "task-a" }, async ({ assertHeld, lease }) => {
      assertHeld();
      return lease.generation;
    });
    expect(result).toEqual({ kind: "completed", value: 1 });
    expect(memory.rows().map((row) => row.state)).toEqual(["released"]);
  });
});
