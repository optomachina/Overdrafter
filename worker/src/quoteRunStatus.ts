import type { VendorStatus } from "./types.js";

export type QuoteRunAggregateStatus = {
  nextQuoteRunStatus: "running" | "completed" | "failed";
  nextJobStatus: "quoting" | "awaiting_vendor_manual_review" | "internal_review";
  successfulVendorQuotes: number;
  manualReviewVendorQuotes: number;
  failedVendorQuotes: number;
};

export function aggregateQuoteRunStatus(statuses: VendorStatus[]): QuoteRunAggregateStatus {
  const hasPending = statuses.some((status) => status === "queued" || status === "running");
  const hasManual = statuses.some(
    (status) => status === "manual_review_pending" || status === "manual_vendor_followup",
  );
  const hasSuccess = statuses.some(
    (status) => status === "instant_quote_received" || status === "official_quote_received",
  );
  const successfulVendorQuotes = statuses.filter(
    (status) => status === "instant_quote_received" || status === "official_quote_received",
  ).length;
  const manualReviewVendorQuotes = statuses.filter(
    (status) => status === "manual_review_pending" || status === "manual_vendor_followup",
  ).length;
  const failedVendorQuotes = statuses.filter((status) => status === "failed").length;
  let nextQuoteRunStatus: QuoteRunAggregateStatus["nextQuoteRunStatus"] = "failed";
  if (hasPending) {
    nextQuoteRunStatus = "running";
  } else if (hasSuccess || hasManual) {
    nextQuoteRunStatus = "completed";
  }

  let nextJobStatus: QuoteRunAggregateStatus["nextJobStatus"] = "quoting";
  if (!hasPending && hasManual) {
    nextJobStatus = "awaiting_vendor_manual_review";
  } else if (!hasPending && hasSuccess) {
    nextJobStatus = "internal_review";
  }

  return {
    nextQuoteRunStatus,
    nextJobStatus,
    successfulVendorQuotes,
    manualReviewVendorQuotes,
    failedVendorQuotes,
  };
}
