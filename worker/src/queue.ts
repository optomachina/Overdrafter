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

/** Marks a task as completed unless it has already been cancelled. */
export async function markTaskCompleted(
  supabase: SupabaseClient,
  taskId: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "completed",
      payload: payloadPatch,
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq("id", taskId)
    .neq("status", "cancelled");

  if (error) {
    throw error;
  }
}

/** Marks a task as failed unless it has already been cancelled. */
export async function markTaskFailed(
  supabase: SupabaseClient,
  taskId: string,
  errorMessage: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "failed",
      payload: payloadPatch,
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", taskId)
    .neq("status", "cancelled");

  if (error) {
    throw error;
  }
}

/** Explicitly marks a task as cancelled and records the cancellation reason. */
export async function markTaskCancelled(
  supabase: SupabaseClient,
  taskId: string,
  errorMessage: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "cancelled",
      payload: payloadPatch,
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", taskId);

  if (error) {
    throw error;
  }
}

/** Requeues a task for a later retry and clears the current worker lock. */
export async function markTaskQueuedForRetry(
  supabase: SupabaseClient,
  taskId: string,
  errorMessage: string,
  availableAt: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const { error } = await supabase
    .from("work_queue")
    .update({
      status: "queued",
      payload: payloadPatch,
      available_at: availableAt,
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", taskId);

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
