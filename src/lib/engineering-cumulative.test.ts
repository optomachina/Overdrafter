// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NATIVE_CHECKS, NATIVE_SEED_FILES, readNativeContext, readNativeJob, verifiedNativeSuccessor, type NativeContext } from "./engineering-cumulative";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (n: number) => `12345678-1234-4234-8234-${n.toString().padStart(12, "0")}`;
const scope = { organizationId: id(1), projectId: id(2) };
const instant = "2026-09-10T00:00:00.000Z";
function seed(): NativeContext {
  return readNativeContext(JSON.stringify({ schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
    scope, snapshotId: id(3), seedSnapshotId: id(3), sequence: 0, producer: null, createdAt: instant,
    configuration: "Default", assemblyPath: "synthetic-assembly.SLDASM", files: NATIVE_SEED_FILES, depthMm: 5, checks: [] }));
}
function fixture(context = seed(), target = 8) {
  const contextText = JSON.stringify(context);
  const job = { schema: "overdrafter.prepared-dimension-job.v2", scope, jobId: id(10 + context.sequence),
    attemptId: id(20 + context.sequence), fence: 1, inputSnapshotId: context.snapshotId,
    outputSnapshotId: id(30 + context.sequence), seedSnapshotId: context.seedSnapshotId, sequence: context.sequence + 1,
    contextSha256: hash(contextText), inputFiles: context.files, expectedDepthMm: context.depthMm,
    dimensionId: "baseline-depth", depthMm: target, configuration: "Default", createdAt: instant, requiredChecks: NATIVE_CHECKS };
  const jobText = JSON.stringify(job);
  const outputFiles = context.files.map((file, index) => {
    if (index === 2) return { ...file };
    return { ...file, bytes: file.bytes + 10, sha256: hash(`${context.snapshotId}/${target}/${file.path}`) };
  });
  const checks = NATIVE_CHECKS.map((check) => ({ id: check, verdict: "pass", evidenceSha256: hash(check) }));
  const result = { schema: "overdrafter.prepared-dimension-result.v2", scope, jobId: job.jobId, attemptId: job.attemptId,
    fence: job.fence, inputSnapshotId: job.inputSnapshotId, outputSnapshotId: job.outputSnapshotId,
    requestSha256: hash(jobText), contextSha256: job.contextSha256, depthMm: target, outcome: "succeeded", failureReason: null,
    inputFiles: job.inputFiles, outputFiles, checks,
    measurements: { beforeDepthMm: context.depthMm, afterDepthMm: target, beforeVolumeMm3: Math.PI * 100 * context.depthMm, afterVolumeMm3: Math.PI * 100 * target },
    candidateRoot: `C:\\OD495\\${job.attemptId}\\candidate`, completedAt: instant, adoption: "unadopted" };
  const active = { scope, jobId: job.jobId, attemptId: job.attemptId, fence: job.fence,
    inputSnapshotId: job.inputSnapshotId, contextSha256: job.contextSha256, outputSnapshotId: job.outputSnapshotId };
  const admission = { contextText, jobText, resultText: JSON.stringify(result), active, storedOutputs: outputFiles,
    storedEvidenceSha256: checks.map((check) => check.evidenceSha256) };
  return { context, contextText, job, jobText, result, admission };
}

