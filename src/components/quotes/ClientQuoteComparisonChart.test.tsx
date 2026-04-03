import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClientQuoteComparisonChart } from "./ClientQuoteComparisonChart";
import { makeClientQuoteOption } from "./test-option-factory";

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
    onClick,
    onMouseEnter,
    onMouseLeave,
    name,
  }: Readonly<{
    data?: readonly unknown[];
    onClick?: (point: { payload: unknown }) => void;
    onMouseEnter?: (point: { payload: unknown }) => void;
    onMouseLeave?: () => void;
    name?: string;
  }>) {
    return (
      <div data-testid={`scatter-${name ?? "vendor"}`}>
        {(data ?? []).map((point, index) => {
          const pointData = point as {
            key?: string;
            size?: number;
            fill?: string;
            stroke?: string;
            strokeWidth?: number;
          };
          const pointKey = pointData.key ?? `point-${index}`;

          return (
            <button
              key={pointKey}
              type="button"
              data-testid={`point-${pointKey}`}
              data-size={String(pointData.size ?? "")}
              data-fill={pointData.fill ?? ""}
              data-stroke={pointData.stroke ?? ""}
              data-stroke-width={String(pointData.strokeWidth ?? "")}
              onClick={() => onClick?.({ payload: point })}
              onMouseEnter={() => onMouseEnter?.({ payload: point })}
              onMouseLeave={() => onMouseLeave?.()}
            />
          );
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

  function ZAxis() {
    return null;
  }

  return {
    CartesianGrid: MockCartesianGrid,
    Label: MockLabel,
    ReferenceArea,
    Scatter,
    ScatterChart,
    XAxis,
    YAxis,
    ZAxis,
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

  it("derives visible bubble sizing and styling from point data", () => {
    render(
      <ClientQuoteComparisonChart
        options={[
          makeClientQuoteOption({
            key: "option-selected",
            totalPriceUsd: 38,
            vendorKey: "devzmanufacturing",
            vendorLabel: "DEVZ Manufacturing",
            supplier: "DEVZ Manufacturing",
          }),
          makeClientQuoteOption({
            key: "option-large",
            totalPriceUsd: 448,
            vendorKey: "infraredlaboratories",
            vendorLabel: "Infrared Laboratories",
            supplier: "Infrared Laboratories",
          }),
        ]}
        selectedKey="option-selected"
        hoveredKey={null}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    expect(Number(screen.getByTestId("point-option-selected").dataset.size)).toBeGreaterThan(0);
    expect(Number(screen.getByTestId("point-option-large").dataset.size)).toBeGreaterThan(
      Number(screen.getByTestId("point-option-selected").dataset.size),
    );
    expect(screen.getByTestId("point-option-selected")).toHaveAttribute("data-stroke", "#ffffff");
    expect(screen.getByTestId("point-option-large")).toHaveAttribute("data-fill", "#4db3a2");
  });
});
