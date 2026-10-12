import type { JobExportControlStatus } from "@/features/quotes/api/export-control-api";

export type ExportControlNoticeCopy = { title: string; detail: string; action: string | null };

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
    };
  }
  if (status.exportReviewState === "blocked_pending_review") {
    return {
      title: "Held for export-control review",
      detail:
        `Files on this part carry export-control markings. Nothing is sent to any supplier automatically until an OverDrafter admin finishes the review. ${NO_MANUAL_QUOTE}`,
      action: null,
    };
  }
  if (status.latestAnswer === null || status.latestAnswer === "missing") {
    return {
      title: "Export-control answer needed",
      detail:
        "Quotes for this part are on hold until you tell us whether its files are export-controlled. Your answer covers every file on the part.",
      action: "Answer export-control question",
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
    };
  }
  return null;
}
