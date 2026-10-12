import {
  EXPORT_CONTROL_TERMS_VERSION,
  isExportControlAnswer,
  type ExportControlAnswer,
} from "@/features/quotes/export-control";
import { callUntypedRpc } from "./shared/rpc";

/**
 * OVD-723 existing-job path. Jobs created before the deploy carry a
 * backfilled `missing` declaration and no scan of record, so dispatch denies
 * them. A member declares on the existing job (same RPC and answers as at
 * upload) and requests a rescan of the job's files. The server stays
 * authoritative; anything the client can't parse reads as held.
 */

export type JobExportReviewState = "clear" | "blocked_pending_review" | "confirmed_controlled";

export type JobExportControlStatus = {
  jobId: string;
  latestAnswer: ExportControlAnswer | "missing";
  reviewState: JobExportReviewState;
  partsMissingScan: number;
  rescansPending: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function parseJobExportControlStatus(jobId: string, value: unknown): JobExportControlStatus {
  const record = asRecord(value);
  const reviewState = record?.exportReviewState;
  const partsMissingScan = record?.partsMissingScan;

  return {
    jobId,
    latestAnswer: isExportControlAnswer(record?.latestAnswer) ? record.latestAnswer : "missing",
    // An unknown review state is treated as a pending review, never as clear.
    reviewState:
      reviewState === "clear" || reviewState === "confirmed_controlled" ? reviewState : "blocked_pending_review",
    // An unparseable count is reported as one missing scan so the job reads as held.
    partsMissingScan:
      typeof partsMissingScan === "number" && Number.isInteger(partsMissingScan) && partsMissingScan >= 0
        ? partsMissingScan
        : 1,
    rescansPending: asCount(record?.rescansPending),
  };
}

/** True when the server would still deny dispatch for this job. */
export function isJobExportDispatchHeld(status: JobExportControlStatus): boolean {
  return status.latestAnswer !== "not_controlled" || status.reviewState !== "clear" || status.partsMissingScan > 0;
}

export async function getJobExportControlStatus(jobId: string): Promise<JobExportControlStatus> {
  const { data, error } = await callUntypedRpc("api_get_job_export_control_status", { p_job_id: jobId });
  if (error) throw error;
  return parseJobExportControlStatus(jobId, data);
}

/**
 * Records an answer for an existing job. `controlled` and `unsure` are
 * recorded for audit and keep the job held; only `not_controlled` clears the
 * declaration rule.
 */
export async function declareExistingJobExportStatus(
  jobId: string,
  answer: ExportControlAnswer,
): Promise<{ answer: ExportControlAnswer; declarationClean: boolean }> {
  if (!isExportControlAnswer(answer)) {
    throw new Error("export_declaration_invalid");
  }

  const { data, error } = await callUntypedRpc("api_declare_job_export_status", {
    p_job_id: jobId,
    p_answer: answer,
    p_terms_version: EXPORT_CONTROL_TERMS_VERSION,
  });
  if (error) throw error;

  const record = asRecord(data);
  if (typeof record?.declarationId !== "string" || record.answer !== answer) {
    throw new Error("export_declaration_missing");
  }

  return { answer, declarationClean: answer === "not_controlled" && record.uploadAllowed === true };
}

/** Queues a marking rescan of every part in the job (member or platform admin). */
export async function requestExportControlRescan(jobId: string): Promise<{ tasksQueued: number }> {
  const { data, error } = await callUntypedRpc("api_request_export_control_rescan", { p_job_id: jobId });
  if (error) throw error;

  const record = asRecord(data);
  if (record?.jobId !== jobId || typeof record.tasksQueued !== "number") {
    throw new Error("export_rescan_failed");
  }

  return { tasksQueued: asCount(record.tasksQueued) };
}
