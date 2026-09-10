import type { CadPreviewSource } from "./cad-preview-source";
import { nativeDigest, readNativeContext, type NativeFile, type NativeScope } from "./engineering-cumulative";

const JSON_LIMIT = 3_000_000;
const STEP_LIMIT = 2_000_000;

/** Exact imported geometry binding. This type confers no verification or release authority. */
export type CumulativePreview = Readonly<{
  schema: "overdrafter.prepared-step-preview.v2";
  scope: NativeScope;
  snapshotId: string;
  contextSha256: string;
  role: "baseline" | "candidate";
  requestSha256: string | null;
  resultSha256: string | null;
  configuration: "Default";
  nativeFiles: readonly NativeFile[];
  step: Readonly<{ fileName: "assembly.step"; bytes: number; sha256: string; base64: string }>;
  export: Readonly<{ nativeVersion: "30.5.0"; reportSha256: string; sourceCommit: string | null }>;
  limitations: readonly string[];
}>;

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  need(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, `${label}: expected an object.`);
  need(Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)), `${label}: missing or unexpected fields.`);
  return value as Record<string, unknown>;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function decode(base64: string): Uint8Array {
  need(base64.length > 0 && base64.length <= Math.ceil(STEP_LIMIT / 3) * 4 &&
    base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), "Invalid or oversized STEP base64.");
  const binary = atob(base64);
  need(btoa(binary) === base64, "STEP base64 must be canonical.");
  return Uint8Array.from(binary, (character) => character.codePointAt(0)!);
}
async function bytesDigest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function nativeFiles(value: unknown, expected: readonly NativeFile[]): void {
  need(Array.isArray(value) && value.length === expected.length, "Native file closure is incomplete.");
  value.forEach((entry, index) => {
    const file = record(entry, ["path", "bytes", "sha256"], "Native file");
    const source = expected[index];
    need(file.path === source.path && file.bytes === source.bytes && file.sha256 === source.sha256, "Native file identity/order differs.");
  });
}
async function validateStep(value: unknown): Promise<void> {
  const step = record(value, ["fileName", "bytes", "sha256", "base64"], "STEP");
  need(step.fileName === "assembly.step" && typeof step.bytes === "number" && Number.isSafeInteger(step.bytes) &&
    step.bytes > 0 && step.bytes <= STEP_LIMIT && digest(step.sha256) && typeof step.base64 === "string", "Invalid STEP identity or size.");
  const bytes = decode(step.base64);
  need(bytes.length === step.bytes && await bytesDigest(bytes) === step.sha256, "STEP bytes differ from their declared identity.");
  const text = new TextDecoder().decode(bytes).trim();
  need(text.startsWith("ISO-10303-21;") && text.endsWith("END-ISO-10303-21;"), "STEP exchange envelope is missing.");
}
function validateExport(value: unknown, limitations: unknown): void {
  const evidence = record(value, ["nativeVersion", "reportSha256", "sourceCommit"], "Export evidence");
  need(evidence.nativeVersion === "30.5.0" && digest(evidence.reportSha256) &&
    (evidence.sourceCommit === null || typeof evidence.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(evidence.sourceCommit)), "Invalid export provenance.");
  need(Array.isArray(limitations) && limitations.length > 0 && limitations.length <= 10 &&
    limitations.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 500), "Preview needs bounded translation limitations.");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Bind exact STEP bytes to a separately selected v2 snapshot before renderer access.
 * Context/check claims remain imported evidence; the authenticated coordinator
 * must establish their provenance and verification independently.
 */
export async function readCumulativePreview(text: string, contextText: string): Promise<CumulativePreview> {
  need(typeof text === "string" && text.length > 0 && text.length <= JSON_LIMIT && !text.startsWith("\uFEFF") &&
    new TextEncoder().encode(text).byteLength <= JSON_LIMIT, "Preview exceeds its JSON limit or has invalid encoding.");
  need(typeof contextText === "string" && contextText.length <= 65536, "Snapshot context exceeds its limit.");
  const context = readNativeContext(contextText);
  const item = record(JSON.parse(text), ["schema", "scope", "snapshotId", "contextSha256", "role", "requestSha256",
    "resultSha256", "configuration", "nativeFiles", "step", "export", "limitations"], "Preview");
  need(item.schema === "overdrafter.prepared-step-preview.v2" && item.configuration === "Default", "Unsupported cumulative preview contract.");
  const scope = record(item.scope, ["organizationId", "projectId"], "Preview scope");
  need(scope.organizationId === context.scope.organizationId && scope.projectId === context.scope.projectId, "Preview scope differs.");
  need(item.snapshotId === context.snapshotId && item.contextSha256 === await nativeDigest(contextText), "Preview snapshot/context differs.");
  const role = context.sequence === 0 ? "baseline" : "candidate";
  need(item.role === role, "Preview role differs from the snapshot.");
  need(item.requestSha256 === (context.producer?.requestSha256 ?? null) &&
    item.resultSha256 === (context.producer?.resultSha256 ?? null), "Preview producer binding differs.");
  nativeFiles(item.nativeFiles, context.files);
  await validateStep(item.step);
  validateExport(item.export, item.limitations);
  return freeze(item as unknown as CumulativePreview);
}

/** Use only a parsed preview; memoize the source in its eventual view component. */
export function cumulativePreviewSource(preview: CumulativePreview): CadPreviewSource {
  return { cacheKey: `cumulative-step:${preview.step.sha256}`, fileName: `${preview.role}-assembly.step`,
    loadStepBuffer: async () => decode(preview.step.base64) };
}
