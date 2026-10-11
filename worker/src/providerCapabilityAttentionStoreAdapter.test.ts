// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { projectCapabilityAttention, type CapabilityAttentionEvidence, type CapabilityAttentionMetadata } from "./providerCapabilityAttention.js";
import { updateCapabilityAttention, type CapabilityAttentionCommit } from "./providerCapabilityAttentionRuntime.js";
import { createCapabilityAttentionStoreAdapter } from "./providerCapabilityAttentionStoreAdapter.js";

const metadata: CapabilityAttentionMetadata = {
  provider: "xometry", route: "quote_home", surface: "account_quote_modal", surfaceRevision: "surface.v1",
  policyRevision: "policy.v1", adapterRevision: "adapter.v1", workerBuild: null,
};
const evidence: CapabilityAttentionEvidence = {
  decision: { contractVersion: "provider-upload-capability.v1", classification: "format_added", allowedExtensions: ["step"],
    reportedAddedExtensions: ["pdf"], reportedRemovedExtensions: [], evidenceRefs: [], normalizedObservedMimeTypes: [] },
  observedAt: "2026-10-02T12:00:00.000Z", expiresAt: "2026-10-02T12:10:00.000Z", observationRevision: 1,
};
const now = "2026-10-02T12:01:00.000Z";
const evaluationKey = "00000000-0000-4000-8000-000000000591";
const signal = () => new AbortController().signal;
function fixture() {
  const projection = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence, previous: null, now });
  if (projection.state !== "projected") throw Error("Synthetic projection failed");
  const commit: CapabilityAttentionCommit = {
    scopeKey: projection.cursor.scopeKey, expectedVersion: null, cursor: projection.cursor, item: projection.item,
    evidence: structuredClone(evidence), intent: projection.intent,
  };
  return { projection, commit };
}
function setup(readValue: unknown = null, commitValue: unknown = { status: "conflict" }) {
  const read = vi.fn(async (_request: unknown, _signal: AbortSignal) => readValue);
  const commit = vi.fn(async (_request: unknown, _signal: AbortSignal) => commitValue);
  const onPrepared = vi.fn(async (_prepared: unknown, _signal: AbortSignal): Promise<void> => undefined);
  const issueEvaluationKey = vi.fn(() => evaluationKey);
  const adapter = createCapabilityAttentionStoreAdapter({
    transport: { read, commit }, reviewedMetadata: [metadata], onPrepared, issueEvaluationKey,
  });
  return { adapter, read, commit, onPrepared, issueEvaluationKey };
}

