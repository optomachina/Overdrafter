// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_QUANTITY_PRICING_LADDER, normalizePricingLadder } from "./quantityPricing";

describe("normalizePricingLadder", () => {
  it("exports the default quantity pricing ladder", () => {
    expect(DEFAULT_QUANTITY_PRICING_LADDER).toEqual([1, 10, 100, 1000]);
  });

  it("parses comma, slash, and whitespace separated quantities", () => {
    expect(normalizePricingLadder("100 / 10, 1 1000")).toEqual([1, 10, 100, 1000]);
  });

  it("normalizes arrays by removing invalid entries, deduping, and sorting", () => {
    expect(normalizePricingLadder([25, "10", "bad", 25, 0, -1, 1.9])).toEqual([1, 10, 25]);
  });

  it("falls back to the primary quantity when no ladder input is provided", () => {
    expect(normalizePricingLadder(undefined, 37)).toEqual([37]);
  });

  it("returns an empty ladder when neither input nor fallback has a valid quantity", () => {
    expect(normalizePricingLadder("bad,0", null)).toEqual([]);
  });
});
