// @vitest-environment node

import { describe, expect, it } from "vitest";
import { aggregateQuoteRunStatus } from "./quoteRunStatus";

describe("aggregateQuoteRunStatus", () => {
  it("keeps quote run active while pending vendor work exists", () => {
    expect(aggregateQuoteRunStatus(["running", "failed"])).toEqual({
      nextQuoteRunStatus: "running",
      nextJobStatus: "quoting",
      successfulVendorQuotes: 0,
      manualReviewVendorQuotes: 0,
      failedVendorQuotes: 1,
    });
  });

  it("marks mixed success/failure outcomes as completed + internal review", () => {
    expect(aggregateQuoteRunStatus(["instant_quote_received", "failed"])).toEqual({
      nextQuoteRunStatus: "completed",
      nextJobStatus: "internal_review",
      successfulVendorQuotes: 1,
      manualReviewVendorQuotes: 0,
      failedVendorQuotes: 1,
    });
  });

  it("routes manual follow-up outcomes to awaiting_vendor_manual_review", () => {
    expect(aggregateQuoteRunStatus(["manual_vendor_followup", "failed"])).toEqual({
      nextQuoteRunStatus: "completed",
      nextJobStatus: "awaiting_vendor_manual_review",
      successfulVendorQuotes: 0,
      manualReviewVendorQuotes: 1,
      failedVendorQuotes: 1,
    });
  });

  it("fails closed when no vendor statuses exist", () => {
    expect(aggregateQuoteRunStatus([])).toEqual({
      nextQuoteRunStatus: "failed",
      nextJobStatus: "quoting",
      successfulVendorQuotes: 0,
      manualReviewVendorQuotes: 0,
      failedVendorQuotes: 0,
    });
  });
});