describe("cumulative native protocol", () => {
  it("builds an immutable 5 → 8 → 9 → 7 chain from measured stored outputs", async () => {
    let previous = seed();
    for (const target of [8, 9, 7]) {
      const test = fixture(previous, target);
      const job = await readNativeJob(test.jobText, test.contextText);
      expect(job.expectedDepthMm).toBe(previous.depthMm);
      expect(job.inputFiles).toEqual(previous.files);
      const next = await verifiedNativeSuccessor(test.admission);
      expect(next.producer?.inputSnapshotId).toBe(previous.snapshotId);
      expect(next.producer?.inputContextSha256).toBe(hash(test.contextText));
      expect(next.producer?.resultSha256).toBe(hash(test.admission.resultText));
      expect(next.depthMm).toBe(target);
      expect(next.files[2]).toEqual(NATIVE_SEED_FILES[2]);
      expect(Object.isFrozen(next.files[0])).toBe(true);
      previous = next;
    }
    expect(previous.sequence).toBe(3);
    expect(seed().depthMm).toBe(5);
  });

  it.each([
    { schema: "overdrafter.prepared-assembly.v1" }, { producer: {} }, { depthMm: 8 },
    { seedSnapshotId: id(9) }, { sequence: 1 }, { checks: [{ verdict: "pass" }] },
    { scope: { organizationId: "local-engineering", projectId: "prepared-assembly" } },
    { configuration: "Other" }, { createdAt: "2026-02-30T00:00:00.000Z" },
    { files: [...NATIVE_SEED_FILES].reverse() }, { executionAuthorized: true },
  ])("rejects unsupported seed claims %j", (patch) => {
    expect(() => readNativeContext(JSON.stringify({ ...seed(), ...patch }))).toThrow();
  });

  it.each([
    { scope: { organizationId: id(8), projectId: id(2) } }, { inputSnapshotId: id(8) },
    { outputSnapshotId: id(3) }, { seedSnapshotId: id(8) }, { sequence: 2 }, { fence: 0 },
    { fence: 1.5 }, { contextSha256: "f".repeat(64) }, { expectedDepthMm: 8 },
    { requiredChecks: NATIVE_CHECKS.slice(1) }, { depthMm: 5 }, { depthMm: 11 },
    { dimensionId: "other" }, { configuration: "Other" }, { createdAt: "2025-01-01T00:00:00.000Z" },
  ])("rejects mismatched job claims %j", async (patch) => {
    const test = fixture();
    await expect(readNativeJob(JSON.stringify({ ...test.job, ...patch }), test.contextText)).rejects.toThrow();
  });

  it.each(["scope", "jobId", "attemptId", "fence", "inputSnapshotId", "contextSha256", "outputSnapshotId"] as const)("rejects a stale coordinator %s", async (key) => {
    const test = fixture();
    const active = { ...test.admission.active, [key]: "stale" };
    await expect(verifiedNativeSuccessor({ ...test.admission, active })).rejects.toThrow();
  });

  it.each([
    { schema: "overdrafter.prepared-dimension-result.v1" }, { outcome: "failed" }, { failureReason: "Incomplete native save" },
    { adoption: "adopted" }, { fence: 2 }, { attemptId: id(99) }, { outputSnapshotId: id(99) },
    { inputSnapshotId: id(99) }, { requestSha256: "f".repeat(64) }, { checks: [] }, { measurements: null },
  ])("cannot promote an ineligible result %j", async (patch) => {
    const test = fixture();
    await expect(verifiedNativeSuccessor({ ...test.admission, resultText: JSON.stringify({ ...test.result, ...patch }) })).rejects.toThrow();
  });

  it("requires every evidence artifact even when all verdicts say pass", async () => {
    const test = fixture();
    for (let index = 0; index < NATIVE_CHECKS.length; index++) {
      await expect(verifiedNativeSuccessor({ ...test.admission, storedEvidenceSha256: test.admission.storedEvidenceSha256.filter((_, i) => i !== index) })).rejects.toThrow("evidence");
    }
  });

  it("rejects failed, duplicated or wrong-version check identities", async () => {
    const test = fixture();
    for (const patch of [{ verdict: "fail" }, { id: NATIVE_CHECKS[0] }, { id: "native_integrity.v2" }]) {
      const result = { ...test.result, checks: test.result.checks.map((check, i) => i === 1 ? { ...check, ...patch } : check) };
      await expect(verifiedNativeSuccessor({ ...test.admission, resultText: JSON.stringify(result) })).rejects.toThrow();
    }
  });

  it("rejects corrupted uploaded output and companion movement at the identity boundary", async () => {
    const test = fixture();
    for (let index = 0; index < 3; index++) {
      const storedOutputs = test.admission.storedOutputs.map((file, i) => i === index ? { ...file, sha256: "e".repeat(64) } : file);
      await expect(verifiedNativeSuccessor({ ...test.admission, storedOutputs })).rejects.toThrow();
    }
  });

  it("rejects a worker still reporting original-baseline measurements for a successor", async () => {
    const next = await verifiedNativeSuccessor(fixture().admission), test = fixture(next, 9);
    const measurements = { ...test.result.measurements, beforeDepthMm: 5, beforeVolumeMm3: Math.PI * 500 };
    await expect(verifiedNativeSuccessor({ ...test.admission, resultText: JSON.stringify({ ...test.result, measurements }) })).rejects.toThrow("beforeDepthMm");
  });

  it("binds exact JSON bytes and rejects changed context serialization", async () => {
    const test = fixture();
    await expect(readNativeJob(test.jobText, JSON.stringify(test.context, null, 2))).rejects.toThrow("context bytes");
    await expect(verifiedNativeSuccessor({ ...test.admission, jobText: test.jobText + "\n" })).rejects.toThrow("Request bytes");
  });

  it("rejects forged root-file identity, unsafe paths and excessive size", () => {
    for (const patch of [{ sha256: "a".repeat(64) }, { path: "../target.SLDPRT" }, { bytes: 16_000_001 }]) {
      const context = seed();
      expect(() => readNativeContext(JSON.stringify({ ...context, files: context.files.map((file, i) => i === 0 ? { ...file, ...patch } : file) }))).toThrow();
    }
  });
});
