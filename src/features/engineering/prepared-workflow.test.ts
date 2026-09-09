// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { create, getJobText, importContext, importResult, queue, restore, serialize, type PreparedContext, type PreparedResult, type Workbench, type WorkbenchRecord } from "./prepared-workflow";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function context(): PreparedContext {
  return {
    schema: "overdrafter.prepared-assembly.v1", packageId: "ovd-native04-assembly",
    scope: { organizationId: "local-engineering", projectId: "prepared-assembly" },
    capturedAt: "2020-01-01T00:00:00.000Z", configuration: "Default", assemblyPath: "synthetic-assembly.SLDASM",
    files: [
      { path: "synthetic-assembly.SLDASM", bytes: 59987, sha256: "90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a" },
      { path: "parts/baseline-5mm.SLDPRT", bytes: 56144, sha256: "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa" },
      { path: "parts/candidate-8mm.SLDPRT", bytes: 56171, sha256: "b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898" },
    ],
    dimension: { id: "baseline-depth", occurrence: "baseline-5mm-1", feature: "OVD_QualificationExtrusion", partPath: "parts/baseline-5mm.SLDPRT", unit: "mm", baseline: 5, minimum: 6, maximum: 10 },
    limitations: ["Synthetic fixed assembly; no mates or drawings.", "Imported operator evidence; source freshness is rechecked by the runner."],
  };
}
async function queued(depth = 8): Promise<Workbench> { return queue(await create(JSON.stringify(context(), null, 2) + "\n"), depth); }
function receipt(record: WorkbenchRecord): PreparedResult {
  return {
    schema: "overdrafter.prepared-dimension-result.v1", jobId: record.job.jobId, attemptId: record.job.attemptId,
    requestSha256: record.requestSha256, contextSha256: record.job.contextSha256, depthMm: record.job.depthMm,
    outcome: "succeeded", failureReason: null, inputFiles: clone(record.job.inputFiles),
    outputFiles: [
      { path: "synthetic-assembly.SLDASM", bytes: 61001, sha256: "a".repeat(64) },
      { path: "parts/baseline-5mm.SLDPRT", bytes: 57101, sha256: "b".repeat(64) },
      clone(record.job.inputFiles[2]),
    ],
    checks: record.job.requiredChecks.map((id) => ({ id, verdict: "pass", evidenceSha256: hash(id) })),
    measurements: { beforeDepthMm: 5, afterDepthMm: record.job.depthMm, beforeVolumeMm3: Math.PI * 500, afterVolumeMm3: Math.PI * 100 * record.job.depthMm },
    candidateRoot: "C:\\OverDrafterQualification\\private-attempt-1", completedAt: record.job.createdAt, adoption: "unadopted",
  };
}

