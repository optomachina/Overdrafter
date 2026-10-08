import { describe, expect, it, vi } from "vitest";
import { writeNativeArtifactMappings, WRITE_NATIVE_ARTIFACT_MAPPINGS_SQL, prepareNativeArtifactInputs, prepareNativeArtifactOutputs, PREPARE_NATIVE_ARTIFACT_INPUTS_SQL, PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL } from "./native-artifact-mapping";
import type { PrivateArtifactSql } from "./native-artifact-repository";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
function fixture() {
  const receipt = { attemptId: id(1), inputAdmissionId: id(2), outputRoles: 7,
    inputs: [0, 1, 2].map((ordinal) => ({ ordinal, id: id(ordinal + 3) })) };
  const query = vi.fn().mockResolvedValue([{ mapping: receipt }]);
  const sql: PrivateArtifactSql = { query, transaction: async (work) => work(sql) };
  return { receipt, query, sql, input: { enabled: true, sql, attemptId: id(1), seedManifestText: null,
    outputBucket: "synthetic-private", signal: new AbortController().signal } };
}
describe("trusted native artifact mapping writer", () => {
  it("defaults closed before driver use", async () => {
    const f = fixture(); await expect(writeNativeArtifactMappings({ ...f.input, enabled: false })).rejects.toThrow("disabled");
    expect(f.query).not.toHaveBeenCalled();
  });
  it("uses fixed positional SQL and returns frozen receipt", async () => {
    const f = fixture(); const result = await writeNativeArtifactMappings(f.input);
    expect(f.query).toHaveBeenCalledWith(WRITE_NATIVE_ARTIFACT_MAPPINGS_SQL,
      [id(1), null, "synthetic-private"], { signal: f.input.signal, timeoutMs: 30000 });
    expect(Object.isFrozen(result.inputs[0])).toBe(true);
    f.receipt.inputs[0].id = id(99); expect(result.inputs[0].id).toBe(id(3));
  });
  it.each(["attemptId", "inputAdmissionId", "outputRoles", "inputs"])("rejects invalid receipt %s", async (field) => {
    const f = fixture(); Object.assign(f.receipt, { [field]: null });
    await expect(writeNativeArtifactMappings(f.input)).rejects.toThrow("invalid_receipt");
  });
  it("rejects duplicate mapping IDs", async () => {
    const f = fixture(); f.receipt.inputs[1].id = f.receipt.inputs[0].id;
    await expect(writeNativeArtifactMappings(f.input)).rejects.toThrow("invalid_receipt");
  });
  it("never retries unknown write outcome", async () => {
    const f = fixture(); f.query.mockRejectedValue(new Error("commit_unknown"));
    await expect(writeNativeArtifactMappings(f.input)).rejects.toThrow("commit_unknown");
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not call the driver on pre-abort", async () => {
    const f = fixture(); const c = new AbortController(); c.abort();
    await expect(writeNativeArtifactMappings({ ...f.input, signal: c.signal })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("rejects malformed inputs before SQL", async () => {
    const f = fixture(); await expect(writeNativeArtifactMappings({ ...f.input, seedManifestText: "x".repeat(16385) })).rejects.toThrow("invalid_input");
    expect(f.query).not.toHaveBeenCalled();
  });
});

describe("preclaim inputs and postclaim outputs", () => {
  it("prepares input IDs with no attempt ID", async () => {
    const f = fixture();
    const result = await prepareNativeArtifactInputs({ enabled: true, sql: f.sql,
      inputAdmissionId: id(2), actorId: id(8), seedManifestText: "[]", signal: f.input.signal });
    expect(result.inputs).toHaveLength(3);
    expect(f.query).toHaveBeenCalledWith(PREPARE_NATIVE_ARTIFACT_INPUTS_SQL,
      [id(2), id(8), "[]"], { signal: f.input.signal, timeoutMs: 30000 });
  });
  it("prepares exactattempt targets without seed manifest", async () => {
    const f = fixture();
    const result = await prepareNativeArtifactOutputs(f.input);
    expect(result).toEqual({ attemptId: id(1), outputRoles: 7 });
    expect(f.query).toHaveBeenCalledWith(PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL,
      [id(1), "synthetic-private"], { signal: f.input.signal, timeoutMs: 30000 });
  });
  it("keeps both phases disabled without explicit flag", async () => {
    const f = fixture();
    await expect(prepareNativeArtifactInputs({ enabled: false, sql: f.sql,
      inputAdmissionId: id(2), actorId: id(8), seedManifestText: null, signal: f.input.signal })).rejects.toThrow("disabled");
    await expect(prepareNativeArtifactOutputs({ ...f.input, enabled: false })).rejects.toThrow("disabled");
    expect(f.query).not.toHaveBeenCalled();
  });
});
