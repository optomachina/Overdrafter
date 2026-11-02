import { createClient } from "@supabase/supabase-js";
import { mintIdToken, workerOrigin } from "./oidc.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
export type WakeRuntime = {
  enabled: () => boolean;
  authenticate: (token: string, signal: AbortSignal) => Promise<boolean>;
  takeSlot: (signal: AbortSignal) => Promise<boolean>;
  wake: (signal: AbortSignal) => Promise<boolean>;
  deadlineMs: number;
};
function reply(status: number): Response {
  return new Response(null, { status, headers: { ...cors, ...(status === 429 ? { "Retry-After": "10" } : {}) } });
}
// Never buffer an unbounded caller body. The client sends {} (or no body).
async function emptyBody(request: Request, signal: AbortSignal): Promise<boolean> {
  if (!request.body) return true;
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 64) return false;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (!text.trim()) return true;
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
  finally { signal.removeEventListener("abort", cancel); cancel(); }
}
export function createWakeHandler(runtime: WakeRuntime) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return reply(204);
    if (request.method !== "POST") return reply(405);
    if (!runtime.enabled()) return reply(503);
    const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) return reply(401);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(reply(504)); }, runtime.deadlineMs);
    });
    const work = async () => {
      if (!await runtime.authenticate(token, controller.signal)) return reply(401);
      if (controller.signal.aborted) return reply(504);
      if (!await emptyBody(request, controller.signal)) return reply(400);
      if (controller.signal.aborted) return reply(504);
      if (!await runtime.takeSlot(controller.signal)) return reply(429);
      if (controller.signal.aborted) return reply(504);
      return reply(await runtime.wake(controller.signal) ? 204 : 502);
    };
    try { return await Promise.race([work().catch(() => reply(503)), deadline]); }
    finally { clearTimeout(timer!); controller.abort(); }
  };
}
export function productionRuntime(env: (name: string) => string | undefined, http: typeof fetch = fetch): WakeRuntime {
  function client(signal: AbortSignal) {
    return createClient(env("SUPABASE_URL") ?? "", env("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => http(input, { ...init, signal, redirect: "error" }) },
    });
  }
  return {
    enabled: () => env("WORKER_WAKE_ENABLED") === "true",
    deadlineMs: 15000,
    authenticate: async (token, signal) => {
      const { data, error } = await client(signal).auth.getUser(token);
      return !error && !!data.user?.id && data.user.role === "authenticated" && data.user.is_anonymous !== true;
    },
    takeSlot: async (signal) => {
      const { data, error } = await client(signal).rpc("api_take_worker_wake_slot");
      if (error || typeof data !== "boolean") throw new Error("wake unavailable");
      return data;
    },
    wake: async (signal) => {
      const origin = workerOrigin(env("WORKER_WAKE_URL") ?? "");
      const token = await mintIdToken(env("WORKER_WAKE_SERVICE_ACCOUNT_JSON") ?? "", origin, signal, http);
      // A cold start may return 503. Retry once, within the same overall deadline.
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const response = await http(origin + "/", {
          method: "GET", headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error",
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.ok) return true;
        if (response.status !== 503 || attempt === 1) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      return false;
    },
  };
}
if (import.meta.main) Deno.serve(createWakeHandler(productionRuntime((name) => Deno.env.get(name))));
