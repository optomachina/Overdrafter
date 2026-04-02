import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";

export function makeClientQuoteOption(
  overrides: Partial<ClientQuoteSelectionOption> = {},
): ClientQuoteSelectionOption {
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
