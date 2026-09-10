import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { NATIVE_CHECKS, NATIVE_SEED_FILES, nativeDigest } from "./engineering-cumulative";
import { cumulativePreviewSource, readCumulativePreview } from "./engineering-cumulative-preview";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (n: number) => String(n).repeat(64);
// Synthetic exchange bytes exercise protocol validation, not native geometry.
const stepText = "ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;\nEND-ISO-10303-21;";
async function fixture(candidate = true, step = stepText) {
  const context = {
    schema: "overdrafter.prepared-assembly.v2", packageId: "ovd-native04-assembly",
    scope: { organizationId: id(1), projectId: id(2) }, snapshotId: id(candidate ? 4 : 3), seedSnapshotId: id(3),
    sequence: candidate ? 2 : 0, createdAt: "2026-09-10T00:00:00.000Z", configuration: "Default",
    assemblyPath: "synthetic-assembly.SLDASM", depthMm: candidate ? 9 : 5,
    files: NATIVE_SEED_FILES.map((file, index) => ({ ...file, sha256: candidate && index < 2 ? hash(index + 1) : file.sha256 })),
    producer: candidate ? { jobId: id(6), attemptId: id(7), fence: 2, inputSnapshotId: id(5),
      inputContextSha256: hash(3), requestSha256: hash(4), resultSha256: hash(5) } : null,
    checks: candidate ? NATIVE_CHECKS.map((check) => ({ id: check, verdict: "pass", evidenceSha256: hash(6) })) : [],
  };
  const contextText = JSON.stringify(context);
  const preview = {
    schema: "overdrafter.prepared-step-preview.v2", scope: context.scope, snapshotId: context.snapshotId,
    contextSha256: await nativeDigest(contextText), role: candidate ? "candidate" : "baseline",
    requestSha256: context.producer?.requestSha256 ?? null, resultSha256: context.producer?.resultSha256 ?? null,
    configuration: "Default", nativeFiles: context.files,
    step: { fileName: "assembly.step", bytes: step.length, sha256: await nativeDigest(step), base64: btoa(step) },
    export: { nativeVersion: "30.5.0", reportSha256: hash(7), sourceCommit: "a".repeat(40) },
    limitations: ["Imported operator evidence; no release authority."],
  };
  return { context, contextText, preview };
}

describe("cumulative STEP preview binding", () => {
  it("preserves all byte values when checking the STEP digest and loading the renderer", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([Buffer.from("ISO-10303-21;\n"),
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)), Buffer.from("\nEND-ISO-10303-21;")]);
    f.preview.step = { fileName: "assembly.step", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
    const preview = await readCumulativePreview(JSON.stringify(f.preview), f.contextText);
    expect(Array.from(await cumulativePreviewSource(preview).loadStepBuffer())).toEqual(Array.from(bytes));
  });
  it.each([false, true])("accepts an exact %s snapshot without conferring verification", async (candidate) => {
    const f = await fixture(candidate);
    const result = await readCumulativePreview(JSON.stringify(f.preview), f.contextText);
    expect(result).toEqual(f.preview);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scope)).toBe(true);
    expect(Object.isFrozen(result.nativeFiles[0])).toBe(true);
    expect(Object.isFrozen(result.step)).toBe(true);
    expect(Object.isFrozen(result.limitations)).toBe(true);
    const source = cumulativePreviewSource(result);
    expect(source.cacheKey).toContain(f.preview.step.sha256);
    expect(new TextDecoder().decode(await source.loadStepBuffer())).toBe(stepText);
  });

  it.each(["schema", "snapshotId", "contextSha256", "role", "configuration", "requestSha256", "resultSha256"])("rejects a foreign %s", async (field) => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify({ ...f.preview, [field]: "foreign" }), f.contextText)).rejects.toThrow();
  });
  it.each(["organizationId", "projectId"])("rejects a foreign %s even with identical files", async (field) => {
    const f = await fixture();
    f.preview.scope = { ...f.preview.scope, [field]: id(90) };
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/scope/);
  });
  it("binds exact context bytes, including producer history", async () => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText + "\n")).rejects.toThrow(/context/);
    f.context.producer!.fence++;
    await expect(readCumulativePreview(JSON.stringify(f.preview), JSON.stringify(f.context))).rejects.toThrow(/context/);
  });
  it.each(["missing", "failed", "duplicate"])("rejects %s context checks despite a matching context hash", async (kind) => {
    const f = await fixture();
    if (kind === "missing") f.context.checks.pop();
    else if (kind === "failed") f.context.checks[0].verdict = "fail";
    else f.context.checks[1] = f.context.checks[0];
    const text = JSON.stringify(f.context);
    f.preview.contextSha256 = await nativeDigest(text);
    await expect(readCumulativePreview(JSON.stringify(f.preview), text)).rejects.toThrow();
  });
  it.each(["bytes", "sha256", "path", "extra"])("rejects altered native %s", async (field) => {
    const f = await fixture();
    f.preview.nativeFiles[0] = { ...f.preview.nativeFiles[0], [field]: "changed" } as typeof f.preview.nativeFiles[0];
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/Native/);
  });
  it("rejects native file reordering and incomplete closure", async () => {
    const f = await fixture();
    f.preview.nativeFiles.reverse();
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/Native/);
    f.preview.nativeFiles.pop();
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/Native/);
  });
  it("prevents seed previews from claiming candidate authority", async () => {
    const f = await fixture(false);
    f.preview.requestSha256 = hash(4);
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/producer/);
  });
  it.each(["bytes", "sha256", "fileName", "base64"])("rejects corrupt STEP %s", async (field) => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify({ ...f.preview, step: { ...f.preview.step, [field]: "invalid" } }), f.contextText)).rejects.toThrow();
  });
  it("rejects byte changes and noncanonical encoding", async () => {
    const f = await fixture();
    f.preview.step.base64 = btoa(stepText.replace("DATA", "TEST"));
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/bytes/);
    f.preview.step.base64 = btoa(stepText) + "\n";
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/base64/);
  });
  it.each(["ISO-10303-21;missing footer", "missing header;END-ISO-10303-21;"])("requires both STEP exchange markers: %s", async (step) => {
    const f = await fixture(true, step);
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/exchange/);
  });
  it("accepts the exact byte limit and rejects larger STEP/JSON", async () => {
    const header = "ISO-10303-21;";
    const footer = "END-ISO-10303-21;";
    const text = header + " ".repeat(2_000_000 - header.length - footer.length) + footer;
    const exact = await fixture(true, text);
    expect(exact.preview.step.bytes).toBe(2_000_000);
    await expect(readCumulativePreview(JSON.stringify(exact.preview), exact.contextText)).resolves.toBeDefined();
    const f = await fixture(true, text + " ");
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/size/);
    f.preview.step.bytes = 2_000_000;
    await expect(readCumulativePreview(JSON.stringify(f.preview), f.contextText)).rejects.toThrow(/bytes/);
    await expect(readCumulativePreview(JSON.stringify(f.preview).padEnd(3_000_001), f.contextText)).rejects.toThrow(/limit/);
  });
  it.each([null, [], {}, { verified: true }])("rejects malformed top-level input %j", async (value) => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify(value), f.contextText)).rejects.toThrow();
  });
  it.each(["export", "limitations"])("rejects incomplete %s", async (field) => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify({ ...f.preview, [field]: {} }), f.contextText)).rejects.toThrow();
  });
  it("rejects unknown fields rather than importing authority claims", async () => {
    const f = await fixture();
    await expect(readCumulativePreview(JSON.stringify({ ...f.preview, verified: true }), f.contextText)).rejects.toThrow();
  });
});
