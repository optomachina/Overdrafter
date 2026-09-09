// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findPreparedPreview, parsePreparedPreview, preparedPreviewSource,
  PREVIEW_IMPORT_LIMIT, PREVIEW_STORAGE_LIMIT, restorePreparedPreviews, savePreparedPreviews,
} from "./prepared-preview";
import { create, importResult, queue, type PreparedResult, type Workbench, type WorkbenchRecord } from "./prepared-workflow";

const contextText = readFileSync(new URL("../../../e2e/fixtures/prepared-assembly-context.json", import.meta.url), "utf8");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Deliberately only a STEP exchange header: these tests exercise admission, not geometry or triangulation.
const stepFixture = "ISO-10303-21;\n";

function receipt(record: WorkbenchRecord): PreparedResult {
  return {
    schema: "overdrafter.prepared-dimension-result.v1", jobId: record.job.jobId, attemptId: record.job.attemptId,
    requestSha256: record.requestSha256, contextSha256: record.job.contextSha256, depthMm: record.job.depthMm,
    outcome: "succeeded", failureReason: null, inputFiles: record.job.inputFiles,
    outputFiles: [
      { path: "synthetic-assembly.SLDASM", bytes: 61001, sha256: "a".repeat(64) },
      { path: "parts/baseline-5mm.SLDPRT", bytes: 57101, sha256: "b".repeat(64) },
      record.job.inputFiles[2],
    ],
    checks: record.job.requiredChecks.map((id) => ({ id, verdict: "pass", evidenceSha256: hash(id) })),
    measurements: { beforeDepthMm: 5, afterDepthMm: record.job.depthMm, beforeVolumeMm3: Math.PI * 500, afterVolumeMm3: Math.PI * 100 * record.job.depthMm },
    candidateRoot: "C:\\OverDrafterQualification\\private-preview-test", completedAt: record.job.createdAt, adoption: "unadopted",
  };
}

async function completed(): Promise<Workbench> {
  const waiting = await queue(await create(contextText), 8);
  return importResult(waiting, JSON.stringify(receipt(waiting.records[0]), null, 2) + "\n");
}

function preview(workbench: Workbench, record?: WorkbenchRecord, stepText = stepFixture) {
  const files = record?.result?.outputFiles ?? workbench.context.files;
  return {
    schema: "overdrafter.prepared-step-preview.v1", contextSha256: workbench.contextSha256,
    role: record ? "candidate" : "baseline", requestSha256: record?.requestSha256 ?? null,
    resultSha256: record?.resultText ? hash(record.resultText) : null, configuration: "Default",
    nativeFiles: files.map((file) => ({ ...file })),
    step: { fileName: "assembly.step", bytes: Buffer.byteLength(stepText), sha256: hash(stepText), base64: Buffer.from(stepText).toString("base64") },
    export: { nativeVersion: "30.5.0", reportSha256: hash("unit-test export report"), sourceCommit: "c".repeat(40) as string | null },
    limitations: ["Parser contract fixture only; no actual geometry or native export is claimed."],
  };
}

