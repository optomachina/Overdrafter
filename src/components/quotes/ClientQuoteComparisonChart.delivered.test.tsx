import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildDeliveredComparisonModel } from "@/features/quotes/delivered-comparison";
import { getVendorColor } from "@/features/quotes/vendor-colors";
import { ClientQuoteComparisonChart } from "./ClientQuoteComparisonChart";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...rest }: PropsWithChildren<Record<string, unknown>>) => (
    <div role={rest.role as string} aria-label={rest["aria-label"] as string}>{children}</div>
  ),
  ChartTooltip: () => null,
}));

vi.mock("@/features/quotes/quote-chart-diagnostics", () => ({
  logQuoteChartPointDiagnostics: vi.fn(),
}));

vi.mock("recharts", () => {
  const Pass = ({ children }: PropsWithChildren) => <div>{children}</div>;
  const Label = ({ value }: { value?: string }) => (value ? <span>{value}</span> : null);
  function Scatter({ data, name, onClick }: { data?: readonly Record<string, unknown>[]; name?: string; onClick?: (point: { payload: unknown }) => void }) {
    return (
      <div data-testid={`scatter-${name}`}>
        {(data ?? []).map((point) => (
          <button
            key={String(point.key)}
            type="button"
            data-testid={`point-${String(point.key)}`}
            data-x={String(point.x)}
            data-y={String(point.y)}
            data-fill={String(point.fill)}
            data-hollow={String(point.hollow)}
            data-opacity={String(point.opacity)}
            onClick={() => onClick?.({ payload: point })}
          />
        ))}
      </div>
    );
  }
  return {
    CartesianGrid: () => null,
    Label,
    ReferenceArea: Pass,
    Scatter,
    ScatterChart: Pass,
    XAxis: Pass,
    YAxis: Pass,
    ZAxis: () => null,
  };
});