describe("prepared assembly context and independent intent", () => {
  it("pins all native input identities and hashes the exact imported text", async () => {
    const source = JSON.stringify(context(), null, 2) + "\n";
    const workbench = await importContext(source);
    expect(workbench.contextSha256).toBe(hash(source));
    expect(workbench.contextText).toBe(source);
    expect(Object.fromEntries(workbench.engineeringState.baseline.artifacts.map((item) => [item.artifactId, item.contentHash]))).toEqual(Object.fromEntries(context().files.map((item) => [item.path, item.sha256])));
    expect(workbench.engineeringState.tasks).toEqual([]);
    const compact = await importContext(JSON.stringify(context()));
    expect(compact.contextSha256).not.toBe(workbench.contextSha256);
    expect(compact.engineeringState.baseline.canonicalKey).not.toBe(workbench.engineeringState.baseline.canonicalKey);
  });

  it.each([
    ["unit", (item: Record<string, unknown>) => { item.dimension = { ...context().dimension, unit: "m" }; }],
    ["range", (item: Record<string, unknown>) => { item.dimension = { ...context().dimension, maximum: 20 }; }],
    ["dimension ID", (item: Record<string, unknown>) => { item.dimension = { ...context().dimension, id: "other" }; }],
    ["tenant", (item: Record<string, unknown>) => { item.scope = { ...context().scope, organizationId: "other-org" }; }],
    ["configuration", (item: Record<string, unknown>) => { item.configuration = "Other"; }],
    ["native hash", (item: Record<string, unknown>) => { item.files = context().files.map((file, index) => index === 0 ? { ...file, sha256: "c".repeat(64) } : file); }],
    ["file byte count", (item: Record<string, unknown>) => { item.files = context().files.map((file, index) => index === 0 ? { ...file, bytes: 59988 } : file); }],
    ["file traversal", (item: Record<string, unknown>) => { item.files = [{ ...context().files[0], path: "../synthetic-assembly.SLDASM" }, ...context().files.slice(1)]; }],
    ["duplicate file", (item: Record<string, unknown>) => { item.files = [...context().files, context().files[0]]; }],
    ["timestamp", (item: Record<string, unknown>) => { item.capturedAt = "2026-02-30T00:00:00.000Z"; }],
    ["extra authority", (item: Record<string, unknown>) => { item.executionAuthorized = true; }],
  ])("rejects a context with altered %s", async (_name, change) => {
    const input = clone(context()) as unknown as Record<string, unknown>;
    change(input);
    await expect(importContext(JSON.stringify(input))).rejects.toThrow();
  });

  it.each(["", "not JSON", "\uFEFF{}", "null", "[]"])("rejects malformed context %j", async (text) => {
    await expect(importContext(text)).rejects.toThrow();
  });

  it("queues immutable independent snapshots and exact reproducible export bytes without dispatching", async () => {
    const original = await importContext(JSON.stringify(context()));
    const first = await queue(original, 6);
    const second = await queue(first, 10);
    expect(original.records).toHaveLength(0);
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(2);
    expect(second.engineeringState.tasks).toEqual([]);
    expect(second.engineeringState.decisions.map((item) => [item.disposition, item.dependencies])).toEqual([["accepted", []], ["accepted", []]]);
    for (const record of second.records) {
      expect(record.execution).toBe("waiting");
      expect(record.checks).toBe("unverified");
      expect(record.result).toBeNull();
      expect(getJobText(record)).toBe(JSON.stringify(record.job, null, 2) + "\n");
      expect(record.requestSha256).toBe(hash(getJobText(record)));
      const snapshot = JSON.parse(record.snapshotKey);
      expect(snapshot.binding.includedDecisions).toHaveLength(1);
      expect(snapshot.binding.includedDecisions[0].decisionId).toBe(record.job.jobId);
      expect(snapshot.binding.baselineSnapshotId).toBe(original.contextSha256);
      expect(Object.isFrozen(record.job.inputFiles[0])).toBe(true);
    }
    expect(second.records[0].snapshotKey).not.toBe(second.records[1].snapshotKey);
    expect(() => (second.records as WorkbenchRecord[]).pop()).toThrow();
    expect(() => { (second.context.dimension as { baseline: number }).baseline = 99; }).toThrow();
  });

  it("enforces the Workstation context byte limit before accepting a request", async () => {
    const source = JSON.stringify(context());
    const exactLimit = source.padEnd(65536, " ");
    await expect(importContext(exactLimit)).resolves.toMatchObject({ contextText: exactLimit });
    await expect(importContext(exactLimit + " ")).rejects.toThrow("64 KiB");
  });

  it.each([5, 10.01, Number.NaN, Number.POSITIVE_INFINITY, "8", null])("rejects malformed or out-of-range depth %j", async (depth) => {
    const workbench = await importContext(JSON.stringify(context()));
    await expect(queue(workbench, depth as number)).rejects.toThrow();
    expect(workbench.records).toHaveLength(0);
  });

  it("caps recorded independent requests at five", async () => {
    let workbench = await importContext(JSON.stringify(context()));
    for (let index = 0; index < 5; index += 1) workbench = await queue(workbench, 6 + index);
    await expect(queue(workbench, 8)).rejects.toThrow(/five requests/);
  });
});

