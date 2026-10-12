import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDiagnostics } from "@/features/quotes/types";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";
import { makeClientQuoteOption } from "./test-option-factory";

const mobileMock = vi.hoisted(() => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: mobileMock.useIsMobile,
}));

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: ({
    options,
    selectedKey,
    hoveredKey,
    onSelect,
  }: {
    options: readonly ClientQuoteSelectionOption[];
    selectedKey: string | null;
    hoveredKey: string | null;
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
      <div data-testid="quote-chart-hovered-key">{hoveredKey ?? "none"}</div>
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
    vendorKey: "protolabs",
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

describe("ClientQuoteDecisionPanel when the previous choice is gone", () => {
  function UnavailableSelectionHarness({
    options,
    onSelect,
  }: {
    readonly options: readonly ClientQuoteSelectionOption[];
    readonly onSelect: (option: ClientQuoteSelectionOption) => void;
  }) {
    const [selected, setSelected] = useState<ClientQuoteSelectionOption | null>(null);

    return (
      <ClientQuoteDecisionPanel
        options={options}
        selectedOption={selected}
        previousSelectionUnavailable={selected === null}
        onSelect={(option) => {
          onSelect(option);
          setSelected(option);
        }}
        requestedByDate="2026-04-15"
      />
    );
  }

  it("shows no option as selected, explains why, and allows a normal reselection", async () => {
    const onSelect = vi.fn();
    const first = makeClientQuoteOption();
    const second = makeSecondOption();

    render(<UnavailableSelectionHarness options={[first, second]} onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your previous quote choice is no longer available. Choose a quote to continue.",
    );
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent("none");
    expect(screen.queryByText("Current selection")).not.toBeInTheDocument();
    // OVD-571 removed the recommendation fallback, so nothing stands in for the lost choice.
    expect(screen.queryByText("Recommended starting point")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Proto Labs"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(second);
    expect(screen.queryByTestId("previous-selection-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(second.key);
    expect(screen.getByText("Current selection")).toBeInTheDocument();
  });

  it.each([
    ["there are no options", [], "available"],
    ["the quote data is unavailable", [makeClientQuoteOption()], "schema_unavailable"],
    ["the quote rows could not be plotted", [makeClientQuoteOption()], "invalid_for_plotting"],
  ] as const)("does not show the notice when %s", (_label, options, quoteDataStatus) => {
    render(
      <ClientQuoteDecisionPanel
        options={options}
        selectedOption={null}
        previousSelectionUnavailable
        quoteDataStatus={quoteDataStatus}
        onSelect={vi.fn()}
        requestedByDate={null}
      />,
    );

    expect(screen.queryByTestId("previous-selection-unavailable")).not.toBeInTheDocument();
  });

  it("does not show the notice when nothing was ever chosen", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[makeClientQuoteOption()]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("previous-selection-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent("none");
  });
});

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
    expect(screen.getByText(/Validity not provided/)).toBeInTheDocument();
    expect(screen.getByText("Proto Labs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Proto Labs"));

    expect(onSelect).toHaveBeenCalledWith(second);
  });

  it("shows collection freshness separately from commercial validity", async () => {
    const selected = makeClientQuoteOption({
      offerCreatedAt: new Date().toISOString(),
      validUntil: "2026-09-30T23:59:59.999Z",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[selected]}
        selectedOption={selected}
        onSelect={vi.fn()}
        requestedByDate={null}
      />,
    );

    expect(await screen.findByText(/Recently collected/)).toHaveTextContent(
      /Valid through/,
    );
  });

  it("preserves date-only vendor terms in the user's local timezone", async () => {
    const selected = makeClientQuoteOption({
      quoteDateIso: "2026-04-15",
      validUntil: "2026-04-30",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[selected]}
        selectedOption={selected}
        onSelect={vi.fn()}
        requestedByDate={null}
      />,
    );

    await screen.findByText("Quote Chart");
    fireEvent.click(screen.getByText("Response source facts"));

    expect(screen.getByText("4/15/2026")).toBeInTheDocument();
    expect(screen.getAllByText("4/30/2026")).not.toHaveLength(0);
  });

  it("shows a supported vendor purchasing link without selecting the row", async () => {
    const onSelect = vi.fn();
    const option = makeClientQuoteOption({
      quoteUrl: "https://www.xometry.com/quoting/home/Q-123",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[option]}
        selectedOption={null}
        onSelect={onSelect}
        requestedByDate={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    const vendorLink = screen.getByRole("link", { name: "Open from Xometry" });
    expect(vendorLink).toHaveAttribute("href", option.quoteUrl);
    expect(vendorLink).toHaveAttribute("target", "_blank");
    expect(screen.getByText(/vendor sign-in or a vendor-issued guest link may be required/i)).toBeInTheDocument();

    fireEvent.click(vendorLink);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides unsafe and unsupported vendor quote URLs", async () => {
    const mismatched = makeClientQuoteOption({
      quoteUrl: "https://example.test/quote/1",
    });
    const unsupported = makeClientQuoteOption({
      key: "partsbadger-option",
      offerId: "partsbadger-offer",
      persistedOfferId: "partsbadger-offer",
      vendorKey: "partsbadger",
      vendorLabel: "PartsBadger",
      quoteUrl: "https://portal.parts-badger.com/rapid-quote/1",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[mismatched, unsupported]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: /open from/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/vendor sign-in or a vendor-issued guest link may be required/i)).not.toBeInTheDocument();
  });

  it("syncs panel selection state when chart selection changes", async () => {
    const first = makeClientQuoteOption();
    const second = makeSecondOption();

    render(<SelectionHarness first={first} second={second} />);

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });
    expect(within(screen.getByTestId("selected-option-summary")).getByText("10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quote Chart Select" }));

    expect(within(screen.getByTestId("selected-option-summary")).getByText("25")).toBeInTheDocument();
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

  it("syncs table hover and keyboard focus to the chart without replacing selection", async () => {
    const first = makeClientQuoteOption();
    const second = makeSecondOption();

    render(<SelectionHarness first={first} second={second} />);
    await screen.findByText("Quote Chart");

    const secondRow = screen.getByRole("row", { name: /Proto Labs/i });
    fireEvent.mouseEnter(secondRow);
    expect(screen.getByTestId("quote-chart-hovered-key")).toHaveTextContent(second.key);
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(first.key);

    fireEvent.mouseLeave(secondRow);
    fireEvent.focus(secondRow);
    expect(screen.getByTestId("quote-chart-hovered-key")).toHaveTextContent(second.key);
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(first.key);

    fireEvent.keyDown(secondRow, { key: "Enter" });
    expect(screen.getByTestId("quote-chart-selected-key")).toHaveTextContent(second.key);
  });

  it("renders the projected delivered date in the comparison table", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[makeClientQuoteOption({ leadTimeBusinessDays: 7, resolvedDeliveryDate: "2026-04-10" })]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate="2026-10-15"
        now={new Date("2026-10-12T15:00:00.000Z")}
        timeZone="UTC"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    const table = screen.getByRole("columnheader", { name: "Delivered by" }).closest("table");

    expect(table).not.toBeNull();
    expect(within(table as HTMLTableElement).getByText("After Wed, Oct 21, 2026")).toBeInTheDocument();
    expect(within(table as HTMLTableElement).getByText("Ships then; transit not quoted")).toBeInTheDocument();
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
    expect(screen.getAllByText(/invalid total price format/i)).toHaveLength(3);
    expect(screen.getByRole("row", { name: /Xometry USA.*Invalid total price format/i })).toBeInTheDocument();
    expect(screen.queryByText("Quote Chart")).not.toBeInTheDocument();
  });

  it("keeps noncomparable responses in the vendor table beside comparable offers", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[makeClientQuoteOption()]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        quoteDiagnostics={makeDiagnostics({ plottableOfferCount: 1 })}
      />,
    );

    await screen.findByText("Quote Chart");

    const excludedRow = screen.getByRole("row", { name: /Xometry USA.*Invalid total price format/i });
    expect(excludedRow).toHaveAttribute("aria-disabled", "true");
    expect(within(excludedRow).getAllByText("Unavailable")).toHaveLength(4);
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

  it("uses the synchronized vendor table in compact contexts", async () => {
    render(
      <ClientQuoteDecisionPanel
        options={[
          makeClientQuoteOption(),
          makeClientQuoteOption({
            key: "option-2",
            offerId: "offer-2",
            persistedOfferId: "offer-2",
            vendorQuoteResultId: "result-2",
            vendorKey: "protolabs",
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
    expect(screen.getByRole("columnheader", { name: "Vendor" })).toBeInTheDocument();
  });

  it("lists every provider variant and excludes unknown provenance from US-only scope", async () => {
    const domestic = makeClientQuoteOption({
      key: "xometry-domestic",
      offerId: "domestic-standard",
      persistedOfferId: "offer-domestic",
      laneLabel: "Domestic Standard",
      geographicOrigin: "domestic",
      domesticStatus: "domestic",
    });
    const unknown = makeClientQuoteOption({
      key: "xometry-economy",
      offerId: "economy",
      persistedOfferId: "offer-economy",
      laneLabel: "Economy",
      geographicOrigin: "unknown",
      domesticStatus: "unknown",
      sourcing: "Domestic",
    });

    const { rerender } = render(
      <ClientQuoteDecisionPanel
        options={[domestic, unknown]}
        selectedOption={unknown}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="cheapest_domestic"
      />,
    );

    await screen.findByText("Quote Chart");
    expect(getVendorRowNames()).toHaveLength(1);
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
    // A concealed selection is not replaced by a recommended option.
    expect(screen.queryByTestId("selected-option-summary")).not.toBeInTheDocument();

    rerender(
      <ClientQuoteDecisionPanel
        options={[domestic, unknown]}
        selectedOption={unknown}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="cheapest_global"
      />,
    );

    expect(getVendorRowNames()).toHaveLength(2);
    expect(screen.getAllByText("Unknown")).not.toHaveLength(0);
    const unknownRow = screen.getByRole("row", { name: /Economy Unknown/ });
    expect(within(unknownRow).getByText("Economy")).toBeInTheDocument();
    expect(within(unknownRow).queryByText("Domestic")).not.toBeInTheDocument();

    rerender(
      <ClientQuoteDecisionPanel
        options={[domestic, unknown]}
        selectedOption={unknown}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="cheapest"
      />,
    );

    expect(getVendorRowNames()).toHaveLength(2);
    expect(within(screen.getByTestId("selected-option-summary")).getByText("Unknown")).toBeInTheDocument();
  });

  it("keeps late vendor rows visible and marks them when a need by date is set", async () => {
    const first = makeClientQuoteOption({
      key: "option-on-time",
      offerId: "offer-on-time",
      persistedOfferId: "offer-on-time",
      shipReceiveBy: "2026-10-14",
    });
    const second = makeClientQuoteOption({
      key: "option-late",
      offerId: "offer-late",
      persistedOfferId: "offer-late",
      vendorQuoteResultId: "result-2",
      vendorKey: "protolabs",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      shipReceiveBy: "2026-10-22",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[first, second]}
        selectedOption={first}
        onSelect={vi.fn()}
        requestedByDate="2026-10-15"
        now={new Date("2026-10-12T15:00:00.000Z")}
        timeZone="UTC"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(getVendorRowNames().some((name) => name.includes("Xometry"))).toBe(true);
    expect(getVendorRowNames().some((name) => name.includes("Proto Labs"))).toBe(true);
    expect(screen.getByText("Misses deadline")).toBeInTheDocument();
  });

  it("follows an external Cheapest/Fastest preset with the table order and never badges a winner", async () => {
    const now = new Date("2026-10-12T15:00:00.000Z");
    const fastest = makeClientQuoteOption({
      key: "option-fast",
      offerId: "offer-fast",
      persistedOfferId: "offer-fast",
      vendorQuoteResultId: "result-fast",
      vendorKey: "fictiv",
      vendorLabel: "Fictiv",
      supplier: "Fictiv",
      totalPriceUsd: 180,
      shipReceiveBy: "2026-10-14",
    });
    const cheapest = makeClientQuoteOption({
      key: "option-cheap",
      offerId: "offer-cheap",
      persistedOfferId: "offer-cheap",
      vendorQuoteResultId: "result-cheap",
      vendorKey: "protolabs",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 90,
      shipReceiveBy: "2026-10-23",
    });

    const { rerender } = render(
      <ClientQuoteDecisionPanel
        options={[fastest, cheapest]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="balanced"
        now={now}
        timeZone="UTC"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(getVendorRowNames()[0]).toContain("Proto Labs");
    expect(screen.getByRole("radio", { name: "Cheapest" })).toHaveAttribute("aria-checked", "true");

    rerender(
      <ClientQuoteDecisionPanel
        options={[fastest, cheapest]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        activePreset="fastest"
        now={now}
        timeZone="UTC"
      />,
    );

    expect(getVendorRowNames()[0]).toContain("Fictiv");
    expect(screen.getByRole("radio", { name: "Fastest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/pick$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaders?$/)).not.toBeInTheDocument();
  });

  it("keeps all vendors visible when every vendor misses the need by date", async () => {
    const lateOption = makeClientQuoteOption({
      key: "option-late",
      offerId: "offer-late",
      persistedOfferId: "offer-late",
      shipReceiveBy: "2026-10-22",
    });

    render(
      <ClientQuoteDecisionPanel
        options={[lateOption]}
        selectedOption={lateOption}
        onSelect={vi.fn()}
        requestedByDate="2026-10-15"
        now={new Date("2026-10-12T15:00:00.000Z")}
        timeZone="UTC"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    });

    expect(screen.queryByText("No vendors meet this due date")).not.toBeInTheDocument();
    expect(screen.getByText("Misses deadline")).toBeInTheDocument();
    expect(screen.getAllByText("Xometry").length).toBeGreaterThan(0);
  });
});
