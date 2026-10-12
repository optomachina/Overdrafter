import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { QueueTaskRecord, WorkerConfig } from "./types.js";

const terminalFreeQuoteCursors = new WeakMap<SupabaseClient, string | null>();
const RECONCILIATION_LIMIT = 100;
type TerminalFreeQuoteSummary = {
  scanned: number;
  reconciled: number;
  indeterminate: number;
  deferred: number;
  nextCursor: string | null;
};

/** Requires the separately qualified terminal-lifecycle migration before use. */
export async function reconcileTerminalFreeQuoteTasks(supabase: SupabaseClient): Promise<TerminalFreeQuoteSummary> {
  const { data, error } = await supabase.rpc("api_reconcile_terminal_free_quote_tasks", {
    p_after_admission_id: terminalFreeQuoteCursors.get(supabase) ?? null,
    p_limit: RECONCILIATION_LIMIT,
  }).abortSignal(AbortSignal.timeout(10_000));
  if (error) throw error;
  const result = data as Partial<TerminalFreeQuoteSummary> | null;
  const counts = [result?.scanned, result?.reconciled, result?.indeterminate, result?.deferred];
  if (!result || counts.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > RECONCILIATION_LIMIT)
    || result.reconciled! + result.indeterminate! + result.deferred! > result.scanned!
    || (result.nextCursor !== null && (typeof result.nextCursor !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.nextCursor)))) {
    throw new Error("free_quote_reconciliation_response_invalid");
  }
  // An interrupted call safely repeats its old page; an indeterminate row does
  // not prevent later pages from being inspected on subsequent reaper passes.
  terminalFreeQuoteCursors.set(supabase, result.nextCursor);
  if (result.indeterminate! > 0) throw new Error("free_quote_lifecycle_indeterminate");
  return result as TerminalFreeQuoteSummary;
}

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

  // A separate transaction avoids queue -> result/request lock inversion.
  // Always scan, including when zero tasks were just reaped, to recover an
  // interruption between a previous terminal queue commit and reconciliation.
  await reconcileTerminalFreeQuoteTasks(supabase);
  return data?.length ?? 0;
}
