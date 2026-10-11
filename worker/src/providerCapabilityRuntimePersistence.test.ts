import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { claimCapabilityWindow, getCapabilityWindow, completeCapabilityWindow, commitCapabilityAttention, readCapabilityAttention, listDueCapabilityAttention } from "./providerCapabilityRuntimePersistence.js";
import { projectCapabilityAttention } from "./providerCapabilityAttention.js";
const uuid = "00000000-0000-4000-8000-000000000001";
const input = { windowKey: `canary:${"a".repeat(64)}`, resourceKey: "b".repeat(64), configDigest: "c".repeat(64), requestKey: uuid, provider: "xometry", route: "route", surface: "modal", surfaceRevision: "v1", windowStart: "2026-10-02T00:00:00.000Z", windowEnd: "2026-10-02T01:00:00.000Z", leaseSeconds: 60 };
const receipt = { status: "claimed", windowKey: input.windowKey, fence: uuid, generation: 1, owner: uuid, observationRevision: 1, deadline: input.windowEnd };
function client(data: unknown, error: unknown = null) { const rpc = vi.fn().mockResolvedValue({ data, error }); return { rpc, db: { rpc } as unknown as SupabaseClient }; }
describe("capability runtime service transport (not SQL durability proof)", () => {
  it("preserves claim identity and does not retry", async () => { const c = client(receipt); expect(await claimCapabilityWindow(c.db, input)).toEqual({ ok: true, value: receipt }); expect(c.rpc).toHaveBeenCalledExactlyOnceWith("api_claim_capability_window", { p_input: input }); });
  it.each(["replay", "expired", "completed"])("status lookup preserves %s without authorizing claimed", async (status) => { const c = client({ ...receipt, status }); expect((await getCapabilityWindow(c.db, input.windowKey, uuid)).ok).toBe(true); });
  it("rejects claimed status from lookup", async () => { const c = client(receipt); expect(await getCapabilityWindow(c.db, input.windowKey, uuid)).toEqual({ ok: false, reasonCode: "invalid_response" }); });
  it.each([{ ...receipt, fence: "secret" }, { ...receipt, owner: "00000000-0000-4000-8000-000000000002" }, { ...receipt, observationRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...receipt, extra: "secret" }])("rejects malformed or foreign receipt", async (r) => { const c = client(r); expect((await claimCapabilityWindow(c.db, input)).ok).toBe(false); });
  it.each([{ ...input, leaseSeconds: 301 }, { ...input, resourceKey: "/home/profile" }, { ...input, windowKey: "a".repeat(64) }, { ...input, configDigest: "secret" }])("rejects malformed claim before RPC", async (bad) => { const c = client(receipt); expect((await claimCapabilityWindow(c.db, bad)).ok).toBe(false); expect(c.rpc).not.toHaveBeenCalled(); });
  it("does not execute input getters", async () => { const c = client(receipt); const getter = vi.fn(() => input.windowKey); const bad = { ...input }; Object.defineProperty(bad, "windowKey", { get: getter, enumerable: true }); expect((await claimCapabilityWindow(c.db, bad)).ok).toBe(false); expect(getter).not.toHaveBeenCalled(); });
  it("scrubs transport and SQL errors and never retries", async () => { const c = client(null, { message: "private secret" }); expect(await claimCapabilityWindow(c.db, input)).toEqual({ ok: false, reasonCode: "rpc_denied" }); c.rpc.mockRejectedValue(new Error("private secret")); expect(await claimCapabilityWindow(c.db, input)).toEqual({ ok: false, reasonCode: "transport_error" }); expect(c.rpc).toHaveBeenCalledTimes(2); });
  it("refuses completion without disposal attestation", async () => { const c = client(null); expect((await completeCapabilityWindow(c.db, { windowKey: input.windowKey, requestKey: uuid, fence: uuid, completionKey: uuid, resourceReleased: false } as never)).ok).toBe(false); expect(c.rpc).not.toHaveBeenCalled(); });
  it("checks attention CAS response version", async () => { const c = client({ status: "committed", version: 5 }); const m = { provider: "xometry", route: "route", surface: "modal", surfaceRevision: "v1", policyRevision: "v1", adapterRevision: null, workerBuild: null }; const projected = projectCapabilityAttention({ metadata: m, reviewedMetadata: [m], evidence: null, previous: null, now: "2026-10-02T00:00:00.000Z" }); if (projected.state !== "projected") throw new Error("fixture"); const p = { expectedVersion: 1, evaluationKey: uuid, cursor: projected.cursor, item: projected.item, intent: projected.intent, evidence: null }; expect(await commitCapabilityAttention(c.db, p as never)).toEqual({ ok: false, reasonCode: "invalid_response" }); });
  it("rejects huge sparse candidate arrays before serialization", async () => { const c = client(null); const candidate = { provider: "xometry", route: "route", surface: "modal", revision: "v1", state: "fresh", extensions: new Array(100000000), mimeTypes: [], acceptAttributePresent: true, observedAt: input.windowStart, expiresAt: input.windowEnd, actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: "v1", evidenceReference: "issue:OVD-591", idempotencyKey: input.windowKey }; expect((await completeCapabilityWindow(c.db, { windowKey: input.windowKey, requestKey: uuid, fence: uuid, completionKey: uuid, resourceReleased: true, candidate } as never)).ok).toBe(false); expect(c.rpc).not.toHaveBeenCalled(); });
  it("accepts the declared 100-row due batch and rejects secret extras", async () => {
    const m = { provider: "xometry", route: "route", surface: "modal", surfaceRevision: "v1", policyRevision: "v1", adapterRevision: null, workerBuild: null };
    const p = projectCapabilityAttention({ metadata: m, reviewedMetadata: [m], evidence: null, previous: null, now: "2026-10-02T00:00:00.000Z" });
    if (p.state !== "projected") throw new Error("fixture");
    const row = { version: 1, cursor: p.cursor, item: p.item, evidence: null };
    const c = client(Array.from({ length: 100 }, () => ({ ...row })));
    expect((await listDueCapabilityAttention(c.db, 100)).ok).toBe(true);
    c.rpc.mockResolvedValue({ data: [{ ...row, item: { ...p.item, secret: "private" } }], error: null });
    expect(await listDueCapabilityAttention(c.db, 100)).toEqual({ ok: false, reasonCode: "invalid_response" });
  });
  it("rejects candidate accessors before RPC", async () => {
    const c = client(null); const getter = vi.fn(() => input.windowKey); const candidate = {};
    Object.defineProperty(candidate, "idempotencyKey", { get: getter, enumerable: true });
    expect((await completeCapabilityWindow(c.db, { windowKey: input.windowKey, requestKey: uuid, fence: uuid, completionKey: uuid, resourceReleased: true, candidate } as never)).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(c.rpc).not.toHaveBeenCalled();
  });
  it("bounds due sweep and rejects foreign read scope", async () => { const c = client({ version: 1, cursor: { scopeKey: "b".repeat(64) }, item: { key: `capability:${"b".repeat(64)}` }, evidence: null }); expect((await readCapabilityAttention(c.db, "a".repeat(64))).ok).toBe(false); expect((await listDueCapabilityAttention(c.db, 101)).ok).toBe(false); expect(c.rpc).toHaveBeenCalledTimes(1); });
});

function completionInput() {
  return {
    windowKey: input.windowKey, requestKey: uuid, fence: uuid, completionKey: uuid, resourceReleased: true as const,
    candidate: { provider: "xometry", route: "route", surface: "modal", revision: "v1", state: "fresh" as const,
      extensions: ["step"], mimeTypes: ["application/step"], acceptAttributePresent: true,
      observedAt: input.windowStart, expiresAt: input.windowEnd, actorKind: "scheduled_canary" as const,
      sourceKind: "scheduled_canary" as const, sourceVersion: "v1", evidenceReference: "issue:OVD-591", idempotencyKey: input.windowKey },
  };
}
function attentionInput() {
  const metadata = { provider: "xometry", route: "route", surface: "modal", surfaceRevision: "v1", policyRevision: "v1", adapterRevision: null, workerBuild: null };
  const p = projectCapabilityAttention({ metadata, reviewedMetadata: [metadata], evidence: null, previous: null, now: input.windowStart });
  if (p.state !== "projected") throw new Error("fixture");
  return { expectedVersion: 1, evaluationKey: uuid, cursor: { ...p.cursor, lastObservationRevision: 1, lastObservedAt: input.windowStart, lastEvidenceHash: "d".repeat(64) }, item: p.item, intent: p.intent, evidence: null };
}
function attentionRow() {
  const { cursor, item, evidence } = attentionInput();
  return { version: 1, cursor, item, evidence };
}
function arrayify(target: object, field: string) {
  const record = target as Record<string, unknown>;
  record[field] = [record[field]];
}

describe("canonical JSON validation hardening", () => {
  it.each(["windowKey", "resourceKey", "configDigest", "requestKey", "provider", "route", "surface", "surfaceRevision"])("rejects array-coerced claim %s before dispatch", async (field) => {
    const bad = structuredClone(input); arrayify(bad, field); const c = client(receipt);
    expect(await claimCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each(["windowKey", "requestKey", "fence", "completionKey"])("rejects array-coerced completion %s before dispatch", async (field) => {
    const bad = completionInput(); arrayify(bad, field); const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each(["provider", "route", "surface", "revision", "sourceVersion", "evidenceReference", "idempotencyKey"])("rejects array-coerced candidate %s before dispatch", async (field) => {
    const bad = completionInput(); arrayify(bad.candidate, field); const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each(["scopeKey", "fingerprint", "lastEvidenceHash"])("rejects array-coerced cursor %s in writes, reads and due lists", async (field) => {
    const bad = attentionInput(); arrayify(bad.cursor, field); const c = client(null);
    expect(await commitCapabilityAttention(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
    const row = { version: 1, cursor: bad.cursor, item: bad.item, evidence: null };
    c.rpc.mockResolvedValue({ data: row, error: null });
    expect(await readCapabilityAttention(c.db, attentionInput().cursor.scopeKey)).toEqual({ ok: false, reasonCode: "invalid_response" });
    c.rpc.mockResolvedValue({ data: [row], error: null });
    expect(await listDueCapabilityAttention(c.db, 1)).toEqual({ ok: false, reasonCode: "invalid_response" });
  });
  it("rejects coercible UUID/hash arguments and intent keys", async () => {
    const c = client(null);
    expect(await getCapabilityWindow(c.db, [input.windowKey] as never, uuid)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(await getCapabilityWindow(c.db, input.windowKey, [uuid] as never)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(await readCapabilityAttention(c.db, ["a".repeat(64)] as never)).toEqual({ ok: false, reasonCode: "invalid_input" });
    const bad = attentionInput(); arrayify(bad, "evaluationKey");
    expect(await commitCapabilityAttention(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    const withIntent = attentionInput();
    if (!withIntent.intent) throw new Error("fixture intent");
    arrayify(withIntent.intent, "key");
    expect(await commitCapabilityAttention(c.db, withIntent)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects array-coerced receipt fences", async () => {
    const c = client({ ...receipt, fence: [uuid] });
    expect(await claimCapabilityWindow(c.db, input)).toEqual({ ok: false, reasonCode: "invalid_response" });
    c.rpc.mockResolvedValue({ data: { ...receipt, status: "replay", fence: [uuid] }, error: null });
    expect(await getCapabilityWindow(c.db, input.windowKey, uuid)).toEqual({ ok: false, reasonCode: "invalid_response" });
  });
  it.each(["stp", "https://synthetic.invalid/unsanitized"])("rejects inherited serialization substitution %s without invoking it", async (replacement) => {
    const bad = completionInput(); const getter = vi.fn(() => () => [replacement]);
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, "toJSON", { get: getter });
    Object.setPrototypeOf(bad.candidate.extensions, proto);
    const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(getter).not.toHaveBeenCalled(); expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects custom array prototypes even without a serialization hook", async () => {
    const bad = completionInput(); Object.setPrototypeOf(bad.candidate.extensions, Object.create(Array.prototype));
    const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each(["own", "array", "object"])("rejects %s serialization getters without invoking them", async (location) => {
    const bad = completionInput(); const getter = vi.fn(() => () => ["stp"]);
    const target = location === "own" ? bad.candidate.extensions : location === "array" ? Array.prototype : Object.prototype;
    const previous = Object.getOwnPropertyDescriptor(target, "toJSON");
    const c = client(null);
    let result: ReturnType<typeof completeCapabilityWindow>;
    try {
      Object.defineProperty(target, "toJSON", { get: getter, configurable: true });
      result = completeCapabilityWindow(c.db, bad);
    } finally {
      if (previous) Object.defineProperty(target, "toJSON", previous); else Reflect.deleteProperty(target, "toJSON");
    }
    expect(await result).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(getter).not.toHaveBeenCalled(); expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects response array hooks without invoking them", async () => {
    const getter = vi.fn(() => () => []); const rows = [attentionRow()];
    const proto = Object.create(Array.prototype); Object.defineProperty(proto, "toJSON", { get: getter }); Object.setPrototypeOf(rows, proto);
    const c = client(rows);
    expect(await listDueCapabilityAttention(c.db, 1)).toEqual({ ok: false, reasonCode: "invalid_response" });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["2026-10-02T00:00:00Z", "2026-10-02T00:00:00.123456Z", "2026-10-02T00:00:00.123456+00:00"])("preserves accepted UTC date spelling %s", async (timestamp) => {
    const c = client({ status: "completed", windowKey: input.windowKey, observationRevision: 1 });
    const completion = completionInput(); completion.candidate.observedAt = timestamp;
    expect((await completeCapabilityWindow(c.db, completion)).ok).toBe(true);
    expect(c.rpc.mock.calls[0][1].p_input.candidate.observedAt).toBe(timestamp);
  });
  it.each([false, true])("binds claim replies to the original request after caller mutation (foreign=%s)", async (foreign) => {
    const original = structuredClone(input); const changedKey = `canary:${"e".repeat(64)}`; const changedOwner = "00000000-0000-4000-8000-000000000002";
    const reply = { ...receipt, ...(foreign ? { windowKey: changedKey, owner: changedOwner } : {}) };
    const c = client(reply); const pending = claimCapabilityWindow(c.db, original);
    original.windowKey = changedKey; original.requestKey = changedOwner;
    expect(await pending).toEqual(foreign ? { ok: false, reasonCode: "invalid_response" } : { ok: true, value: reply });
    expect(c.rpc.mock.calls[0][1].p_input).toEqual(input);
  });
  it.each([false, true])("binds completion replies to the original window after caller mutation (foreign=%s)", async (foreign) => {
    const original = completionInput(); const expected = structuredClone(original); const changedKey = `canary:${"e".repeat(64)}`;
    const reply = { status: "completed", windowKey: foreign ? changedKey : input.windowKey, observationRevision: 1 };
    const c = client(reply); const pending = completeCapabilityWindow(c.db, original);
    original.windowKey = changedKey; original.candidate.extensions[0] = "stp";
    expect(await pending).toEqual(foreign ? { ok: false, reasonCode: "invalid_response" } : { ok: true, value: reply });
    expect(c.rpc.mock.calls[0][1].p_input).toEqual(expected);
  });
  it.each([false, true])("binds attention replies to the original CAS version after caller mutation (foreign=%s)", async (foreign) => {
    const original = attentionInput(); const expected = structuredClone(original); const reply = { status: "committed", version: foreign ? 6 : 2 };
    const c = client(reply); const pending = commitCapabilityAttention(c.db, original);
    original.expectedVersion = 5; original.cursor.fingerprint = "e".repeat(64);
    expect(await pending).toEqual(foreign ? { ok: false, reasonCode: "invalid_response" } : { ok: true, value: reply });
    expect(c.rpc.mock.calls[0][1].p_input).toEqual(expected);
  });
  it("detaches the request before the actual SDK serializes it using an inert fetch", async () => {
    let sent: unknown;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ status: "completed", windowKey: input.windowKey, observationRevision: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const db = createClient("https://synthetic.invalid", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
    const original = completionInput(); const expected = structuredClone(original);
    const pending = completeCapabilityWindow(db, original);
    original.windowKey = `canary:${"e".repeat(64)}`; original.candidate.extensions[0] = "stp";
    expect((await pending).ok).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent).toEqual({ p_input: expected });
  });
});


describe("dense canonical JSON arrays", () => {
  it.each(["extra", "01", "-1"])("rejects holes disguised by the %s key before RPC", async (key) => {
    const bad = completionInput();
    bad.candidate.extensions = Object.assign(new Array<string>(1), { [key]: "step" });
    const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects a nonenumerable non-index key on a dense array", async () => {
    const bad = completionInput();
    Object.defineProperty(bad.candidate.extensions, "extra", { value: "step" });
    const c = client(null);
    expect(await completeCapabilityWindow(c.db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it("rejects sparse due-list responses with compensating extra keys", async () => {
    const rows = Object.assign(new Array(1), { extra: attentionRow() }); const c = client(rows);
    expect(await listDueCapabilityAttention(c.db, 1)).toEqual({ ok: false, reasonCode: "invalid_response" });
    c.rpc.mockResolvedValue({ data: [attentionRow()], error: null });
    expect(await listDueCapabilityAttention(c.db, 1)).toEqual({ ok: true, value: [attentionRow()] });
  });
  it.each([false, true])("rejects sparse input before actual SDK fetch without reading extra properties (getter=%s)", async (accessor) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "completed", windowKey: input.windowKey, observationRevision: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const db = createClient("https://synthetic.invalid", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
    const bad = completionInput(); bad.candidate.extensions = new Array<string>(1);
    const getter = vi.fn(() => "step");
    Object.defineProperty(bad.candidate.extensions, "extra", { ...(accessor ? { get: getter } : { value: "step" }), enumerable: true });
    expect(await completeCapabilityWindow(db, bad)).toEqual({ ok: false, reasonCode: "invalid_input" });
    expect(getter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect((await completeCapabilityWindow(db, completionInput())).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled();
  });
});
