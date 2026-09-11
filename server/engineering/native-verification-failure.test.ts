// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeEvidenceRejection, rejectedNativeReport } from "./native-verification-failure";
import { storedNativeFixture } from "./native-result-fixture";
import { verifyStoredNativeCandidate } from "./native-result-bytes";

describe("native verification failure evidence", () => {
  it("records measured size and exact registry identity for a truncated artifact", async () => {
    const f = storedNativeFixture(); f.bytes.target = f.bytes.target.subarray(0, 10);
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toMatchObject({ failure: {
      schema: "overdrafter.native-verification-failure.v1", code: "artifact_size_mismatch", reason: "truncated object",
      objectId: f.objects[1].id, observedBytes: 10, observedSha256: null,
    } });
  });
  it("does not persist parser excerpts that can contain document contents", () => {
    const error = rejectedNativeReport(new SyntaxError('Unexpected token in "customer private contents"'));
    expect(error.failure.reason).toBe("Malformed JSON evidence");
    expect(error.message).not.toContain("customer"); expect(Object.isFrozen(error.failure)).toBe(true);
  });
  it("preserves an internal measurement predicate label", () => {
    expect(rejectedNativeReport(new TypeError("Invalid prepared evidence: extrusion depth.")).failure.reason).toBe("extrusion depth.");
  });
  it("leaves unavailable object delivery as a nonterminal verification error", async () => {
    const f = storedNativeFixture();
    const failure = await verifyStoredNativeCandidate(f.admission, async () => new Response(null, { status: 503 })).catch(error => error);
    expect(failure).toBeInstanceOf(TypeError); expect(failure).not.toBeInstanceOf(NativeEvidenceRejection);
  });
  it("does not blame valid evidence for malformed process admission", async () => {
    const f = storedNativeFixture();
    const admission = { ...f.admission, process: { ...f.admission.process, candidateRoot: "invalid-path" } };
    const error = await verifyStoredNativeCandidate(admission, f.reader).catch(error => error);
    expect(error).toBeInstanceOf(TypeError); expect(error).not.toBeInstanceOf(NativeEvidenceRejection);
  });
});
