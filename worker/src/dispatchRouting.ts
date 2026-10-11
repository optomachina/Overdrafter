import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorAdapter } from "./adapters/base.js";
import {
  ProviderDispatchAuthorizationError,
  quoteWithProviderDispatchPreflight,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight.js";
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
 * The generic path admits only reviewed envelopes, and none is reviewed in
 * code, so no non-Xometry adapter can launch in production yet.
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
}): Promise<VendorQuoteAdapterOutput> {
  const claim =
    input.config.workerMode === "live"
      ? providerDispatchClaimFromTask({
          task: input.task,
          vendorQuoteResultId: input.vendorQuoteResultId,
          vendor: input.vendor,
        })
      : null;

  if (claim) {
    return quoteWithProviderDispatchPreflight({
      supabase: input.supabase,
      workerName: input.config.workerName,
      claimedAt: input.claimedAt,
      claim,
      scopeSnapshot: input.scopeSnapshot,
      adapter: input.adapter,
      quoteInput: input.quoteInput,
      onAuthorized: input.onAuthorized,
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
    adapter: input.adapter,
    quoteInput: input.quoteInput,
    onAuthorized: input.onAuthorized,
  });
}

export type DispatchAuthorizationFailure = {
  boundary: "xometry" | "provider";
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
  return null;
}
