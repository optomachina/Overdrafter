import { createClient } from "@supabase/supabase-js";

export const WORKER_GATEWAY_SCHEMA = "overdrafter.worker-gateway.v1";
const MAX_BODY_BYTES = 8192;
const DEADLINE_MS = 5000;
type Action = "pair" | "boot" | "session";
type RpcName = "api_consume_worker_pairing" | "api_register_worker_boot" | "api_worker_session_eligibility";
type RpcResult = { data: unknown; error: { code?: string } | null };
export type WorkerGatewayRuntime = {
  enabled: () => boolean;
  rpc: (name: RpcName, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<RpcResult>;
  deadlineMs: number;
};
type Payload = {
  schema: typeof WORKER_GATEWAY_SCHEMA;
  action: Action;
  workerId: string;
  bootId?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  installationId?: string;
  pairingCode?: string;
};

class GatewayFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function secret(value: unknown, purpose: "odw" | "odp"): value is string {
  return typeof value === "string" && value.startsWith(`${purpose}_`) && value.length === 68
    && /^[0-9a-f]{64}$/.test(value.slice(4));
}
/** Create a purpose-bound 32-byte secret; store worker tokens under DPAPI before pairing. */
export function createWorkerSecret(purpose: "worker" | "pairing"): string {
  const prefix = purpose === "worker" ? "odw" : "odp";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** The gateway hashes the complete raw secret, never a caller-supplied digest. */
export async function hashWorkerSecret(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ schema: WORKER_GATEWAY_SCHEMA, ...value }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
/** A runtime that ignores AbortSignal must not keep the HTTP handler pending. */
function bounded<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const result = Promise.resolve(promise);
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new GatewayFailure(504, "deadline_exceeded"));
    };
    if (signal.aborted) { void result.catch(() => undefined); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
/** Limit decoded bytes while streaming, including bodies without Content-Length. */
async function readPayload(request: Request, signal: AbortSignal): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d{1,10}$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new GatewayFailure(413, "body_too_large");
  }
  if (!request.body) throw new GatewayFailure(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new GatewayFailure(400, "invalid_request");
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new GatewayFailure(413, "body_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new GatewayFailure(400, "invalid_request"); }
  } finally {
    // Cancellation itself may stall; it must not defeat the request deadline.
    void reader.cancel().catch(() => undefined);
  }
}
function validatePayload(value: unknown): Payload {
  if (!record(value) || value.schema !== WORKER_GATEWAY_SCHEMA || !uuid(value.workerId)
      || !["pair", "boot", "session"].includes(String(value.action))) {
    throw new GatewayFailure(400, "invalid_request");
  }
  const action = value.action as Action;
  const keys = ["schema", "action", "workerId"];
  if (action === "pair") keys.push("expectedRevision", "idempotencyKey", "installationId", "pairingCode");
  else if (action === "boot") keys.push("expectedRevision", "idempotencyKey", "bootId");
  else keys.push("bootId");
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
      || (action !== "session" && (!revision(value.expectedRevision) || value.expectedRevision === Number.MAX_SAFE_INTEGER || !uuid(value.idempotencyKey)))
      || (action !== "pair" && !uuid(value.bootId))
      || (action === "pair" && (!uuid(value.installationId) || !secret(value.pairingCode, "odp")))) {
    throw new GatewayFailure(400, "invalid_request");
  }
  return value as Payload;
}
async function operation(payload: Payload, token: string): Promise<{ name: RpcName; args: Record<string, unknown> }> {
  const args: Record<string, unknown> = {
    p_worker_id: payload.workerId, p_credential_sha256: await hashWorkerSecret(token),
  };
  if (payload.action === "pair") {
    return { name: "api_consume_worker_pairing", args: { ...args, p_expected_revision: payload.expectedRevision,
      p_key: payload.idempotencyKey, p_installation_id: payload.installationId,
      p_code_sha256: await hashWorkerSecret(payload.pairingCode!) } };
  }
  if (payload.action === "boot") {
    return { name: "api_register_worker_boot", args: { ...args, p_expected_revision: payload.expectedRevision,
      p_key: payload.idempotencyKey, p_boot_id: payload.bootId } };
  }
  return { name: "api_worker_session_eligibility", args: { ...args, p_boot_id: payload.bootId } };
}
/** Validate the database subject and emit only explicitly supported receipt fields. */
function receipt(value: unknown, payload: Payload): Record<string, unknown> {
  if (!record(value) || value.workerId !== payload.workerId || !revision(value.revision)) {
    throw new GatewayFailure(502, "invalid_upstream_result");
  }
  const common = { workerId: value.workerId, revision: value.revision };
  if (payload.action === "pair") {
    if (value.installationId !== payload.installationId || value.revision !== payload.expectedRevision! + 1 || !timestamp(value.pairedAt)) {
      throw new GatewayFailure(502, "invalid_upstream_result");
    }
    return { ...common, installationId: value.installationId, pairedAt: value.pairedAt };
  }
  if (payload.action === "boot") {
    if (value.bootId !== payload.bootId || value.revision !== payload.expectedRevision! + 1 || value.enabled !== false) {
      throw new GatewayFailure(502, "invalid_upstream_result");
    }
    return { ...common, bootId: value.bootId, enabled: false };
  }
  const reason = value.reason;
  const reasons = ["enabled", "paused", "expired", "boot_mismatch", "owner_enablement_required"];
  if (typeof reason !== "string" || !reasons.includes(reason) || !uuid(value.installationId)
      || (value.bootId !== null && !uuid(value.bootId)) || (value.sessionId !== null && !uuid(value.sessionId))
      || (value.expiresAt !== null && !timestamp(value.expiresAt)) || value.sessionEligible !== (reason === "enabled")) {
    throw new GatewayFailure(502, "invalid_upstream_result");
  }
  if (reason === "boot_mismatch") {
    if (value.bootId === payload.bootId) throw new GatewayFailure(502, "invalid_upstream_result");
  } else if (value.bootId !== payload.bootId) {
    throw new GatewayFailure(502, "invalid_upstream_result");
  }
  if (reason === "owner_enablement_required") {
    if (value.sessionId !== null || value.expiresAt !== null) throw new GatewayFailure(502, "invalid_upstream_result");
  } else if (reason !== "boot_mismatch" && (value.sessionId === null || value.expiresAt === null)) {
    throw new GatewayFailure(502, "invalid_upstream_result");
  }
  return { ...common, installationId: value.installationId, bootId: value.bootId, sessionId: value.sessionId,
    sessionEligible: value.sessionEligible, reason, expiresAt: value.expiresAt };
}
function rpcFailure(code: string | undefined): GatewayFailure {
  if (code === "42501") return new GatewayFailure(401, "worker_access_denied");
  if (code === "PT409" || code === "23505") return new GatewayFailure(409, "worker_conflict");
  if (code === "22023") return new GatewayFailure(400, "invalid_request");
  return new GatewayFailure(503, "upstream_unavailable");
}
/** Server-only RPC bridge. This credential is never returned or provided by Windows. */
async function serverRpc(name: RpcName, args: Record<string, unknown>, signal: AbortSignal): Promise<RpcResult> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || new URL(url).protocol !== "https:") throw new GatewayFailure(503, "gateway_unavailable");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return await client.rpc(name, args).abortSignal(signal);
}
/**
 * Build the custom-auth worker gateway. Pair/boot replies may be indeterminate
 * after transport failure; replay exactly, never infer a rollback from timeout.
 */
