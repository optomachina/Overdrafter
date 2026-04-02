import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDiagnostics } from "@/features/quotes/types";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: ({
    options,
    onSelect,
  }: {
    options: readonly ClientQuoteSelectionOption[];
    onSelect: (option: ClientQuoteSelectionOption) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          const next = options[1] ?? options[0];
          if (next) {
            onSelect(next);
          }
        }}
      >
        Quote Chart Select
      </button>
      <div>Quote Chart</div>
    </div>
  ),
}));

function makeDiagnostics(overrides: Partial<QuoteDiagnostics> = {}): QuoteDiagnostics {
  return {
    rawQuoteRowCount: 1,
    rawOfferCount: 1,
    plottableOfferCount: 0,
    excludedOfferCount: 1,
    excludedOffers: [
      {
        vendorQuoteResultId: "result-1",
        vendorKey: "xometry",
        offerId: "offer-1",
        offerKey: "lane-1",
        supplier: "Xometry USA",
        laneLabel: "USA / Standard",
        reasons: ["invalid_total_price_format"],
      },
    ],
    excludedReasonCounts: [{ reason: "invalid_total_price_format", count: 1 }],
    ...overrides,
  };
}

describe("ClientQuoteDecisionPanel", () => {
  it("renders quote data and selects a clicked option", async () => {
    const onSelect = vi.fn();
    const first = makeClientQuoteOption();
    const second = makeClientQuoteOption({
      key: "option-2",
      offerId: "offer-2",
      persistedOfferId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 160,
      requestedQuantity: 25,
    });

    render(
      <ClientQuoteDecisionPanel
        options={[first, second]}
        selectedOption={first}
        onSelect={onSelect}
        requestedByDate="2026-04-15"
        activePreset="cheapest"
        onPresetSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByText("Current selection")).toBeInTheDocument();
    expect(screen.getByText("Proto Labs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Proto Labs"));

    expect(onSelect).toHaveBeenCalledWith(second);
  });

  it("syncs panel selection state when chart selection changes", async () => {
    const first = makeClientQuoteOption();
    const second = makeClientQuoteOption({
      key: "option-2",
      offerId: "offer-2",
      persistedOfferId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 160,
      requestedQuantity: 25,
    });

    function SelectionHarness() {
      const [selected, setSelected] = useState<ClientQuoteSelectionOption | null>(first);

      return (
        <ClientQuoteDecisionPanel
          options={[first, second]}
          selectedOption={selected}
          onSelect={setSelected}
          requestedByDate="2026-04-15"
        />
      );
    }

    render(<SelectionHarness />);

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByText("Qty 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quote Chart Select" }));

    expect(screen.getByText("Qty 25")).toBeInTheDocument();
  });

  it("renders a stable empty state when quote data is absent", () => {
    render(
      <ClientQuoteDecisionPanel
        options={[]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        emptyState="No quote options are available for this part yet."
      />,
    );

    expect(screen.getByText("No quote options are available for this part yet.")).toBeInTheDocument();
    expect(screen.queryByText("Quote Chart")).not.toBeInTheDocument();
  });

  it("renders a schema error state instead of an empty state", () => {
    render(
      <ClientQuoteDecisionPanel
        options={[]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        quoteDataStatus="schema_unavailable"
        quoteDataMessage="Apply the latest Supabase migrations and refresh the schema cache."
      />,
    );

    expect(screen.getByText("Quote comparison is unavailable")).toBeInTheDocument();
    expect(screen.getByText(/apply the latest supabase migrations/i)).toBeInTheDocument();
    expect(screen.queryByText("Quote Chart")).not.toBeInTheDocument();
  });

  it("renders an invalid-for-plotting state when quote rows cannot be plotted", () => {
    render(
      <ClientQuoteDecisionPanel
        options={[]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        quoteDataStatus="invalid_for_plotting"
        quoteDataMessage="1 quote lanes were excluded before plotting: Invalid total price format (1)."
        quoteDiagnostics={makeDiagnostics()}
      />,
    );

    expect(screen.getByText("Quote rows were loaded but could not be plotted")).toBeInTheDocument();
    expect(screen.getAllByText(/invalid total price format/i)).toHaveLength(2);
    expect(screen.queryByText("Quote Chart")).not.toBeInTheDocument();
  });

  it("renders custom controls instead of the legacy preset row when provided", () => {
    render(
      <ClientQuoteDecisionPanel
        options={[makeClientQuoteOption()]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
        activePreset="cheapest"
        onPresetSelect={vi.fn()}
        controls={<div>Function Box</div>}
      />,
    );

    expect(screen.getByText("Function Box")).toBeInTheDocument();
    expect(screen.queryByText("Presets")).not.toBeInTheDocument();
  });

  it("renders compact quote cards when requested", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[
          makeClientQuoteOption(),
          makeClientQuoteOption({
            key: "option-2",
            offerId: "offer-2",
            persistedOfferId: "offer-2",
            vendorQuoteResultId: "result-2",
            vendorLabel: "Proto Labs",
            supplier: "Proto Labs",
            totalPriceUsd: 160,
          }),
        ]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
        layout="compact"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByText("Proto Labs")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Vendor" })).not.toBeInTheDocument();
  });
});
