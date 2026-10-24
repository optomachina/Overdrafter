import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequestSummaryBadges } from "./RequestSummaryBadges";

describe("RequestSummaryBadges", () => {
  it("shows quote fields for quote-compatible service selections", () => {
    render(
      <RequestSummaryBadges
        requestedServiceKinds={["manufacturing_quote"]}
        quantity={12}
        requestedQuoteQuantities={[12, 24]}
        requestedByDate="2026-04-15"
      />,
    );

    expect(screen.getByText("Manufacturing quote")).toBeInTheDocument();
    expect(screen.getByText("Qty 12")).toBeInTheDocument();
    expect(screen.getByText("Quote qty 12 / 24")).toBeInTheDocument();
    expect(screen.getByText("Need by Apr 15, 2026")).toBeInTheDocument();
    for (const label of ["Manufacturing quote", "Qty 12", "Quote qty 12 / 24", "Need by Apr 15, 2026"]) {
      expect(screen.getByText(label)).toHaveClass("border-border", "bg-accent", "text-foreground");
      expect(screen.getByText(label).className).not.toMatch(/(?:emerald|amber|sky|rose)-/);
    }
  });

  it("hides quote fields for mixed-service selections", () => {
    render(
      <RequestSummaryBadges
        requestedServiceKinds={["manufacturing_quote", "dfm_review"]}
        quantity={12}
        requestedQuoteQuantities={[12, 24]}
        requestedByDate="2026-04-15"
      />,
    );

    expect(screen.getByText("Manufacturing quote")).toBeInTheDocument();
    expect(screen.getByText("DFM review")).toBeInTheDocument();
    expect(screen.queryByText("Qty 12")).not.toBeInTheDocument();
    expect(screen.queryByText("Quote qty 12 / 24")).not.toBeInTheDocument();
    expect(screen.queryByText("Need by Apr 15, 2026")).not.toBeInTheDocument();
  });
});
