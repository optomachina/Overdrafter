import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readNativeContext, type NativeScope } from "../../src/lib/engineering-cumulative";
import { readCumulativePreview, type CumulativePreview } from "../../src/lib/engineering-cumulative-preview";
import { parsePreparedEvidenceJson, validateAdmittedReportProcess, validatePreparedPreviewReport,
  type AdmittedReportProcess } from "./native-reports";
import type { RegisteredObjectReader } from "./native-result-bytes";

const LIMITS = Object.freeze({ bundle: 3_000_000, report: 128_000 });
export const NATIVE_PREVIEW_POLICY = "prepared-native-preview-v1";
export type RegisteredPreviewObject = Readonly<{
  id: string; role: keyof typeof LIMITS; bytes: number; sha256: string;
}>;
/** Trusted server admission for a completed read-only export, independent of
 * bundle/report claims. The loader must establish current access, qualified
 * source/process, normal shutdown and immutable object ownership before use.
 * This pure verifier neither creates that admission nor substitutes for it.
 */
export type NativePreviewAdmission = Readonly<{
  exportId: string; scope: NativeScope; snapshotId: string; contextSha256: string;
  sourceCommit: string; process: AdmittedReportProcess; objects: readonly RegisteredPreviewObject[];
}>;
export type NativeCandidatePreview = Readonly<{
  status: "unavailable"; snapshotId: string; contextSha256: string; reason: "not_exported";
}> | Readonly<{
  status: "ready"; snapshotId: string; contextSha256: string; exportId: string;
  policy: typeof NATIVE_PREVIEW_POLICY; preview: CumulativePreview;
}>;
function need(condition: unknown, label: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid stored native preview: ${label}.`);
}
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function uuid(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
function validateAdmission(a: NativePreviewAdmission, scope: NativeScope, snapshotId: string, contextSha256: string): void {
  need(isDeepStrictEqual(Object.keys(a).sort(), ["exportId", "scope", "snapshotId", "contextSha256", "sourceCommit", "process", "objects"].sort()), "admission fields");
  need(uuid(a.exportId) && a.snapshotId === snapshotId && a.contextSha256 === contextSha256
    && isDeepStrictEqual(a.scope, scope), "admitted snapshot");
  need(typeof a.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(a.sourceCommit), "qualified export source");
  validateAdmittedReportProcess(a.process);
  need(Array.isArray(a.objects) && a.objects.length === 2, "preview object set");
  const ids = new Set<string>(), roles = new Set<string>();
  for (const o of a.objects) {
    need(o && isDeepStrictEqual(Object.keys(o).sort(), ["id", "role", "bytes", "sha256"].sort()), "object fields");
    need(uuid(o.id) && !ids.has(o.id) && Object.hasOwn(LIMITS, o.role) && !roles.has(o.role), "object identity");
    need(Number.isSafeInteger(o.bytes) && o.bytes > 0 && o.bytes <= LIMITS[o.role as keyof typeof LIMITS]
      && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256), "object bounds");
    ids.add(o.id); roles.add(o.role);
  }
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Native preview read interrupted."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function readObject(o: RegisteredPreviewObject, read: RegisteredObjectReader, signal: AbortSignal): Promise<Uint8Array> {
  const response = await bounded(read(o.id, signal), signal);
  need(response.status === 200 && !response.redirected && response.body, "object response");
  const stream = response.body.getReader(), bytes = new Uint8Array(o.bytes);
  let size = 0, count = 0, complete = false;
  try {
    while (true) {
      const chunk = await bounded(stream.read(), signal);
      if (chunk.done) { complete = true; break; }
      need(chunk.value instanceof Uint8Array && chunk.value.length > 0 && ++count <= 4096, "stream progress");
      need(size + chunk.value.length <= bytes.length, "object exceeds registered size");
      bytes.set(chunk.value, size); size += chunk.value.length;
    }
  } finally {
    if (complete) stream.releaseLock();
    else void stream.cancel().catch(() => undefined);
  }
  need(size === o.bytes && hash(bytes) === o.sha256, "stored object identity");
  return bytes;
}

/** Read only registered IDs and check actual preview/export bytes against one
 * finalized candidate. Missing export is explicit; bad evidence throws and
 * cannot replace geometry or change independently established native results.
 * Callers must authorize access to context/admission and persist association
 * under their own rechecked authority. No fallback to another snapshot occurs.
 */
export async function verifyStoredNativePreview(contextText: string, admission: NativePreviewAdmission | null,
  reader: RegisteredObjectReader, timeoutMs = 30_000): Promise<NativeCandidatePreview> {
  need(typeof contextText === "string" && contextText.length <= 65536, "context size");
  const contextBytes = new TextEncoder().encode(contextText);
  need(contextBytes.length <= 65536, "context byte size");
  parsePreparedEvidenceJson(contextBytes);
  const context = readNativeContext(contextText), contextSha256 = hash(contextBytes);
  need(context.sequence > 0 && context.producer !== null, "finalized candidate required");
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, "read deadline");
  if (admission === null) return Object.freeze({ status: "unavailable", snapshotId: context.snapshotId, contextSha256, reason: "not_exported" });
  const a: NativePreviewAdmission = structuredClone(admission);
  validateAdmission(a, context.scope, context.snapshotId, contextSha256);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = performance.now() + timeoutMs;
  try {
    const content = {} as Record<keyof typeof LIMITS, Uint8Array>;
    for (const object of a.objects) content[object.role] = await readObject(object, reader, controller.signal);
    parsePreparedEvidenceJson(content.bundle);
    const preview = await bounded(readCumulativePreview(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(content.bundle), contextText), controller.signal);
    need(preview.export.sourceCommit === a.sourceCommit, "export source differs");
    validatePreparedPreviewReport({ context, preview, process: a.process, report: content.report });
    need(!controller.signal.aborted && performance.now() < deadline, "read deadline");
    return Object.freeze({ status: "ready", snapshotId: context.snapshotId, contextSha256,
      exportId: a.exportId, policy: NATIVE_PREVIEW_POLICY, preview });
  } finally { clearTimeout(timer); controller.abort(); }
}
