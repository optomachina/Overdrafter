import type { JobExportControlStatus } from "@/features/quotes/api/export-control-api";

export type ExportControlNoticeAction = "declare" | "rescan";

export type ExportControlNoticeCopy = {
  title: string;
  detail: string;
  action: string | null;
  /** What the action button does; null when there is no action. */
  actionKind: ExportControlNoticeAction | null;
};

/**
 * Window 1 (expand) holds automatic dispatch only. A manual quote request is
 * not refused by the server until the contract migration gates it, so a held
 * part's copy asks the owner not to send one instead of promising it cannot
 * happen.
 */
const NO_MANUAL_QUOTE = "Do not request a manual quote for this part while it is held.";

/**
 * Plain explanation of an OVD-723 hold. Returns null when the part is clear
 * (declared not_controlled with no open or confirmed marking block).
 */
export function getExportControlNoticeCopy(status: JobExportControlStatus): ExportControlNoticeCopy | null {
  if (status.exportReviewState === "confirmed_controlled") {
    return {
      title: "Export-controlled files",
      detail:
        `An OverDrafter admin confirmed that files on this part are export-controlled. The beta cannot quote them, and they are not sent to any supplier automatically. ${NO_MANUAL_QUOTE}`,
      action: null,
      actionKind: null,
    };
  }
  if (status.exportReviewState === "blocked_pending_review") {
    return {
      title: "Held for export-control review",
      detail:
        `Files on this part carry export-control markings. Nothing is sent to any supplier automatically until an OverDrafter admin finishes the review. ${NO_MANUAL_QUOTE}`,
      action: null,
      actionKind: null,
    };
  }
  if (status.latestAnswer === null || status.latestAnswer === "missing") {
    return {
      title: "Export-control answer needed",
      detail:
        "Quotes for this part are on hold until you tell us whether its files are export-controlled. Your answer covers every file on the part.",
      action: "Answer export-control question",
      actionKind: "declare",
    };
  }
  if (status.latestAnswer === "controlled" || status.latestAnswer === "unsure") {
    return {
      title: "Quotes on hold for export control",
      detail:
        status.latestAnswer === "controlled"
          ? `You told us files on this part are export-controlled. The beta cannot quote them, and they are not sent to any supplier automatically. ${NO_MANUAL_QUOTE}`
          : `You told us you are not sure whether files on this part are export-controlled. Nothing is sent to any supplier automatically until you confirm they are not. ${NO_MANUAL_QUOTE}`,
      action: "Change answer",
      actionKind: "declare",
    };
  }
  return getExportScanNoticeCopy(status.scanState ?? null);
}

/**
 * A clean answer still holds the part until every drawing and STEP file has a
 * clean scan of its current bytes. These match the worker's hold note: recheck
 * a file that waits for a check, replace one that could not be read.
 */
function getExportScanNoticeCopy(scanState: JobExportControlStatus["scanState"]): ExportControlNoticeCopy | null {
  switch (scanState) {
    case "missing":
      return {
        title: "Files waiting for an export-control check",
        detail:
          `At least one file on this part has not been checked for export-control markings yet, so nothing is sent to any supplier automatically. Recheck the files to release the part. ${NO_MANUAL_QUOTE}`,
        action: "Recheck files",
        actionKind: "rescan",
      };
    case "pending":
      return {
        title: "Checking files for export-control markings",
        detail:
          `Nothing is sent to any supplier automatically until the check finishes. This usually takes a few minutes. ${NO_MANUAL_QUOTE}`,
        action: null,
        actionKind: null,
      };
    case "drawing_unread":
      return {
        title: "Drawing could not be read",
        detail:
          `We could not read the text on every page of this part's drawing, so it cannot be checked for export-control markings and is not sent to any supplier automatically. Replace it with a PDF whose text can be selected to release the part. ${NO_MANUAL_QUOTE}`,
        action: null,
        actionKind: null,
      };
    case "step_header_incomplete":
      return {
        title: "STEP file could not be checked",
        detail:
          `The header of this part's STEP file could not be read in full, so it cannot be checked for export-control markings and is not sent to any supplier automatically. Export the STEP file again and replace it to release the part. ${NO_MANUAL_QUOTE}`,
        action: null,
        actionKind: null,
      };
    default:
      return null;
  }
}

/** How often the notice rereads the status while a file check is running. */
export const EXPORT_CONTROL_CHECKING_REFETCH_MS = 15_000;

/**
 * While a clean answer waits for its file check (scanState `pending`), the
 * notice rereads the status on an interval, so it clears or moves on without
 * a focus change or reload. Every other state waits for the owner or an
 * admin, so it is not polled.
 */
export function exportControlStatusRefetchInterval(status: JobExportControlStatus | undefined): number | false {
  return status?.scanState === "pending" ? EXPORT_CONTROL_CHECKING_REFETCH_MS : false;
}