describe("prepared CAD preview identity", () => {
  it("accepts an exact baseline, keeps immutable evidence, and loads the hashed STEP bytes", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    const text = JSON.stringify(input, null, 2) + "\n";
    const entry = await parsePreparedPreview(text, workbench);
    expect(entry.text).toBe(text);
    expect(findPreparedPreview([entry], workbench)).toBe(entry);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.preview.nativeFiles[0])).toBe(true);
    expect(Object.isFrozen(entry.preview.step)).toBe(true);
    expect(Object.isFrozen(entry.preview.export)).toBe(true);
    expect(Object.isFrozen(entry.preview.limitations)).toBe(true);
    const source = preparedPreviewSource(entry);
    expect(source.cacheKey).toContain(input.step.sha256);
    expect(source.fileName).toMatch(/\.step$/);
    const bytes = await source.loadStepBuffer();
    expect(hash(bytes)).toBe(input.step.sha256);
    bytes.fill(0);
    expect(hash(await source.loadStepBuffer())).toBe(input.step.sha256);
  });

  it("selects a candidate only after importing its actual matching successful receipt", async () => {
    const workbench = await completed();
    const record = workbench.records[0];
    const entry = await parsePreparedPreview(JSON.stringify(preview(workbench, record)), workbench);
    expect(findPreparedPreview([entry], workbench, record)).toBe(entry);
    expect(findPreparedPreview([entry], workbench)).toBeUndefined();
    expect(record.adoption).toBe("unadopted");
    expect(entry.preview.nativeFiles).toEqual(record.result?.outputFiles);
  });

  it("does not substitute another request's geometry merely because its requested depth is equal", async () => {
    let workbench = await completed();
    workbench = await queue(workbench, 8);
    const entry = await parsePreparedPreview(JSON.stringify(preview(workbench, workbench.records[0])), workbench);
    expect(findPreparedPreview([entry], workbench, workbench.records[1])).toBeUndefined();
  });

  it.each(["waiting", "failed"])("rejects a candidate whose native request is %s", async (state) => {
    let workbench = await queue(await create(contextText), 8);
    const success = receipt(workbench.records[0]);
    if (state === "failed") {
      workbench = await importResult(workbench, JSON.stringify({ ...success, outcome: "failed", failureReason: "Reopen failed.", outputFiles: [], checks: [], measurements: null, candidateRoot: null }));
    }
    const input = { ...preview(workbench, workbench.records[0]), resultSha256: hash(JSON.stringify(success)) };
    await expect(parsePreparedPreview(JSON.stringify(input), workbench)).rejects.toThrow(/matching successful native result/);
  });

  it("rejects a foreign request or result even when the declared native files match", async () => {
    const workbench = await completed();
    const input = preview(workbench, workbench.records[0]);
    for (const field of ["requestSha256", "resultSha256"] as const) {
      await expect(parsePreparedPreview(JSON.stringify({ ...input, [field]: "f".repeat(64) }), workbench)).rejects.toThrow();
    }
  });

  it("does not select a preview for a different exact receipt with identical output geometry identities", async () => {
    const waiting = await queue(await create(contextText), 8);
    const receiptText = JSON.stringify(receipt(waiting.records[0]));
    const first = await importResult(waiting, receiptText);
    const second = await importResult(waiting, receiptText + "\n");
    const entry = await parsePreparedPreview(JSON.stringify(preview(first, first.records[0])), first);
    await expect(parsePreparedPreview(entry.text, second)).rejects.toThrow(/different native result/);
    expect(findPreparedPreview([entry], second, second.records[0])).toBeUndefined();
  });

  it("treats changed exact context bytes as stale even when normalized source files match", async () => {
    const first = await create(contextText);
    const second = await create(contextText + "\n");
    const entry = await parsePreparedPreview(JSON.stringify(preview(first)), first);
    await expect(parsePreparedPreview(entry.text, second)).rejects.toThrow(/different assembly context/);
    expect(findPreparedPreview([entry], second)).toBeUndefined();
  });

  it("prevents a baseline from claiming request or result authority", async () => {
    const workbench = await create(contextText);
    for (const field of ["requestSha256", "resultSha256"] as const) {
      await expect(parsePreparedPreview(JSON.stringify({ ...preview(workbench), [field]: "d".repeat(64) }), workbench)).rejects.toThrow(/must not claim/);
    }
  });

  it("rejects missing, duplicate, foreign, altered, or path-normalized native closure entries", async () => {
    const workbench = await completed();
    const input = preview(workbench, workbench.records[0]);
    const [first, ...remaining] = input.nativeFiles;
    const invalid = [
      remaining, [first, first, remaining[0]], [...input.nativeFiles, first],
      [{ ...first, sha256: "f".repeat(64) }, ...remaining],
      [{ ...first, bytes: first.bytes + 1 }, ...remaining],
      [{ ...first, path: `./${first.path}` }, ...remaining],
      workbench.context.files,
    ];
    for (const nativeFiles of invalid) {
      await expect(parsePreparedPreview(JSON.stringify({ ...input, nativeFiles }), workbench)).rejects.toThrow(/closure/);
    }
  });

  it("compares the native closure by exact path identity independent of manifest order", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    input.nativeFiles.reverse();
    const entry = await parsePreparedPreview(JSON.stringify(input), workbench);
    expect(findPreparedPreview([entry], workbench)).toBe(entry);
  });

  it("rejects added authority fields and malformed nested native records", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    for (const value of [
      { ...input, releaseApproved: true },
      { ...input, nativeFiles: [{ ...input.nativeFiles[0], writable: true }, ...input.nativeFiles.slice(1)] },
      { ...input, step: { ...input.step, trusted: true } },
      { ...input, export: { ...input.export, verified: true } },
    ]) await expect(parsePreparedPreview(JSON.stringify(value), workbench)).rejects.toThrow(/missing or unexpected fields/);
  });
});

