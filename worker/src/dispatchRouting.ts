import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorAdapter } from "./adapters/base.js";
import {
  ProviderDispatchAuthorizationError,
  quoteWithProviderDispatchPreflight,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight.js";
import {
  createProviderKillSwitchGuard,
  PROVIDER_KILL_SWITCH_ENGAGED,
  ProviderKillSwitchError,
  supabaseProviderKillSwitchReader,
  type ProviderKillSwitchReader,
} from "./providerKillSwitch.js";
import type {
  VendorName,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
  WorkerConfig,
} from "./types.js";
import {
  quoteWithDispatchPreflight,
  XometryDispatchAuthorizationError,
} from "./xometryDispatchPreflight.js";

/**
 * OVD-381 (worker routing, OVD-464): the single seam that picks the dispatch
 * authorization boundary for a claimed `run_vendor_quote` task.
 *
 * - simulate mode, and every Xometry task, keep `quoteWithDispatchPreflight`
 *   exactly as before; stray generic permit keys on a Xometry task are ignored
 * - a live non-Xometry task carrying a generic permit (both
 *   `providerDispatchPermitId` and `providerDispatchEnvelopeFingerprint` as
 *   strings, as written by `api_request_provider_dispatch`) goes through the
 *   provider-neutral `quoteWithProviderDispatchPreflight`
 * - any other live non-Xometry task stays on the specialized path, which
 *   refuses it with `dispatch_live_provider_not_permitted` before launch
 *
 * The generic path admits only envelopes listed in
 * `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`. Fictiv's
 * (`fictiv-quote-envelope.v1`, OVD-673), Quickparts
 * (`quickparts-quote-envelope.v1`, OVD-674), and Weerg
 * (`weerg-quote-envelope.v1`, OVD-675) are listed here. A
 * database-approved decision for any other envelope is refused with
 * `provider_envelope_unknown` and no adapter launches.
 *
 * OVD-722: in live mode the provider kill switch is re-read immediately
 * before the adapter launches, after any authorization was obtained, so a
 * stale permit cannot bypass a switch flipped in between. The same guard is
 * handed to the adapter as `providerKillSwitchCheckpoint` for its own
 * navigation, upload, and configuration checkpoints.
 */
export function providerDispatchClaimFromTask(input: {
  task: { id: string; payload: Record<string, unknown> };
  vendorQuoteResultId: string;
  vendor: VendorName;
}): ProviderDispatchClaim | null {
  if (input.vendor === "xometry") return null;
  const permitId = input.task.payload.providerDispatchPermitId;
  const envelopeFingerprint = input.task.payload.providerDispatchEnvelopeFingerprint;
  if (typeof permitId !== "string" || typeof envelopeFingerprint !== "string") return null;
  return {
    workQueueTaskId: input.task.id,
    vendorQuoteResultId: input.vendorQuoteResultId,
    provider: input.vendor,
    permitId,
    envelopeFingerprint,
  };
}

export async function quoteWithRoutedDispatchPreflight(input: {
  supabase: SupabaseClient;
  config: Pick<WorkerConfig, "workerMode" | "workerName">;
  task: { id: string; payload: Record<string, unknown> };
  vendorQuoteResultId: string;
  claimedAt: string;
  vendor: VendorName;
  scopeSnapshot: Record<string, unknown>;
  adapter: Pick<VendorAdapter, "quote">;
  quoteInput: VendorQuoteAdapterInput;
  onAuthorized?: () => void;
  /** Test seam; production reads `api_worker_provider_kill_switch_state` on every checkpoint. */
  killSwitchReader?: ProviderKillSwitchReader;
}): Promise<VendorQuoteAdapterOutput> {
  const guard =
    input.config.workerMode === "live"
      ? createProviderKillSwitchGuard(
          input.killSwitchReader ?? supabaseProviderKillSwitchReader(input.supabase),
          input.vendor,
        )
      : null;
  // Wraps the adapter so the final kill-switch read sits between the admitted
  // authorization and the launch; onAuthorized fires only once it passes.
  const adapter: Pick<VendorAdapter, "quote"> = {
    quote: async (quoteInput) => {
      if (guard) await guard("before_launch");
      input.onAuthorized?.();
      return input.adapter.quote(guard ? { ...quoteInput, providerKillSwitchCheckpoint: guard } : quoteInput);
    },
  };
  const claim =
    input.config.workerMode === "live"
      ? providerDispatchClaimFromTask({
          task: input.task,
          vendorQuoteResultId: input.vendorQuoteResultId,
          vendor: input.vendor,
        })
      : null;

  try {
    return await routeDispatchPreflight(input, claim, adapter);
  } catch (error) {
    // A server preflight that denied for the kill switch ends the same way as a
    // worker checkpoint refusal: cancelled_provider_disabled, never retried.
    if (serverKillSwitchDenial(error)) {
      throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, input.vendor, "server_preflight");
    }
    throw error;
  }
}

function serverKillSwitchDenial(error: unknown): boolean {
  return (
    (error instanceof XometryDispatchAuthorizationError && error.reasonCode === PROVIDER_KILL_SWITCH_ENGAGED) ||
    (error instanceof ProviderDispatchAuthorizationError && error.denial === PROVIDER_KILL_SWITCH_ENGAGED)
  );
}

function routeDispatchPreflight(
  input: Parameters<typeof quoteWithRoutedDispatchPreflight>[0],
  claim: ProviderDispatchClaim | null,
  adapter: Pick<VendorAdapter, "quote">,
): Promise<VendorQuoteAdapterOutput> {
  if (claim) {
    return quoteWithProviderDispatchPreflight({
      supabase: input.supabase,
      workerName: input.config.workerName,
      claimedAt: input.claimedAt,
      claim,
      scopeSnapshot: input.scopeSnapshot,
      adapter,
      quoteInput: input.quoteInput,
    });
  }

  return quoteWithDispatchPreflight({
    supabase: input.supabase,
    config: input.config,
    workQueueTaskId: input.task.id,
    vendorQuoteResultId: input.vendorQuoteResultId,
    claimedAt: input.claimedAt,
    vendor: input.vendor,
    scopeSnapshot: input.scopeSnapshot,
    adapter,
    quoteInput: input.quoteInput,
  });
}

export type DispatchAuthorizationFailure = {
  boundary: "xometry" | "provider" | "kill_switch";
  reasonCode: string;
  retryable: boolean;
};

/** Bounded view of either dispatch authorization error; null for anything else. */
export function dispatchAuthorizationFailure(error: unknown): DispatchAuthorizationFailure | null {
  if (error instanceof XometryDispatchAuthorizationError) {
    return {
      boundary: "xometry",
      reasonCode: error.reasonCode,
      retryable: error.reasonCode === "dispatch_preflight_unavailable",
    };
  }
  if (error instanceof ProviderDispatchAuthorizationError) {
    return { boundary: "provider", reasonCode: error.denial, retryable: error.retryable };
  }
  if (error instanceof ProviderKillSwitchError) {
    return { boundary: "kill_switch", reasonCode: error.reasonCode, retryable: error.retryable };
  }
  return null;
}
