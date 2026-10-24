import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorAdapter } from "./adapters/base.js";
import {
  createXometryUploadCapabilityCheckpoint,
  supabaseXometryAdmissionReader,
} from "./xometryUploadAdmission.js";
import {
  ProviderDispatchAuthorizationError,
  quoteWithProviderDispatchPreflight,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight.js";
import {
  guardProviderDispatch,
  PROVIDER_KILL_SWITCH_ENGAGED,
  ProviderDispatchRefusedError,
  ProviderKillSwitchError,
  providerDispatchCapMode,
  supabaseProviderSettingsPort,
  type ProviderKillSwitchReader,
  type ProviderSettingsPort,
} from "./providerSettings.js";
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
import {
  EXPORT_CONTROL_DENIAL_CODES,
  ExportControlLookupError,
  ExportControlMarkingBlockedError,
  type ExportControlDenialCode,
} from "./exportControl.js";

/**
 * OVD-381 (worker routing, OVD-464): the single seam that picks the dispatch
 * authorization boundary for a claimed `run_vendor_quote` task.
 *
 * - simulate mode, and every Xometry task, keep `quoteWithDispatchPreflight`
 *   exactly as before; stray generic permit keys on a Xometry task are ignored
 * - a live non-Xometry task carrying a generic permit (both
 *   `providerDispatchPermitId` and `providerDispatchEnvelopeFingerprint` as
 *   strings, as written by `api_request_provider_dispatch`) goes through the
 *   provider-neutral `quoteWithProviderDispatchPreflight`. The worker's
 *   `handleVendorQuoteTask` sends those tasks to the OVD-464 ordered pipeline
 *   (`providerTaskPipeline.ts`) instead and reaches this function only for
 *   Xometry and simulate mode. That route wraps its adapter with the same
 *   `guardProviderQuote` kill-switch guard used here
 * - any other live non-Xometry task stays on the specialized path, which
 *   refuses it with `dispatch_live_provider_not_permitted` before launch
 *
 * The generic path admits only envelopes listed in
 * `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`. Fictiv's
 * (`fictiv-quote-envelope.v1`, OVD-673), Quickparts
 * (`quickparts-quote-envelope.v1`, OVD-674), Weerg
 * (`weerg-quote-envelope.v1`, OVD-675) are listed here. OSH Cut remains
 * unreviewed and default-off for 1.0 (Blaine, 2026-10-20). A
 * database-approved decision for any other envelope is refused with
 * `provider_envelope_unknown` and no adapter launches.
 *
 * OVD-722: in live mode the provider kill switch is re-read immediately
 * before the adapter launches, after any authorization was obtained, so a
 * stale permit cannot bypass a switch flipped in between. The same guard is
 * handed to the adapter as `providerKillSwitchCheckpoint` for its own
 * navigation, upload, and configuration checkpoints.
 *
 * OVD-829: that before-launch step is `assertProviderDispatchAllowed`, the
 * universal supplier settings gate: kill switch first, then one durable
 * reservation against the supplier's daily quote cap.
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
  config: Pick<WorkerConfig, "workerMode" | "workerName" | "providerDurableDispatchCap">;
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
  /** Test seam; production reserves through `api_worker_reserve_provider_dispatch`. */
  reserveDispatch?: ProviderSettingsPort["reserveDispatch"];
}): Promise<VendorQuoteAdapterOutput> {
  // OVD-414: production Xometry dispatch always supplies the upload capability
  // checkpoint, which reads its admission decision from the database. Set on
  // the same object, never a copy, like beforeProviderDisclosure below.
  const innerAdapter: Pick<VendorAdapter, "quote"> =
    input.vendor === "xometry"
      ? {
          quote: (quoteInput) => {
            quoteInput.uploadCapabilityCheckpoint ??= createXometryUploadCapabilityCheckpoint(
              supabaseXometryAdmissionReader(input.supabase),
            );
            return input.adapter.quote(quoteInput);
          },
        }
      : input.adapter;
  // Wraps the adapter so the settings gate (kill switch, then the daily cap
  // reservation) sits between the admitted authorization and the launch;
  // onAuthorized fires only once it passes.
  const adapter: Pick<VendorAdapter, "quote"> = {
    quote: input.config.workerMode === "live"
      ? guardProviderDispatch({
          provider: input.vendor,
          port: supabaseProviderSettingsPort(input.supabase, {
            ...(input.killSwitchReader ? { readKillSwitch: input.killSwitchReader } : {}),
            ...(input.reserveDispatch ? { reserveDispatch: input.reserveDispatch } : {}),
          }),
          capMode: providerDispatchCapMode(input.config.providerDurableDispatchCap),
          quote: (quoteInput) => innerAdapter.quote(quoteInput),
          onLaunch: input.onAuthorized,
        })
      : async (quoteInput) => {
          input.onAuthorized?.();
          return innerAdapter.quote(quoteInput);
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

/**
 * OVD-723 window 1: the export-control gate, asked before every dispatch
 * preflight (`api_check_export_control_dispatch`). Window 1 leaves the
 * preflights unchanged, so this check is what stops a controlled, uncertain,
 * undeclared, blocked, or unscanned part in the new worker; the contract
 * migration later wraps both preflights with the same gate on the server.
 * Anything but exactly `{ allowed: true }` is a denial: an RPC error, a thrown
 * call, or a malformed response throws `ExportControlLookupError`, which the
 * task retries on the finite schedule. A decision is thrown as the boundary's
 * own authorization error, and the task holds the lane (see
 * `exportControlHoldReason`) before any adapter launches.
 */
export async function assertExportControlDispatchAllowed(
  supabase: Pick<SupabaseClient, "rpc">,
  input: { taskId: string; vendor: VendorName },
): Promise<void> {
  let denial: ExportControlDenialCode | null = "export_control_lookup_failed";
  try {
    const { data, error } = await supabase.rpc("api_check_export_control_dispatch", {
      p_work_queue_task_id: input.taskId,
      p_provider: input.vendor,
    });
    if (!error && data && typeof data === "object" && !Array.isArray(data)) {
      const value = data as Record<string, unknown>;
      const keys = Object.keys(value).sort((a, b) => a.localeCompare(b)).join(",");
      if (value.allowed === true && keys === "allowed") {
        denial = null;
      } else if (
        value.allowed === false
        && keys === "allowed,reasonCode"
        && (EXPORT_CONTROL_DENIAL_CODES as readonly unknown[]).includes(value.reasonCode)
      ) {
        denial = value.reasonCode as ExportControlDenialCode;
      }
    }
  } catch {
    // Fail closed: denial stays export_control_lookup_failed.
  }
  if (denial === null) return;
  // A failed lookup is not a decision: it retries (finite), then holds.
  if (denial === "export_control_lookup_failed") throw new ExportControlLookupError("dispatch");
  throw input.vendor === "xometry"
    ? new XometryDispatchAuthorizationError(denial)
    : new ProviderDispatchAuthorizationError(denial);
}

/**
 * OVD-723 point in time checks. Wraps an adapter so the export-control gate is
 * asked once more after the dispatch preflight authorizes and before
 * `adapter.quote` starts, and again through `beforeProviderDisclosure`, which
 * the portal kernel and the Xometry and Fictiv adapters await right before
 * the first file upload (navigation and page classification can take a
 * while). A declaration change or a marking block that lands in between stops
 * the upload (`assertExportControlDispatchAllowed` throws). The residual
 * window is the time between the last answer and the provider receiving the
 * files.
 */
export function withExportControlDispatchRecheck(
  adapter: Pick<VendorAdapter, "quote">,
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    taskId: string;
    vendor: VendorName;
    /** Called once the recheck before `adapter.quote` passes; never for a denied lane. */
    onAllowed?: () => void;
  },
): Pick<VendorAdapter, "quote"> {
  return {
    quote: async (quoteInput) => {
      await assertExportControlDispatchAllowed(supabase, input);
      input.onAllowed?.();
      // Set on the same object, never a copy: authorized inputs are tracked by
      // identity (live evaluation file capture), so a spread would drop them.
      const previous = quoteInput.beforeProviderDisclosure;
      quoteInput.beforeProviderDisclosure = () => assertExportControlDispatchAllowed(supabase, input);
      try {
        return await adapter.quote(quoteInput);
      } finally {
        quoteInput.beforeProviderDisclosure = previous;
      }
    },
  };
}

export type DispatchAuthorizationFailure = {
  boundary: "xometry" | "provider" | "kill_switch" | "provider_settings";
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
  // OVD-829: refused before launch, so nothing reached the supplier.
  if (error instanceof ProviderDispatchRefusedError) {
    return { boundary: "provider_settings", reasonCode: error.reasonCode, retryable: error.retryable };
  }
  return null;
}

/**
 * OVD-998 (OVD-987 S4): the Xometry preflight refused a lane above quantity 1
 * because the user quantity switch does not admit it. Preflight runs before the
 * browser launches, so nothing reached Xometry. The note names the quantity as
 * the reason and says what happens next; it never says the switch is global,
 * because the rollout may admit a quantity per participant or per request.
 */
export const DISPATCH_QUANTITY_NOT_ADMITTED_NOTE =
  "Xometry quote not started: this request is for a quantity above 1, and quantities above 1 are not enabled for this request in the controlled beta. "
  + "Nothing was sent to Xometry. Manual follow-up is required.";

/**
 * Lane note for a terminal Xometry preflight denial that has copy of its own;
 * null keeps the generic "authorization was denied" note. Only the exact
 * Xometry boundary qualifies, so a lookalike code from another boundary never
 * borrows this wording.
 */
export function xometryDispatchDenialNote(failure: DispatchAuthorizationFailure): string | null {
  if (failure.boundary === "xometry" && !failure.retryable && failure.reasonCode === "dispatch_quantity_not_admitted") {
    return DISPATCH_QUANTITY_NOT_ADMITTED_NOTE;
  }
  return null;
}

/** Customer-safe note on a held lane. It names the hold and the way out, never the files' content. */
export const EXPORT_CONTROL_HOLD_NOTE =
  "Held by export control. These files were not sent to this supplier and must not be quoted manually. "
  + "Open the part and follow its export-control notice: answer the export-control question, recheck files that are still waiting for a check, "
  + "or replace a drawing or STEP file that could not be read. Parts with export-control markings stay held until an OverDrafter admin reviews them.";

/**
 * The hold note for a lane whose provider automation had already started when
 * the export-control gate refused or could not be read, so an upload may have
 * reached the supplier. It never claims that nothing was sent.
 */
export const EXPORT_CONTROL_HOLD_AFTER_ADAPTER_START_NOTE =
  "Held by export control after automation with this supplier had started, so some files may already have reached it. "
  + "This lane is closed, will not be retried, and must not be quoted manually. An OverDrafter admin should review what was sent.";

/**
 * The hold note for a generic provider lane whose export-control check could
 * not be read after its automation started but before the adapter marked any
 * provider mutation (no upload or quote configuration yet). The lane is still
 * held and never requeued, but nothing reached the supplier. It promises no
 * retry: the admin queue for these lanes is OVD-753.
 */
export const EXPORT_CONTROL_LOOKUP_HOLD_BEFORE_UPLOAD_NOTE =
  "Held because the export-control check could not be read before any file was sent to this supplier. "
  + "Nothing was sent to this supplier. This lane will not be retried automatically, is held for review, and must not be quoted manually.";

/**
 * Picks the hold note for a lane. `providerMutationStarted` is the lane's
 * outer phase (fail closed: set once the adapter ran). On the generic route,
 * `stopBeforeProviderMutation` is true when the export stop was raised while
 * the pipeline's own mutation phase was still unmarked, so no upload had
 * started even though the adapter had.
 */
export function exportControlHoldNote(input: {
  providerMutationStarted: boolean;
  stopBeforeProviderMutation: boolean;
  lookupFailed: boolean;
}): string {
  if (!input.providerMutationStarted) return EXPORT_CONTROL_HOLD_NOTE;
  if (!input.stopBeforeProviderMutation) return EXPORT_CONTROL_HOLD_AFTER_ADAPTER_START_NOTE;
  return input.lookupFailed ? EXPORT_CONTROL_LOOKUP_HOLD_BEFORE_UPLOAD_NOTE : EXPORT_CONTROL_HOLD_NOTE;
}

/**
 * OVD-723: a quote lane held by export control. Every export-control code a
 * dispatch boundary returns (from the worker's check or, after the contract,
 * from the preflight wrappers) and a marking hit found while staging the lane
 * is a hold: terminal, never retried, and never routed to manual vendor
 * follow-up, because quoting the files by hand would send them to the vendor
 * the gate just refused. The worker's own failed lookup
 * (`ExportControlLookupError`) is not a hold until its retries run out.
 * Returns the reason code, or null for anything else.
 */
export function exportControlHoldReason(error: unknown): ExportControlDenialCode | null {
  if (error instanceof ExportControlMarkingBlockedError) return "export_review_pending";
  const failure = dispatchAuthorizationFailure(error);
  if (failure && (EXPORT_CONTROL_DENIAL_CODES as readonly string[]).includes(failure.reasonCode)) {
    return failure.reasonCode as ExportControlDenialCode;
  }
  return null;
}
