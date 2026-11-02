import { VendorAutomationError } from "./types.js";
import { summarizeWorkerError } from "./errorSummary.js";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight.js";
import { ProviderKillSwitchError } from "./providerKillSwitch.js";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight.js";
import {
  ExportControlDrawingUnreadError,
  ExportControlExtractionDeniedError,
  ExportControlLookupError,
  ExportControlMarkingBlockedError,
} from "./exportControl.js";
import {
  currentProviderMutationPhase,
  type ProviderMutationPhase,
} from "./providerMutationPhase.js";

export const VENDOR_TASK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** Bookkeeping retries read stored results before any provider work. */
export class VendorQuoteBookkeepingError extends Error {
  constructor(cause: unknown) {
    super(`Vendor quote bookkeeping failed: ${summarizeWorkerError(cause)}`, { cause });
    this.name = "VendorQuoteBookkeepingError";
  }
}

const NON_RETRYABLE_MESSAGE_PATTERNS = [
  /run_vendor_quote task is missing/i,
  /vendor quote result row was not found/i,
  /no approved requirement found/i,
  /part .* not found/i,
  /unhandled task type/i,
] as const;

const RETRYABLE_GENERIC_MESSAGE_PATTERNS = [
  /failed to download storage object/i,
  /econnreset|econnrefused|etimedout|enotfound|eai_again/i,
  /target closed|page crashed|browser has been closed/i,
  /navigation/i,
  /network/i,
] as const;

export function retryCountForAttempts(attempts: number) {
  return Math.max(0, attempts - 1);
}

export function failureCodeForError(error: unknown) {
  if (error instanceof VendorQuoteBookkeepingError) return "quote_bookkeeping_failed";
  if (error instanceof XometryDispatchAuthorizationError) {
    return error.reasonCode;
  }

  if (error instanceof ProviderDispatchAuthorizationError) {
    return error.denial;
  }

  if (error instanceof ProviderKillSwitchError) {
    return error.reasonCode;
  }

  if (error instanceof VendorAutomationError) {
    return error.code;
  }

  if (error instanceof ExportControlMarkingBlockedError) {
    return "export_review_pending";
  }

  if (error instanceof ExportControlLookupError) {
    return error.reasonCode;
  }

  if (error instanceof ExportControlExtractionDeniedError) {
    return error.reasonCode;
  }

  if (error instanceof ExportControlDrawingUnreadError) {
    return "export_scan_unread";
  }

  return "task_failure";
}

/**
 * Retries transient navigation and persistence failures, plus upload failures that
 * are not caused by missing or unsupported CAD input. Authentication, captcha,
 * selector, and unexpected-UI failures require intervention and remain terminal.
 *
 * Once provider mutation starts, only stored-result bookkeeping can retry.
 * Provider failures remain fail-closed, including transport-looking errors.
 */
export function isRetryableVendorTaskError(
  error: unknown,
  mutationPhase: ProviderMutationPhase | undefined = currentProviderMutationPhase(),
) {
  // Safe even after an upload: the next claim synchronizes the settled lane.
  if (error instanceof VendorQuoteBookkeepingError) return true;
  if (mutationPhase?.started) {
    return false;
  }

  if (error instanceof XometryDispatchAuthorizationError) {
    return error.reasonCode === "dispatch_preflight_unavailable";
  }

  if (error instanceof ProviderDispatchAuthorizationError) {
    return error.retryable;
  }

  // OVD-723: the worker's own export-control lookup failed before any
  // preflight; retried like an unavailable preflight, on the finite schedule.
  if (error instanceof ExportControlLookupError) {
    return true;
  }

  if (error instanceof ProviderKillSwitchError) {
    return error.retryable;
  }

  if (error instanceof VendorAutomationError) {
    // Once a provider-facing mutation may have occurred, an automatic retry
    // could duplicate an upload or configuration change. Human inspection is
    // required regardless of the transport-flavored error code.
    if (error.payload.providerMutationPossible === true) {
      return false;
    }
    switch (error.code) {
      case "navigation_failure":
        return true;
      case "persistence_failure":
        return error.payload.providerMutationPossible !== true;
      case "upload_failure":
        return !["missing_cad_file", "unsupported_file_type"].includes(
          String(error.payload.reason),
        );
      case "login_required":
      case "captcha":
      case "selector_failure":
      case "unexpected_ui_state":
        return false;
      default:
        return false;
    }
  }

  const message = error instanceof Error ? error.message : String(error);

  if (NON_RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  return RETRYABLE_GENERIC_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** A rescan task row that can never succeed (it names no job or file). */
export class ExportMarkingRescanTaskInvalidError extends Error {
  constructor() {
    super("export_marking_rescan task is missing job_id or jobFileId.");
    this.name = "ExportMarkingRescanTaskInvalidError";
  }
}

/**
 * OVD-723: a scan only rescan sends nothing to any provider or model, so a
 * repeat is safe. Every failure (a Storage download, an RPC, a hash that could
 * not be verified, the export check itself) is retried on the finite schedule;
 * only a task row without its job or file is terminal. A rescan that still
 * fails is shown on the part page (scanState missing), whose owner action
 * requeues it.
 */
export function isRetryableExportRescanError(error: unknown) {
  return !(error instanceof ExportMarkingRescanTaskInvalidError);
}

export function retryDelayForAttempts(attempts: number) {
  return VENDOR_TASK_RETRY_DELAYS_MS[attempts - 1] ?? null;
}

export function nextRetryAt(attempts: number, now = new Date()) {
  const delayMs = retryDelayForAttempts(attempts);

  if (delayMs === null) {
    return null;
  }

  return new Date(now.getTime() + delayMs).toISOString();
}
