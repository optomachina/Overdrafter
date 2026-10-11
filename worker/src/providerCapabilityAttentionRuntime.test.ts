// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  updateCapabilityAttention, type CapabilityAttentionCommit, type CapabilityAttentionSnapshot,
  type CapabilityAttentionStore,
} from "./providerCapabilityAttentionRuntime.js";
import type { CapabilityAttentionEvidence, CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareCapabilityCanaryPlan } from "./providerCapabilityCanary.js";
import { recordCapabilityCanaryWithAttention } from "./providerCapabilityCanaryLedger.js";

const metadata: CapabilityAttentionMetadata = { provider: "xometry", route: "quote_home", surface: "account_quote_modal",
  surfaceRevision: "surface.v1", policyRevision: "policy.v1", adapterRevision: "adapter.v1", workerBuild: null };
const evidence: CapabilityAttentionEvidence = {
  decision: { contractVersion: "provider-upload-capability.v1", classification: "matches_policy",
    allowedExtensions: ["step", "stp"], reportedAddedExtensions: [], reportedRemovedExtensions: [], evidenceRefs: [], normalizedObservedMimeTypes: [] },
  observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T12:10:00.000Z", observationRevision: 1,
};
const input = { metadata, reviewedMetadata: [metadata], evidence, now: "2026-10-02T12:01:00.000Z" };
const changed: CapabilityAttentionEvidence = { ...evidence, decision: { ...evidence.decision,
  classification: "format_added", reportedAddedExtensions: ["pdf"] } };
afterEach(() => vi.useRealTimers());

/** An atomic in-memory TEST MODEL. No durability or production adapter claimed. */
function atomicFixture() {
  const snapshots = new Map<string, CapabilityAttentionSnapshot>();
  const outbox = new Map<string, NonNullable<CapabilityAttentionCommit["intent"]>>();
  const commits: CapabilityAttentionCommit[] = [];
  let serial = 0;
  const load = vi.fn(async (scope: string) => structuredClone(snapshots.get(scope) ?? null));
  const compareAndSwap = vi.fn(async (commit: CapabilityAttentionCommit) => {
    if ((snapshots.get(commit.scopeKey)?.version ?? null) !== commit.expectedVersion) return "conflict" as const;
    snapshots.set(commit.scopeKey, { version: `version:${++serial}`, cursor: structuredClone(commit.cursor), evidence: structuredClone(commit.evidence) });
    commits.push(structuredClone(commit));
    if (commit.intent) outbox.set(commit.intent.key, structuredClone(commit.intent));
    return "committed" as const;
  });
  const store: CapabilityAttentionStore = { load, compareAndSwap };
  return { store, load, compareAndSwap, snapshots, outbox, commits };
}

