import { VendorAutomationError } from "./types.js";

export const VENDOR_TASK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

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
  if (error instanceof VendorAutomationError) {
    return error.code;
  }

  return "task_failure";
}

export function isRetryableVendorTaskError(error: unknown) {
  if (error instanceof VendorAutomationError) {
    switch (error.code) {
      case "navigation_failure":
        return true;
      case "upload_failure":
        return error.payload.reason !== "missing_cad_file";
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
