import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import type { MouseEvent, PropsWithChildren, ReactElement, ReactNode, SVGProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClientQuoteComparisonChart } from "./ClientQuoteComparisonChart";
import { makeClientQuoteOption } from "./test-option-factory";
import { getVendorColor } from "@/features/quotes/vendor-colors";

type ShapeProps = {
  readonly cx: number;
  readonly cy: number;
  readonly payload: unknown;
};
type ShapeRenderer =
  | ReactNode
  | ((props: ShapeProps) => ReactElement<SVGProps<SVGCircleElement>> | null);

function resolveShapeElement(shape: ShapeRenderer | undefined, shapeProps: ShapeProps) {
  if (!shape) {
    return null;
  }

  let element: ReactElement<SVGProps<SVGCircleElement>> | null = null;
  if (typeof shape === "function") {
    element = shape(shapeProps);
  } else if (isValidElement(shape)) {
    element = cloneElement(shape, shapeProps);
  }

  if (!element) {
    return null;
  }

  return typeof element.type === "function"
    ? (element.type as (props: SVGProps<SVGCircleElement>) => ReactElement | null)(element.props)
    : element;
}

function renderPointButton(
  point: unknown,
  index: number,
  renderedElement: ReactElement<SVGProps<SVGCircleElement>>,
  onMouseEnter?: (point: { payload: unknown }) => void,
  onMouseLeave?: () => void,
) {
  const pointKey = (point as { key?: string }).key ?? `point-${index}`;

  return (
    <button
      key={pointKey}
      type="button"
      data-testid={`point-${pointKey}`}
      onClick={() => {
        renderedElement.props.onClick?.({} as MouseEvent<SVGCircleElement>);
      }}
      onMouseEnter={() => {
        renderedElement.props.onMouseEnter?.({} as MouseEvent<SVGCircleElement>);
        onMouseEnter?.({ payload: point });
      }}
      onMouseLeave={() => {
        renderedElement.props.onMouseLeave?.({} as MouseEvent<SVGCircleElement>);
        onMouseLeave?.();
      }}
    >
      <svg>{renderedElement}</svg>
    </button>
  );
}

function MockCartesianGrid() {
  return null;
}

function MockLabel() {
  return null;
}

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
  }: Readonly<{
    data?: readonly unknown[];
    shape?: ShapeRenderer;
    onMouseEnter?: (point: { payload: unknown }) => void;
    onMouseLeave?: () => void;
    name?: string;
  }>) {
    return (
      <div data-testid={`scatter-${name ?? "vendor"}`}>
        {(data ?? []).map((point, index) => {
          const shapeProps = {
            cx: 20 + index * 16,
            cy: 20 + index * 12,
            payload: point,
          };
          const renderedElement = resolveShapeElement(shape, shapeProps);

          if (!renderedElement) {
            return null;
          }

          return renderPointButton(point, index, renderedElement, onMouseEnter, onMouseLeave);
        })}
      </div>
    );
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
    CartesianGrid: MockCartesianGrid,
    Label: MockLabel,
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

  it("renders vendor-colored bubbles with an explicit fill style for dark backgrounds", () => {
    const option = makeClientQuoteOption({
      key: "option-color",
      vendorKey: "xometry",
      vendorLabel: "Xometry",
      supplier: "Xometry",
    });

    render(
      <ClientQuoteComparisonChart
        options={[option]}
        selectedKey={null}
        hoveredKey={null}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    const bubble = screen.getByTestId("point-option-color").querySelector("circle");

    expect(bubble).not.toBeNull();
    expect(bubble).toHaveAttribute("fill", getVendorColor("xometry"));
    expect(bubble).toHaveStyle({ fill: getVendorColor("xometry") });
  });

  it("plots zero-day quotes on the lead-time axis instead of the N/A lane", () => {
    render(
      <ClientQuoteComparisonChart
        options={[
          makeClientQuoteOption({
            key: "option-zero-day",
            leadTimeBusinessDays: 0,
          }),
        ]}
        selectedKey={null}
        hoveredKey={null}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    const bubble = screen.getByTestId("point-option-zero-day").querySelector("circle");

    expect(bubble).not.toBeNull();
    expect(bubble).toHaveAttribute("cx", "20");
  });
});
