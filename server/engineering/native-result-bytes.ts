import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readNativeJob, verifiedNativeSuccessor, type NativeResult, type NativeScope } from "../../src/lib/engineering-cumulative";
import { parsePreparedEvidenceJson, validatePreparedReports, type AdmittedReportProcess } from "./native-reports";

const LIMITS = Object.freeze({
  assembly: 16_000_000, target: 16_000_000, companion: 16_000_000,
  result: 256_000, identity: 64_000, preservation: 128_000, native: 4_000_000,
});
type Role = keyof typeof LIMITS;
export type RegisteredResultObject = Readonly<{
  id: string; scope: NativeScope; attemptId: string; role: Role; bytes: number; sha256: string;
}>;
type ActiveAttempt = Parameters<typeof verifiedNativeSuccessor>[0]["active"];
export type ResultReadAdmission = Readonly<{
  contextText: string; jobText: string; active: ActiveAttempt;
  process: AdmittedReportProcess; objects: readonly RegisteredResultObject[];
}>;
/** Reader resolves registry IDs internally; worker URLs/paths are never accepted. */
export type RegisteredObjectReader = (id: string, signal: AbortSignal) => Promise<Response>;
function need(condition: unknown, label: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid stored native result: ${label}.`);
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Native result verification interrupted."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function read(object: RegisteredResultObject, reader: RegisteredObjectReader, signal: AbortSignal, deadline: number) {
  const response = await bounded(reader(object.id, signal), signal);
  need(response.status === 200 && !response.redirected && response.body, "object response");
  const stream = response.body.getReader(), chunks: Uint8Array[] = [];
  const contentNeeded = !["assembly", "target", "companion"].includes(object.role), digest = createHash("sha256");
  let size = 0, count = 0, complete = false;
  try {
    while (true) {
      need(performance.now() < deadline, "verification deadline");
      const chunk = await bounded(stream.read(), signal);
      if (chunk.done) { complete = true; break; }
      need(chunk.value instanceof Uint8Array, "object bytes");
      need(chunk.value.byteLength > 0 && ++count <= 4096, "stream progress bounds");
      size += chunk.value.byteLength; need(size <= object.bytes, "object exceeds registered size");
      digest.update(chunk.value);
      if (contentNeeded) chunks.push(new Uint8Array(chunk.value));
    }
  } finally {
    if (complete) stream.releaseLock();
    else void stream.cancel().catch(() => undefined);
  }
  need(size === object.bytes, "truncated object");
  const sha256 = digest.digest("hex"); need(sha256 === object.sha256, "stored digest mismatch");
  let content: Uint8Array | null = null;
  if (contentNeeded) {
    content = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  }
  return { bytes: size, sha256, content };
}
function validateRegistry(objects: readonly RegisteredResultObject[], active: ActiveAttempt): void {
  need(Array.isArray(objects) && objects.length === Object.keys(LIMITS).length, "complete object set");
  const ids = new Set<string>(), roles = new Set<string>();
  for (const object of objects) {
    need(object && isDeepStrictEqual(Object.keys(object).sort(), ["id", "scope", "attemptId", "role", "bytes", "sha256"].sort()), "registry fields");
    need(typeof object.id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(object.id)
      && object.id !== "00000000-0000-0000-0000-000000000000" && !ids.has(object.id), "registry identity");
    need(Object.hasOwn(LIMITS, object.role) && !roles.has(object.role), "registry role");
    need(Number.isSafeInteger(object.bytes) && object.bytes > 0 && object.bytes <= LIMITS[object.role as Role], "registry size");
    need(typeof object.sha256 === "string" && /^[0-9a-f]{64}$/.test(object.sha256), "registry digest");
    need(isDeepStrictEqual(object.scope, active.scope) && object.attemptId === active.attemptId, "registry scope");
    ids.add(object.id); roles.add(object.role);
  }
}

/**
 * Measure immutable registered object bytes and verify the complete prepared
 * result. Admission must be loaded by the trusted server; this function is not
 * an HTTP handler and cannot authorize itself. A later locked transaction must
 * recheck eligibility and persist its returned candidate atomically.
 */
export async function verifyStoredNativeCandidate(admission: ResultReadAdmission, reader: RegisteredObjectReader, timeoutMs = 30_000) {
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, "verification deadline");
  // Take a private snapshot before the first await; callers cannot replace the
  // scope, registry or process binding while object reads are in progress.
  const input: ResultReadAdmission = structuredClone(admission);
  parsePreparedEvidenceJson(new TextEncoder().encode(input.contextText));
  parsePreparedEvidenceJson(new TextEncoder().encode(input.jobText));
  const job = await readNativeJob(input.jobText, input.contextText);
  need(isDeepStrictEqual(input.active.scope, job.scope), "active scope");
  for (const key of ["jobId", "attemptId", "fence", "inputSnapshotId", "contextSha256", "outputSnapshotId"] as const) {
    need(input.active[key] === job[key], `active ${key}`);
  }
  validateRegistry(input.objects, input.active);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = performance.now() + timeoutMs;
  try {
    const stored = {} as Record<Role, Awaited<ReturnType<typeof read>>>;
    for (const object of input.objects) stored[object.role] = await read(object, reader, controller.signal, deadline);
    const content = (role: Role) => { const value = stored[role].content; need(value, "report content"); return value; };
    const resultText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content("result"));
    const result = parsePreparedEvidenceJson(content("result")) as NativeResult;
    const names = ["synthetic-assembly.SLDASM", "parts/baseline-5mm.SLDPRT", "parts/candidate-8mm.SLDPRT"];
    const outputs = (["assembly", "target", "companion"] as const).map((role, index) => ({
      path: names[index], bytes: stored[role].bytes, sha256: stored[role].sha256,
    }));
    const evidence = [stored.identity, stored.preservation, stored.native].map((object) => object.sha256);
    const context = await bounded(verifiedNativeSuccessor({ contextText: input.contextText, jobText: input.jobText,
      resultText, active: input.active, storedOutputs: outputs, storedEvidenceSha256: evidence }), controller.signal);
    const verified = validatePreparedReports({ job, result, process: input.process,
      reports: { identity: content("identity"), preservation: content("preservation"), native: content("native") } });
    need(!controller.signal.aborted && performance.now() < deadline, "verification deadline");
    return Object.freeze({ context, policy: verified.policy, resultSha256: stored.result.sha256,
      objects: Object.freeze(input.objects.map((object) => Object.freeze({ ...object, scope: Object.freeze({ ...object.scope }) }))) });
  } finally { clearTimeout(timer); controller.abort(); }
}
