import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDiagnostics } from "@/features/quotes/types";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: readonly ClientQuoteSelectionOption[];
    selectedKey: string | null;
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
      <div data-testid="quote-chart-selected-key">{selectedKey ?? "none"}</div>
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

function getVendorRowNames() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
}

function makeSecondOption() {
  return makeClientQuoteOption({
    key: "option-2",
    offerId: "offer-2",
    persistedOfferId: "offer-2",
    vendorQuoteResultId: "result-2",
    vendorLabel: "Proto Labs",
    supplier: "Proto Labs",
    totalPriceUsd: 160,
    requestedQuantity: 25,
  });
}

function SelectionHarness({
  first,
  second,
}: {
  readonly first: ClientQuoteSelectionOption;
  readonly second: ClientQuoteSelectionOption;
}) {
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

describe("ClientQuoteDecisionPanel", () => {
  it("renders quote data and selects a clicked option", async () => {
    const onSelect = vi.fn();
    const first = makeClientQuoteOption();
    const second = makeSecondOption();

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
    const second = makeSecondOption();

    render(<SelectionHarness first={first} second={second} />);

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByText("Qty 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quote Chart Select" }));

    expect(screen.getByText("Qty 25")).toBeInTheDocument();
  });

  it("syncs chart selection state when a table row is clicked", async () => {
    const first = makeClientQuoteOption();
    const second = makeSecondOption();

    render(<SelectionHarness first={first} second={second} />);

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(first.key);

    fireEvent.click(screen.getByText("Proto Labs"));

    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(second.key);
  });

  it("renders estimated delivery in days in the comparison table", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[makeClientQuoteOption({ leadTimeBusinessDays: 7, resolvedDeliveryDate: "2026-04-10" })]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    const table = screen.getByRole("columnheader", { name: "Estimated Delivery" }).closest("table");

    expect(table).not.toBeNull();
    expect(within(table as HTMLTableElement).getByText("7 days")).toBeInTheDocument();
    expect(screen.queryByText("7 business days")).not.toBeInTheDocument();
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

  it("filters visible vendor rows when due by removes late options", async () => {
    const first = makeClientQuoteOption({
      key: "option-on-time",
      offerId: "offer-on-time",
      persistedOfferId: "offer-on-time",
      resolvedDeliveryDate: "2026-04-10",
      dueDateEligible: true,
    });
    const second = makeClientQuoteOption({
      key: "option-late",
      offerId: "offer-late",
      persistedOfferId: "offer-late",
      vendorQuoteResultId: "result-2",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      resolvedDeliveryDate: "2026-04-22",
      dueDateEligible: false,
    });

    render(
      <ClientQuoteDecisionPanel
        options={[first, second]}
        selectedOption={first}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(getVendorRowNames().some((name) => name.includes("Xometry"))).toBe(true);
    expect(getVendorRowNames().some((name) => name.includes("Proto Labs"))).toBe(false);
    expect(screen.getByText("Showing vendors that can meet 2026-04-15. 1 row is hidden.")).toBeInTheDocument();
  });

  it("visibly reorders vendor rows and updates the indicator when preset mode changes", async () => {
    const fastest = makeClientQuoteOption({
      key: "option-fast",
      offerId: "offer-fast",
      persistedOfferId: "offer-fast",
      vendorQuoteResultId: "result-fast",
      vendorLabel: "Fictiv",
      supplier: "Fictiv",
      totalPriceUsd: 180,
      unitPriceUsd: 18,
      leadTimeBusinessDays: 3,
      resolvedDeliveryDate: "2026-04-08",
    });
    const cheapest = makeClientQuoteOption({
      key: "option-cheap",
      offerId: "offer-cheap",
      persistedOfferId: "offer-cheap",
      vendorQuoteResultId: "result-cheap",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 90,
      unitPriceUsd: 9,
      leadTimeBusinessDays: 8,
      resolvedDeliveryDate: "2026-04-16",
    });

    const { rerender } = render(
      <ClientQuoteDecisionPanel
        options={[fastest, cheapest]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="fastest"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    let vendorRows = getVendorRowNames();
    expect(vendorRows[0]).toContain("Fictiv");
    expect(vendorRows[1]).toContain("Proto Labs");
    expect(screen.getByText("Sorting by fastest delivery")).toBeInTheDocument();
    expect(screen.getByText("Fastest")).toBeInTheDocument();

    rerender(
      <ClientQuoteDecisionPanel
        options={[fastest, cheapest]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="cheapest"
      />,
    );

    vendorRows = getVendorRowNames();
    expect(vendorRows[0]).toContain("Proto Labs");
    expect(vendorRows[1]).toContain("Fictiv");
    expect(screen.getByText("Sorting by lowest cost")).toBeInTheDocument();
    expect(screen.getByText("Lowest Cost")).toBeInTheDocument();
  });

  it("badges the top-ranked vendor under the active ranking mode", async () => {
    const first = makeClientQuoteOption({
      key: "option-1",
      vendorLabel: "Fictiv",
      totalPriceUsd: 90,
      unitPriceUsd: 9,
      leadTimeBusinessDays: 4,
      resolvedDeliveryDate: "2026-04-09",
    });
    const second = makeClientQuoteOption({
      key: "option-2",
      offerId: "offer-2",
      persistedOfferId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 90,
      unitPriceUsd: 9,
      leadTimeBusinessDays: 4,
      resolvedDeliveryDate: "2026-04-09",
    });
    const third = makeClientQuoteOption({
      key: "option-3",
      offerId: "offer-3",
      persistedOfferId: "offer-3",
      vendorQuoteResultId: "result-3",
      vendorLabel: "Xometry",
      supplier: "Xometry",
      totalPriceUsd: 110,
      unitPriceUsd: 11,
      leadTimeBusinessDays: 6,
      resolvedDeliveryDate: "2026-04-11",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[third, second, first]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="cheapest"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(getVendorRowNames().filter((name) => name.includes("Lowest Cost"))).toHaveLength(1);
    expect(screen.getByText("1 leader tagged")).toBeInTheDocument();
  });

  it("shows an empty filtered state when every vendor misses the due date", async () => {
    const lateOption = makeClientQuoteOption({
      key: "option-late",
      offerId: "offer-late",
      persistedOfferId: "offer-late",
      dueDateEligible: false,
      resolvedDeliveryDate: "2026-04-22",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[lateOption]}
        selectedOption={lateOption}
        onSelect={vi.fn()}
        requestedByDate="2026-04-15"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(screen.getByText("No vendors meet this due date")).toBeInTheDocument();
    expect(screen.getByText("No visible quote rows can meet 2026-04-15. Clear DUE BY to see every vendor again.")).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "Xometry" })).not.toBeInTheDocument();
  });
});
