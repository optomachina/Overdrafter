import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { QueueTaskRecord, WorkerConfig } from "./types.js";

/** Creates a non-persistent service-role Supabase client for worker operations. */
export function createServiceClient(config: WorkerConfig) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/** Atomically claims the next available queued task for a worker, if one exists. */
export async function claimNextTask(
  supabase: SupabaseClient,
  workerName: string,
): Promise<QueueTaskRecord | null> {
  const { data, error } = await supabase
    .rpc("api_claim_next_task", { p_worker_name: workerName })
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as QueueTaskRecord | null) ?? null;
}

/**
 * Merges a patch into a task's existing payload.
 *
 * These helpers take a *patch*, not a replacement. Writing the patch straight
 * into `payload` would drop the task's original inputs — vendor, quantity,
 * quote request id — leaving a completed row that no longer records what was
 * asked for. Every call site used to compensate by spreading `task.payload`
 * itself; merging here makes that impossible to forget.
 */
function mergePayload(
  task: Pick<QueueTaskRecord, "payload"> | null,
  payloadPatch: Record<string, unknown>,
) {
  return { ...(task?.payload ?? {}), ...payloadPatch };
}

/** Marks a task as completed unless it has already been cancelled. */
export async function markTaskCompleted(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "completed",
      payload: mergePayload(task, payloadPatch),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq("id", task.id)
    .neq("status", "cancelled");

  if (error) {
    throw error;
  }
}

/** Marks a task as failed unless it has already been cancelled. */
export async function markTaskFailed(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  errorMessage: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "failed",
      payload: mergePayload(task, payloadPatch),
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", task.id)
    .neq("status", "cancelled");

  if (error) {
    throw error;
  }
}

/** Explicitly marks a task as cancelled and records the cancellation reason. */
export async function markTaskCancelled(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  errorMessage: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "cancelled",
      payload: mergePayload(task, payloadPatch),
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", task.id);

  if (error) {
    throw error;
  }
}

/** Requeues a task for a later retry and clears the current worker lock. */
export async function markTaskQueuedForRetry(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  errorMessage: string,
  availableAt: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "queued",
      payload: mergePayload(task, payloadPatch),
      available_at: availableAt,
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", task.id);

  if (error) {
    throw error;
  }
}

// Reaps tasks that have been stuck in "running" for more than staleness_minutes.
// This recovers from worker crashes that left tasks without a terminal write.
// Returns the number of tasks reaped.
export async function reapStaleTasks(
  supabase: SupabaseClient,
  stalenessMinutes = 10,
): Promise<number> {
  const cutoff = new Date(Date.now() - stalenessMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("work_queue")
    .update({
      status: "failed",
      locked_at: null,
      locked_by: null,
      last_error: "worker_crash_recovery",
    })
    .eq("status", "running")
    .lt("locked_at", cutoff)
    .select("id");

  if (error) {
    throw error;
  }

  return data?.length ?? 0;
}
