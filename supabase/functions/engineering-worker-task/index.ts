import { createClient } from "@supabase/supabase-js";

/** Default-off worker authority seam for exactly one prepared native attempt. */
export const TASK_SCHEMA = "overdrafter.worker-task.v1";
const MAX_BODY = 2048;
const DEADLINE_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
type Action = "claim" | "eligibility" | "heartbeat";
type Rpc = "api_claim_native_task" | "api_native_attempt_eligibility" | "api_heartbeat_native_attempt";
type Result = { data: unknown; error: { code?: string } | null };
export type TaskRuntime = Readonly<{
  enabled: () => boolean;
  rpc: (name: Rpc, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<Result>;
}>;
class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
function id(v: unknown): v is string { return typeof v === "string" && UUID.test(v) && v !== "00000000-0000-0000-0000-000000000000"; }
function integer(v: unknown, min = 0): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v < Number.MAX_SAFE_INTEGER; }
function digest(v: unknown): v is string { return typeof v === "string" && SHA.test(v); }
function instant(v: unknown): v is string { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)); }
function exact(v: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
}
function reply(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ schema: TASK_SCHEMA, ...value }), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
async function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Failure(504, "deadline_exceeded"));
    if (signal.aborted) { void Promise.resolve(promise).catch(() => undefined); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
async function body(request: Request, signal: AbortSignal): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,6}$/.test(declared) || Number(declared) > MAX_BODY)) throw new Failure(413, "body_too_large");
  if (!request.body) throw new Failure(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Failure(400, "invalid_request");
      size += part.value.byteLength;
      if (size > MAX_BODY) throw new Failure(413, "body_too_large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Failure(400, "invalid_request"); }
  } finally { void reader.cancel().catch(() => undefined); }
}
type Payload = Record<string, unknown> & { schema: string; action: Action; workerId: string; bootId: string; taskId: string };
function payload(value: unknown): Payload {
  if (!object(value) || value.schema !== TASK_SCHEMA || !["claim", "eligibility", "heartbeat"].includes(String(value.action))
    || !id(value.workerId) || !id(value.bootId) || !id(value.taskId)) throw new Failure(400, "invalid_request");
  const action = value.action as Action;
  const keys = ["schema", "action", "workerId", "bootId", "taskId"];
  if (action === "claim") keys.push("runtimeAdmissionId", "inputAdmissionId", "revision", "idempotencyKey");
  else keys.push("attemptId", "fence");
  if (action === "heartbeat") keys.push("revision", "idempotencyKey");
  if (!exact(value, keys) || (action === "claim" && (!id(value.runtimeAdmissionId) || !id(value.inputAdmissionId)))
    || (action !== "claim" && (!id(value.attemptId) || !integer(value.fence, 1)))
    || (action !== "eligibility" && (!integer(value.revision) || !id(value.idempotencyKey)))) {
    throw new Failure(400, "invalid_request");
  }
  return value as Payload;
}
async function sha(text: string): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
}
function rpcFor(p: Payload, credential: string): { name: Rpc; args: Record<string, unknown> } {
  const args: Record<string, unknown> = { p_worker: p.workerId, p_credential: credential,
    p_boot: p.bootId, p_task: p.taskId };
  if (p.action === "claim") return { name: "api_claim_native_task", args: { ...args, p_runtime: p.runtimeAdmissionId,
    p_input: p.inputAdmissionId, p_revision: p.revision, p_key: p.idempotencyKey } };
  const attempt = { ...args, p_attempt: p.attemptId, p_fence: p.fence };
  if (p.action === "heartbeat") return { name: "api_heartbeat_native_attempt", args: {
    ...attempt, p_revision: p.revision, p_key: p.idempotencyKey } };
  return { name: "api_native_attempt_eligibility", args: attempt };
}
async function claimed(v: Record<string, unknown>, p: Payload): Promise<Record<string, unknown>> {
  const fields = ["outcome","taskId","taskRevision","attemptId","attemptRevision","workerId","installationId",
    "bootId","sessionId","runtimeAdmissionId","inputAdmissionId","fence","jobText","jobSha256",
    "contextText","contextSha256","claimedAt","deadlineAt","leaseExpiresAt"];
  if (!exact(v, fields) || v.outcome !== "claimed" || v.taskId !== p.taskId || v.workerId !== p.workerId
    || v.bootId !== p.bootId || v.runtimeAdmissionId !== p.runtimeAdmissionId || v.inputAdmissionId !== p.inputAdmissionId
    || !id(v.attemptId) || !id(v.installationId) || !id(v.sessionId) || !integer(v.fence, 1)
    || !integer(v.taskRevision) || !integer(v.attemptRevision) || v.taskRevision !== Number(p.revision) + 1
    || typeof v.jobText !== "string" || typeof v.contextText !== "string" || !digest(v.jobSha256) || !digest(v.contextSha256)
    || !instant(v.claimedAt) || !instant(v.deadlineAt) || !instant(v.leaseExpiresAt)
    || Date.parse(v.claimedAt as string) >= Date.parse(v.leaseExpiresAt as string)
    || Date.parse(v.leaseExpiresAt as string) > Date.parse(v.deadlineAt as string)
    || Date.parse(v.deadlineAt as string) - Date.parse(v.claimedAt as string) !== 600000
    || await sha(v.jobText) !== v.jobSha256 || await sha(v.contextText) !== v.contextSha256) throw new Failure(502, "invalid_upstream_result");
  let job: Record<string, unknown>, context: Record<string, unknown>;
  try { job = JSON.parse(v.jobText) as Record<string, unknown>; context = JSON.parse(v.contextText) as Record<string, unknown>; }
  catch { throw new Failure(502, "invalid_upstream_result"); }
  if (!object(job) || !object(context) || job.schema !== "overdrafter.prepared-dimension-job.v2"
    || job.attemptId !== v.attemptId || job.fence !== v.fence || job.contextSha256 !== v.contextSha256
    || job.inputSnapshotId !== context.snapshotId || job.outputSnapshotId === job.inputSnapshotId) {
    throw new Failure(502, "invalid_upstream_result");
  }
  return v;
}
async function receipt(value: unknown, p: Payload): Promise<Record<string, unknown>> {
  if (!object(value)) throw new Failure(502, "invalid_upstream_result");
  if (p.action === "claim") {
    if (value.outcome === "ineligible" && exact(value, ["outcome", "reason"])
      && typeof value.reason === "string" && ["owner_enablement_required", "native_slot_occupied", "qualified_inputs_required",
        "fresh_retry_authorization_required", "verified_predecessor_required", "qualified_seed_required"].includes(value.reason)) return value;
    return await claimed(value, p);
  }
  if (p.action === "eligibility") {
    if (!exact(value, ["attemptId", "fence", "eligible", "reason", "revision", "leaseExpiresAt", "deadlineAt"])
      || value.attemptId !== p.attemptId || value.fence !== p.fence || typeof value.eligible !== "boolean"
      || typeof value.reason !== "string" || value.eligible !== (value.reason === "eligible")
      || !integer(value.revision) || !instant(value.leaseExpiresAt) || !instant(value.deadlineAt)) {
      throw new Failure(502, "invalid_upstream_result");
    }
    return value;
  }
  const fields = value.outcome === "renewed" ? ["outcome","attemptId","fence","revision","leaseExpiresAt","deadlineAt"]
    : ["outcome","reason","attemptId","fence","revision"];
  if (!exact(value, fields) || !["renewed","recovery_required"].includes(String(value.outcome))
    || value.attemptId !== p.attemptId || value.fence !== p.fence || value.revision !== Number(p.revision) + 1
    || (value.outcome === "renewed" && (!instant(value.leaseExpiresAt) || !instant(value.deadlineAt)
      || Date.parse(value.leaseExpiresAt as string) > Date.parse(value.deadlineAt as string)))
    || (value.outcome === "recovery_required" && typeof value.reason !== "string")) throw new Failure(502, "invalid_upstream_result");
  return value;
}
async function serverRpc(name: Rpc, args: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || new URL(url).protocol !== "https:") throw new Failure(503, "gateway_unavailable");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) } });
  return await client.rpc(name, args).abortSignal(signal);
}
/** Worker token is purpose-bound; SQL checks current paired worker/session and slot. */
export function createWorkerTaskHandler(overrides: Partial<TaskRuntime> = {}) {
  const runtime: TaskRuntime = { enabled: () => Deno.env.get("ENGINEERING_WORKER_TASK_ENABLED") === "true", rpc: serverRpc, ...overrides };
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled()) return reply(503, { error: "task_disabled", outcome: "not_applied", retrySameRequest: false });
    if (request.method !== "POST" || request.headers.has("origin") || new URL(request.url).search
      || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
      || request.headers.has("content-encoding")) return reply(400, { error: "invalid_transport", outcome: "not_applied", retrySameRequest: false });
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer odw_[0-9a-f]{64}$/.test(authorization)) return reply(401, { error: "worker_access_denied", outcome: "not_applied", retrySameRequest: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const disconnected = () => controller.abort();
    request.signal.addEventListener("abort", disconnected, { once: true });
    let attempted = false;
    try {
      if (request.signal.aborted) controller.abort();
      const p = payload(await body(request, controller.signal));
      const call = rpcFor(p, await sha(authorization.slice(7)));
      attempted = p.action !== "eligibility";
      const result = await bounded(runtime.rpc(call.name, call.args, controller.signal), controller.signal);
      if (result.error) {
        const code = result.error.code;
        if (code === "42501") throw new Failure(401, "worker_access_denied");
        if (code === "PT409" || code === "23505") throw new Failure(409, "attempt_conflict");
        if (code === "22023") throw new Failure(400, "invalid_request");
        throw new Failure(503, "upstream_unavailable");
      }
      return reply(200, { action: p.action, receipt: await receipt(result.data, p) });
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure(503, "upstream_unavailable");
      const uncertain = attempted && failure.status >= 500;
      return reply(failure.status, { error: failure.code, outcome: uncertain ? "unknown" : "not_applied", retrySameRequest: uncertain });
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", disconnected); }
  };
}
if (import.meta.main) Deno.serve(createWorkerTaskHandler());
