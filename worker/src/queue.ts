import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { QueueTaskRecord, WorkerConfig } from "./types.js";

export function createServiceClient(config: WorkerConfig) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function claimNextTask(
  supabase: SupabaseClient,
  workerName: string,
): Promise<QueueTaskRecord | null> {
  const { data, error } = await supabase
    .from("work_queue")
    .select("*")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const { data: updatedTask, error: updateError } = await supabase
    .from("work_queue")
    .update({
      status: "running",
      locked_at: new Date().toISOString(),
      locked_by: workerName,
      attempts: (data.attempts ?? 0) + 1,
    })
    .eq("id", data.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }

  return (updatedTask as QueueTaskRecord | null) ?? null;
}

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
    .eq("id", taskId);

  if (error) {
    throw error;
  }
}

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
    .eq("id", taskId);

  if (error) {
    throw error;
  }
}
