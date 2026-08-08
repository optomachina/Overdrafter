import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FixturePanel } from "./FixturePanel";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPanel(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FixturePanel />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("FixturePanel", () => {
  it("closes fixture controls and removes only the fixture query on Exit", () => {
    renderPanel("/parts/fx-job?fixture=client-quoted&debug=1");

    expect(screen.getByRole("region", { name: "Fixture controls" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exit" }));

    expect(screen.queryByRole("region", { name: "Fixture controls" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/parts/fx-job?debug=1");
  });

  it("renders as an in-flow section rather than a floating overlay", () => {
    const { container } = renderPanel("/parts/fx-job?fixture=client-quoted");

    const panel = container.querySelector("[data-fixture-panel]");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveClass("shrink-0", "border-b");
    expect(panel).not.toHaveClass("fixed", "rounded-3xl", "shadow-2xl");
  });

  it("preserves debug mode when switching scenarios", () => {
    renderPanel("/parts/fx-job?fixture=client-quoted&debug=1");

    fireEvent.change(screen.getByRole("combobox", { name: "Fixture scenario" }), {
      target: { value: "client-needs-attention" },
    });

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/parts/fx-job-needs-attention?fixture=client-needs-attention&debug=1",
    );
  });
});
