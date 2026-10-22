import { describe, expect, it } from "vitest";
import { makeClientQuoteOption } from "@/components/quotes/test-option-factory";
import {
  buildDeliveredComparisonModel,
  countDeadlineStatuses,
  getDeadlineStatus,
  resolveQuoteRequestCompletion,
  sortDeliveredComparisonRows,
  type QuoteRequestCompletionInput,
} from "./delivered-comparison";

// Monday; UTC calendar keeps civil dates host-independent.
const NOW = new Date("2026-10-12T15:00:00.000Z");
const CALENDAR = { now: NOW, timeZone: "UTC" };

function rowsFor(options: Parameters<typeof buildDeliveredComparisonModel>[0]) {
  return buildDeliveredComparisonModel(options, CALENDAR).rows;
}

describe("buildDeliveredComparisonModel", () => {
  it("plots a provider-fixed delivery date as a confirmed arrival", () => {
    const [row] = rowsFor([makeClientQuoteOption({ shipReceiveBy: "2026-10-20", leadTimeBusinessDays: null })]);
    expect(row.arrival).toEqual({ kind: "arrival", date: "2026-10-20", provenance: "confirmed" });
  });

  it("treats a provider delivery date already in the past as unknown, not as the fastest arrival", () => {
    const rows = rowsFor([
      makeClientQuoteOption({ key: "stale", shipReceiveBy: "2026-10-01", leadTimeBusinessDays: null }),
      makeClientQuoteOption({ key: "live", shipReceiveBy: "2026-10-20", leadTimeBusinessDays: null }),
    ]);
    const [stale, live] = rows;
    expect(stale.arrival).toEqual({ kind: "unknown" });
    expect(stale.plot).toBeNull();
    expect(getDeadlineStatus(stale, "2026-10-22")).toBe("unconfirmed");
    expect(sortDeliveredComparisonRows(rows, "fastest", "2026-10-22").map((row) => row.key)).toEqual([
      "live",
      "stale",
    ]);
    expect(live.arrival.kind).toBe("arrival");
  });

  it("keeps a lead-time ship date as a lower bound instead of inventing transit", () => {
    const [row] = rowsFor([makeClientQuoteOption({ leadTimeBusinessDays: 7, shipReceiveBy: null, dueDate: null })]);
    expect(row.arrival).toEqual({ kind: "ships_by", shipDate: "2026-10-21" });
    expect(row.plot?.exact).toBe(false);
  });

  it("never plots an unknown arrival at zero", () => {
    const [row] = rowsFor([makeClientQuoteOption({ leadTimeBusinessDays: null, shipReceiveBy: null, dueDate: null })]);
    expect(row.arrival).toEqual({ kind: "unknown" });
    expect(row.plot).toBeNull();
    expect(row.notPlottedReason).toBe("arrival_unknown");
  });

  it("labels OTD as partial while shipping, tax and fees are unknown", () => {
    const [row] = rowsFor([makeClientQuoteOption({ totalPriceUsd: 120 })]);
    expect(row.otd).toEqual({ kind: "partial", knownAmountUsd: 120, unknownComponents: ["fees", "tax", "shipping"] });
    expect(row.plot?.y).toBe(120);
  });

  it("does not plot an option whose OTD is entirely unknown", () => {
    const [row] = rowsFor([makeClientQuoteOption({ totalPriceUsd: 0, shipReceiveBy: "2026-10-20" })]);
    expect(row.otd).toEqual({ kind: "unknown" });
    expect(row.plot).toBeNull();
    expect(row.notPlottedReason).toBe("otd_unknown");
  });

  it("keeps every overlapping option as its own row with identical coordinates (no jitter, no collapse)", () => {
    const rows = rowsFor([
      makeClientQuoteOption({ key: "a", shipReceiveBy: "2026-10-20" }),
      makeClientQuoteOption({ key: "b", shipReceiveBy: "2026-10-20" }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(rows[0].plot).toEqual(rows[1].plot);
  });
});

describe("getDeadlineStatus", () => {
  it("classifies on-time, late and unconfirmed arrivals against the deadline", () => {
    const [onTime, late, shipsAfter, shipsBefore, unknown] = rowsFor([
      makeClientQuoteOption({ key: "on", shipReceiveBy: "2026-10-20" }),
      makeClientQuoteOption({ key: "late", shipReceiveBy: "2026-10-30" }),
      makeClientQuoteOption({ key: "ships-after", leadTimeBusinessDays: 15 }),
      makeClientQuoteOption({ key: "ships-before", leadTimeBusinessDays: 2 }),
      makeClientQuoteOption({ key: "unknown", leadTimeBusinessDays: null }),
    ]);
    const deadline = "2026-10-22";
    expect(getDeadlineStatus(onTime, deadline)).toBe("on_time");
    expect(getDeadlineStatus(late, deadline)).toBe("late");
    expect(getDeadlineStatus(shipsAfter, deadline)).toBe("late");
    expect(getDeadlineStatus(shipsBefore, deadline)).toBe("unconfirmed");
    expect(getDeadlineStatus(unknown, deadline)).toBe("unconfirmed");
    expect(getDeadlineStatus(onTime, null)).toBe("no_deadline");
  });

  it("does not call a ship on the deadline day a miss, since zero transit days is valid", () => {
    const row = (shipDate: string) => ({ arrival: { kind: "ships_by" as const, shipDate } });
    expect(getDeadlineStatus(row("2026-10-22"), "2026-10-22")).toBe("unconfirmed");
    expect(getDeadlineStatus(row("2026-10-23"), "2026-10-22")).toBe("late");
  });
});

describe("sortDeliveredComparisonRows", () => {
  const rows = rowsFor([
    makeClientQuoteOption({ key: "late-cheap", vendorLabel: "A", totalPriceUsd: 50, shipReceiveBy: "2026-10-30" }),
    makeClientQuoteOption({ key: "on-pricey", vendorLabel: "B", totalPriceUsd: 300, shipReceiveBy: "2026-10-15" }),
    makeClientQuoteOption({ key: "on-mid", vendorLabel: "C", totalPriceUsd: 150, shipReceiveBy: "2026-10-21" }),
    makeClientQuoteOption({ key: "unknown", vendorLabel: "D", totalPriceUsd: 40, leadTimeBusinessDays: null }),
  ]);

  it("Cheapest with a deadline puts on-time options first by OTD, then unconfirmed, then late", () => {
    expect(sortDeliveredComparisonRows(rows, "cheapest", "2026-10-22").map((row) => row.key))
      .toEqual(["on-mid", "on-pricey", "unknown", "late-cheap"]);
  });

  it("Cheapest without a deadline orders purely by OTD", () => {
    expect(sortDeliveredComparisonRows(rows, "cheapest", null).map((row) => row.key))
      .toEqual(["unknown", "late-cheap", "on-mid", "on-pricey"]);
  });

  it("Fastest orders by projected arrival with unknown arrivals last", () => {
    expect(sortDeliveredComparisonRows(rows, "fastest", "2026-10-22").map((row) => row.key))
      .toEqual(["on-pricey", "on-mid", "late-cheap", "unknown"]);
  });

  it("is stable for exact ties so a new arrival does not reshuffle existing rows", () => {
    const tied = rowsFor([
      makeClientQuoteOption({ key: "b", vendorLabel: "Same", shipReceiveBy: "2026-10-20" }),
      makeClientQuoteOption({ key: "a", vendorLabel: "Same", shipReceiveBy: "2026-10-20" }),
    ]);
    expect(sortDeliveredComparisonRows(tied, "cheapest", null).map((row) => row.key)).toEqual(["a", "b"]);
  });
});

describe("resolveQuoteRequestCompletion", () => {
  const base: QuoteRequestCompletionInput = {
    request: { id: "req-1", status: "received", requestedVendors: ["xometry", "protolabs"] },
    run: { id: "run-1", quoteRequestId: "req-1" },
    vendorResults: [
      { id: "res-x", vendor: "xometry", quoteRunId: "run-1", status: "instant_quote_received" },
      { id: "res-p", vendor: "protolabs", quoteRunId: "run-1", status: "failed" },
    ],
  };
  const visible = [
    makeClientQuoteOption({ key: "x1", vendorKey: "xometry", vendorQuoteResultId: "res-x" }),
    makeClientQuoteOption({ key: "x2", vendorKey: "xometry", vendorQuoteResultId: "res-x" }),
  ];

  it("reports counts once every requested provider is terminal", () => {
    expect(resolveQuoteRequestCompletion(base, visible)).toEqual({
      requestId: "req-1",
      optionCount: 2,
      providerWithOptionsCount: 1,
      noQuoteProviderCount: 1,
    });
  });

  it("stays silent while any requested provider is still running or awaiting review", () => {
    for (const status of ["queued", "running", "manual_review_pending", "manual_vendor_followup", "stale"] as const) {
      const input = {
        ...base,
        vendorResults: [base.vendorResults[0], { ...base.vendorResults[1], status }],
      };
      expect(resolveQuoteRequestCompletion(input, visible)).toBeNull();
    }
  });

  it("stays silent when a requested provider has no result on the active run", () => {
    expect(resolveQuoteRequestCompletion({ ...base, vendorResults: [base.vendorResults[0]] }, visible)).toBeNull();
    expect(resolveQuoteRequestCompletion({
      ...base,
      vendorResults: [base.vendorResults[0], { ...base.vendorResults[1], quoteRunId: "old-run" }],
    }, visible)).toBeNull();
  });

  it("stays silent for canceled or in-flight requests and mismatched runs", () => {
    for (const status of ["queued", "requesting", "canceled"] as const) {
      expect(resolveQuoteRequestCompletion({ ...base, request: { ...base.request!, status } }, visible)).toBeNull();
    }
    expect(resolveQuoteRequestCompletion({ ...base, run: { id: "run-1", quoteRequestId: "other" } }, visible)).toBeNull();
    expect(resolveQuoteRequestCompletion({ ...base, request: null }, visible)).toBeNull();
  });

  it("excludes concealed overseas and unverified-origin results from counts", () => {
    // Only the options the caller can show are passed in; concealed ones never reach the count.
    const notice = resolveQuoteRequestCompletion(base, visible.slice(0, 1));
    expect(notice?.optionCount).toBe(1);
    const none = resolveQuoteRequestCompletion(base, []);
    expect(none).toMatchObject({ optionCount: 0, providerWithOptionsCount: 0 });
  });
});


describe("countDeadlineStatuses", () => {
  it("counts the row as late using the current order instant, not its old quote date", () => {
    const { rows } = buildDeliveredComparisonModel([
      makeClientQuoteOption({ quoteDateIso: "2026-03-16", leadTimeBusinessDays: 5 }),
    ], { now: new Date("2026-10-21T12:00:00Z"), timeZone: "UTC" });
    expect(getDeadlineStatus(rows[0], "2026-04-02")).toBe("late");
    expect(countDeadlineStatuses(rows, "2026-04-02")).toEqual({ on_time: 0, unconfirmed: 0, late: 1 });
  });

  it("counts each status and handles empty rows and no deadline", () => {
    const rows = rowsFor([
      makeClientQuoteOption({ shipReceiveBy: "2026-10-20" }),
      makeClientQuoteOption({ shipReceiveBy: "2026-10-30" }),
      makeClientQuoteOption({ leadTimeBusinessDays: null }),
    ]);
    expect(countDeadlineStatuses(rows, "2026-10-22")).toEqual({ on_time: 1, unconfirmed: 1, late: 1 });
    expect(countDeadlineStatuses([], "2026-10-22")).toEqual({ on_time: 0, unconfirmed: 0, late: 0 });
    expect(countDeadlineStatuses(rows, null)).toEqual({ on_time: 0, unconfirmed: 0, late: 0 });
  });
});
