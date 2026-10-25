import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export const WORKER_WAKE_RPC_ALLOWLIST: ReadonlySet<string> = new Set([
  "api_request_extraction",
  "api_request_debug_extraction",
  "api_request_quotes",
  "api_request_manual_quote",
  "api_request_manual_quotes",
  "api_request_provider_dispatch",
  "api_request_xometry_beta_dispatch",
  "api_start_quote_run",
  "api_enqueue_debug_vendor_quote",
] satisfies (keyof Database["public"]["Functions"])[]);

const WORKER_WAKE_DEBOUNCE_MS = 10_000;
let lastFiredAt: number | undefined;
let now: () => number = Date.now;

export function isWorkerWakeEnabled(): boolean {
  return /^(true|1|on)$/i.test(import.meta.env.VITE_WORKER_WAKE_ON_SUBMIT ?? "");
}

export function requestWorkerWake(fn: string): void {
  if (!isWorkerWakeEnabled() || !WORKER_WAKE_RPC_ALLOWLIST.has(fn)) {
    return;
  }

  const timestamp = now();
  if (lastFiredAt !== undefined && timestamp - lastFiredAt < WORKER_WAKE_DEBOUNCE_MS) {
    return;
  }
  lastFiredAt = timestamp;

  try {
    void supabase.functions.invoke("worker-wake", { body: {} }).catch(() => {
      // Best effort only; never log error payloads that may contain secrets.
    });
  } catch {
    // A synchronous invocation failure must not affect the successful RPC.
  }
}

export function __resetWorkerWakeForTests(clock: () => number = Date.now): void {
  lastFiredAt = undefined;
  now = clock;
}