// jsdom lacks PointerEvent; a MouseEvent subclass carries clientX and pointer identity.
if (typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

const NOW = new Date("2026-10-12T15:00:00.000Z");

function model() {
  return buildDeliveredComparisonModel(
    [
      makeClientQuoteOption({ key: "x-exact", vendorKey: "xometry", shipReceiveBy: "2026-10-20", leadTimeBusinessDays: null }),
      makeClientQuoteOption({ key: "x-late", vendorKey: "xometry", shipReceiveBy: "2026-10-30", leadTimeBusinessDays: null }),
      makeClientQuoteOption({ key: "p-overlap", vendorKey: "protolabs", shipReceiveBy: "2026-10-20", leadTimeBusinessDays: null }),
      makeClientQuoteOption({ key: "p-ships", vendorKey: "protolabs", leadTimeBusinessDays: 3, shipReceiveBy: null }),
      makeClientQuoteOption({ key: "unknown", vendorKey: "fictiv", leadTimeBusinessDays: null, shipReceiveBy: null }),
    ],
    { now: NOW, timeZone: "UTC" },
  );
}

function renderChart(overrides: Partial<Parameters<typeof ClientQuoteComparisonChart>[0]> = {}) {
  const built = model();
  const onDeadlineChange = vi.fn();
  const onSelect = vi.fn();
  const element = (props: Partial<Parameters<typeof ClientQuoteComparisonChart>[0]>) => (
    <ClientQuoteComparisonChart
      options={built.rows.map((row) => row.option)}
      axes="delivered"
      deliveredRows={built.rows}
      orderLocalDate={built.orderLocalDate}
      deadline="2026-10-22"
      onDeadlineChange={onDeadlineChange}
      selectedKey={null}
      hoveredKey={null}
      diagnosticsEnabled={false}
      onSelect={onSelect}
      onHover={vi.fn()}
      {...overrides}
      {...props}
    />
  );
  const view = render(element({}));
  return { onDeadlineChange, onSelect, rerender: (props: Partial<Parameters<typeof ClientQuoteComparisonChart>[0]>) => view.rerender(element(props)) };
}

describe("ClientQuoteComparisonChart delivered axes (OVD-571)", () => {
  it("labels the axes as delivered date and expected OTD", () => {
    renderChart();
    expect(screen.getByText("Delivered date")).toBeInTheDocument();
    expect(screen.getByText("Expected OTD (out-the-door)")).toBeInTheDocument();
    expect(screen.queryByText("Lead not quoted")).not.toBeInTheDocument();
  });

  it("plots every known option, including overlaps, and never plots an unknown arrival", () => {
    renderChart();
    expect(screen.getByTestId("point-x-exact").dataset.x).toBe(screen.getByTestId("point-p-overlap").dataset.x);
    expect(screen.getByTestId("point-x-exact").dataset.y).toBe(screen.getByTestId("point-p-overlap").dataset.y);
    expect(screen.getByTestId("point-x-late")).toBeInTheDocument();
    expect(screen.getByTestId("point-p-ships")).toBeInTheDocument();
    expect(screen.queryByTestId("point-unknown")).not.toBeInTheDocument();
    for (const point of screen.getAllByTestId(/^point-/)) {
      expect(Number(point.dataset.x)).toBeGreaterThan(0);
    }
  });

  it("uses one color per provider and marks lower-bound values hollow", () => {
    renderChart({ selectedKey: "x-exact" });
    expect(screen.getByTestId("point-x-exact").dataset.fill).toBe(getVendorColor("xometry"));
    expect(screen.getByTestId("point-x-late").dataset.fill).toBe(getVendorColor("xometry"));
    expect(screen.getByTestId("point-p-overlap").dataset.fill).toBe(getVendorColor("protolabs"));
    expect(screen.getByTestId("point-p-ships").dataset.fill).toBe(getVendorColor("protolabs"));
    // OTD is partial (shipping, tax and fees unknown), so every current point is a lower bound.
    expect(screen.getByTestId("point-p-ships").dataset.hollow).toBe("true");
  });

  it("de-emphasizes options that miss the deadline without removing them", () => {
    renderChart();
    expect(Number(screen.getByTestId("point-x-late").dataset.opacity)).toBeLessThan(
      Number(screen.getByTestId("point-x-exact").dataset.opacity),
    );
  });

  it("exposes the deadline line as a keyboard slider that shows the date", () => {
    const { onDeadlineChange } = renderChart();
    const slider = screen.getByRole("slider", { name: "Deadline" });
    expect(slider).toHaveAttribute("aria-valuetext", "Thu, Oct 22, 2026");
    expect(slider).toHaveTextContent("Oct 22");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onDeadlineChange).toHaveBeenLastCalledWith("2026-10-23");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onDeadlineChange).toHaveBeenLastCalledWith("2026-10-21");
    fireEvent.keyDown(slider, { key: "PageUp" });
    expect(onDeadlineChange).toHaveBeenLastCalledWith("2026-10-29");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onDeadlineChange).toHaveBeenLastCalledWith("2026-10-12");
  });

  it("keeps the date axis fixed when the deadline moves to its end", () => {
    const { onDeadlineChange, rerender } = renderChart();
    const slider = screen.getByRole("slider", { name: "Deadline" });
    const max = slider.getAttribute("data-domain-max");
    fireEvent.keyDown(slider, { key: "End" });
    const atEnd = onDeadlineChange.mock.calls.at(-1)?.[0] as string;
    rerender({ deadline: atEnd });
    expect(screen.getByRole("slider", { name: "Deadline" }).getAttribute("data-domain-max")).toBe(max);
    onDeadlineChange.mockClear();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Deadline" }), { key: "End" });
    expect(onDeadlineChange).not.toHaveBeenCalled();
  });

  it("moves the deadline by pointer drag (mouse or touch) along the date axis", () => {
    const { onDeadlineChange } = renderChart();
    const slider = screen.getByRole("slider", { name: "Deadline" });
    const track = screen.getByTestId("deadline-track");
    track.getBoundingClientRect = () => ({ left: 100, width: 400, right: 500, top: 0, bottom: 300, height: 300, x: 100, y: 0, toJSON: () => ({}) });
    const min = Number(slider.getAttribute("data-domain-min"));
    const max = Number(slider.getAttribute("data-domain-max"));
    fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerMove(slider, { clientX: 500, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(slider, { clientX: 500, pointerId: 1, pointerType: "touch" });
    const calls = onDeadlineChange.mock.calls.map(([value]) => value as string);
    const toDay = (value: string) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
    expect(toDay(calls[calls.length - 1])).toBe(max);
    expect(calls.every((value) => toDay(value) >= min)).toBe(true);
    expect(slider.style.touchAction).toBe("none");
  });
});
