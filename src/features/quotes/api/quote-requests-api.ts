import type {
  QuoteRequestCancellationResult,
  QuoteRequestSubmissionResult,
  QuoteRunReadiness,
} from "@/features/quotes/types";
import type {
  VendorName,
} from "@/integrations/supabase/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export async function setJobSelectedVendorQuoteOffer(jobId: string, offerId: string | null): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.setJobSelectedVendorQuoteOffer(jobId, offerId);
  }

  const { data, error } = await callRpc("api_set_job_selected_vendor_quote_offer", {
    p_job_id: jobId,
    p_vendor_quote_offer_id: offerId,
  });

  return ensureData(data, error);
}

export async function startQuoteRun(
  jobId: string,
  autoPublishRequested = false,
): Promise<string> {
  const { data, error } = await callRpc("api_start_quote_run", {
    p_job_id: jobId,
    p_auto_publish_requested: autoPublishRequested,
  });

  return ensureData(data, error);
}

export async function requestQuote(
  jobId: string,
  forceRetry = false,
): Promise<QuoteRequestSubmissionResult> {
  const { data, error } = await callRpc("api_request_quote", {
    p_job_id: jobId,
    p_force_retry: forceRetry,
  });

  return ensureData(data, error) as QuoteRequestSubmissionResult;
}

export async function requestQuotes(
  jobIds: string[],
  forceRetry = false,
): Promise<QuoteRequestSubmissionResult[]> {
  const distinctJobIds = [...new Set(jobIds.filter(Boolean))];

  if (distinctJobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_request_quotes", {
    p_job_ids: distinctJobIds,
    p_force_retry: forceRetry,
  });

  const results = ensureData(data, error);

  if (!Array.isArray(results)) {
    throw new Error("Expected quote request results to be returned as an array.");
  }

  return results as QuoteRequestSubmissionResult[];
}

export async function cancelQuoteRequest(
  requestId: string,
): Promise<QuoteRequestCancellationResult> {
  const { data, error } = await callRpc("api_cancel_quote_request", {
    p_request_id: requestId,
  });

  return ensureData(data, error) as QuoteRequestCancellationResult;
}

export async function enqueueDebugVendorQuote(input: {
  jobId: string;
  quoteRunId: string;
  partId: string;
  vendor: VendorName;
  requestedQuantity: number;
}): Promise<string> {
  const { data, error } = await callRpc("api_enqueue_debug_vendor_quote", {
    p_quote_run_id: input.quoteRunId,
    p_part_id: input.partId,
    p_vendor: input.vendor,
    p_requested_quantity: input.requestedQuantity,
  });

  const result = ensureData(data, error) as { taskId: string; created: boolean; reason: string | null };

  if (!result.created && result.reason) {
    throw new Error(result.reason);
  }

  return result.taskId;
}

export async function getQuoteRunReadiness(
  quoteRunId: string,
): Promise<QuoteRunReadiness> {
  const { data, error } = await callRpc("api_get_quote_run_readiness", {
    p_quote_run_id: quoteRunId,
  });

  const readiness = ensureData(data, error) as QuoteRunReadiness;

  return {
    ready: Boolean(readiness.ready),
    successfulVendorQuotes: Number(readiness.successfulVendorQuotes ?? 0),
    failedVendorQuotes: Number(readiness.failedVendorQuotes ?? 0),
    blockingVendorStates: Number(readiness.blockingVendorStates ?? 0),
    unapprovedExtractions: Number(readiness.unapprovedExtractions ?? 0),
    repairTasks: Number(readiness.repairTasks ?? 0),
    priorRequirementsMatch: Boolean(readiness.priorRequirementsMatch),
    reasons: readiness.reasons ?? [],
  };
}
