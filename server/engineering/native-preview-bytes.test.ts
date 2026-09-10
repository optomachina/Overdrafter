// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cumulativePreviewSource } from "../../src/lib/engineering-cumulative-preview";
import { PREPARED_PREVIEW_PREDICATES } from "./native-preview-policy";
import { verifyStoredNativePreview, type NativePreviewAdmission } from "./native-preview-bytes";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
// Actual retained 9/7 mm exporter bytes; admission/registry are test simulations.
// This is report replay, not a new Windows run or qualified server admission.
function fixture(depth: 9 | 7 = 9) {
  const root = `server/engineering/fixtures/preview-${depth}mm/`;
  const contextText = readFileSync(root + "context.json", "utf8"), context = JSON.parse(contextText);
  const bytes = { bundle: new Uint8Array(readFileSync(root + "preview.json")), report: new Uint8Array(readFileSync(root + "native-step.stdout.txt")) };
  const report = JSON.parse(new TextDecoder().decode(bytes.report)), bundle = JSON.parse(new TextDecoder().decode(bytes.bundle));
  const admission: NativePreviewAdmission = {
    exportId: "11111111-1111-4111-8111-000000000001", scope: context.scope, snapshotId: context.snapshotId,
    contextSha256: hash(new TextEncoder().encode(contextText)), sourceCommit: bundle.export.sourceCommit,
    process: { nativePid: report.nativePid, nativeStartTicks: report.nativeStartTicks, helperPid: report.helperPid, candidateRoot: report.candidateRoot },
    objects: (["bundle", "report"] as const).map((role, i) => ({ id: `11111111-1111-4111-8111-00000000000${i + 2}`,
      role, bytes: bytes[role].length, sha256: hash(bytes[role]) })),
  };
  const reader = vi.fn(async (id: string) => new Response(bytes[admission.objects.find((o) => o.id === id)!.role]));
  const check = () => verifyStoredNativePreview(contextText, admission, reader);
  // Deliberately rewrite test registrations to reach semantic validation, instead
  // of merely failing hashes. Production registry/admission must be immutable.
  function rewrite() {
    bytes.report = encode(report); bundle.export.reportSha256 = hash(bytes.report); bytes.bundle = encode(bundle);
    for (const object of admission.objects) Object.assign(object, { bytes: bytes[object.role].length, sha256: hash(bytes[object.role]) });
  }
  return { contextText, context, bytes, report, bundle, admission, reader, check, rewrite };
}

