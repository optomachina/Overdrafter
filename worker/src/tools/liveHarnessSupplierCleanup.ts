/**
 * Live-harness record of supplier-side cleanup (Blaine's standing rule,
 * 2026-10-15): a capture, certification or e2e run that uploads a test part
 * must remove it from the supplier cart/quote once everything is captured.
 *
 * The removal itself runs inside the portal kernel's cleanup hook for the
 * definitions that declare one (OSH Cut). The harness reads the reported
 * outcome from the result or error payload and writes one structured line
 * per run; any run that reached upload without a confirmed removal is a
 * warning that names the vendor and quantity for manual removal. Reporting
 * never throws and never changes the row's outcome.
 */

export type SupplierCartCleanupStatus =
  | "removed"
  | "not_found"
  | "incomplete"
  | "failed"
  | "skipped_kill_switch"
  /** The run reached upload, but the adapter declares no cleanup. */
  | "not_declared"
  /** The payload does not establish whether an upload occurred. */
  | "unknown"
  /** Nothing was uploaded, so there is nothing to remove. */
  | "not_needed";

export type SupplierCartCleanupRecord = {
  status: SupplierCartCleanupStatus;
  removed: number;
  remaining: number | null;
  reason: string | null;
  manualRemovalRequired: boolean;
};

const REPORTED_STATUSES: ReadonlySet<string> = new Set([
  "removed", "not_found", "incomplete", "failed", "skipped_kill_switch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Derives the cleanup record from an adapter result or error payload. */
export function supplierCartCleanupFromPayload(payload: unknown): SupplierCartCleanupRecord {
  const source = isRecord(payload) ? payload : {};
  const report = source.cartCleanup;
  if (isRecord(report) && typeof report.status === "string" && REPORTED_STATUSES.has(report.status)) {
    const status = report.status as SupplierCartCleanupStatus;
    return {
      status,
      removed: finiteCount(report.removed) ?? 0,
      remaining: finiteCount(report.remaining),
      reason: typeof report.reason === "string" ? report.reason : null,
      // `not_found` after an upload means the part could not be located, not that it is gone.
      manualRemovalRequired: status !== "removed",
    };
  }
  const mutation = source.providerMutationPossible;
  // An adapter that never touched the provider (SendCutSend's offline evaluation) needs no cleanup, but an
  // explicit providerMutationPossible: true still wins over a contradictory "no interaction" claim.
  const cleanupNotNeeded = mutation === false || (mutation !== true && source.providerInteractionAttempted === false);
  return {
    status: cleanupNotNeeded ? "not_needed" : mutation === true ? "not_declared" : "unknown",
    removed: 0,
    remaining: null,
    reason: null,
    manualRemovalRequired: !cleanupNotNeeded,
  };
}

/** Logs and returns the run's supplier-cleanup record; never throws. */
export function reportSupplierCartCleanup(
  input: { vendor: string; quantity: number; payload: unknown },
  log: (line: string, warn: boolean) => void = (line, warn) => (warn ? console.warn(line) : console.info(line)),
): SupplierCartCleanupRecord {
  let record: SupplierCartCleanupRecord;
  try {
    record = supplierCartCleanupFromPayload(input.payload);
  } catch {
    record = { status: "failed", removed: 0, remaining: null, reason: "cleanup_report_unreadable", manualRemovalRequired: true };
  }
  try {
    log(JSON.stringify({
      level: record.manualRemovalRequired ? "warn" : "info",
      source: "liveHarnessSupplierCleanup",
      vendor: input.vendor,
      quantity: input.quantity,
      ...record,
      ...(record.manualRemovalRequired
        ? { action: `Review the ${input.vendor} cart/quote manually and remove any uploaded test part.` }
        : {}),
    }), record.manualRemovalRequired);
  } catch {
    // Logging is best-effort; the row keeps the record either way.
  }
  return record;
}