describe("injected attention-store adapter", () => {
  it("maps only explicit null to absent without writing", async () => {
    const f = setup();
    const scope = fixture().commit.scopeKey;
    expect(await f.adapter.load(scope, signal())).toBeNull();
    expect(f.read.mock.calls[0][0]).toEqual({ p_scope_key: scope });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, [], "null"])("rejects malformed read result %j without a write", async (value) => {
    const f = setup();
    f.read.mockResolvedValue(value);
    await expect(f.adapter.load(fixture().commit.scopeKey, signal())).rejects.toThrow("attention_store_invalid_response");
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("retains a frozen UUID and exact immutable payload before explicit dispatch", async () => {
    const f = setup();
    const { commit } = fixture();
    const prepared = f.adapter.prepareCommit(commit, evaluationKey);
    expect(prepared.p_input.expectedVersion).toBe(0);
    expect(prepared.p_input.evaluationKey).toBe(evaluationKey);
    expect(Object.isFrozen(prepared.p_input.item.metadata)).toBe(true);
    commit.item.summary = "private caller mutation";
    expect(prepared.p_input.item.summary).not.toBe(commit.item.summary);
    expect(f.commit).not.toHaveBeenCalled();
    expect(await f.adapter.commitPrepared(prepared, signal())).toBe("conflict");
    expect(f.onPrepared.mock.invocationCallOrder[0]).toBeLessThan(f.commit.mock.invocationCallOrder[0]);
    expect(f.commit.mock.calls[0][0]).toEqual(prepared);
  });
  it("does not dispatch when durable retention fails", async () => {
    const f = setup();
    f.onPrepared.mockRejectedValue(Error("raw journal secret"));
    await expect(f.adapter.compareAndSwap(fixture().commit, signal())).rejects.toThrow("attention_store_commit_unknown");
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("does not blindly retry a lost commit reply and retains an exact replay handle", async () => {
    const f = setup();
    f.commit.mockRejectedValueOnce(Error("raw database connection secret"));
    const prepared = f.adapter.prepareCommit(fixture().commit, evaluationKey);
    await expect(f.adapter.commitPrepared(prepared, signal())).rejects.toThrow("attention_store_commit_unknown");
    expect(f.commit).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(prepared);
    expect(await f.adapter.commitPrepared(JSON.parse(serialized), signal())).toBe("conflict");
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect(f.commit.mock.calls[0][0]).toEqual(f.commit.mock.calls[1][0]);
    expect(f.issueEvaluationKey).not.toHaveBeenCalled();
  });
  it("keeps underlying runtime conflict finite without retry or delivery", async () => {
    const f = setup();
    expect(await updateCapabilityAttention(f.adapter, { metadata, reviewedMetadata: [metadata], evidence, now }))
      .toEqual({ state: "conflict" });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});

function present(version: unknown = 1) {
  const { projection } = fixture();
  return { version, cursor: projection.cursor, item: projection.item, evidence: structuredClone(evidence) };
}

describe("canonical numeric wire contract", () => {
  it.each([1, 2, Number.MAX_SAFE_INTEGER])("loads valid wire version %s as canonical old-store text", async (version) => {
    const f = setup(present(version));
    const snapshot = await f.adapter.load(fixture().commit.scopeKey, signal());
    expect(snapshot).toEqual({ version: String(version), cursor: fixture().projection.cursor, evidence });
    expect(snapshot).not.toHaveProperty("item");
  });
  it.each([0, -1, 1.5, "1", null, true, {}, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects noncanonical present wire version %j", async (version) => {
      const f = setup(present(version));
      await expect(f.adapter.load(fixture().commit.scopeKey, signal())).rejects.toThrow("attention_store_invalid_response");
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
  it.each(["1", "2", String(Number.MAX_SAFE_INTEGER - 1)])("maps canonical expected version %s with exact increment receipt", async (version) => {
    const f = setup(null, { status: "committed", version: Number(version) + 1 });
    const commit = { ...fixture().commit, expectedVersion: version };
    expect(await f.adapter.compareAndSwap(commit, signal())).toBe("committed");
    expect((f.commit.mock.calls[0][0] as {p_input: {expectedVersion: number}}).p_input.expectedVersion).toBe(Number(version));
  });
  it("commits absent expectation as zero with receipt version one", async () => {
    const f = setup(null, { status: "committed", version: 1 });
    expect(await f.adapter.compareAndSwap(fixture().commit, signal())).toBe("committed");
    expect((f.commit.mock.calls[0][0] as {p_input: {expectedVersion: number}}).p_input.expectedVersion).toBe(0);
  });
  it.each(["0", "01", "+1", " 1", "1 ", "1.0", "1e0", "-1", "9007199254740991", "9007199254740992", 1, false, undefined])(
    "rejects noncanonical or nonadvanceable old expected version %j before retention", async (version) => {
      const f = setup();
      const commit = { ...fixture().commit, expectedVersion: version } as unknown as CapabilityAttentionCommit;
      await expect(f.adapter.compareAndSwap(commit, signal())).rejects.toThrow("attention_store_commit_unknown");
      expect(f.onPrepared).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();
    },
  );
  it.each([
    null, undefined, "committed", {}, { status: "conflict", version: 1 },
    { status: "committed" }, { status: "committed", version: "1" }, { status: "committed", version: null },
    { status: "committed", version: 0 }, { status: "committed", version: 1.5 }, { status: "committed", version: 2 },
    { status: "committed", version: Number.MAX_SAFE_INTEGER + 1 }, { status: "committed", version: 1, secret: "private" },
  ])("fails closed on malformed commit receipt %j without retry", async (receipt) => {
    const f = setup();
    f.commit.mockResolvedValue(receipt);
    await expect(f.adapter.compareAndSwap(fixture().commit, signal())).rejects.toThrow("attention_store_commit_unknown");
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});

describe("projection integrity and safe operation boundaries", () => {
  it.each([
    (row: ReturnType<typeof present>) => ({ ...row, extra: "private" }),
    (row: ReturnType<typeof present>) => ({ ...row, item: null }),
    (row: ReturnType<typeof present>) => ({ ...row, evidence: null }),
    (row: ReturnType<typeof present>) => ({ ...row, item: { ...row.item, summary: "Bearer private-secret" } }),
    (row: ReturnType<typeof present>) => ({ ...row, cursor: { ...row.cursor, generation: -1 } }),
    (row: ReturnType<typeof present>) => ({ ...row, item: { ...row.item, metadata: { ...metadata, workerBuild: "unreviewed" } } }),
    (row: ReturnType<typeof present>) => ({ ...row, evidence: { ...evidence, decision: { ...evidence.decision, diagnostic: "private" } } }),
    (row: ReturnType<typeof present>) => ({ ...row, evidence: { ...evidence, observationRevision: 2 } }),
  ])("rejects malformed, self-reviewed, raw or inconsistent stored projection", async (change) => {
    const f = setup(change(present()));
    await expect(f.adapter.load(fixture().commit.scopeKey, signal())).rejects.toThrow("attention_store_invalid_response");
  });
  it("rejects wrong-scope reads and accessors without exposing raw errors", async () => {
    const f = setup(present());
    await expect(f.adapter.load("a".repeat(64), signal())).rejects.toThrow("attention_store_invalid_response");
    const getter = vi.fn(() => { throw Error("secret"); });
    f.read.mockResolvedValue(Object.defineProperty(present(), "item", { enumerable: true, get: getter }));
    await expect(f.adapter.load(fixture().commit.scopeKey, signal())).rejects.toThrow("attention_store_invalid_response");
    expect(getter).not.toHaveBeenCalled();
    f.read.mockRejectedValue(Error("database password private-secret"));
    await expect(f.adapter.load(fixture().commit.scopeKey, signal())).rejects.toThrow(/^attention_store_invalid_response$/);
  });
  it("keeps a captured trusted metadata allowlist independent of caller mutation", async () => {
    const reviewed = [structuredClone(metadata)];
    const f = setup(present());
    const adapter = createCapabilityAttentionStoreAdapter({ transport: f, reviewedMetadata: reviewed,
      issueEvaluationKey: f.issueEvaluationKey, onPrepared: f.onPrepared });
    reviewed[0].workerBuild = "unreviewed";
    expect(await adapter.load(fixture().commit.scopeKey, signal())).not.toBeNull();
  });
  it("permits opaque canonical version-seven UUIDs without a narrower issuer policy", () => {
    const f = setup();
    const uuid = "00000000-0000-7000-8000-000000000591";
    expect(f.adapter.prepareCommit(fixture().commit, uuid).p_input.evaluationKey).toBe(uuid);
  });
  it("rejects changed replay under the same UUID before retention or transport", async () => {
    const f = setup();
    const first = f.adapter.prepareCommit(fixture().commit, evaluationKey);
    const changed = { p_input: { ...structuredClone(first.p_input), expectedVersion: 1 } };
    await expect(f.adapter.commitPrepared(changed, signal())).rejects.toThrow("attention_store_commit_unknown");
    expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("replays a journaled committed payload after reply loss without a new evaluation", async () => {
    const f = setup(null, { status: "committed", version: 1 });
    f.commit.mockRejectedValueOnce(Error("lost reply"));
    const handle = f.adapter.prepareCommit(fixture().commit, evaluationKey);
    await expect(f.adapter.commitPrepared(handle, signal())).rejects.toThrow("attention_store_commit_unknown");
    const persisted = JSON.parse(JSON.stringify(f.onPrepared.mock.calls[0][0]));
    const fresh = setup(null, { status: "committed", version: 1 });
    expect(await fresh.adapter.commitPrepared(persisted, signal())).toBe("committed");
    expect(fresh.commit.mock.calls[0][0]).toEqual(f.commit.mock.calls[0][0]);
    expect(fresh.issueEvaluationKey).not.toHaveBeenCalled();
  });
  it("never calls read, retention or commit for an already aborted caller", async () => {
    const f = setup();
    const control = new AbortController(); control.abort();
    await expect(f.adapter.load(fixture().commit.scopeKey, control.signal)).rejects.toThrow();
    await expect(f.adapter.compareAndSwap(fixture().commit, control.signal)).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled(); expect(f.onPrepared).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("bounds pending retention by cancellation and never dispatches its late reply", async () => {
    const f = setup();
    let release: () => void = () => undefined;
    f.onPrepared.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const control = new AbortController();
    const pending = f.adapter.compareAndSwap(fixture().commit, control.signal);
    await Promise.resolve(); control.abort();
    await expect(pending).rejects.toThrow("attention_store_commit_unknown");
    release(); await Promise.resolve();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("awaits durable capture and uses detached immutable fields across that await", async () => {
    const f = setup();
    let release: () => void = () => undefined;
    f.onPrepared.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const source = fixture().commit;
    const pending = f.adapter.compareAndSwap(source, signal());
    source.evidence!.decision.allowedExtensions.push("private");
    source.item.metadata.workerBuild = "private";
    expect(f.commit).not.toHaveBeenCalled();
    release(); expect(await pending).toBe("conflict");
    expect(JSON.stringify(f.commit.mock.calls[0][0])).not.toContain("private");
  });
  it("captures transport methods before an await can replace their external references", async () => {
    const f = setup();
    const transport = { read: f.read, commit: f.commit };
    const redirected = vi.fn(async () => ({ status: "conflict" }));
    const onPrepared = vi.fn(async () => { transport.commit = redirected; });
    const adapter = createCapabilityAttentionStoreAdapter({ transport, reviewedMetadata: [metadata],
      issueEvaluationKey: () => evaluationKey, onPrepared });
    expect(await adapter.compareAndSwap(fixture().commit, signal())).toBe("conflict");
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(redirected).not.toHaveBeenCalled();
  });
  it("rejects forged intent identity before retaining or dispatching", async () => {
    const f = setup();
    const commit = fixture().commit;
    commit.intent!.key = "a".repeat(64);
    await expect(f.adapter.compareAndSwap(commit, signal())).rejects.toThrow("attention_store_commit_unknown");
    expect(f.onPrepared).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
  it("treats cancellation during commit as uncertain without a retry", async () => {
    const f = setup();
    const control = new AbortController();
    f.commit.mockImplementation(async () => { control.abort(); return { status: "committed", version: 1 }; });
    await expect(f.adapter.compareAndSwap(fixture().commit, control.signal)).rejects.toThrow("attention_store_commit_unknown");
    expect(f.commit).toHaveBeenCalledTimes(1);
  });
});