describe("stored exact native preview", () => {
  it.each([9, 7] as const)("checks actual retained %i mm export bytes and renderer source", async (depth) => {
    const f = fixture(depth), result = await f.check();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("missing preview");
    const step = await cumulativePreviewSource(result.preview).loadStepBuffer();
    expect(hash(step)).toBe(f.report.step.sha256);
    expect(step.length).toBe(f.report.step.bytes);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.preview.step)).toBe(true);
    expect(f.reader.mock.calls.map(([id]) => id)).toEqual(f.admission.objects.map((o) => o.id));
  });
  it("returns exact unavailable state without fetching or implying native failure", async () => {
    const f = fixture(), before = f.contextText;
    expect(await verifyStoredNativePreview(f.contextText, null, f.reader)).toEqual({ status: "unavailable",
      snapshotId: f.context.snapshotId, contextSha256: f.admission.contextSha256, reason: "not_exported" });
    expect(f.reader).not.toHaveBeenCalled(); expect(f.contextText).toBe(before);
  });
  it("does not use an earlier valid export for a later candidate", async () => {
    const old = fixture(9), current = fixture(7);
    await expect(verifyStoredNativePreview(current.contextText, old.admission, old.reader)).rejects.toThrow(/snapshot/);
    expect(old.reader).not.toHaveBeenCalled();
  });
  it.each(PREPARED_PREVIEW_PREDICATES)("rejects missing mandatory export predicate %s", async (key) => {
    const f = fixture(); delete f.report.checks[key]; f.rewrite(); await expect(f.check()).rejects.toThrow(/predicate/);
  });
  it.each([
    ["outcome", (f: ReturnType<typeof fixture>) => { f.report.outcome = "failed"; }],
    ["false predicate", (f: ReturnType<typeof fixture>) => { f.report.checks.step_save_success = false; }],
    ["unexpected predicate", (f: ReturnType<typeof fixture>) => { f.report.checks.extra = true; }],
    ["string predicate", (f: ReturnType<typeof fixture>) => { f.report.checks.step_save_success = "true"; }],
    ["depth", (f: ReturnType<typeof fixture>) => { f.report.preview_geometry_0.depthM = .007; }],
    ["volume", (f: ReturnType<typeof fixture>) => { f.report.preview_geometry_0.massProperties[3] *= 2; }],
    ["companion", (f: ReturnType<typeof fixture>) => { f.report.preview_geometry_1.depthM = .009; }],
    ["movement", (f: ReturnType<typeof fixture>) => { f.report.after_exportOccurrences[1].transform[9] = .05; }],
    ["suppression", (f: ReturnType<typeof fixture>) => { f.report.previewOccurrences[0].suppression = 0; }],
    ["writable model", (f: ReturnType<typeof fixture>) => { f.report.previewOccurrences[0].readOnly = false; }],
    ["dependency", (f: ReturnType<typeof fixture>) => { f.report.after_export_assemblyDependencies[1] = "C:\\foreign\\part.SLDPRT"; }],
    ["native bytes changed", (f: ReturnType<typeof fixture>) => { f.report.afterNativeFiles[0].sha256 = "a".repeat(64); }],
    ["process", (f: ReturnType<typeof fixture>) => { f.report.nativePid++; }],
    ["source", (f: ReturnType<typeof fixture>) => { f.bundle.export.sourceCommit = "a".repeat(40); }],
    ["STEP identity", (f: ReturnType<typeof fixture>) => { f.report.step.sha256 = "a".repeat(64); }],
    ["coordinate override", (f: ReturnType<typeof fixture>) => { f.report.stepPreferencesBefore.outputCoordinateSystem = "other"; }],
    ["settings drift", (f: ReturnType<typeof fixture>) => { f.report.stepPreferencesAfter.ap = 214; }],
    ["save warning", (f: ReturnType<typeof fixture>) => { f.report.stepSave.warnings = 1; }],
    ["release error", (f: ReturnType<typeof fixture>) => { f.report.releaseErrors.push("failure"); }],
  ] as const)("rejects contradictory %s even with rewritten hashes", async (_label, mutate) => {
    const f = fixture(); mutate(f); f.rewrite(); await expect(f.check()).rejects.toThrow();
  });
  it.each(["bundle", "report"] as const)("rejects changed stored %s bytes", async (role) => {
    const f = fixture(); f.bytes[role][5] ^= 1; await expect(f.check()).rejects.toThrow(/identity/);
  });
  it("rejects duplicate JSON keys even with registered matching hashes", async () => {
    const f = fixture(); f.bytes.report = new TextEncoder().encode(new TextDecoder().decode(f.bytes.report).replace('"outcome":', '"outcome":"failed","outcome":'));
    Object.assign(f.admission.objects[1], { bytes: f.bytes.report.length, sha256: hash(f.bytes.report) });
    await expect(f.check()).rejects.toThrow(/duplicate/);
  });
  it("takes an admission snapshot before storage waits", async () => {
    const f = fixture();
    const reader = async (id: string) => {
      Object.assign(f.admission, { sourceCommit: "a".repeat(40), snapshotId: "foreign" });
      return f.reader(id);
    };
    expect((await verifyStoredNativePreview(f.contextText, f.admission, reader)).status).toBe("ready");
  });
  it.each(["oversize", "truncated", "empty chunk", "missing", "redirected"])("rejects %s storage delivery", async (kind) => {
    const f = fixture();
    const reader = async () => {
      if (kind === "missing") return new Response(null, { status: 404 });
      if (kind === "redirected") { const r = new Response(f.bytes.bundle); Object.defineProperty(r, "redirected", { value: true }); return r; }
      if (kind === "empty chunk") return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array()); c.close(); } }));
      const bytes = f.bytes.bundle;
      return new Response(kind === "oversize" ? new Uint8Array(bytes.length + 1) : bytes.slice(0, -1));
    };
    await expect(verifyStoredNativePreview(f.contextText, f.admission, reader)).rejects.toThrow();
  });
  it("bounds a reader that ignores cancellation", async () => {
    const f = fixture();
    await expect(verifyStoredNativePreview(f.contextText, f.admission, () => new Promise(() => {}), 10)).rejects.toThrow(/interrupted/);
  });
  it("rejects foreign access scope and malformed admission before reads", async () => {
    const f = fixture(); Object.assign(f.admission.scope, { organizationId: "foreign" });
    await expect(f.check()).rejects.toThrow(); expect(f.reader).not.toHaveBeenCalled();
  });
});