describe("required atomic attention-store integration", () => {
  it("is explicitly unavailable without a durable backend, with no fallback or notification", async () => {
    expect(await updateCapabilityAttention(null, input)).toEqual({ state: "dependency_unavailable" });
  });

  it("persists cursor, item, retained evidence and unique intent in one CAS", async () => {
    const f = atomicFixture();
    const result = await updateCapabilityAttention(f.store, { ...input, evidence: changed });
    expect(result).toMatchObject({ state: "committed", generation: 1, transitionStored: true, item: { severity: "attention" } });
    expect(f.commits).toHaveLength(1);
    expect(f.commits[0]).toMatchObject({ expectedVersion: null, cursor: { generation: 1 },
      evidence: { observationRevision: 1 }, intent: { generation: 1, kind: "attention" }, item: { category: "provider_upload_capability" } });
    expect(f.outbox.size).toBe(1);
    expect(result).not.toHaveProperty("intent"); // The runtime does not deliver.
  });

  it("crosses the persistence boundary on replay and deduplicates across runtime calls", async () => {
    const f = atomicFixture();
    await updateCapabilityAttention(f.store, { ...input, evidence: changed });
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: changed, now: "2026-10-02T12:02:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: false });
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.commits[1].expectedVersion).toBe("version:1");
    expect(f.outbox.size).toBe(1);
    const newer = { ...changed, observationRevision: 2, observedAt: "2026-10-02T12:02:00.000Z" };
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: newer, now: "2026-10-02T12:03:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: false });
    expect(f.outbox.size).toBe(1);
    expect(f.commits[2].cursor.lastObservationRevision).toBe(2);
  });

  it("stores stale transition without a new observation and suppresses repeated stale polls", async () => {
    const f = atomicFixture();
    expect(await updateCapabilityAttention(f.store, input)).toMatchObject({ state: "committed", generation: 0, transitionStored: false });
    const original = structuredClone(f.commits[0].evidence);
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: undefined, now: evidence.expiresAt }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: true, item: { reasonCode: "observation_stale" } });
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: undefined, now: "2026-10-02T12:11:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: false });
    expect(f.commits[2].evidence).toEqual(original);
    expect(f.commits[2].cursor.lastObservationRevision).toBe(1);
    expect(f.outbox.size).toBe(1);
  });

  it("retains recovery and recurrence generations", async () => {
    const f = atomicFixture();
    await updateCapabilityAttention(f.store, { ...input, evidence: changed });
    const healthy = { ...evidence, observationRevision: 2, observedAt: "2026-10-02T12:02:00.000Z" };
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: healthy, now: "2026-10-02T12:03:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 2, transitionStored: true });
    const again = { ...changed, observationRevision: 3, observedAt: "2026-10-02T12:04:00.000Z" };
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: again, now: "2026-10-02T12:05:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 3, transitionStored: true });
    expect([...f.outbox.values()].map((intent) => intent.kind)).toEqual(["attention", "recovery", "attention"]);
  });

  it("allows only one atomic winner on concurrent transition and never retries the conflict", async () => {
    const f = atomicFixture();
    const results = await Promise.all([
      updateCapabilityAttention(f.store, { ...input, evidence: changed }),
      updateCapabilityAttention(f.store, { ...input, evidence: changed }),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(["committed", "conflict"]);
    expect(f.compareAndSwap).toHaveBeenCalledTimes(2);
    expect(f.commits).toHaveLength(1);
    expect(f.outbox.size).toBe(1);
  });

  it("marks lost commit response uncertain, then suppresses already persisted intent on re-read", async () => {
    const f = atomicFixture();
    const commit = f.store.compareAndSwap;
    const loseReply: CapabilityAttentionStore = { load: f.load, compareAndSwap: async (...args) => {
      await commit(...args); throw Error("private reply loss");
    } };
    expect(await updateCapabilityAttention(loseReply, { ...input, evidence: changed }))
      .toEqual({ state: "uncertain", reasonCode: "store_commit_unknown" });
    expect(f.outbox.size).toBe(1);
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: changed }))
      .toMatchObject({ state: "committed", transitionStored: false, generation: 1 });
    expect(f.outbox.size).toBe(1);
  });

  it("rejects changed same-revision evidence and malformed evidence without advancing state", async () => {
    const f = atomicFixture();
    await updateCapabilityAttention(f.store, input);
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: changed }))
      .toEqual({ state: "rejected", reasonCode: "observation_replay" });
    expect(await updateCapabilityAttention(f.store, { ...input, evidence: { ...evidence, token: "private" } }))
      .toEqual({ state: "rejected", reasonCode: "source_malformed" });
    expect(f.commits).toHaveLength(1);
    expect(f.outbox.size).toBe(0);
  });

  it("never persists decision diagnostic/free text and bounds invalid context before store read", async () => {
    const f = atomicFixture();
    const verbose = { ...changed, decision: { ...changed.decision, reason: "private account details", diagnostic: { token: "secret" } } };
    expect((await updateCapabilityAttention(f.store, { ...input, evidence: verbose })).state).toBe("committed");
    expect(JSON.stringify(f.commits)).not.toMatch(/private account|secret|diagnostic/);
    const count = f.load.mock.calls.length;
    expect(await updateCapabilityAttention(f.store, { ...input, metadata: { ...metadata, provider: "unknown" } }))
      .toEqual({ state: "rejected", reasonCode: "invalid_context" });
    expect(f.load).toHaveBeenCalledTimes(count);
  });

  it("fails closed on store read errors and malformed snapshots without raw errors", async () => {
    const f = atomicFixture();
    f.load.mockRejectedValueOnce(Error("secret database URL"));
    expect(await updateCapabilityAttention(f.store, input)).toEqual({ state: "failed", reasonCode: "store_read_failed" });
    f.load.mockResolvedValueOnce({ version: "v1", cursor: null, evidence: null, raw: "private" } as never);
    expect(await updateCapabilityAttention(f.store, input)).toEqual({ state: "failed", reasonCode: "store_read_failed" });
    f.load.mockResolvedValueOnce({ version: "v1", cursor: null, evidence: null } as never);
    expect(await updateCapabilityAttention(f.store, input)).toEqual({ state: "failed", reasonCode: "store_read_failed" });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it("consumes the actual ledger bridge evidence, then persists one stale transition without another RPC", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(input.now));
    const context = { ...metadata, surfaceRevision: "xometry-account-quote-modal.v1", policyRevision: "xometry-controlled-beta-2026-08-17.v1" };
    const scope = { provider: "xometry" as const, route: context.route, surface: context.surface, revision: context.surfaceRevision };
    const envelope = { ...scope, extensions: ["step", "stp"], policyRevision: context.policyRevision, evidenceReference: "OVD-373" };
    const config = { enabled: false, scope, probeMode: "capability_inspection_no_upload", startAt: evidence.observedAt,
      intervalSeconds: 3600, windowCount: 1, timeoutSeconds: 60 };
    const plan = prepareCapabilityCanaryPlan(config, [envelope]);
    if (plan.state !== "prepared_plan") throw Error("fixture");
    const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: 1, error: null }) }));
    const f = atomicFixture();
    const recorded = await recordCapabilityCanaryWithAttention({ rpc } as unknown as SupabaseClient, {
      config, reviewed: [envelope], nowMs: Date.parse(input.now), claim: { windowKey: plan.plan.windows[0].idempotencyKey, observationRevision: 1 },
      observation: { ...scope, state: "fresh", extensions: ["step", "stp"], mimeTypes: [], acceptAttributePresent: true,
        observedAt: evidence.observedAt, expiresAt: evidence.expiresAt, observationRevision: 1, windowIndex: 0 },
      admission: { policy_present: true, provider_admitted: true, generically_dispatchable: false, provider: "xometry",
        admission_state: "controlled_beta_only", policy_revision: envelope.policyRevision, evidence_reference: envelope.evidenceReference,
        permission_basis: "existing_controlled_beta_path", supported_processes: ["cnc_milling"], accepted_file_extensions: ["step", "stp"],
        session_owner: "overdrafter_managed", reviewed_at: "2026-08-17T00:00:00.000Z", expires_at: null, reason_code: "controlled_beta_only" },
    }, { store: f.store, metadata: context, reviewedMetadata: [context], now: () => Date.parse(input.now) });
    expect(recorded.state).toBe("recorded");
    if (recorded.state !== "recorded") throw Error("fixture record");
    const poll = { metadata: context, reviewedMetadata: [context], now: input.now };
    expect(recorded.attention)
      .toMatchObject({ state: "committed", generation: 0, transitionStored: false });
    expect(await updateCapabilityAttention(f.store, { ...poll, now: evidence.expiresAt }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: true, item: { freshness: "stale" } });
    expect(await updateCapabilityAttention(f.store, { ...poll, now: "2026-10-02T12:11:00.000Z" }))
      .toMatchObject({ state: "committed", generation: 1, transitionStored: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(f.outbox.size).toBe(1);
  });

  it("bounds hung read and commit separately without interpreting cancellation as rollback", async () => {
    vi.useFakeTimers();
    const f = atomicFixture();
    f.load.mockImplementationOnce(() => new Promise(() => {}));
    const loading = updateCapabilityAttention(f.store, input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await loading).toEqual({ state: "failed", reasonCode: "store_read_failed" });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
    f.compareAndSwap.mockImplementationOnce(() => new Promise(() => {}));
    const committing = updateCapabilityAttention(f.store, input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await committing).toEqual({ state: "uncertain", reasonCode: "store_commit_unknown" });
    expect(f.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("performs no store calls when pre-aborted", async () => {
    const f = atomicFixture();
    expect(await updateCapabilityAttention(f.store, { ...input, signal: AbortSignal.abort() }))
      .toEqual({ state: "rejected", reasonCode: "aborted_before_store" });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });
});