export function createEngineeringWorkerHandler(overrides: Partial<WorkerGatewayRuntime> = {}) {
  const runtime: WorkerGatewayRuntime = {
    enabled: () => Deno.env.get("ENGINEERING_WORKER_GATEWAY_ENABLED") === "true",
    rpc: serverRpc, deadlineMs: DEADLINE_MS, ...overrides,
  };
  if (!Number.isInteger(runtime.deadlineMs) || runtime.deadlineMs < 1 || runtime.deadlineMs > DEADLINE_MS) {
    throw new Error("Invalid gateway deadline configuration.");
  }
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled()) return json(503, { error: "gateway_disabled", outcome: "not_applied", retrySameRequest: false });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed", outcome: "not_applied", retrySameRequest: false });
    if (request.headers.has("origin") || new URL(request.url).search) return json(403, { error: "unsupported_transport", outcome: "not_applied", retrySameRequest: false });
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
        || (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity")) {
      return json(415, { error: "unsupported_media_type", outcome: "not_applied", retrySameRequest: false });
    }
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.slice(7);
    if (authorization.slice(0,7).toLowerCase() !== "bearer " || !secret(token, "odw")) {
      return json(401, { error: "worker_access_denied", outcome: "not_applied", retrySameRequest: false });
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), runtime.deadlineMs);
    const disconnected = () => controller.abort();
    request.signal.addEventListener("abort", disconnected, { once: true });
    let mutationAttempted = false;
    try {
      if (request.signal.aborted) controller.abort();
      const payload = validatePayload(await readPayload(request, controller.signal));
      const call = await bounded(operation(payload, token), controller.signal);
      if (controller.signal.aborted) throw new GatewayFailure(504, "deadline_exceeded");
      mutationAttempted = payload.action !== "session";
      const result = await bounded(runtime.rpc(call.name, call.args, controller.signal), controller.signal);
      if (result.error) {
        const failure = rpcFailure(result.error.code);
        if ([400,401,409].includes(failure.status)) mutationAttempted = false;
        throw failure;
      }
      return json(200, { action: payload.action, receipt: receipt(result.data, payload) });
    } catch (error) {
      const failure = error instanceof GatewayFailure ? error : new GatewayFailure(503, "upstream_unavailable");
      return json(failure.status, { error: failure.code, outcome: mutationAttempted ? "unknown" : "not_applied",
        retrySameRequest: mutationAttempted && failure.status >= 500 });
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener("abort", disconnected);
    }
  };
}

if (import.meta.main) Deno.serve(createEngineeringWorkerHandler());
