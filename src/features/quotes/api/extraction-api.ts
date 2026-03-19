import type { ApprovedPartRequirement } from "@/features/quotes/types";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export async function reconcileJobParts(jobId: string): Promise<Record<string, number>> {
  const { data, error } = await callRpc("api_reconcile_job_parts", {
    p_job_id: jobId,
  });

  return ensureData(data, error) as Record<string, number>;
}

export async function requestExtraction(jobId: string): Promise<number> {
  const { data, error } = await callRpc("api_request_extraction", {
    p_job_id: jobId,
  });

  return ensureData(data, error);
}

export async function requestDebugExtraction(
  partId: string,
  model: string | null,
): Promise<string> {
  const { data, error } = await callRpc("api_request_debug_extraction", {
    p_part_id: partId,
    p_model: model,
  });

  return ensureData(data, error);
}

export async function approveJobRequirements(
  jobId: string,
  requirements: ApprovedPartRequirement[],
): Promise<number> {
  const { data, error } = await callRpc("api_approve_job_requirements", {
    p_job_id: jobId,
    p_requirements: requirements,
  });

  return ensureData(data, error);
}
