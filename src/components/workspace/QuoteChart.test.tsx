import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React, { createContext, useContext, useState } from "react";
import type { PropsWithChildren, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { QuoteChart } from "./QuoteChart";

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
    }) => ReactElement<React.SVGProps<SVGCircleElement>> | null;
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

          return React.cloneElement<React.SVGProps<SVGCircleElement>>(element, {
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

describe("QuoteChart", () => {
  it("does not render points for invalid chart data", () => {
    render(
      <QuoteChart
        quotes={[
          makeQuote({ offerId: "valid-1", key: "valid-1" }),
          makeQuote({ offerId: "bad-lead", key: "bad-lead", leadTimeBusinessDays: null }),
          makeQuote({ offerId: "bad-price", key: "bad-price", unitPriceUsd: Number.NaN }),
        ]}
        selectedOfferId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("quote-point-valid-1")).toBeInTheDocument();
    expect(screen.queryByTestId("quote-point-bad-lead")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quote-point-bad-price")).not.toBeInTheDocument();
  });

  it("renders vendor legend entries and bubble points grouped by vendor", () => {
    render(
      <QuoteChart
        quotes={[
          makeQuote(),
          makeQuote({
            key: "offer-2",
            offerId: "offer-2",
            vendorQuoteResultId: "result-2",
            vendorKey: "fictiv",
            vendorLabel: "Fictiv",
            supplier: "Fictiv",
            unitPriceUsd: 68.66,
            leadTimeBusinessDays: 10,
          }),
        ]}
        selectedOfferId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Xometry")).toBeInTheDocument();
    expect(screen.getByText("Fictiv")).toBeInTheDocument();
    expect(screen.getByTestId("quote-point-offer-1")).toBeInTheDocument();
    expect(screen.getByTestId("quote-point-offer-2")).toBeInTheDocument();
  });

  it("selects a bubble, toggles it off, clears on empty-space click, and shows tooltip content on hover", () => {
    const onSelect = vi.fn();
    const quote = makeQuote({ tier: "Expedite", sourcing: "International" });

    const { rerender } = render(
      <QuoteChart quotes={[quote]} selectedOfferId={null} onSelect={onSelect} />,
    );

    fireEvent.mouseEnter(screen.getByTestId("quote-point-offer-1"));
    expect(screen.getAllByText("Xometry")).toHaveLength(2);
    expect(screen.getByText("Expedite · International")).toBeInTheDocument();
    expect(screen.getByText("$42.37 / ea")).toBeInTheDocument();
    expect(screen.getByText("14 bd lead time")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quote-point-offer-1"));
    expect(onSelect).toHaveBeenCalledWith("offer-1");

    rerender(<QuoteChart quotes={[quote]} selectedOfferId="offer-1" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("quote-point-offer-1"));
    expect(onSelect).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByTestId("scatter-chart"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("supports keyboard selection for chart points", () => {
    const onSelect = vi.fn();

    const { rerender } = render(
      <QuoteChart quotes={[makeQuote()]} selectedOfferId={null} onSelect={onSelect} />,
    );

    fireEvent.keyDown(screen.getByTestId("quote-point-offer-1"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("offer-1");

    rerender(<QuoteChart quotes={[makeQuote()]} selectedOfferId="offer-1" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId("quote-point-offer-1"), { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
