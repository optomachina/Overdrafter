// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyStoredNativeCandidate } from "./native-result-bytes";
import { storedNativeFixture as createFixture } from "./native-result-fixture";
function fixture() { const f = createFixture(); return { ...f, reader: vi.fn(f.reader) }; }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("stored native candidate verification", () => {
  it("measures the three actual retained native files and verifies all reports", async () => {
    const f = fixture(), verified = await verifyStoredNativeCandidate(f.admission, f.reader);
    expect(f.reader).toHaveBeenCalledTimes(7);
    expect(verified.context.depthMm).toBe(8);
    expect(verified.context.producer?.inputSnapshotId).toBe(f.admission.active.inputSnapshotId);
    expect(verified.context.files).toEqual(f.data.result.outputFiles);
    expect(verified.resultSha256).toBe(hash(f.bytes.result));
    expect(verified).not.toHaveProperty("approved");
  });
  it.each(["assembly", "target", "companion", "result", "identity", "preservation", "native"] as const)("rejects changed %s bytes", async (role) => {
    const f = fixture(); f.bytes[role][10] ^= 1;
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toThrow("stored digest mismatch");
  });
  it("rejects truncated streams rather than trusting Content-Length", async () => {
    const f = fixture();
    await expect(verifyStoredNativeCandidate(f.admission, async () => new Response(new Uint8Array(1), { headers: { "Content-Length": "60608" } })))
      .rejects.toThrow("truncated object");
  });
  it("rejects data beyond registered size while streaming", async () => {
    const f = fixture();
    await expect(verifyStoredNativeCandidate(f.admission, async () => new Response(new Uint8Array(60609))))
      .rejects.toThrow("exceeds registered size");
  });
  it.each([404, 206, 500])("rejects HTTP %s", async (status) => {
    const f = fixture();
    await expect(verifyStoredNativeCandidate(f.admission, async () => new Response("bad", { status }))).rejects.toThrow("object response");
  });
  it("rejects foreign registry scope before reading any object", async () => {
    const f = fixture(); f.objects[0] = { ...f.objects[0], scope: { ...f.objects[0].scope, organizationId: "foreign" } };
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toThrow("registry scope"); expect(f.reader).not.toHaveBeenCalled();
  });
  it("rejects duplicate roles and object identities before reads", async () => {
    const f = fixture(); f.objects[1] = f.objects[0];
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toThrow("registry identity"); expect(f.reader).not.toHaveBeenCalled();
  });
  it("requires the complete seven-object set", async () => {
    const f = fixture(); f.objects.pop();
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toThrow("complete object set");
  });
  it("rejects an obsolete active fence before reads", async () => {
    const f = fixture(); f.admission.active.fence++;
    await expect(verifyStoredNativeCandidate(f.admission, f.reader)).rejects.toThrow("active fence"); expect(f.reader).not.toHaveBeenCalled();
  });
  it("bounds a reader that ignores cancellation", async () => {
    const f = fixture();
    await expect(verifyStoredNativeCandidate(f.admission, () => new Promise(() => undefined), 20)).rejects.toThrow("interrupted");
  });
  it("bounds a stalled response body", async () => {
    const f = fixture(), cancel = vi.fn();
    await expect(verifyStoredNativeCandidate(f.admission, async () => new Response(new ReadableStream({ cancel })), 20)).rejects.toThrow("interrupted");
    expect(cancel).toHaveBeenCalled();
  });
  it("snapshots admission before awaits", async () => {
    const f = fixture(), promise = verifyStoredNativeCandidate(f.admission, f.reader);
    f.admission.active.fence = 99;
    expect((await promise).context.producer?.fence).toBe(1);
  });
  it("rejects an endless stream of empty chunks", async () => {
    const f = fixture(), cancel = vi.fn();
    const reader = async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel }));
    await expect(verifyStoredNativeCandidate(f.admission, reader)).rejects.toThrow("stream progress bounds");
    expect(cancel).toHaveBeenCalled();
  });
  it("bounds fragmented streams without relying on timer scheduling", async () => {
    const f = fixture(), cancel = vi.fn();
    const reader = async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel }));
    await expect(verifyStoredNativeCandidate(f.admission, reader)).rejects.toThrow("stream progress bounds");
    expect(cancel).toHaveBeenCalled();
  });
});
