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
};

const ANSWERS = new Set(["not_controlled", "controlled", "unsure", "missing"]);
const REVIEW_STATES = new Set(["clear", "blocked_pending_review", "confirmed_controlled"]);

/** Strict parse: anything unexpected is an error, never a clean status. */
export function parseJobExportControlStatus(value: unknown): JobExportControlStatus {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const latestAnswer = record?.latestAnswer ?? null;
  if (
    !record
    || typeof record.jobId !== "string"
    || (latestAnswer !== null && !ANSWERS.has(latestAnswer as string))
    || !REVIEW_STATES.has(record.exportReviewState as string)
  ) {
    throw new Error("Unexpected export-control status response.");
  }
  return {
    jobId: record.jobId,
    latestAnswer: latestAnswer as JobExportControlStatus["latestAnswer"],
    exportReviewState: record.exportReviewState as JobExportControlStatus["exportReviewState"],
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
