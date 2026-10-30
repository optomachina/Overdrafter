import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueTaskRecord } from "./types.js";

type RefreshEvent = {
  level: "info" | "warn";
  source: string;
  message: string;
  context: Record<string, unknown>;
  error?: unknown;
};

/** Call only after the separate, authoritative task-status request has settled. */
export async function refreshJobExtractionStatus(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  log: (event: RefreshEvent) => void,
): Promise<void> {
  if (task.task_type !== "extract_part") return;
  const jobId = task.job_id ?? (task.payload.jobId as string | undefined);
  const context = { jobId, taskId: task.id };
  const source = "worker.job.extraction_status_refresh";
  try {
    if (!jobId) throw new Error("Extraction task is missing job_id.");
    const { data: status, error } = await supabase.rpc("api_refresh_job_extraction_status", {
      p_job_id: jobId,
    });
    if (error) throw error;
    log({ level: "info", source, message: "Refreshed job extraction status.", context: { ...context, status } });
  } catch (error) {
    log({ level: "warn", source, message: "Could not refresh job extraction status.", context, error });
  }
}
