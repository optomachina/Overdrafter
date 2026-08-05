import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RequestServiceIntentFields } from "./RequestServiceIntentFields";

const value = {
  requestedServiceKinds: ["manufacturing_quote"],
  primaryServiceKind: "manufacturing_quote",
  serviceNotes: null,
};

describe("RequestServiceIntentFields", () => {
  it("keeps client service cards in one column inside the fixed-width right rail", () => {
    render(<RequestServiceIntentFields value={value} onChange={vi.fn()} />);

    const serviceCard = screen.getByText("Manufacturing quote", { selector: "div" }).closest("label");
    expect(serviceCard?.parentElement).toHaveClass("grid-cols-1");
    expect(serviceCard?.parentElement).not.toHaveClass("md:grid-cols-2");
    expect(serviceCard).toHaveClass("min-w-0");
  });

  it("preserves the wider two-column layout for internal review surfaces", () => {
    render(<RequestServiceIntentFields value={value} onChange={vi.fn()} tone="internal" />);

    const serviceCard = screen.getByText("Manufacturing quote", { selector: "div" }).closest("label");
    expect(serviceCard?.parentElement).toHaveClass("md:grid-cols-2");
  });
});