describe("bounded STEP and conversion evidence", () => {
  it.each(["digest", "byte count", "payload"])("rejects STEP %s tampering", async (kind) => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    if (kind === "digest") input.step.sha256 = "d".repeat(64);
    else if (kind === "byte count") input.step.bytes += 1;
    else input.step.base64 = Buffer.from(stepFixture.replace("ISO", "BAD")).toString("base64");
    await expect(parsePreparedPreview(JSON.stringify(input), workbench)).rejects.toThrow(/declared identity/);
  });

  it("rejects noncanonical padding, whitespace, and invalid base64 characters", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encoded = input.step.base64;
    const changedPadding = encoded.slice(0, -2) + alphabet[alphabet.indexOf(encoded.at(-2)!) + 1] + "=";
    expect(Buffer.from(changedPadding, "base64")).toEqual(Buffer.from(encoded, "base64"));
    for (const base64 of [changedPadding, `${encoded}\n`, `!${encoded.slice(1)}`]) {
      await expect(parsePreparedPreview(JSON.stringify({ ...input, step: { ...input.step, base64 } }), workbench)).rejects.toThrow(/base64/);
    }
  });

  it("rejects correctly hashed bytes that are not a STEP exchange file", async () => {
    const workbench = await create(contextText);
    await expect(parsePreparedPreview(JSON.stringify(preview(workbench, undefined, "not a STEP file")), workbench)).rejects.toThrow(/not a STEP exchange file/);
  });

  it("accepts exactly 2 MB of STEP bytes and rejects the next byte", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench, undefined, stepFixture.padEnd(2_000_000));
    expect((await parsePreparedPreview(JSON.stringify(input), workbench)).preview.step.bytes).toBe(2_000_000);
    const larger = preview(workbench, undefined, stepFixture.padEnd(2_000_001));
    await expect(parsePreparedPreview(JSON.stringify(larger), workbench)).rejects.toThrow(/size/);
  });

  it("enforces the JSON admission limit in UTF-8 bytes, including exact boundary whitespace", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    const exact = JSON.stringify(input).padEnd(PREVIEW_IMPORT_LIMIT);
    await expect(parsePreparedPreview(exact, workbench)).resolves.toMatchObject({ text: exact });
    await expect(parsePreparedPreview(exact + " ", workbench)).rejects.toThrow(/limit/);
    input.limitations = ["é".repeat(400)];
    const multibyte = JSON.stringify(input).padEnd(PREVIEW_IMPORT_LIMIT - 1);
    expect(multibyte.length).toBeLessThan(PREVIEW_IMPORT_LIMIT);
    await expect(parsePreparedPreview(multibyte, workbench)).rejects.toThrow(/limit/);
  });

  it("rejects malformed, foreign, or unsupported preview contracts", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    for (const text of ["", "null", "[]", "not JSON", `\uFEFF${JSON.stringify(input)}`, JSON.stringify({ ...input, schema: "foreign.preview.v1" }), JSON.stringify({ ...input, configuration: "Other" }), JSON.stringify({ ...input, role: "released" })]) {
      await expect(parsePreparedPreview(text, workbench)).rejects.toThrow();
    }
  });

  it("requires the qualified native version and valid export digests without inventing a source commit", async () => {
    const workbench = await create(contextText);
    const input = preview(workbench);
    input.export.sourceCommit = null;
    await expect(parsePreparedPreview(JSON.stringify(input), workbench)).resolves.toBeDefined();
    for (const changed of [{ nativeVersion: "31.0.0" }, { reportSha256: "A".repeat(64) }, { sourceCommit: "main" }]) {
      await expect(parsePreparedPreview(JSON.stringify({ ...input, export: { ...input.export, ...changed } }), workbench)).rejects.toThrow(/provenance/);
    }
  });

  it("requires nonempty bounded translation limitations", async () => {
    const workbench = await create(contextText);
    for (const limitations of [[], [" "], ["x".repeat(501)], Array(11).fill("limitation"), [42]]) {
      await expect(parsePreparedPreview(JSON.stringify({ ...preview(workbench), limitations }), workbench)).rejects.toThrow(/translation limitations/);
    }
  });
});

