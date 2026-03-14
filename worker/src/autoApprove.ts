import type { SupabaseClient } from "@supabase/supabase-js";

export async function autoApproveJobRequirements(
  supabase: SupabaseClient,
  jobId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("api_auto_approve_job_requirements", {
    p_job_id: jobId,
  });

  if (error) {
    throw error;
  }

  const approvedCount = typeof data === "number" ? data : Number(data ?? 0);

  if (!Number.isFinite(approvedCount) || approvedCount < 1) {
    throw new Error(`Auto-approval did not persist any approved requirements for job ${jobId}.`);
  }

  return approvedCount;
}
