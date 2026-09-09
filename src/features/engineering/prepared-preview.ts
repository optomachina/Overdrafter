import type { CadPreviewSource } from "@/lib/cad-preview";
import type { PreparedFile, Workbench, WorkbenchRecord } from "./prepared-workflow";

export const PREVIEW_IMPORT_LIMIT = 3_000_000;
export const PREVIEW_STORAGE_LIMIT = 4_000_000;
const STEP_LIMIT = 2_000_000;

/** Imported conversion evidence is bound to native identities; it is not authenticated release evidence. */
export type PreparedPreview = Readonly<{
  schema: "overdrafter.prepared-step-preview.v1";
  contextSha256: string;
  role: "baseline" | "candidate";
  requestSha256: string | null;
  resultSha256: string | null;
  configuration: "Default";
  nativeFiles: readonly PreparedFile[];
  step: Readonly<{ fileName: "assembly.step"; bytes: number; sha256: string; base64: string }>;
  export: Readonly<{ nativeVersion: "30.5.0"; reportSha256: string; sourceCommit: string | null }>;
  limitations: readonly string[];
}>;
export type PreviewEntry = Readonly<{ text: string; preview: PreparedPreview; boundResultText: string | null }>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${name}: expected an object.`);
  requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)), `${name}: missing or unexpected fields.`);
  return value as Record<string, unknown>;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(result), (value) => value.toString(16).padStart(2, "0")).join("");
}
function decode(base64: string): Uint8Array {
  requireValue(base64.length > 0 && base64.length <= Math.ceil(STEP_LIMIT / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64), "STEP preview has invalid or oversized base64.");
  const binary = atob(base64);
  requireValue(btoa(binary) === base64, "STEP preview base64 is not canonical.");
  return Uint8Array.from(binary, (character) => character.codePointAt(0)!);
}
function sameFiles(actual: unknown, expected: readonly PreparedFile[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const paths = new Set<string>();
  return actual.every((value) => {
    const item = object(value, ["path", "bytes", "sha256"], "Native source file");
    if (typeof item.path !== "string" || paths.has(item.path)) return false;
    paths.add(item.path);
    const match = expected.find((file) => file.path === item.path);
    return match && item.bytes === match.bytes && item.sha256 === match.sha256;
  });
}

/** Validate exact preview bytes and source bindings before letting the STEP parser see the file. */
export async function parsePreparedPreview(text: string, workbench: Workbench): Promise<PreviewEntry> {
  requireValue(text.length > 0 && !text.startsWith("\uFEFF") && new TextEncoder().encode(text).length <= PREVIEW_IMPORT_LIMIT, "Preview JSON exceeds its limit or has an invalid encoding.");
  const input = object(JSON.parse(text), ["schema", "contextSha256", "role", "requestSha256", "resultSha256", "configuration", "nativeFiles", "step", "export", "limitations"], "Preview");
  requireValue(input.schema === "overdrafter.prepared-step-preview.v1" && input.configuration === "Default", "Unsupported STEP preview contract or configuration.");
  requireValue(input.contextSha256 === workbench.contextSha256, "Preview belongs to a different assembly context.");
  requireValue(input.role === "baseline" || input.role === "candidate", "Unknown preview role.");
  let expectedFiles = workbench.context.files;
  let boundResultText: string | null = null;
  if (input.role === "baseline") {
    requireValue(input.requestSha256 === null && input.resultSha256 === null, "Baseline preview must not claim a candidate result.");
  } else {
    requireValue(digest(input.requestSha256) && digest(input.resultSha256), "Candidate preview needs exact request and result digests.");
    const record = workbench.records.find((item) => item.requestSha256 === input.requestSha256);
    requireValue(record?.result?.outcome === "succeeded" && record.checks === "passed" && record.resultText, "Import the matching successful native result before its CAD preview.");
    requireValue(await sha256(new TextEncoder().encode(record.resultText)) === input.resultSha256, "Preview belongs to a different native result.");
    boundResultText = record.resultText;
    expectedFiles = record.result.outputFiles;
  }
  requireValue(sameFiles(input.nativeFiles, expectedFiles), "Preview native source closure does not match the exact package.");
  const step = object(input.step, ["fileName", "bytes", "sha256", "base64"], "STEP");
  requireValue(step.fileName === "assembly.step" && typeof step.bytes === "number" && Number.isSafeInteger(step.bytes) && step.bytes > 0 && step.bytes <= STEP_LIMIT && digest(step.sha256) && typeof step.base64 === "string", "Invalid STEP preview identity or size.");
  const bytes = decode(step.base64);
  requireValue(bytes.length === step.bytes && await sha256(bytes) === step.sha256, "STEP bytes do not match their declared identity.");
  requireValue(new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("ISO-10303-21;"), "Preview is not a STEP exchange file.");
  const evidence = object(input.export, ["nativeVersion", "reportSha256", "sourceCommit"], "Export evidence");
  requireValue(evidence.nativeVersion === "30.5.0" && digest(evidence.reportSha256) && (evidence.sourceCommit === null || typeof evidence.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(evidence.sourceCommit)), "Invalid export provenance.");
  requireValue(Array.isArray(input.limitations) && input.limitations.length > 0 && input.limitations.length <= 10 && input.limitations.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 500), "Preview must declare bounded translation limitations.");
  const preview = input as unknown as PreparedPreview;
  Object.freeze(preview.step); Object.freeze(preview.export);
  preview.nativeFiles.forEach(Object.freeze); Object.freeze(preview.nativeFiles); Object.freeze(preview.limitations); Object.freeze(preview);
  return Object.freeze({ text, preview, boundResultText });
}

/** Bind display selection to exact realized state, never to a requested depth alone. */
export function findPreparedPreview(entries: readonly PreviewEntry[], workbench: Workbench, record?: WorkbenchRecord): PreviewEntry | undefined {
  return entries.find(({ preview, boundResultText }) => {
    if (preview.contextSha256 !== workbench.contextSha256) return false;
    if (!record) return preview.role === "baseline" && sameFiles(preview.nativeFiles, workbench.context.files);
    return preview.role === "candidate" && record.result?.outcome === "succeeded" && record.checks === "passed" && boundResultText === record.resultText && preview.requestSha256 === record.requestSha256 && sameFiles(preview.nativeFiles, record.result.outputFiles);
  });
}

/** Memoize this source in the component; the content digest is the renderer cache identity. */
export function preparedPreviewSource(entry: PreviewEntry): CadPreviewSource {
  return { cacheKey: `prepared-step:${entry.preview.step.sha256}`, fileName: `${entry.preview.role}-assembly.step`, loadStepBuffer: async () => decode(entry.preview.step.base64) };
}

/** Preserve at most one exact export per baseline/request, within a bounded local storage representation. */
export function savePreparedPreviews(entries: readonly PreviewEntry[], next?: PreviewEntry): string {
  const combined = [...entries];
  if (next) {
    const index = combined.findIndex((entry) => entry.preview.role === next.preview.role && entry.preview.contextSha256 === next.preview.contextSha256 && entry.preview.requestSha256 === next.preview.requestSha256);
    if (index >= 0) {
      requireValue(combined[index].preview.step.sha256 === next.preview.step.sha256, "A different preview is already recorded for this exact subject. Use Reset workbench before replacing it.");
    } else combined.push(next);
  }
  requireValue(combined.length <= 6, "At most six prepared CAD previews can be retained.");
  const text = JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: combined.map((entry) => entry.text) });
  requireValue(new TextEncoder().encode(text).length <= PREVIEW_STORAGE_LIMIT, "Saved CAD previews exceed the 4 MB budget. Existing previews were kept.");
  return text;
}

/** Revalidate persisted STEP bytes and all current source/result bindings after refresh. */
export async function restorePreparedPreviews(text: string, workbench: Workbench): Promise<readonly PreviewEntry[]> {
  requireValue(new TextEncoder().encode(text).length <= PREVIEW_STORAGE_LIMIT, "Saved CAD previews exceed the 4 MB budget.");
  const saved = object(JSON.parse(text), ["schema", "entries"], "Saved previews");
  requireValue(saved.schema === "overdrafter.prepared-previews.v1" && Array.isArray(saved.entries) && saved.entries.length <= 6 && saved.entries.every((entry) => typeof entry === "string"), "Invalid saved CAD previews.");
  const entries: PreviewEntry[] = [];
  for (const text of saved.entries as string[]) {
    const next = await parsePreparedPreview(text, workbench);
    const subject = `${next.preview.role}:${next.preview.requestSha256}`;
    requireValue(!entries.some((entry) => `${entry.preview.role}:${entry.preview.requestSha256}` === subject), "Duplicate saved CAD preview subject.");
    entries.push(next);
  }
  return entries;
}
