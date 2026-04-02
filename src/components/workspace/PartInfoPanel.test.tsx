import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartInfoPanel } from "./PartInfoPanel";

vi.mock("@/components/quotes/ClientPartRequestEditor", () => ({
  ClientPartRequestEditor: () => <div>Request editor</div>,
}));

function renderPartInfoPanel(overrides: Partial<ComponentProps<typeof PartInfoPanel>> = {}) {
  render(
    <PartInfoPanel
      part={null}
      summary={null}
      extraction={null}
      effectiveRequestDraft={null}
      quoteQuantityInput=""
      onQuoteQuantityInputChange={vi.fn()}
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onUploadRevision={vi.fn()}
      {...overrides}
    />,
  );
}

function expectRowValue(label: string, value: string) {
  const labelCell = screen.getByText(label);
  expect(labelCell.nextElementSibling).toHaveTextContent(value);
}

describe("PartInfoPanel", () => {
  it("prefers the trimmed draft part number over the fallback prop", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        partNumber: "  DRFT-200  ",
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
      partNumber: "PROP-100",
      description: "Bracket",
    });

    expectRowValue("Part Number", "DRFT-200");
    expectRowValue("Description", "Bracket");
  });

  it("uses the fallback part number prop when no draft part number is present", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
      partNumber: "  PROP-100  ",
      description: "Support bracket",
    });

    expectRowValue("Part Number", "PROP-100");
    expectRowValue("Description", "Support bracket");
  });

  it("collapses blank part metadata values to an em dash", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        partNumber: "   ",
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
      partNumber: "   ",
      description: "   ",
    });

    expectRowValue("Part Number", "—");
    expectRowValue("Description", "—");
  });

  it("shows the draft thread override before extraction-derived thread callouts", () => {
    renderPartInfoPanel({
      extraction: {
        material: { normalized: null, raw: null },
        finish: { normalized: null, raw: null },
        tightestTolerance: { valueInch: null },
        threads: ["M6x1"],
      } as ComponentProps<typeof PartInfoPanel>["extraction"],
      effectiveRequestDraft: {
        partNumber: "BRKT-1",
        threads: "1/4-20 UNC-2B",
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
    });

    expectRowValue("Thread", "1/4-20 UNC-2B");
  });

  it("falls back to the base quantity when the selected services are not quote-compatible", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        requestedServiceKinds: ["manufacturing_quote", "dfm_review"],
        requestedQuoteQuantities: [10, 25],
        quantity: 4,
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
    });

    expectRowValue("Quantity", "4");
  });
});
