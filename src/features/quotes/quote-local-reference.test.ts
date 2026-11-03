import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_QUOTE_REFERENCE_LENGTH,
  clearAllQuoteReferences,
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
  it("clears all references, preserves unrelated storage, and notifies listeners", () => {
    writeQuoteReference("job-1", "Customer 1");
    writeQuoteReference("job-2", "Customer 2");
    window.localStorage.setItem("unrelated", "keep");
    const listener = vi.fn();
    const unsubscribe = subscribeToQuoteReferenceChanges(listener);

    clearAllQuoteReferences();

    expect(readQuoteReference("job-1")).toBeNull();
    expect(readQuoteReference("job-2")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({ jobId: "job-1", reference: null });
    expect(listener).toHaveBeenCalledWith({ jobId: "job-2", reference: null });
    unsubscribe();
  });

  it("does not block logout when browser storage is unavailable", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    expect(() => clearAllQuoteReferences()).not.toThrow();
    vi.restoreAllMocks();
  });

});