describe("imported native evidence", () => {
  it("records passed checks and measurements only for the exact request, leaving intent state and adoption distinct", async () => {
    const waiting = await queued();
    const text = JSON.stringify(receipt(waiting.records[0]), null, 2) + "\n";
    const checked = await importResult(waiting, text);
    expect(waiting.records[0].result).toBeNull();
    expect(checked.records[0]).toMatchObject({ execution: "succeeded", checks: "passed", intent: "accepted", adoption: "unadopted", resultText: text });
    expect(checked.records[0].result?.measurements?.afterDepthMm).toBe(8);
    expect(checked.engineeringState).toBe(waiting.engineeringState);
    expect(await importResult(checked, text)).toBe(checked);
    expect(Object.isFrozen(checked.records[0].result?.checks[0])).toBe(true);
    await expect(importResult(checked, JSON.stringify(receipt(waiting.records[0])))).rejects.toThrow(/different result/);
  });

  it("retains a truthful failed receipt with partial evidence and never reports passed checks", async () => {
    const workbench = await queued();
    const failed = { ...receipt(workbench.records[0]), outcome: "failed", failureReason: "Native reopen could not be verified.", outputFiles: [], checks: [], measurements: null, candidateRoot: null };
    const result = await importResult(workbench, JSON.stringify(failed));
    expect(result.records[0]).toMatchObject({ execution: "failed", checks: "failed", adoption: "unadopted" });
    expect(result.records[0].result?.failureReason).toBe(failed.failureReason);
    await expect(importResult(result, JSON.stringify(receipt(workbench.records[0])))).rejects.toThrow(/different result/);
  });

  it.each([{ inputFiles: [] }, { inputFiles: [{ path: "parts/baseline-5mm.SLDPRT", bytes: 56145, sha256: "f".repeat(64) }] }])("retains failed admission observations $inputFiles without requiring unchanged originals", async ({ inputFiles }) => {
    const workbench = await queued();
    const failed = { ...receipt(workbench.records[0]), outcome: "failed", failureReason: "Original input is unavailable or changed.", inputFiles, outputFiles: [], checks: [], measurements: null, candidateRoot: null };
    const imported = await importResult(workbench, JSON.stringify(failed));
    expect(imported.records[0]).toMatchObject({ execution: "failed", checks: "failed" });
    expect(imported.records[0].result?.inputFiles).toEqual(inputFiles);
    expect((await restore(serialize(imported))).records[0].result).toEqual(imported.records[0].result);
  });

  it.each([
    ["foreign job", (item: Record<string, unknown>) => { item.jobId = "1d95b9d4-50b8-4799-b21d-bf26e659ce36"; }],
    ["stale attempt", (item: Record<string, unknown>) => { item.attemptId = "1d95b9d4-50b8-4799-b21d-bf26e659ce36"; }],
    ["wrong request hash", (item: Record<string, unknown>) => { item.requestSha256 = "c".repeat(64); }],
    ["uppercase hash", (item: Record<string, unknown>) => { item.requestSha256 = "A".repeat(64); }],
    ["wrong context", (item: Record<string, unknown>) => { item.contextSha256 = "c".repeat(64); }],
    ["wrong depth", (item: Record<string, unknown>) => { item.depthMm = 9; }],
    ["stale timestamp", (item: Record<string, unknown>) => { item.completedAt = "2020-01-01T00:00:00.000Z"; }],
    ["adoption claim", (item: Record<string, unknown>) => { item.adoption = "adopted"; }],
    ["incomplete checks", (item: Record<string, unknown>) => { item.checks = (item.checks as unknown[]).slice(1); }],
    ["failed mandatory check", (item: Record<string, unknown>) => { item.checks = (item.checks as object[]).map((check, index) => index === 0 ? { ...check, verdict: "fail" } : check); }],
    ["duplicate check", (item: Record<string, unknown>) => { item.checks = [...(item.checks as unknown[]), (item.checks as unknown[])[0]]; }],
    ["unsupported check", (item: Record<string, unknown>) => { item.checks = [{ id: "looks_good", verdict: "pass", evidenceSha256: "a".repeat(64) }, ...(item.checks as unknown[]).slice(1)]; }],
    ["missing evidence digest", (item: Record<string, unknown>) => { item.checks = (item.checks as object[]).map((check, index) => index === 0 ? { ...check, evidenceSha256: "" } : check); }],
    ["missing output", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as unknown[]).slice(1); }],
    ["duplicate output", (item: Record<string, unknown>) => { item.outputFiles = [...(item.outputFiles as unknown[]), (item.outputFiles as unknown[])[0]]; }],
    ["zero output bytes", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as object[]).map((file, index) => index === 0 ? { ...file, bytes: 0 } : file); }],
    ["fractional output bytes", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as object[]).map((file, index) => index === 0 ? { ...file, bytes: 1.5 } : file); }],
    ["absent output bytes", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as Record<string, unknown>[]).map((file, index) => { const copy = { ...file }; if (index === 0) delete copy.bytes; return copy; }); }],
    ["unchanged target", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as object[]).map((file, index) => index === 1 ? context().files[1] : file); }],
    ["changed companion bytes", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as object[]).map((file, index) => index === 2 ? { ...file, bytes: 56172 } : file); }],
    ["changed companion hash", (item: Record<string, unknown>) => { item.outputFiles = (item.outputFiles as object[]).map((file, index) => index === 2 ? { ...file, sha256: "d".repeat(64) } : file); }],
    ["altered input", (item: Record<string, unknown>) => { item.inputFiles = context().files.map((file, index) => index === 0 ? { ...file, bytes: 1 } : file); }],
    ["missing measurements", (item: Record<string, unknown>) => { item.measurements = null; }],
    ["wrong cylinder volume", (item: Record<string, unknown>) => { item.measurements = { ...(item.measurements as object), afterVolumeMm3: 100 }; }],
    ["wrong measured depth", (item: Record<string, unknown>) => { item.measurements = { ...(item.measurements as object), afterDepthMm: 7 }; }],
    ["nonfinite measurements", (item: Record<string, unknown>) => { item.measurements = { ...(item.measurements as object), beforeVolumeMm3: Number.POSITIVE_INFINITY }; }],
    ["relative candidate", (item: Record<string, unknown>) => { item.candidateRoot = "private/output"; }],
    ["candidate traversal", (item: Record<string, unknown>) => { item.candidateRoot = "C:\\private\\..\\source"; }],
    ["missing candidate", (item: Record<string, unknown>) => { item.candidateRoot = null; }],
    ["failure without reason", (item: Record<string, unknown>) => { item.outcome = "failed"; item.failureReason = null; }],
    ["success with failure reason", (item: Record<string, unknown>) => { item.failureReason = "cleanup failed"; }],
    ["unknown authority field", (item: Record<string, unknown>) => { item.executionAuthorized = true; }],
  ])("rejects receipt with %s without changing waiting state", async (_name, change) => {
    const workbench = await queued();
    const input = clone(receipt(workbench.records[0])) as unknown as Record<string, unknown>;
    change(input);
    await expect(importResult(workbench, JSON.stringify(input))).rejects.toThrow();
    expect(workbench.records[0]).toMatchObject({ execution: "waiting", result: null });
  });

  it("accepts boundary-tolerant native measurements and does not require changed file size", async () => {
    const workbench = await queued();
    const input = receipt(workbench.records[0]);
    const tolerant = { ...input, outputFiles: input.outputFiles.map((file, index) => index === 1 ? { ...file, bytes: context().files[1].bytes } : file), measurements: { ...input.measurements!, afterDepthMm: 8 + 0.5e-7, afterVolumeMm3: Math.PI * 800 + 0.05 } };
    expect((await importResult(workbench, JSON.stringify(tolerant))).records[0].checks).toBe("passed");
  });
});

