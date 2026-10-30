import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export const WORKER_WAKE_RPC_ALLOWLIST: ReadonlySet<string> = new Set([
  ...([
    "api_request_extraction",
    "api_request_debug_extraction",
    "api_request_provider_dispatch",
    "api_request_xometry_beta_dispatch",
    "api_start_quote_run",
  ] satisfies (keyof Database["public"]["Functions"])[]),
  // Called via callUntypedRpc because it is absent from the generated types.
  "api_request_export_marking_rescan",
]);

const WORKER_WAKE_DEBOUNCE_MS = 10_000;
const WORKER_WAKE_FAILURE_MESSAGE = "worker wake request failed";
let lastFiredAt: number | undefined;

export function isWorkerWakeEnabled(): boolean {
  return /^(true|1|on)$/i.test(import.meta.env.VITE_WORKER_WAKE_ON_SUBMIT ?? "");
}

export function requestWorkerWake(fn: string): void {
  if (!isWorkerWakeEnabled() || !WORKER_WAKE_RPC_ALLOWLIST.has(fn)) {
    return;
  }

  const timestamp = Date.now();
  if (lastFiredAt !== undefined && timestamp - lastFiredAt < WORKER_WAKE_DEBOUNCE_MS) {
    return;
  }
  lastFiredAt = timestamp;

  try {
    void supabase.functions.invoke("worker-wake", { body: {} }).catch(() => {
      console.warn(WORKER_WAKE_FAILURE_MESSAGE);
    });
  } catch {
    console.warn(WORKER_WAKE_FAILURE_MESSAGE);
  }
}
