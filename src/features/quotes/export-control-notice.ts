import type { JobExportControlStatus } from "@/features/quotes/api/export-control-api";

export type ExportControlNoticeCopy = { title: string; detail: string; action: string | null };

/**
 * Plain explanation of an OVD-723 hold. Returns null when the part is clear
 * (declared not_controlled with no open or confirmed marking block).
 */
export function getExportControlNoticeCopy(status: JobExportControlStatus): ExportControlNoticeCopy | null {
  if (status.exportReviewState === "confirmed_controlled") {
    return {
      title: "Export-controlled files",
      detail:
        "An OverDrafter admin confirmed that files on this part are export-controlled. The beta cannot quote them, and they will not be sent to any supplier.",
      action: null,
    };
  }
  if (status.exportReviewState === "blocked_pending_review") {
    return {
      title: "Held for export-control review",
      detail:
        "Files on this part carry export-control markings. Nothing is sent to any supplier or quoted by hand until an OverDrafter admin finishes the review.",
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
          ? "You told us files on this part are export-controlled. The beta cannot quote them, and they will not be sent to any supplier."
          : "You told us you are not sure whether files on this part are export-controlled. Nothing is sent to any supplier until you confirm they are not.",
      action: "Change answer",
    };
  }
  return null;
}
