// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyStoredNativeCandidate, type RegisteredResultObject, type ResultReadAdmission } from "./native-result-bytes";

const directory = "server/engineering/fixtures/";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const data = JSON.parse(readFileSync(directory + "prepared-reports.json", "utf8"));
  const contextText = JSON.stringify(data.context);
  data.job.contextSha256 = hash(new TextEncoder().encode(contextText));
  const jobText = JSON.stringify(data.job), requestSha256 = hash(new TextEncoder().encode(jobText));
  for (const report of [data.result, data.identity, data.native]) {
    report.requestSha256 = requestSha256; report.contextSha256 = data.job.contextSha256;
  }
  const bytes = {
    assembly: new Uint8Array(readFileSync(directory + "candidate/synthetic-assembly.SLDASM")),
    target: new Uint8Array(readFileSync(directory + "candidate/parts/baseline-5mm.SLDPRT")),
    companion: new Uint8Array(readFileSync(directory + "candidate/parts/candidate-8mm.SLDPRT")),
    identity: encode(data.identity), preservation: encode(data.preservation), native: encode(data.native), result: new Uint8Array(),
  };
  data.result.checks.forEach((check: { evidenceSha256: string }, index: number) => {
    let report = bytes.native;
    if (index === 0) report = bytes.identity;
    else if (index === 6) report = bytes.preservation;
    check.evidenceSha256 = hash(report);
  });
  bytes.result = encode(data.result);
  const objects: RegisteredResultObject[] = Object.entries(bytes).map(([role, content], index) => ({
    id: `11111111-1111-4111-8111-00000000000${index}`, scope: data.job.scope,
    attemptId: data.job.attemptId, role: role as RegisteredResultObject["role"], bytes: content.byteLength, sha256: hash(content),
  }));
  const admission: ResultReadAdmission = { contextText, jobText,
    active: { scope: data.job.scope, jobId: data.job.jobId, attemptId: data.job.attemptId, fence: data.job.fence,
      inputSnapshotId: data.job.inputSnapshotId, contextSha256: data.job.contextSha256, outputSnapshotId: data.job.outputSnapshotId },
    process: { nativePid: 42, helperPid: 43, nativeStartTicks: "639246000000000000", candidateRoot: data.native.candidateRoot }, objects };
  const reader = vi.fn(async (id: string) => {
    const object = objects.find((entry) => entry.id === id)!;
    return new Response(bytes[object.role]);
  });
  return { admission, bytes, reader, objects, data };
}

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
