import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useQuoteReferences } from "@/components/quote-intelligence/useQuoteReferences";
import { writeQuoteReference } from "@/features/quotes/quote-local-reference";

describe("useQuoteReferences", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("updates only the subscribed quote collection when a reference changes", () => {
    const { result } = renderHook(() =>
      useQuoteReferences(["job-1", "job-2"]),
    );

    expect(result.current.size).toBe(0);

    act(() => {
      writeQuoteReference("job-1", "RFQ-1138");
      writeQuoteReference("job-outside", "RFQ-OTHER");
    });

    expect(result.current.get("job-1")).toBe("RFQ-1138");
    expect(result.current.has("job-outside")).toBe(false);
  });
});
