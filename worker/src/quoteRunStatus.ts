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
  const nextQuoteRunStatus = hasPending ? "running" : hasSuccess || hasManual ? "completed" : "failed";
  const nextJobStatus = hasPending
    ? "quoting"
    : hasManual
      ? "awaiting_vendor_manual_review"
      : hasSuccess
        ? "internal_review"
        : "quoting";

  return {
    nextQuoteRunStatus,
    nextJobStatus,
    successfulVendorQuotes,
    manualReviewVendorQuotes,
    failedVendorQuotes,
  };
}
