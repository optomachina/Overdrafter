import type { SupabaseClient } from "@supabase/supabase-js";

export type AutoApproveResult = {
  approvedCount: number;
  /**
   * OVD-1067: the RPC approved nothing because a field needs human review
   * (for example title-block fields while DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL
   * is off). The extraction stays needs_review. The job is NOT moved to
   * needs_spec_review here: the RPC runs while this task is still 'running', so
   * the job stays 'extracting' (OVD-1095). This is a held outcome, not a failure.
   */
  reviewHold: boolean;
};

export async function autoApproveJobRequirements(
  supabase: SupabaseClient,
  jobId: string,
): Promise<AutoApproveResult> {
  const { data, error } = await supabase.rpc("api_auto_approve_job_requirements", {
    p_job_id: jobId,
  });

  if (error) {
    throw error;
  }

  // A missing or malformed count fails closed; only a real integer is trusted.
  const approvedCount =
    typeof data === "number" ? data : typeof data === "string" && data.trim() !== "" ? Number(data) : Number.NaN;

  if (!Number.isInteger(approvedCount) || approvedCount < 0) {
    throw new Error(`Auto-approval returned an invalid approved requirement count for job ${jobId}.`);
  }

  return { approvedCount, reviewHold: approvedCount === 0 };
}
