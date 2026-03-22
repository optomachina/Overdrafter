import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { QuoteStatBar } from "./QuoteStatBar";
import { buildQuoteStats } from "./quote-stat-bar";

function makeQuote(overrides: Partial<ClientQuoteSelectionOption> = {}): ClientQuoteSelectionOption {
  return {
    key: "offer-1",
    offerId: "offer-1",
    persistedOfferId: "offer-1",
    vendorKey: "xometry",
    vendorQuoteResultId: "result-1",
    vendorLabel: "Xometry",
    supplier: "Xometry",
    requestedQuantity: 10,
    unitPriceUsd: 42.37,
    totalPriceUsd: 423.7,
    leadTimeBusinessDays: 14,
    resolvedDeliveryDate: "2026-04-01",
    domesticStatus: "domestic",
    excluded: false,
    dueDateEligible: true,
    eligible: true,
    isSelectable: true,
    expedite: false,
    shipReceiveBy: null,
    dueDate: null,
    quoteDateIso: "2026-03-21",
    sourcing: "USA",
    tier: "Standard",
    laneLabel: null,
    process: null,
    material: null,
    finish: null,
    tightestTolerance: null,
    notes: null,
    rawPayload: null,
    ...overrides,
  };
}

describe("QuoteStatBar", () => {
  it("derives best price, fastest lead, and option count from active quotes", () => {
    const stats = buildQuoteStats([
      makeQuote(),
      makeQuote({
        offerId: "offer-2",
        key: "offer-2",
        vendorKey: "fictiv",
        vendorLabel: "Fictiv",
        supplier: "Fictiv",
        tier: "Fastest",
        unitPriceUsd: 65,
        leadTimeBusinessDays: 3,
      }),
      makeQuote({
        offerId: "offer-3",
        key: "offer-3",
        vendorKey: "protolabs",
        vendorLabel: "Protolabs",
        supplier: "Protolabs",
        unitPriceUsd: 75,
        leadTimeBusinessDays: 5,
        excluded: true,
      }),
    ]);

    expect(stats).toEqual([
      expect.objectContaining({
        label: "Best price",
        value: "$42.37",
        detail: "Xometry · Standard",
      }),
      expect.objectContaining({
        label: "Fastest",
        value: "3 bd",
        detail: "Fictiv · Fastest",
      }),
      expect.objectContaining({
        label: "Options",
        value: "2",
        detail: "across 2 vendors",
      }),
    ]);
  });

  it("renders the three stat cards", () => {
    render(<QuoteStatBar quotes={[makeQuote()]} />);

    expect(screen.getByText("Best price")).toBeInTheDocument();
    expect(screen.getByText("Fastest")).toBeInTheDocument();
    expect(screen.getByText("Options")).toBeInTheDocument();
    expect(screen.getByText("$42.37")).toBeInTheDocument();
    expect(screen.getByText("14 bd")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
