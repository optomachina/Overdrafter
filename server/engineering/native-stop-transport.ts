import { createHash } from "node:crypto";
import { admitNativeProcessStop, type NativeStopRepository } from "./native-stop-admission";

export const NATIVE_STOP_SCHEMA = "overdrafter.native-stop-request.v1";
const PATH = "/functions/v1/engineering-worker-stop";
const DEADLINE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Scope = Readonly<{ workerId: string; bootId: string; taskId: string; attemptId: string; fence: number }>;
/** Repository implementations use this for a lost response after SQL may have committed. */
export class NativeStopOutcomeUnknown extends Error {}
export type NativeStopRuntime = Readonly<{
  enabled: () => boolean;
  authorize: (scope: Scope & { tokenSha256: string }) => Promise<boolean>;
  repository: NativeStopRepository;
}>;
function id(value: unknown): value is string { return typeof value === "string" && UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000"; }
function obj(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function response(status: number, data: Record<string, unknown>) {
  return new Response(JSON.stringify({ schema: NATIVE_STOP_SCHEMA, ...data }), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new NativeStopOutcomeUnknown("stop deadline or disconnect"));
    if (signal.aborted) { void promise.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** The request carries an opaque ID, never a shutdown boolean, journal bytes,
 * terminal set, validator verdict, Storage path, or SQL table name. */
export function createNativeStopHandler(runtime: NativeStopRuntime) {
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled()) return response(503, { error: "stop_disabled" });
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.pathname !== PATH || url.search || url.hash
      || request.method !== "POST" || request.headers.has("origin") || request.headers.has("cookie")
      || request.headers.has("content-encoding") || request.headers.get("content-type") !== "application/json") {
      return response(400, { error: "invalid_request" });
    }
    const auth = request.headers.get("authorization") ?? "";
    if (!/^Bearer odw_[0-9a-f]{64}$/.test(auth)) return response(401, { error: "worker_access_denied" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const disconnected = () => controller.abort();
    request.signal.addEventListener("abort", disconnected, { once: true });
    try {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d{1,5}$/.test(declared) || Number(declared) > 2048)) {
      return response(400, { error: "invalid_request" });
    }
    if (!request.body) return response(400, { error: "invalid_request" });
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await bounded(reader.read(), controller.signal);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) return response(400, { error: "invalid_request" });
        size += part.value.byteLength;
        if (size > 2048) return response(400, { error: "invalid_request" });
        chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (size < 1) return response(400, { error: "invalid_request" });
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return response(400, { error: "invalid_request" }); }
    if (!obj(value) || Object.keys(value).length !== 10
      || value.schema !== NATIVE_STOP_SCHEMA || ![value.workerId,value.bootId,value.taskId,value.attemptId,
        value.evidenceId,value.idempotencyKey].every(id)
      || !Number.isSafeInteger(value.fence) || Number(value.fence) < 1 || Number(value.fence) >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || Number(value.revision) >= Number.MAX_SAFE_INTEGER) {
      return response(400, { error: "invalid_request" });
    }
    const expected = ["schema","workerId","bootId","taskId","attemptId","fence","evidenceId","revision","idempotencyKey","action"];
    if (expected.some((key) => !Object.hasOwn(value, key)) || value.action !== "record_stop") return response(400, { error: "invalid_request" });
    const scope: Scope = { workerId: value.workerId as string, bootId: value.bootId as string,
      taskId: value.taskId as string, attemptId: value.attemptId as string, fence: value.fence as number };
    const tokenSha256 = createHash("sha256").update(auth.slice(7), "utf8").digest("hex");
    try {
      if (!await bounded(runtime.authorize({ ...scope, tokenSha256 }), controller.signal)) return response(401, { error: "worker_access_denied" });
      const outcome = await bounded(admitNativeProcessStop({ taskId: scope.taskId, attemptId: scope.attemptId,
        evidenceId: value.evidenceId as string, revision: value.revision as number,
        idempotencyKey: value.idempotencyKey as string, repository: runtime.repository,
        expectedScope: { workerId: scope.workerId, bootId: scope.bootId, fence: scope.fence } }), controller.signal);
      return response(200, { action: "record_stop", receipt: outcome.receipt });
    } catch (error) {
      if (error instanceof NativeStopOutcomeUnknown) return response(503, { error: "stop_outcome_unknown",
        outcome: "unknown", retrySameRequest: true });
      return response(409, { error: "stop_not_admitted" });
    }
    } catch (error) {
      if (error instanceof NativeStopOutcomeUnknown) return response(503, { error: "stop_outcome_unknown",
        outcome: "unknown", retrySameRequest: true });
      return response(400, { error: "invalid_request" });
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", disconnected); }
  };
}
