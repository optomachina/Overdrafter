import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTE_QUANTITIES_AMBIGUOUS_ERROR,
  formatRequestedByDateLabel,
  formatRequestedQuoteQuantitiesInput,
  normalizeRequestedQuoteQuantities,
  parseRequestIntake,
  validateRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "./request-intake";

afterEach(() => {
  vi.useRealTimers();
});

describe("request intake parsing", () => {
  it("parses a single quantity and explicit month-name due date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("I need 10 of these by April 15")).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [10],
      requestedByDate: "2026-04-15",
    });
  });

  it("parses multiple quote quantities and a relative next-weekday due date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("Please quote 1/10/100 by next Friday")).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [1, 10, 100],
      requestedByDate: "2026-03-13",
    });
  });

  it("uses the default quantity pricing ladder when pricing curves are requested without explicit quantities", () => {
    expect(parseRequestIntake("Please quote quantity pricing for this bracket")).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [1, 10, 100, 1000],
      requestedByDate: null,
    });

    expect(parseRequestIntake("Need pricing curves")).toMatchObject({
      requestedQuoteQuantities: [1, 10, 100, 1000],
    });

    expect(parseRequestIntake("Need a price ladder")).toMatchObject({
      requestedQuoteQuantities: [1, 10, 100, 1000],
    });
  });

  it("parses a slash date only as a date-intent phrase and not as quantities", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("need by 4/15")).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: "2026-04-15",
    });
  });

  it("ignores part-number noise, dedupes quantities, and leaves unresolved urgency unstructured", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("PN 1093-00001 rev A. Quote 10/25/25 ASAP")).toEqual({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      requestedQuoteQuantities: [10, 25],
      requestedByDate: null,
    });
  });

  it("captures mixed-service prompts without forcing a quote-only default", () => {
    expect(parseRequestIntake("Need DFM review, drawing redraft, and a quote for this bracket")).toEqual({
      requestedServiceKinds: ["dfm_review", "drawing_redraft", "manufacturing_quote"],
      primaryServiceKind: "dfm_review",
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    });
  });

  it("normalizes quantity helpers for editing and display", () => {
    expect(normalizeRequestedQuoteQuantities(["10", 10, "25", 0, -1], 5)).toEqual([10, 25]);
    expect(parseRequestedQuoteQuantitiesInput("10/25/25", 3)).toEqual([10, 25]);
    expect(formatRequestedQuoteQuantitiesInput([1, 10, 100])).toBe("1/10/100");
    expect(formatRequestedByDateLabel("2026-04-15")).toBe("Apr 15, 2026");
  });
});


describe("validateRequestedQuoteQuantitiesInput", () => {
  it.each([
    ["1,000/2,000", [1000, 2000]],
    ["1,000;2,000", [1000, 2000]],
    ["250,500/1,000", [250500, 1000]],
    ["10,25/50", [10, 25, 50]],
    ["10,25,50", [10, 25, 50]],
    ["500,1000", [500, 1000]],
    ["100, 250, 500", [100, 250, 500]],
    ["25, 50 100;200", [25, 50, 100, 200]],
    ["25/25/50", [25, 50]],
    ["", [12]],
  ])("parses %j without truncation", (text, quantities) => {
    expect(validateRequestedQuoteQuantitiesInput(text as string, 12)).toEqual({ quantities, invalidTokens: [] });
  });

  it.each(["12.5", "-5", "abc", "0", "2147483648", "1e3", "/"])(
    "reports invalid token %j instead of silently dropping it",
    (token) => {
      expect(validateRequestedQuoteQuantitiesInput(token, 12).invalidTokens).toEqual([token]);
    },
  );

  it("reports invalid tokens in a mixed list", () => {
    expect(validateRequestedQuoteQuantitiesInput("10/12.5/25", 12)).toEqual({
      quantities: [10, 25], invalidTokens: ["12.5"],
    });
  });
});

  it.each(["250,500", "100,250,500", "1,000"])("rejects ambiguous %j with guidance", (text) => {
    expect(validateRequestedQuoteQuantitiesInput(text)).toEqual({
      quantities: [], invalidTokens: [text], error: QUOTE_QUANTITIES_AMBIGUOUS_ERROR,
    });
  });

  it.each([
    ["Please quote 1,000 of these", []],
    ["quote 1,000/2,000", [1000, 2000]],
    ["quote 1,000;2,000", [1000, 2000]],
    ["qty 12.5", []],
    ["Please quote 2,500 pieces", []],
    ["need 1,000 pcs", []],
    ["qty 1000", [1000]],
    ["quote 10/25/50", [10, 25, 50]],
    ["quote 250,500", []],
    ["quote 100,250,500", []],
    ["quote 10,25,50", [10, 25, 50]],
    ["quote 100, 250, 500", [100, 250, 500]],
    ["qty -5", []],
    ["qty 0", []],
    ["qty 12pcs", []],
    ["qty 12-15", []],
    ["qty 12+5", []],
    ["quote 10/12.5/25", []],
    ["quote 10/abc/25", []],
    ["quantity pricing for qty 12.5", []],
  ])("prefills only unambiguous whole quantities from %j", (prompt, quantities) => {
    expect(parseRequestIntake(prompt as string).requestedQuoteQuantities).toEqual(quantities);
  });
