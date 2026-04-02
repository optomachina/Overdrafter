import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { PropsWithChildren, ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClientQuoteComparisonChart } from "./ClientQuoteComparisonChart";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ChartTooltip: () => null,
}));

vi.mock("@/features/quotes/quote-chart-diagnostics", () => ({
  logQuoteChartPointDiagnostics: vi.fn(),
}));

vi.mock("recharts", () => {
  function ScatterChart({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function Scatter({
    data,
    shape,
    onMouseEnter,
    onMouseLeave,
    name,
  }: {
    data?: unknown[];
    shape?:
      | ReactNode
      | ((props: { cx: number; cy: number; payload: unknown }) => ReactElement<React.SVGProps<SVGCircleElement>> | null);
    onMouseEnter?: (point: { payload: unknown }) => void;
    onMouseLeave?: () => void;
    name?: string;
  }) {
    return (
      <div data-testid={`scatter-${name ?? "vendor"}`}>
        {(data ?? []).map((point, index) => {
          const shapeProps = {
            cx: 20 + index * 16,
            cy: 20 + index * 12,
            payload: point,
          };

          let element: ReactElement<React.SVGProps<SVGCircleElement>> | null = null;
          if (typeof shape === "function") {
            element = shape(shapeProps);
          } else if (React.isValidElement(shape)) {
            element = React.cloneElement(shape, shapeProps);
          }

          if (!element) {
            return null;
          }

          const renderedElement =
            typeof element.type === "function"
              ? (element.type as (props: React.SVGProps<SVGCircleElement>) => ReactElement | null)(element.props)
              : element;

          if (!renderedElement) {
            return null;
          }

          const pointKey = (point as { key?: string }).key ?? `point-${index}`;

          return (
            <button
              key={pointKey}
              type="button"
              data-testid={`point-${pointKey}`}
              onClick={() => {
                renderedElement.props.onClick?.();
              }}
              onMouseEnter={() => onMouseEnter?.({ payload: point })}
              onMouseLeave={() => onMouseLeave?.()}
            >
              <svg>{renderedElement}</svg>
            </button>
          );
        })}
      </div>
    );
  }

  function CartesianGrid() {
    return null;
  }

  function Label() {
    return null;
  }

  function ReferenceArea({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function XAxis({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  function YAxis({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  }

  return {
    CartesianGrid,
    Label,
    ReferenceArea,
    Scatter,
    ScatterChart,
    XAxis,
    YAxis,
  };
});

describe("ClientQuoteComparisonChart", () => {
  it("selects an option when a chart bubble is clicked", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    const first = makeClientQuoteOption();
    const second = makeClientQuoteOption({
      key: "option-2",
      offerId: "offer-2",
      persistedOfferId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorKey: "fictiv",
      vendorLabel: "Fictiv",
      supplier: "Fictiv",
      totalPriceUsd: 180,
      leadTimeBusinessDays: 5,
    });

    render(
      <ClientQuoteComparisonChart
        options={[first, second]}
        selectedKey={null}
        hoveredKey={null}
        onSelect={onSelect}
        onHover={onHover}
      />,
    );

    fireEvent.click(screen.getByTestId("point-option-2"));

    expect(onSelect).toHaveBeenCalledWith(second);
  });

  it("ignores chart clicks for non-selectable options", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();

    render(
      <ClientQuoteComparisonChart
        options={[
          makeClientQuoteOption({
            key: "option-disabled",
            offerId: "offer-disabled",
            persistedOfferId: "offer-disabled",
            vendorQuoteResultId: "result-disabled",
            eligible: false,
            isSelectable: false,
          }),
        ]}
        selectedKey={null}
        hoveredKey={null}
        onSelect={onSelect}
        onHover={onHover}
      />,
    );

    fireEvent.click(screen.getByTestId("point-option-disabled"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps hover synchronization callbacks", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();

    render(
      <ClientQuoteComparisonChart
        options={[makeClientQuoteOption({ key: "option-hover" })]}
        selectedKey={null}
        hoveredKey={null}
        onSelect={onSelect}
        onHover={onHover}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("point-option-hover"));
    expect(onHover).toHaveBeenCalledWith("option-hover");

    fireEvent.mouseLeave(screen.getByTestId("point-option-hover"));
    expect(onHover).toHaveBeenLastCalledWith(null);
  });
});
