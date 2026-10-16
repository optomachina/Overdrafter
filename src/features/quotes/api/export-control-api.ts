import {
  EXPORT_CONTROL_TERMS_VERSION,
  type ExportControlAnswer,
} from "@/features/quotes/export-control";
import { callUntypedRpc } from "./shared/rpc";

/**
 * OVD-723 export-control state of one part request (job), as returned by
 * `api_get_job_export_control_status`. `latestAnswer` is null when nothing
 * was ever declared and "missing" for a job backfilled before OVD-723.
 */
export type JobExportControlStatus = {
  jobId: string;
  latestAnswer: ExportControlAnswer | "missing" | null;
  exportReviewState: "clear" | "blocked_pending_review" | "confirmed_controlled";
  /**
   * Whether every drawing and STEP file has a clean scan of its current bytes.
   * `missing`: nothing will scan a file on its own (a rescan failed for good),
   * so the owner can recheck it. `drawing_unread`, `drawing_too_many_pages`,
   * `drawing_sheet_too_large`, `drawing_recheck_limit`, and
   * `step_header_incomplete`: the same bytes cannot pass, so the file must be
   * replaced. Null when the server did not report it.
   */
  scanState?: ExportScanState | null;
};

export type ExportScanState =
  | "complete"
  | "pending"
  | "missing"
  | "drawing_unread"
  | "drawing_too_many_pages"
  | "drawing_sheet_too_large"
  | "drawing_recheck_limit"
  | "step_header_incomplete";

const ANSWERS = new Set(["not_controlled", "controlled", "unsure", "missing"]);
const REVIEW_STATES = new Set(["clear", "blocked_pending_review", "confirmed_controlled"]);
const SCAN_STATES = new Set([
  "complete",
  "pending",
  "missing",
  "drawing_unread",
  "drawing_too_many_pages",
  "drawing_sheet_too_large",
  "drawing_recheck_limit",
  "step_header_incomplete",
]);

/** Strict parse: anything unexpected is an error, never a clean status. */
export function parseJobExportControlStatus(value: unknown): JobExportControlStatus {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const latestAnswer = record?.latestAnswer ?? null;
  const scanState = record?.scanState ?? null;
  if (
    !record
    || typeof record.jobId !== "string"
    || (latestAnswer !== null && !ANSWERS.has(latestAnswer as string))
    || !REVIEW_STATES.has(record.exportReviewState as string)
    || (scanState !== null && !SCAN_STATES.has(scanState as string))
  ) {
    throw new Error("Unexpected export-control status response.");
  }
  return {
    jobId: record.jobId,
    latestAnswer: latestAnswer as JobExportControlStatus["latestAnswer"],
    exportReviewState: record.exportReviewState as JobExportControlStatus["exportReviewState"],
    scanState: scanState as ExportScanState | null,
  };
}

export async function fetchJobExportControlStatus(jobId: string): Promise<JobExportControlStatus> {
  const { data, error } = await callUntypedRpc("api_get_job_export_control_status", { p_job_id: jobId });
  if (error) throw error;
  return parseJobExportControlStatus(data);
}

/**
 * Records a declaration for an existing part without uploading. It covers
 * every file already on the part. controlled and unsure are recorded too:
 * they keep the part's quotes held, and the server never treats them as clean.
 */
export async function declareJobExportStatus(jobId: string, answer: ExportControlAnswer): Promise<void> {
  const { error } = await callUntypedRpc("api_declare_job_export_status", {
    p_job_id: jobId,
    p_answer: answer,
    p_terms_version: EXPORT_CONTROL_TERMS_VERSION,
  });
  if (error) throw error;
}

/**
 * Owner recovery for a file left without a scan (scanState `missing`): queues
 * a scan only rescan of every drawing and STEP file of the part that has no
 * scan of its current bytes. The server allows it only to a user who can edit
 * the part, and only while the latest answer is not_controlled with no open
 * review. Returns the number of rescans queued.
 */
export async function requestExportMarkingRescan(jobId: string): Promise<number> {
  const { data, error } = await callUntypedRpc("api_request_export_marking_rescan", { p_job_id: jobId });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}
