import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRequestedByDateLabel,
  formatRequestedQuoteQuantitiesInput,
  normalizeRequestedQuoteQuantities,
  parseRequestIntake,
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
      requestedQuoteQuantities: [10],
      requestedByDate: "2026-04-15",
    });
  });

  it("parses multiple quote quantities and a relative next-weekday due date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("Please quote 1/10/100 by next Friday")).toEqual({
      requestedQuoteQuantities: [1, 10, 100],
      requestedByDate: "2026-03-13",
    });
  });

  it("parses a slash date only as a date-intent phrase and not as quantities", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("need by 4/15")).toEqual({
      requestedQuoteQuantities: [],
      requestedByDate: "2026-04-15",
    });
  });

  it("ignores part-number noise, dedupes quantities, and leaves unresolved urgency unstructured", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00-07:00"));

    expect(parseRequestIntake("PN 1093-00001 rev A. Quote 10/25/25 ASAP")).toEqual({
      requestedQuoteQuantities: [10, 25],
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
