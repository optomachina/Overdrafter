import { createClient } from "@supabase/supabase-js";
import {
  dispatchPreparedRequest, type DispatchIdentity, type PreparedAdapter,
  type PreparedDispatchRuntime,
} from "../../../server/engineering/dispatch-prepared-request.ts";

const SCHEMA = "overdrafter.prepared-dispatch.v1";
const MAX_BODY_BYTES = 1024;
const BODY_DEADLINE_MS = 5_000;
class BodyTimeoutError extends Error {}
type RpcName = "api_reserve_prepared_interpretation" | "api_finish_prepared_interpretation"
  | "api_fail_prepared_interpretation";
type RpcResult = { data: unknown; error: { code?: string } | null };
type Rpc = (name: RpcName, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<RpcResult>;
type Runtime = Readonly<{
  enabled: () => boolean;
  serviceKey: () => string | undefined;
  rpc: Rpc;
  adapter: PreparedAdapter;
  deadlineMs?: number;
}>;

function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ schema: SCHEMA, ...value }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function equalSecret(actual: string, expected: string): boolean {
  if (actual.length !== expected.length || expected.length < 32) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    && value !== "00000000-0000-0000-0000-000000000000";
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("missing body");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>MAX_BODY_BYTES)) throw new TypeError("large body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new BodyTimeoutError("Request body timed out.")), BODY_DEADLINE_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new TypeError("large body");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeoutId!);
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function serverRpc(name: RpcName, args: Record<string, unknown>, signal: AbortSignal): Promise<RpcResult> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || new URL(url).protocol !== "https:") throw new Error("database unavailable");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) },
  });
  return client.rpc(name, args).abortSignal(signal);
}
const unavailableAdapter: PreparedAdapter = () => { throw new Error("No model adapter is configured."); };
function rpcValue(result: RpcResult): unknown {
  if (result.error) throw new Error(result.error.code ?? "database_error");
  return result.data;
}
function dispatchRuntime(runtime: Runtime): PreparedDispatchRuntime {
  return {
    enabled: runtime.enabled, adapter: runtime.adapter, deadlineMs: runtime.deadlineMs,
    reserve: async (identity, signal) => rpcValue(await runtime.rpc("api_reserve_prepared_interpretation", {
      p_request_id: identity.requestId, p_expected_queue_revision: identity.expectedQueueRevision,
      p_idempotency_key: identity.idempotencyKey,
    }, signal)),
    finish: async (identity, result, signal) => rpcValue(await runtime.rpc("api_finish_prepared_interpretation", {
      p_request_id: identity.requestId, p_expected_queue_revision: identity.expectedQueueRevision,
      p_idempotency_key: identity.idempotencyKey, p_outcome: result.outcome,
      p_depth_mm: result.depthMm, p_response: result.response, p_clarification: result.clarification,
    }, signal)),
    fail: async (identity, code, signal) => rpcValue(await runtime.rpc("api_fail_prepared_interpretation", {
      p_request_id: identity.requestId, p_expected_queue_revision: identity.expectedQueueRevision,
      p_idempotency_key: identity.idempotencyKey, p_failure_code: code,
    }, signal)),
  };
}
/** Default-off service-to-service entry point; it never returns message or context bytes. */
export function createEngineeringInterpretationHandler(overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = {
    enabled: () => Deno.env.get("ENGINEERING_INTERPRETATION_ENABLED") === "true",
    serviceKey: () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    rpc: serverRpc, adapter: unavailableAdapter, ...overrides,
  };
  return async (request: Request): Promise<Response> => {
    if (!runtime.enabled() || runtime.adapter === unavailableAdapter) {
      return json(503, { state: "disabled" });
    }
    if (request.method !== "POST") return json(405, { state: "conflict" });
    if (request.headers.has("origin") || new URL(request.url).search
      || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json(403, { state: "conflict" });
    }
    const key = runtime.serviceKey();
    const authorization = request.headers.get("authorization") ?? "";
    if (!key || !authorization.startsWith("Bearer ")
      || !equalSecret(authorization.slice(7), key)) return json(401, { state: "conflict" });
    let identity: DispatchIdentity;
    try {
      const input = await readBody(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid");
      const data = input as Record<string, unknown>;
      if (Object.keys(data).sort().join(",") !== "expectedQueueRevision,idempotencyKey,requestId,schema"
        || data.schema !== SCHEMA || !uuid(data.requestId) || !uuid(data.idempotencyKey)
        || !Number.isSafeInteger(data.expectedQueueRevision)
        || (data.expectedQueueRevision as number) < 0) throw new TypeError("invalid");
      identity = { requestId: data.requestId, idempotencyKey: data.idempotencyKey,
        expectedQueueRevision: data.expectedQueueRevision as number };
    } catch (error) {
      if (error instanceof BodyTimeoutError) return json(504, { state: "timed_out" });
      return json(400, { state: "conflict" });
    }
    const result = await dispatchPreparedRequest(identity, dispatchRuntime(runtime));
    if (result.state === "completed") return json(200, { state: result.state, receipt: result.receipt });
    if (result.state === "failed") return json(200, { state: result.state, failureCode: result.failureCode });
    if (result.state === "reserved") return json(202, { state: result.state });
    if (result.state === "budget_exhausted") return json(429, { state: result.state });
    return json(result.state === "conflict" ? 409 : 503, { state: result.state });
  };
}

if (import.meta.main) Deno.serve(createEngineeringInterpretationHandler());
