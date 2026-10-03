import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeFirstLoopRuntime } from "./native-first-loop-runtime";
import { PREPARE_NATIVE_ARTIFACT_INPUTS_SQL } from "./native-artifact-mapping";
import { NATIVE_FINALIZATION_SQL, type NativeOwnerSqlPool } from "./native-result-executor";

const id = (n: number) => `56200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(enabled = true, withKey = true) {
  const key = new Uint8Array(32).fill(7), context = '{ "synthetic": true }';
  const payload = JSON.stringify({ schema: "overdrafter.native-verification-receipt.v2", taskId: id(1),
    attemptId: id(2), fence: 3, candidateSnapshotId: id(4),
    candidateContextSha256: createHash("sha256").update(context).digest("hex") });
  const envelope = { p_payload_text: payload, p_candidate_context_text: context, p_key: id(5),
    p_signature: createHmac("sha256", key).update(payload).digest("hex") };
  const receipt = { outcome: "finalized", taskId: id(1), attemptId: id(2), fence: 3,
    snapshotId: id(4), inputAdmissionId: id(6), successorTaskId: null };
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    if (text === PREPARE_NATIVE_ARTIFACT_INPUTS_SQL) return { rows: [{ mapping: { inputAdmissionId: id(6),
      inputs: [0, 1, 2].map(ordinal => ({ id: id(10 + ordinal), ordinal })) } }] };
    if (text === NATIVE_FINALIZATION_SQL.load) return { rows: [{ value: envelope }] };
    if (text === NATIVE_FINALIZATION_SQL.finalize) return { rows: [{ value: receipt }] };
    if (text === "begin isolation level read committed" || text.startsWith("set local ") || text === "commit") return { rows: [] };
    throw new Error("Unexpected statement in synthetic composition fixture.");
  });
  const release = vi.fn(), pool: NativeOwnerSqlPool = { connect: vi.fn(async () => ({ query, release })) };
  const fetch = vi.fn(async () => { throw new Error("No provider request expected."); });
  const service = createNativeFirstLoopRuntime({ pool, fetch, enabled: enabled ? true : undefined, receiptKey: withKey ? key : undefined,
    publicOrigin: "https://inert.test", storageOrigin: "https://storage.inert.test",
    storageAuthorization: "Bearer synthetic-fixture-only", outputBucket: "configured-private-fixture",
    storageVersionIdQualified: false });
  return { service, pool, fetch, key, query, release, envelope, receipt };
}
describe("concrete first-loop server composition", () => {
  it("defaults owner operations off before pool/provider access", async () => {
    const f = fixture(false);
    await expect(f.service.prepareInputs({ inputAdmissionId: id(6), actorId: id(7), seedManifestText: "[]",
      signal: new AbortController().signal })).rejects.toThrow("disabled");
    await expect(f.service.finalize(id(1), id(2))).rejects.toThrow("disabled");
    await expect(f.service.replay(id(1), id(2))).rejects.toThrow("disabled");
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("prepares the three opaque inputs before any attempt exists", async () => {
    const f = fixture();
    const result = await f.service.prepareInputs({ inputAdmissionId: id(6), actorId: id(7), seedManifestText: "[ ]",
      signal: new AbortController().signal });
    expect(result.inputs.map(item => item.id)).toEqual([id(10), id(11), id(12)]);
    expect(f.query).toHaveBeenCalledWith(PREPARE_NATIVE_ARTIFACT_INPUTS_SQL, [id(6), id(7), "[ ]"]);
    expect(f.query.mock.calls.map(call => call[0]).at(-1)).toBe("commit");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledWith(false);
  });
  it("replays only the original retained envelope through the fixed executor", async () => {
    const f = fixture(); f.key.fill(0); // Server owns its copied key, not caller's mutable buffer.
    expect(await f.service.replay(id(1), id(2))).toEqual(f.receipt);
    expect(f.query).toHaveBeenCalledWith(NATIVE_FINALIZATION_SQL.finalize,
      [f.envelope.p_payload_text, f.envelope.p_signature, f.envelope.p_candidate_context_text, f.envelope.p_key]);
    expect(f.query.mock.calls.filter(call => !call[0].startsWith("set local ")
      && call[0] !== "begin isolation level read committed" && call[0] !== "commit").map(call => call[0]))
      .toEqual([NATIVE_FINALIZATION_SQL.load, NATIVE_FINALIZATION_SQL.finalize]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not discover a missing signing key or query without it", async () => {
    const f = fixture(true, false);
    await expect(f.service.finalize(id(1), id(2))).rejects.toThrow("key unavailable");
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
});
