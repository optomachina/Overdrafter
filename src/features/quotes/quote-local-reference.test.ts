import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_QUOTE_REFERENCE_LENGTH,
  normalizeQuoteReference,
  readQuoteReference,
  subscribeToQuoteReferenceChanges,
  writeQuoteReference,
} from "@/features/quotes/quote-local-reference";

describe("quote local reference", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("normalizes whitespace and clears empty references", () => {
    expect(normalizeQuoteReference("  RFQ-24-1138   fixture  ")).toBe("RFQ-24-1138 fixture");
    expect(normalizeQuoteReference("   ")).toBeNull();
    expect(
      normalizeQuoteReference("Q".repeat(MAX_QUOTE_REFERENCE_LENGTH + 20)),
    ).toHaveLength(MAX_QUOTE_REFERENCE_LENGTH);
  });

  it("stores the reference under the opaque job identity", () => {
    writeQuoteReference("job-1", "RFQ-24-1138");

    expect(readQuoteReference("job-1")).toBe("RFQ-24-1138");

    writeQuoteReference("job-1", "");

    expect(readQuoteReference("job-1")).toBeNull();
  });

  it("notifies quote collections when a reference changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToQuoteReferenceChanges(listener);

    writeQuoteReference("job-1", "Customer 881");

    expect(listener).toHaveBeenCalledWith({
      jobId: "job-1",
      reference: "Customer 881",
    });

    unsubscribe();
  });
});
