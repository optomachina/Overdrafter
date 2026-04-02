import type {
  QuoteRequestCancellationResult,
  QuoteRequestSubmissionResult,
  QuoteRunReadiness,
  WorkQueueRecord,
} from "@/features/quotes/types";
import type {
  VendorName,
} from "@/integrations/supabase/types";
import type { VendorQuoteResultRecord } from "@/features/quotes/types";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc, callUntypedRpc, insertUntyped, untypedSupabase } from "./shared/rpc";
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
  const { data, error } = await callUntypedRpc("api_enqueue_debug_vendor_quote", {
    p_quote_run_id: input.quoteRunId,
    p_part_id: input.partId,
    p_vendor: input.vendor,
    p_requested_quantity: input.requestedQuantity,
  });

  if (!error && data) {
    const result = ensureData(data, error) as { taskId: string; created: boolean; reason: string | null };

    if (!result.created && result.reason) {
      throw new Error(result.reason);
    }

    return result.taskId;
  }

  const { data: quoteResultData, error: quoteResultError } = await untypedSupabase
    .from("vendor_quote_results")
    .select("id, organization_id, status")
    .eq("quote_run_id", input.quoteRunId)
    .eq("part_id", input.partId)
    .eq("vendor", input.vendor)
    .eq("requested_quantity", input.requestedQuantity)
    .maybeSingle();

  if (quoteResultError) {
    throw quoteResultError;
  }

  const quoteResult = quoteResultData as Pick<VendorQuoteResultRecord, "id" | "organization_id" | "status"> | null;

  if (!quoteResult) {
    throw new Error("No matching vendor quote lane exists for this part and quantity.");
  }

  const { data: queueRows, error: queueError } = await untypedSupabase
    .from("work_queue")
    .select("id, status, payload")
    .eq("job_id", input.jobId)
    .eq("quote_run_id", input.quoteRunId)
    .eq("part_id", input.partId)
    .eq("task_type", "run_vendor_quote")
    .in("status", ["queued", "running"]);

  const existingTasks = ensureData(queueRows, queueError) as Pick<
    WorkQueueRecord,
    "id" | "status" | "payload"
  >[];

  const matchingTask = existingTasks.find((task) => {
    const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
      ? (task.payload as Record<string, unknown>)
      : {};

    return (
      payload.vendor === input.vendor &&
      Number(payload.requestedQuantity ?? 0) === input.requestedQuantity
    );
  });

  if (matchingTask) {
    throw new Error("A Xometry quote task is already queued or running for this part and quantity.");
  }

  const { data: insertedTaskData, error: insertError } = await (insertUntyped("work_queue", {
      organization_id: quoteResult.organization_id,
      job_id: input.jobId,
      part_id: input.partId,
      quote_run_id: input.quoteRunId,
      task_type: "run_vendor_quote",
      status: "queued",
      payload: {
        quoteRunId: input.quoteRunId,
        partId: input.partId,
        vendor: input.vendor,
        vendorQuoteResultId: quoteResult.id,
        requestedQuantity: input.requestedQuantity,
        source: "xometry-debug-submit",
      },
    })
    .select("id")
    .single() as Promise<PostgrestSingleResponse<Pick<WorkQueueRecord, "id">>>);

  return ensureData(insertedTaskData?.id ?? null, insertError);
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