describe("preview persistence and refresh", () => {
  it("restores exact baseline and candidate evidence and revalidates current selection", async () => {
    const workbench = await completed();
    const entries = await Promise.all([undefined, workbench.records[0]].map((record) => parsePreparedPreview(JSON.stringify(preview(workbench, record), null, 2) + "\n", workbench)));
    const saved = savePreparedPreviews(entries);
    const restored = await restorePreparedPreviews(saved, workbench);
    expect(savePreparedPreviews(restored)).toBe(saved);
    expect(restored.map((entry) => entry.text)).toEqual(entries.map((entry) => entry.text));
    expect(findPreparedPreview(restored, workbench, workbench.records[0])?.preview.role).toBe("candidate");
    expect(Object.isFrozen(restored[1].preview)).toBe(true);
  });

  it("rejects persisted previews after the source context changes", async () => {
    const workbench = await create(contextText);
    const entry = await parsePreparedPreview(JSON.stringify(preview(workbench)), workbench);
    await expect(restorePreparedPreviews(savePreparedPreviews([entry]), await create(contextText + "\n"))).rejects.toThrow(/different assembly context/);
  });

  it("rechecks a persisted candidate against the exact current receipt", async () => {
    const waiting = await queue(await create(contextText), 8);
    const text = JSON.stringify(receipt(waiting.records[0]));
    const first = await importResult(waiting, text);
    const entry = await parsePreparedPreview(JSON.stringify(preview(first, first.records[0])), first);
    await expect(restorePreparedPreviews(savePreparedPreviews([entry]), await importResult(waiting, text + "\n"))).rejects.toThrow(/different native result/);
  });

  it("detects STEP byte tampering inside persisted entry text on refresh", async () => {
    const workbench = await create(contextText);
    const entry = await parsePreparedPreview(JSON.stringify(preview(workbench)), workbench);
    const saved = JSON.parse(savePreparedPreviews([entry])) as { schema: string; entries: string[] };
    const altered = preview(workbench);
    altered.step.bytes += 1;
    saved.entries[0] = JSON.stringify(altered);
    await expect(restorePreparedPreviews(JSON.stringify(saved), workbench)).rejects.toThrow(/declared identity/);
  });

  it("makes identical imports idempotent and preserves prior evidence when replacement differs", async () => {
    const workbench = await create(contextText);
    const entry = await parsePreparedPreview(JSON.stringify(preview(workbench)), workbench);
    const original = savePreparedPreviews([entry]);
    expect(savePreparedPreviews([entry], entry)).toBe(original);
    const different = await parsePreparedPreview(JSON.stringify(preview(workbench, undefined, stepFixture + "\n")), workbench);
    expect(() => savePreparedPreviews([entry], different)).toThrow(/different preview is already recorded/);
    expect(savePreparedPreviews([entry])).toBe(original);
  });

  it("rejects duplicate saved subjects, even with identical STEP bytes", async () => {
    const workbench = await create(contextText);
    const text = JSON.stringify(preview(workbench));
    await expect(restorePreparedPreviews(JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: [text, text] }), workbench)).rejects.toThrow(/Duplicate saved/);
  });

  it("rejects foreign storage envelopes, authority fields, and nontext entries", async () => {
    const workbench = await create(contextText);
    for (const saved of [{ schema: "foreign.v1", entries: [] }, { schema: "overdrafter.prepared-previews.v1", entries: [42] }, { schema: "overdrafter.prepared-previews.v1", entries: [], verified: true }]) {
      await expect(restorePreparedPreviews(JSON.stringify(saved), workbench)).rejects.toThrow();
    }
  });

  it("admits the exact escaped 4 MB aggregate boundary and leaves existing evidence intact on overflow", async () => {
    const workbench = await completed();
    const baselineText = JSON.stringify(preview(workbench)).padEnd(2_000_000);
    let candidateText = JSON.stringify(preview(workbench, workbench.records[0]));
    const initial = JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: [baselineText, candidateText] });
    candidateText = candidateText.padEnd(candidateText.length + PREVIEW_STORAGE_LIMIT - Buffer.byteLength(initial));
    const baseline = await parsePreparedPreview(baselineText, workbench);
    const candidate = await parsePreparedPreview(candidateText, workbench);
    const saved = savePreparedPreviews([baseline], candidate);
    expect(Buffer.byteLength(saved)).toBe(PREVIEW_STORAGE_LIMIT);
    expect(await restorePreparedPreviews(saved, workbench)).toHaveLength(2);
    const larger = await parsePreparedPreview(candidateText + " ", workbench);
    expect(() => savePreparedPreviews([baseline], larger)).toThrow(/4 MB budget/);
    expect(savePreparedPreviews([baseline], candidate)).toBe(saved);
    await expect(restorePreparedPreviews(saved + " ", workbench)).rejects.toThrow(/4 MB budget/);
  });

  it("retains the baseline plus five candidate previews while rejecting a seventh retained entry", async () => {
    let workbench = await create(contextText);
    for (const depth of [6, 7, 8, 9, 10]) {
      workbench = await queue(workbench, depth);
      workbench = await importResult(workbench, JSON.stringify(receipt(workbench.records.at(-1)!)));
    }
    const entries = await Promise.all([undefined, ...workbench.records].map((record) => parsePreparedPreview(JSON.stringify(preview(workbench, record)), workbench)));
    expect(await restorePreparedPreviews(savePreparedPreviews(entries), workbench)).toHaveLength(6);
    const foreign = await create(contextText + "\n");
    const seventh = await parsePreparedPreview(JSON.stringify(preview(foreign)), foreign);
    expect(() => savePreparedPreviews(entries, seventh)).toThrow(/six prepared CAD previews/);
    await expect(restorePreparedPreviews(JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: [...entries, seventh].map((entry) => entry.text) }), workbench)).rejects.toThrow(/Invalid saved/);
  });
});
