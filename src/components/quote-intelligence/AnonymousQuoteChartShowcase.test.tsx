import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnonymousQuoteChartShowcase } from "./AnonymousQuoteChartShowcase";

const chartState = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: () => {
    if (chartState.shouldThrow) {
      throw new Error("chart chunk unavailable");
    }
    return <div data-testid="example-scatter-chart" />;
  },
}));

describe("AnonymousQuoteChartShowcase", () => {
  beforeEach(() => {
    chartState.shouldThrow = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("demonstrates the balanced selection and lets visitors inspect other examples", async () => {
    const onGetStarted = vi.fn();
    render(<AnonymousQuoteChartShowcase onGetStarted={onGetStarted} />);

    expect(screen.getByRole("heading", { name: "Multiple quotes. One obvious tradeoff." })).toBeInTheDocument();
    expect(screen.getByText("Illustrative beta comparison · sample data")).toBeInTheDocument();
    expect(screen.getByText("Sample prices · not live quotes")).toBeInTheDocument();
    expect(screen.getByText("$165.00 less than the fastest example")).toBeInTheDocument();
    expect(screen.getByText("7 days faster than the lowest example")).toBeInTheDocument();
    expect(await screen.findByTestId("example-scatter-chart")).toBeInTheDocument();

    const summit = screen.getByRole("button", { name: "Select Summit Prototype example" });
    fireEvent.mouseEnter(summit);
    expect(screen.getByText("Previewing example")).toBeInTheDocument();
    expect(screen.getAllByText("$690.00").length).toBeGreaterThan(0);

    fireEvent.click(summit);
    fireEvent.mouseLeave(summit);
    expect(screen.getByText("Selected example")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Summit Prototype" })).toBeInTheDocument();
    expect(screen.getByText("5 working days")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compare your quotes" }));
    expect(onGetStarted).toHaveBeenCalledOnce();
  });

  it("keeps the landing call to action usable when the interactive chart fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    chartState.shouldThrow = true;
    const onGetStarted = vi.fn();

    render(<AnonymousQuoteChartShowcase onGetStarted={onGetStarted} />);

    expect(
      await screen.findByText(/interactive chart is temporarily unavailable/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare your quotes" }));
    expect(onGetStarted).toHaveBeenCalledOnce();
  });
});