describe("safe persistence replay", () => {
  it("rejects an individually valid receipt that exceeds the escaped aggregate storage budget", async () => {
    const workbench = await queued();
    const text = JSON.stringify(receipt(workbench.records[0]));
    await expect(importResult(workbench, text.padEnd(1_999_999))).rejects.toThrow(/storage budget/);
    expect(await restore(serialize(workbench))).toEqual(workbench);
    expect(workbench.records[0].result).toBeNull();
  });

  it("keeps prior evidence restorable when multiple receipts exceed the aggregate budget", async () => {
    let workbench = await queued();
    workbench = await queue(workbench, 9);
    workbench = await importResult(workbench, JSON.stringify(receipt(workbench.records[0])).padEnd(1_100_000));
    const saved = serialize(workbench);
    await expect(importResult(workbench, JSON.stringify(receipt(workbench.records[1])).padEnd(1_100_000))).rejects.toThrow(/storage budget/);
    expect(serialize(await restore(saved))).toBe(saved);
    expect(workbench.records[1].result).toBeNull();
  });

  it("replays exact whitespace, decisions, bindings and imported receipts without restoring worker claims", async () => {
    let workbench = await queued(7.5);
    workbench = await importResult(workbench, JSON.stringify(receipt(workbench.records[0]), null, 2) + "\n");
    workbench = await queue(workbench, 9);
    const saved = serialize(workbench);
    const restored = await restore(saved);
    expect(serialize(restored)).toBe(saved);
    expect(restored).toEqual(workbench);
    expect(restored.engineeringState.tasks).toEqual([]);
    expect(restored.records.map((record) => record.execution)).toEqual(["succeeded", "waiting"]);
    expect(Object.isFrozen(restored.records[0].result)).toBe(true);
  });

  it.each([
    ["forged status", (saved: Record<string, unknown>) => { saved.status = "passed"; }],
    ["forged record status", (saved: Record<string, unknown>) => { (saved.records as Record<string, unknown>[])[0].execution = "succeeded"; }],
    ["forged snapshot binding", (saved: Record<string, unknown>) => { const record = (saved.records as Record<string, unknown>[])[0]; const snapshot = JSON.parse(record.snapshotKey as string); snapshot.binding.scope.organizationId = "other"; record.snapshotKey = JSON.stringify(snapshot); }],
    ["wrong saved context hash", (saved: Record<string, unknown>) => { saved.contextSha256 = "a".repeat(64); }],
    ["changed exact context text", (saved: Record<string, unknown>) => { saved.contextText += "\n"; }],
    ["changed normalized context", (saved: Record<string, unknown>) => { saved.context = { ...context(), configuration: "Other" }; }],
    ["changed exact job bytes", (saved: Record<string, unknown>) => { (saved.records as Record<string, unknown>[])[0].jobText += " "; }],
    ["changed job depth", (saved: Record<string, unknown>) => { const record = (saved.records as Record<string, unknown>[])[0]; const job = JSON.parse(record.jobText as string); job.depthMm = 9; record.jobText = JSON.stringify(job, null, 2) + "\n"; }],
    ["invalid job UUID", (saved: Record<string, unknown>) => { const record = (saved.records as Record<string, unknown>[])[0]; const job = JSON.parse(record.jobText as string); job.jobId = "job-1"; record.jobText = JSON.stringify(job, null, 2) + "\n"; }],
    ["duplicate attempt", (saved: Record<string, unknown>) => { (saved.records as unknown[]).push((saved.records as unknown[])[0]); }],
    ["forged imported success", (saved: Record<string, unknown>) => { (saved.records as Record<string, unknown>[])[0].resultText = JSON.stringify({ outcome: "succeeded" }); }],
    ["changed saved request digest", (saved: Record<string, unknown>) => { (saved.records as Record<string, unknown>[])[0].requestSha256 = "a".repeat(64); }],
  ])("rejects %s", async (_name, change) => {
    const saved = JSON.parse(serialize(await queued()));
    change(saved);
    await expect(restore(JSON.stringify(saved))).rejects.toThrow();
  });

  it("does not accept a forged runtime workbench as already validated", async () => {
    const workbench = clone(await queued());
    await expect(queue(workbench, 8)).rejects.toThrow(/not validated/);
    await expect(importResult(workbench, "{}")).rejects.toThrow(/not validated/);
    expect(() => serialize(workbench)).toThrow(/not validated/);
  });
});
