import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteIntelligenceLanding } from "./QuoteIntelligenceLanding";

describe("QuoteIntelligenceLanding", () => {
  it("renders a focused single-hero landing page", () => {
    render(
      <QuoteIntelligenceLanding
        onUpload={vi.fn()}
        onSignIn={vi.fn()}
        onCreateAccount={vi.fn()}
      />,
    );

    expect(screen.getByText("Machined aluminum sourcing")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CAD In Parts Out" })).toBeInTheDocument();
    expect(screen.getByText("Parts Out")).toHaveClass("text-paper-muted");
    expect(
      screen.getByText(/upload CAD files and drawings to collect vendor quotes, compare price and lead time/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/choose the best source for your budget and deadline/i)).toBeInTheDocument();
    expect(screen.queryByText(/recommendations come from reviewed capability data/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Illustrative Pro workspace · sample data")).not.toBeInTheDocument();
    expect(screen.queryByText("Example returned offers")).not.toBeInTheDocument();
    expect(screen.queryByText("Three exact responses")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /include the PDF drawing to extract material, finish, tolerances, and threads/i,
      ),
    ).toBeInTheDocument();
    const quoteChart = screen.getByRole("img", { name: /vendor quotes plotted by total price and lead time/i });
    expect(quoteChart).toBeInTheDocument();
    expect(quoteChart).toHaveAccessibleDescription(
      /Apex CNC is recommended at \$1,842 with an 11-day lead time.*Mesa Precision is \$2,240.*Orbit Manufacturing is \$1,990.*Northline is \$1,695/i,
    );
    expect(screen.getByText("Quote comparison")).toBeInTheDocument();
    expect(screen.getByText("14 DAY TARGET")).toBeInTheDocument();
    expect(screen.getByText("Apex CNC")).toBeInTheDocument();
    expect(screen.queryByText(/example quote comparison/i)).not.toBeInTheDocument();
    expect(screen.getByText("© 2026 OverDrafter")).toBeInTheDocument();
  });
});
