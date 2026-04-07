import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PartProductDataBar } from "./PartProductDataBar";

function renderBar(overrides: Partial<ComponentProps<typeof PartProductDataBar>> = {}) {
  render(
    <PartProductDataBar
      part={null}
      summary={null}
      extraction={null}
      draft={null}
      {...overrides}
    />,
  );
}

describe("PartProductDataBar", () => {
  it("shows em dashes when no data is available", () => {
    renderBar();

    expect(screen.getByText("Material").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByText("Finish").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByText("Tolerance").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByText("Quantity").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByText("Thread").nextElementSibling).toHaveTextContent("—");
  });

  it("prefers draft values over extraction data", () => {
    renderBar({
      draft: {
        material: "Titanium",
        finish: "Electropolish",
        tightestToleranceInch: 0.001,
        quantity: 5,
        threads: "M4x0.7",
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartProductDataBar>["draft"],
      extraction: {
        material: { normalized: "Steel", raw: "Steel" },
        finish: { normalized: "Anodize", raw: "Anodize" },
        tightestTolerance: { valueInch: 0.005 },
        threads: ["M6x1"],
      } as ComponentProps<typeof PartProductDataBar>["extraction"],
    });

    expect(screen.getByText("Material").nextElementSibling).toHaveTextContent("Titanium");
    expect(screen.getByText("Finish").nextElementSibling).toHaveTextContent("Electropolish");
    expect(screen.getByText("Tolerance").nextElementSibling).toHaveTextContent("±0.0010 in");
    expect(screen.getByText("Thread").nextElementSibling).toHaveTextContent("M4x0.7");
  });

  it("falls back to extraction material when draft has no material", () => {
    renderBar({
      draft: { requestedQuoteQuantities: [] } as ComponentProps<typeof PartProductDataBar>["draft"],
      extraction: {
        material: { normalized: "Aluminum 6061", raw: null },
        finish: { normalized: null, raw: null },
        tightestTolerance: { valueInch: null },
        threads: null,
      } as ComponentProps<typeof PartProductDataBar>["extraction"],
    });

    expect(screen.getByText("Material").nextElementSibling).toHaveTextContent("Aluminum 6061");
  });

  it("shows quantity from summary when no draft quantity is present", () => {
    renderBar({
      summary: {
        jobId: "job-1",
        partNumber: "BRKT-001",
        revision: "A",
        description: "Bracket",
        quantity: 25,
        importedBatch: null,
        requestedQuoteQuantities: [],
        requestedByDate: null,
        selectedSupplier: null,
        selectedPriceUsd: null,
        selectedLeadTimeBusinessDays: null,
        requestedServiceKinds: [],
        primaryServiceKind: null,
        serviceNotes: null,
      },
    });

    expect(screen.getByText("Quantity").nextElementSibling).toHaveTextContent("25");
  });
});
