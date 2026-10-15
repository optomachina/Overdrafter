import { NativeStopFailure, stopInteger, stopObject, type NativeStopRepository, type NativeStopRequest } from "./native-stop-admission.ts";

export const NATIVE_STOP_SCHEMA = "overdrafter.native-stop-request.v1";
const PATH = "/functions/v1/engineering-worker-stop";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(value: unknown): boolean { return typeof value === "string" && UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000"; }
function reply(status: number, value: Record<string, unknown>): Response {
  return Response.json({ schema: NATIVE_STOP_SCHEMA, ...value }, { status, headers: { "cache-control": "no-store" } });
}
type StopBudget = Readonly<{ signal: AbortSignal; check: () => void }>;
function bounded<T>(start: () => Promise<T>, budget: StopBudget): Promise<T> {
  const { signal } = budget;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", stop);
    const stop = () => { cleanup(); reject(new NativeStopFailure(503, "stop_deadline")); };
    signal.addEventListener("abort", stop, { once: true });
    void (async () => {
      try {
        budget.check();
        const value = await start();
        budget.check();
        resolve(value);
      } catch (error) { reject(error); }
      finally { cleanup(); }
    })();
  });
}
async function readPayload(request: Request, budget: StopBudget): Promise<NativeStopRequest> {
  const invalid = () => new NativeStopFailure(400, "invalid_request");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,5}$/.test(declared) || Number(declared) > 2048)) throw invalid();
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await bounded(() => reader.read(), budget);
      if (part.done) break;
      // Every chunk must advance the byte budget: eager empty chunks can keep
      // this loop in microtasks indefinitely without letting the deadline run.
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) throw invalid();
      size += part.value.byteLength;
      if (size > 2048) throw invalid();
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  const keys = ["schema", "action", "workerId", "bootId", "taskId", "attemptId", "fence", "evidenceId", "revision", "idempotencyKey"];
  if (!stopObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.schema !== NATIVE_STOP_SCHEMA || value.action !== "record_stop"
    || ![value.workerId, value.bootId, value.taskId, value.attemptId, value.evidenceId, value.idempotencyKey].every(id)
    || !stopInteger(value.fence, 1, Number.MAX_SAFE_INTEGER) || !stopInteger(value.revision)) throw invalid();
  return value as NativeStopRequest;
}
/** Source-bound adaptation of PR543 d305da28's bounded stop transport.
 * Authentication and admission are now one checked restricted SQL transaction;
 * the parent privileged repository reads and fabricated manifest are not used. */
export function createNativeStopHandler(runtime: Readonly<{
  enabled: () => boolean; repository: () => NativeStopRepository; deadlineMs?: number;
}>) {
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled()) return reply(503, { error: "stop_disabled", outcome: "not_applied", retrySameRequest: false });
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.pathname !== PATH || url.search || url.hash || request.method !== "POST"
      || request.headers.has("origin") || request.headers.has("cookie") || request.headers.has("content-encoding")
      || request.headers.get("content-type") !== "application/json") {
      return reply(400, { error: "invalid_request", outcome: "not_applied", retrySameRequest: false });
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer odw_[0-9a-f]{64}$/.test(authorization)) return reply(401, { error: "worker_access_denied", outcome: "not_applied", retrySameRequest: false });
    const controller = new AbortController();
    const deadlineMs = runtime.deadlineMs ?? 5000;
    const deadlineAt = performance.now() + deadlineMs;
    const expireIfElapsed = () => {
      if (performance.now() >= deadlineAt) controller.abort();
    };
    const budget: StopBudget = { signal: controller.signal, check: () => {
      expireIfElapsed();
      if (controller.signal.aborted) throw new NativeStopFailure(503, "stop_deadline");
    } };
    const disconnected = () => controller.abort();
    request.signal.addEventListener("abort", disconnected, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(disconnected, deadlineMs);
    let attempted = false;
    try {
      budget.check();
      const payload = await readPayload(request, budget);
      const hash = await bounded(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.slice(7))), budget);
      const credential = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      budget.check();
      const repository = runtime.repository();
      const receipt = await bounded(() => {
        attempted = true;
        return repository.admit(payload, credential, controller.signal);
      }, budget);
      const response = reply(200, { action: "record_stop", receipt });
      budget.check();
      return response;
    } catch (error) {
      expireIfElapsed();
      const failure = controller.signal.aborted ? new NativeStopFailure(503, "stop_deadline")
        : error instanceof NativeStopFailure ? error : new NativeStopFailure(503, "stop_unavailable", attempted);
      const uncertain = failure.uncertain || (attempted && failure.code === "stop_deadline");
      return reply(failure.status, { error: failure.code, outcome: uncertain ? "unknown" : "not_applied", retrySameRequest: uncertain });
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", disconnected); }
  };
}
