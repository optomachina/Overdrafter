import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: () => <div>Quote Chart</div>,
}));

function makeOption(overrides: Partial<ClientQuoteSelectionOption> = {}): ClientQuoteSelectionOption {
  return {
    key: "option-1",
    offerId: "offer-1",
    persistedOfferId: "offer-1",
    vendorKey: "xometry",
    vendorQuoteResultId: "result-1",
    vendorLabel: "Xometry",
    supplier: "Xometry USA",
    requestedQuantity: 10,
    unitPriceUsd: 12,
    totalPriceUsd: 120,
    leadTimeBusinessDays: 7,
    resolvedDeliveryDate: "2026-04-10",
    domesticStatus: "domestic",
    excluded: false,
    dueDateEligible: true,
    eligible: true,
    isSelectable: true,
    expedite: false,
    shipReceiveBy: null,
    dueDate: null,
    quoteDateIso: "2026-03-20",
    sourcing: null,
    tier: "Standard",
    laneLabel: "Balanced",
    process: "CNC mill",
    material: "6061-T6",
    finish: "As machined",
    tightestTolerance: null,
    notes: null,
    rawPayload: null,
    ...overrides,
  };
}

describe("ClientQuoteDecisionPanel", () => {
  it("renders quote data and selects a clicked option", () => {
    const onSelect = vi.fn();
    const first = makeOption();
    const second = makeOption({
      key: "option-2",
      offerId: "offer-2",
      persistedOfferId: "offer-2",
      vendorQuoteResultId: "result-2",
      vendorLabel: "Proto Labs",
      supplier: "Proto Labs",
      totalPriceUsd: 160,
      requestedQuantity: 25,
    });

    render(
      <ClientQuoteDecisionPanel
        options={[first, second]}
        selectedOption={first}
        onSelect={onSelect}
        requestedByDate="2026-04-15"
        activePreset="cheapest"
        onPresetSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Quote Chart")).toBeInTheDocument();
    expect(screen.getByText("Current selection")).toBeInTheDocument();
    expect(screen.getByText("Proto Labs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Proto Labs"));

    expect(onSelect).toHaveBeenCalledWith(second);
  });

  it("renders a stable empty state when quote data is absent", () => {
    render(
      <ClientQuoteDecisionPanel
        options={[]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        emptyState="No quote options are available for this part yet."
      />,
    );

    expect(screen.getByText("No quote options are available for this part yet.")).toBeInTheDocument();
    expect(screen.queryByText("Quote Chart")).not.toBeInTheDocument();
  });
});
