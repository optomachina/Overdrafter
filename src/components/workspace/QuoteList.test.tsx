import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDiagnostics } from "@/features/quotes/types";
import { QuoteList } from "./QuoteList";

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

function makeDiagnostics(): QuoteDiagnostics {
  return {
    rawQuoteRowCount: 0,
    rawOfferCount: 0,
    plottableOfferCount: 0,
    excludedOfferCount: 0,
    excludedOffers: [],
    excludedReasonCounts: [],
  };
}

describe("QuoteList", () => {
  it("sorts quotes by price, sinks excluded rows, and renders best/fastest badges", () => {
    const quotes = [
      makeQuote({ offerId: "offer-3", key: "offer-3", vendorLabel: "Protolabs", unitPriceUsd: 88, leadTimeBusinessDays: 5 }),
      makeQuote({ offerId: "offer-2", key: "offer-2", vendorLabel: "Fictiv", unitPriceUsd: 55, leadTimeBusinessDays: 3 }),
      makeQuote({ offerId: "offer-1", key: "offer-1", vendorLabel: "Xometry", unitPriceUsd: 42.37, excluded: true, leadTimeBusinessDays: 9 }),
    ];

    render(
      <QuoteList
        quotes={quotes}
        selectedOfferId={null}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
        quoteDataStatus="available"
        quoteDataMessage={null}
        quoteDiagnostics={makeDiagnostics()}
        activePreset={null}
        onPresetSelect={vi.fn()}
        onToggleVendorExclusion={vi.fn()}
      />,
    );

    const vendorLabels = screen.getAllByText(/Fictiv|Protolabs|Xometry/).map((node) => node.textContent);
    expect(vendorLabels.slice(0, 3)).toEqual(["Fictiv", "Protolabs", "Xometry"]);
    expect(screen.getByText("Best $55.00")).toBeInTheDocument();
    expect(screen.getByText("Fastest 3 bd")).toBeInTheDocument();
    expect(screen.getByText("Need-by 2026-04-15")).toBeInTheDocument();
  });

  it("toggles selected rows and select buttons through the shared onSelect contract", () => {
    const onSelect = vi.fn();
    const quote = makeQuote();
    const { rerender } = render(
      <QuoteList
        quotes={[quote]}
        selectedOfferId={null}
        onSelect={onSelect}
        quoteDataStatus="available"
        quoteDataMessage={null}
        quoteDiagnostics={makeDiagnostics()}
        activePreset="cheapest"
        onPresetSelect={vi.fn()}
        onToggleVendorExclusion={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Xometry"));
    expect(onSelect).toHaveBeenCalledWith("offer-1");

    rerender(
      <QuoteList
        quotes={[quote]}
        selectedOfferId="offer-1"
        onSelect={onSelect}
        quoteDataStatus="available"
        quoteDataMessage={null}
        quoteDiagnostics={makeDiagnostics()}
        activePreset="cheapest"
        onPresetSelect={vi.fn()}
        onToggleVendorExclusion={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Selected ✓"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
