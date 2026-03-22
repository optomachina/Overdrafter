import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React, { createContext, useContext, useState } from "react";
import type { PropsWithChildren, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteDiagnostics } from "@/features/quotes/types";
import { QuoteChart } from "./QuoteChart";
import { QuoteList } from "./QuoteList";

type MockPayload = Array<{ payload: ClientQuoteSelectionOption }>;

const ChartContext = createContext<{
  activePayload: MockPayload;
  setActivePayload: (payload: MockPayload) => void;
} | null>(null);

vi.mock("recharts", () => {
  function ResponsiveContainer({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function ScatterChart({
    children,
    onClick,
  }: PropsWithChildren<{ onClick?: (state: { activePayload: MockPayload }) => void }>) {
    const [activePayload, setActivePayload] = useState<MockPayload>([]);

    return (
      <ChartContext.Provider value={{ activePayload, setActivePayload }}>
        <div data-testid="scatter-chart" onClick={() => onClick?.({ activePayload })}>
          {children}
        </div>
      </ChartContext.Provider>
    );
  }

  function Scatter({
    data,
    shape,
  }: {
    data?: ClientQuoteSelectionOption[];
    shape?: (props: {
      cx: number;
      cy: number;
      payload: ClientQuoteSelectionOption;
    }) => ReactElement | null;
  }) {
    const context = useContext(ChartContext);

    return (
      <>
        {(data ?? []).map((point, index) => {
          const element = shape?.({
            cx: 20 + index * 16,
            cy: 20 + index * 12,
            payload: point,
          });

          if (!element || !context) {
            return null;
          }

          return React.cloneElement(element, {
            key: point.offerId,
            onMouseEnter: (event: React.MouseEvent<SVGCircleElement>) => {
              context.setActivePayload([{ payload: point }]);
              element.props.onMouseEnter?.(event);
            },
            onMouseLeave: (event: React.MouseEvent<SVGCircleElement>) => {
              context.setActivePayload([]);
              element.props.onMouseLeave?.(event);
            },
          });
        })}
      </>
    );
  }

  function Tooltip({
    content,
  }: {
    content?: ReactElement | ((props: { active: boolean; payload: MockPayload }) => ReactElement | null);
  }) {
    const context = useContext(ChartContext);
    const props = {
      active: Boolean(context?.activePayload.length),
      payload: context?.activePayload ?? [],
    };

    if (!content) {
      return null;
    }

    return typeof content === "function" ? content(props) : React.cloneElement(content, props);
  }

  function CartesianGrid() {
    return null;
  }

  function XAxis({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function YAxis({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function Label() {
    return null;
  }

  return {
    CartesianGrid,
    Label,
    ResponsiveContainer,
    Scatter,
    ScatterChart,
    Tooltip,
    XAxis,
    YAxis,
  };
});

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

const diagnostics: QuoteDiagnostics = {
  rawQuoteRowCount: 0,
  rawOfferCount: 0,
  plottableOfferCount: 0,
  excludedOfferCount: 0,
  excludedOffers: [],
  excludedReasonCounts: [],
};

function SurfaceHarness() {
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const quotes = [
    makeQuote(),
    makeQuote({
      key: "offer-2",
      offerId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorKey: "fictiv",
      vendorLabel: "Fictiv",
      supplier: "Fictiv",
      unitPriceUsd: 55,
      leadTimeBusinessDays: 7,
    }),
  ];

  return (
    <div>
      <span data-testid="selected-offer">{selectedOfferId ?? "none"}</span>
      <QuoteChart quotes={quotes} selectedOfferId={selectedOfferId} onSelect={setSelectedOfferId} />
      <QuoteList
        quotes={quotes}
        selectedOfferId={selectedOfferId}
        onSelect={setSelectedOfferId}
        quoteDataStatus="available"
        quoteDataMessage={null}
        quoteDiagnostics={diagnostics}
        activePreset={null}
        onPresetSelect={vi.fn()}
        onToggleVendorExclusion={vi.fn()}
      />
    </div>
  );
}

describe("Quote selection surface", () => {
  it("keeps chart and list in sync through shared selectedOfferId state", () => {
    render(<SurfaceHarness />);

    fireEvent.click(screen.getByTestId("quote-point-offer-2"));
    expect(screen.getByTestId("selected-offer")).toHaveTextContent("offer-2");
    expect(screen.getByText("Selected ✓")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Selected ✓"));
    expect(screen.getByTestId("selected-offer")).toHaveTextContent("none");
  });
});
