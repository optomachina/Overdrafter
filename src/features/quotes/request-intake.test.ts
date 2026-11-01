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


describe("prompt intake main compatibility", () => {
  it.each([
    ["Please quote 25.", [25]],
    ["Please quote 10/25/50.", [10, 25, 50]],
    ["Quantity: 25.", [25]],
    ["Please quote 25 of these in 6061-T6/T651.", [25]],
    ["Please quote 25 pcs per drawing 12-345/A", [25]],
    ["qty 25; deburr all edges", [25]],
    ["Need 25 pcs.", [25]],
    ["Please quote 25 pieces in 6061-T6.", [25]],
    ["Please quote 25, thanks", [25]],
    ["Please quote 10 / 25 / 50 pcs", [10, 25, 50]],
    ["Need these in 2 weeks", []],
    ["Need it within 3 days please", []],
    ["Need 2 day turnaround", []],
    ["Need these in 2 weeks, quote 50", [50]],
    ["need 50 of these", [50]],
    ["Need 25 pcs", [25]],
    ["Please quote 50.", [50]],
    ["Quote 10/25/50.", [10, 25, 50]],
    ["Please quote 50. Need by tomorrow", [50]],
    ["qty 50.", [50]],
    ["Please quote 50", [50]],
    ["Quote 10/25/50", [10, 25, 50]],
  ])("preserves main's quantities for %j", (prompt, quantities) => {
    expect(parseRequestIntake(prompt as string).requestedQuoteQuantities).toEqual(quantities);
  });
});

describe("prompt intake quantity tokens (OVD-1036)", () => {
  it.each([
    ["Please quote 1,000 of these", [1000]],
    ["quote 1,000/2,000", [1000, 2000]],
    ["qty 12.5", []],
    ["Please quote 25.", [25]],
    ["Please quote 25 of these in 6061-T6/T651.", [25]],
    ["Need these in 2 weeks", []],
    ["Please quote, need these in 2 weeks", []],
    ["quote 10,25,50", [10, 25, 50]],
    ["quote 10, 25, 50", [10, 25, 50]],
    ["quote 100, 250, 500", [100, 250, 500]],
    ["quote 250,500", []],
    ["quote 1,500", []],
    ["quote 2,500", []],
    ["quote 1,500, 25", []],
    ["quote 1,000, 2,000", [1000, 2000]],
    ["quote 1,000,25", []],
    ["quote 10,25/50", []],
    ["quote 1,0", []],
    ["quote 1.5", []],
    ["quote 1,000.5", []],
    ["quote 10/12.5/25", []],
    ["quote 1,000/2,00", []],
    ["quote 10 / 1,000", [10, 1000]],
    ["quote 12,500 / 25,000", [12500, 25000]],
    ["qty: 1,000 / 2,000 / 5,000", [1000, 2000, 5000]],
    ["Need 1,000 of these", [1000]],
    ["Need 1.5 of these", []],
    ["need 12.5 of these", []],
    ["Quantity: 1,000.", [1000]],
    ["Quantity: 12.5.", []],
    ["Quote 1,000,000", [1000000]],
    ["quote 2147483648", []],
    ["quote 0", []],
    ["Please quote in 6061-T6", []],
    ["quote these parts in 6061-T6", []],
    ["Please quote 10/25/50 in 6061-T6/T651", [10, 25, 50]],
    ["quote 10-20 pcs", []],
    ["Need a quote for 3D printing", []],
    ["drawing 12-345/678, ship 4/15", []],
    ["quote 12.5mm", []],
    ["quote 1,000pcs", []],
    ["quote 2.5k", []],
    ["quote 1,000/2,000x", []],
    ["quote 1,000.5x", []],
    ["quote 25 weeks", []],
    ["quote 3 days", []],
    ["quote 250,500 with qty breaks", []],
    ["Please quote 1,500 with quantity pricing", []],
    ["quote 10 000 pcs", []],
    ["quote 1 000", []],
    ["quote 1'000", []],
    ["quote 10 - 20 pcs", []],
    ["quote 10\u201320 pcs", []],
    ["quote 10 to 20 pcs", []],
    ["quote 25, 2 weeks lead time", []],
    ["quote 25 delivered 12/15", [25]],
    ["quote 10/25 by 12/1", [10, 25]],
    ["Need pricing at 100/500/1000", [100, 500, 1000]],
    ["Can I get prices for 10/25/50?", [10, 25, 50]],
    ["Pricing for 100 / 250 / 500 pcs", [100, 250, 500]],
    ["10/25/50 pcs please", [10, 25, 50]],
    ["drawing 12/15 attached", []],
    ["1/4 inch plate, quote 25", [25]],
    ["quote 1,000/2,000 pcs", [1000, 2000]],
    ["quote 1,000 / 2,000 pcs by Dec 5", [1000, 2000]],
    ["qty 1,000/2,000/5,000 pieces", [1000, 2000, 5000]],
    ["Need pricing at 1,000/2,000 units", [1000, 2000]],
    ["1,000/2,000 pcs please", [1000, 2000]],
    ["quote 1.5/2 pcs", []],
  ])("parses %j as %j", (prompt, quantities) => {
    expect(parseRequestIntake(prompt as string).requestedQuoteQuantities).toEqual(quantities);
  });
});

describe("validateRequestedQuoteQuantitiesInput", () => {
  it.each([
    ["1,000/2,000", [1000, 2000]],
    ["0,500/10", [500, 10]],
    ["1,000;2,000", [1000, 2000]],
    ["250,500/1,000", [250500, 1000]],
    ["12,500 / 25,000", [12500, 25000]],
    ["2,500/5,000/10,000", [2500, 5000, 10000]],
    ["1000 12,500;25", [1000, 12500, 25]],
    ["10,25,50", [10, 25, 50]],
    ["500,1000", [500, 1000]],
    ["100, 250, 500", [100, 250, 500]],
    ["100, 25, 50", [100, 25, 50]],
    ["25 50 100;200", [25, 50, 100, 200]],
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

  it.each([
    ["10/12.5/25", ["12.5"]],
    ["10,25/50", ["10,25"]],
    ["1,25;50", ["1,25"]],
    ["25, 50 100;200", ["25,"]],
    ["1,500,25/50", ["1,500,25"]],
    ["1,500, 2,500 / 5,000", ["1,500,"]],
    ["1,500, 25 / 50", ["1,500,"]],
    ["1,000,25/50", ["1,000,25"]],
    ["1234,567/50", ["1234,567"]],
    ["10,25,500/50", ["10,25,500"]],
    ["12.5/25", ["12.5"]],
    ["1,0", ["0"]],
    ["x 40", ["x"]],
  ])("reports malformed tokens in mixed input %j", (text, invalidTokens) => {
    expect(validateRequestedQuoteQuantitiesInput(text as string, 12).invalidTokens).toEqual(invalidTokens);
  });

  it.each([
    "250,500", "100,250,500", "1,000", "1,250",
    "1,500,25", "25,1,500", "10,25,1,500", "2,500,10", "12,500,5",
    "10,25,500", "1000,250", "1234,567", "1,500,250", "1,500", "1,500, 25", "1,500 ,25",
    "1,250 2,500", "1,250, 2,500", "2,500 7,500", "100,250 500",
    "1,500, 2,500", "1,000, 2,000", "10 1,250,", "1,250,",
  ])("rejects ambiguous %j with guidance", (text) => {
    expect(validateRequestedQuoteQuantitiesInput(text)).toEqual({
      quantities: [], invalidTokens: [text], error: QUOTE_QUANTITIES_AMBIGUOUS_ERROR,
    });
  });
});
