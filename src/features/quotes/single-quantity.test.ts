import { describe, expect, it } from "vitest";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import {
  MAX_REQUEST_QUANTITY,
  buildSingleQuantityRequest,
  describeSavedQuantities,
  isRequestQuantity,
  parseRequestQuantityText,
} from "./single-quantity";

function draft(quantity: number, requestedQuoteQuantities: number[]): ClientPartRequestUpdateInput {
  return { jobId: "job-1", material: "6061-T6", quantity, requestedQuoteQuantities } as ClientPartRequestUpdateInput;
}

const OPEN = { allowAboveOne: true, loading: false };
const FIXED = { allowAboveOne: false, loading: false };
const LOADING = { allowAboveOne: false, loading: true };

describe("parseRequestQuantityText", () => {
  it.each([
    ["1", 1],
    ["5", 5],
    [" 12 ", 12],
    ["007", 7],
    ["1000000", 1_000_000],
    [String(MAX_REQUEST_QUANTITY), MAX_REQUEST_QUANTITY],
  ])("reads %j as %i", (text, expected) => {
    expect(parseRequestQuantityText(text)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "0",
    "00",
    "-1",
    "+5",
    "2.5",
    "5.0",
    "1e3",
    "0x10",
    "5 pcs",
    "10 / 25",
    "1,000",
    String(MAX_REQUEST_QUANTITY + 1),
    "99999999999999999999999",
  ])("refuses %j", (text) => {
    expect(parseRequestQuantityText(text)).toBeNull();
  });
});

describe("isRequestQuantity", () => {
  it("accepts only whole numbers from 1 to the integer limit", () => {
    expect(isRequestQuantity(1)).toBe(true);
    expect(isRequestQuantity(MAX_REQUEST_QUANTITY)).toBe(true);
    for (const value of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_REQUEST_QUANTITY + 1, "5", null, undefined]) {
      expect(isRequestQuantity(value)).toBe(false);
    }
  });
});

describe("buildSingleQuantityRequest", () => {
  it("sends [quantity] when only Qty changed from a saved [1] (the silent quantity-1 save)", () => {
    expect(buildSingleQuantityRequest(draft(5, [1]), OPEN)).toEqual(draft(5, [5]));
  });

  it("collapses several saved quantities to the one quantity", () => {
    expect(buildSingleQuantityRequest(draft(10, [10, 25, 50]), OPEN)?.requestedQuoteQuantities).toEqual([10]);
  });

  it("sends a very large quantity as typed, with no product cap", () => {
    expect(buildSingleQuantityRequest(draft(1_000_000, [1]), OPEN)).toEqual(draft(1_000_000, [1_000_000]));
  });

  it("forces quantity 1 when the server did not scope a larger quantity", () => {
    expect(buildSingleQuantityRequest(draft(5, [5]), FIXED)).toEqual(draft(1, [1]));
    expect(buildSingleQuantityRequest(draft(1, [1, 10]), FIXED)).toEqual(draft(1, [1]));
  });

  it("does not save while the server answer is pending or for an unusable quantity", () => {
    expect(buildSingleQuantityRequest(draft(5, [5]), LOADING)).toBeNull();
    expect(buildSingleQuantityRequest(draft(0, [0]), OPEN)).toBeNull();
    expect(buildSingleQuantityRequest(draft(Number.NaN, []), OPEN)).toBeNull();
    expect(buildSingleQuantityRequest(draft(MAX_REQUEST_QUANTITY + 1, []), OPEN)).toBeNull();
  });

  it("keeps every other field and does not mutate the draft", () => {
    const original = draft(5, [1]);
    const built = buildSingleQuantityRequest(original, OPEN);
    expect(built).toEqual({ ...original, quantity: 5, requestedQuoteQuantities: [5] });
    expect(original.requestedQuoteQuantities).toEqual([1]);
  });
});

describe("describeSavedQuantities", () => {
  it("says nothing when the saved quantities already match what a save writes", () => {
    expect(describeSavedQuantities(draft(1, [1]), FIXED)).toBeNull();
    expect(describeSavedQuantities(draft(1, []), FIXED)).toBeNull();
    expect(describeSavedQuantities(draft(5, [5]), OPEN)).toBeNull();
    expect(describeSavedQuantities(draft(5, []), OPEN)).toBeNull();
    expect(describeSavedQuantities(draft(5, [1, 5]), LOADING)).toBeNull();
  });

  it("explains that a save keeps one quantity when several are saved", () => {
    expect(describeSavedQuantities(draft(10, [10, 25, 50]), OPEN)).toBe(
      "This request is saved with quantities 10, 25, 50. Saving keeps only quantity 10.",
    );
  });

  it("follows the quantity being edited", () => {
    expect(describeSavedQuantities(draft(7, [10, 25]), OPEN)).toContain("Saving keeps only quantity 7.");
  });

  it("explains that a save sets quantity 1 when the server did not scope a larger quantity", () => {
    expect(describeSavedQuantities(draft(25, [25]), FIXED)).toBe(
      "This request is saved with quantity 25. Saving sets the quantity to 1.",
    );
    expect(describeSavedQuantities(draft(1, [1, 10]), FIXED)).toBe(
      "This request is saved with quantities 1, 10. Saving sets the quantity to 1.",
    );
    expect(describeSavedQuantities(draft(25, []), FIXED)).toContain("quantity 25.");
  });
});
