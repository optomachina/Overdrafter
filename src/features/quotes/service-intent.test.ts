import { describe, expect, it } from "vitest";
import { requestedServicesSupportQuoteFields } from "@/features/quotes/service-intent";

describe("service-intent", () => {
  it("treats mixed-service selections as not quote-compatible", () => {
    expect(requestedServicesSupportQuoteFields(["manufacturing_quote"])).toBe(true);
    expect(requestedServicesSupportQuoteFields(["sourcing_only"])).toBe(true);
    expect(requestedServicesSupportQuoteFields(["manufacturing_quote", "dfm_review"])).toBe(false);
    expect(requestedServicesSupportQuoteFields(["dfm_review"])).toBe(false);
  });
});
