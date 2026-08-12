import type {
  QuoteRequestCancellationResult,
  QuoteLaneEligibility,
  QuoteRequestSubmissionResult,
  QuoteRunReadiness,
} from "@/features/quotes/types";
import type { ClientQuoteSelectionTarget } from "@/features/quotes/selection";
import type {
  VendorName,
} from "@/integrations/supabase/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc, callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";
import { selectQuoteOption } from "./packages-api";

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

/**
 * Persists a client comparison choice at the strongest available provenance boundary.
 * Published choices remain package-scoped; only pre-publication choices use the
 * legacy job-level offer pointer.
 */
export async function persistClientQuoteSelection(input: {
  jobId: string;
  target: ClientQuoteSelectionTarget;
}): Promise<string> {
  if (input.target.kind === "published_quote_option") {
    return selectQuoteOption({
      packageId: input.target.packageId,
      optionId: input.target.optionId,
    });
  }

  return setJobSelectedVendorQuoteOffer(input.jobId, input.target.offerId);
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
  selectedVendors: VendorName[] = [],
): Promise<QuoteRequestSubmissionResult> {
  const { data, error } = await callUntypedRpc("api_request_quote_scoped", {
    p_job_id: jobId,
    p_selected_vendors: selectedVendors,
  });

  const result = ensureData(data, error) as QuoteRequestSubmissionResult;

  return {
    ...result,
    quoteMode: result.quoteMode ?? "automatic",
  };
}

export async function getQuoteLaneEligibility(
  jobId: string,
  selectedVendors?: VendorName[],
): Promise<QuoteLaneEligibility[]> {
  const { data, error } = await callUntypedRpc("api_get_quote_lane_eligibility", {
    p_job_id: jobId,
    p_selected_vendors: selectedVendors ?? null,
  });

  const result = ensureData(data, error);
  if (!Array.isArray(result)) {
    throw new Error("Expected quote lane eligibility to be returned as an array.");
  }
  return result as QuoteLaneEligibility[];
}

export async function requestManualQuote(
  jobId: string,
): Promise<QuoteRequestSubmissionResult> {
  const { data, error } = await callRpc("api_request_manual_quote", {
    p_job_id: jobId,
    p_force_retry: false,
  });

  return ensureData(data, error) as QuoteRequestSubmissionResult;
}

export async function requestQuotes(
  jobIds: string[],
): Promise<QuoteRequestSubmissionResult[]> {
  const distinctJobIds = [...new Set(jobIds.filter(Boolean))];

  if (distinctJobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_request_quotes", {
    p_job_ids: distinctJobIds,
    p_force_retry: false,
  });

  const results = ensureData(data, error);

  if (!Array.isArray(results)) {
    throw new Error("Expected quote request results to be returned as an array.");
  }

  return results.map((result) => ({
    ...(result as QuoteRequestSubmissionResult),
    quoteMode: (result as QuoteRequestSubmissionResult).quoteMode ?? "automatic",
  }));
}

export async function requestManualQuotes(
  jobIds: string[],
): Promise<QuoteRequestSubmissionResult[]> {
  const distinctJobIds = [...new Set(jobIds.filter(Boolean))];

  if (distinctJobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_request_manual_quotes", {
    p_job_ids: distinctJobIds,
    p_force_retry: false,
  });

  const results = ensureData(data, error);

  if (!Array.isArray(results)) {
    throw new Error("Expected manual quote request results to be returned as an array.");
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
