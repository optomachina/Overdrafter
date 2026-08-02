import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteIntelligenceLanding } from "./QuoteIntelligenceLanding";

describe("QuoteIntelligenceLanding", () => {
  it("states the launch scope and labels illustrative quote data honestly", () => {
    render(
      <QuoteIntelligenceLanding
        onUpload={vi.fn()}
        onSignIn={vi.fn()}
        onCreateAccount={vi.fn()}
      />,
    );

    expect(screen.getByText("Machined aluminum sourcing")).toBeInTheDocument();
    expect(screen.getByText(/free gives you ranked potential providers and official RFQ links/i)).toBeInTheDocument();
    expect(screen.getByText(/pro automatically collects supported vendor quotes for \$49\/month/i)).toBeInTheDocument();
    expect(screen.getByText(/recommendations come from reviewed capability data/i)).toBeInTheDocument();
    expect(screen.getByText("Illustrative Pro workspace · sample data")).toBeInTheDocument();
    expect(screen.getByText("Sample prices and lead times — not live quotes")).toBeInTheDocument();
    expect(screen.queryByText("Three exact responses")).not.toBeInTheDocument();
  });
});
