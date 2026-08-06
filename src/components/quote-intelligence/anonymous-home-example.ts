import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";

type ExampleQuoteInput = {
  key: string;
  vendorKey: ClientQuoteSelectionOption["vendorKey"];
  supplier: string;
  totalPriceUsd: number;
  leadTimeBusinessDays: number;
  tier: string;
  sourcing: string;
};

export const anonymousHomeExamplePart = {
  partNumber: "FLT-BRACKET-01",
  revision: "Rev C",
  requestedQuantity: 25,
  material: "6061-T6 Aluminum",
  finish: "Clear Anodize Type II",
  tolerance: "±0.005 in",
  cadFilename: "FLT-BRACKET-01.step",
  drawingFilename: "FLT-BRACKET-01.pdf",
} as const;

export const anonymousHomeDefaultQuoteKey = "mesa-balanced";

function createExampleQuote(input: ExampleQuoteInput): ClientQuoteSelectionOption {
  return {
    key: input.key,
    offerId: input.key,
    persistedOfferId: input.key,
    vendorKey: input.vendorKey,
    vendorQuoteResultId: `${input.key}-result`,
    vendorLabel: input.supplier,
    supplier: input.supplier,
    requestedQuantity: anonymousHomeExamplePart.requestedQuantity,
    unitPriceUsd: input.totalPriceUsd / anonymousHomeExamplePart.requestedQuantity,
    totalPriceUsd: input.totalPriceUsd,
    leadTimeBusinessDays: input.leadTimeBusinessDays,
    resolvedDeliveryDate: null,
    domesticStatus: "unknown",
    excluded: false,
    dueDateEligible: true,
    eligible: true,
    isSelectable: true,
    expedite: input.leadTimeBusinessDays <= 7,
    shipReceiveBy: null,
    dueDate: null,
    quoteDateIso: null,
    sourcing: input.sourcing,
    tier: input.tier,
    laneLabel: null,
    process: "CNC milling",
    material: anonymousHomeExamplePart.material,
    finish: anonymousHomeExamplePart.finish,
    tightestTolerance: anonymousHomeExamplePart.tolerance,
    notes: null,
    rawPayload: null,
  };
}

export const anonymousHomeExampleQuotes = [
  createExampleQuote({
    key: "northline-value",
    vendorKey: "rapiddirect",
    supplier: "Northline Manufacturing",
    totalPriceUsd: 445,
    leadTimeBusinessDays: 16,
    tier: "Economy",
    sourcing: "Lowest price",
  }),
  createExampleQuote({
    key: "apex-standard",
    vendorKey: "xometry",
    supplier: "Apex CNC",
    totalPriceUsd: 487,
    leadTimeBusinessDays: 12,
    tier: "Standard",
    sourcing: "Strong value",
  }),
  createExampleQuote({
    key: anonymousHomeDefaultQuoteKey,
    vendorKey: "fictiv",
    supplier: "Mesa Precision",
    totalPriceUsd: 525,
    leadTimeBusinessDays: 9,
    tier: "Standard",
    sourcing: "Best fit",
  }),
  createExampleQuote({
    key: "forgeworks-standard",
    vendorKey: "geomiq",
    supplier: "ForgeWorks",
    totalPriceUsd: 558,
    leadTimeBusinessDays: 11,
    tier: "Standard",
    sourcing: "Comparable",
  }),
  createExampleQuote({
    key: "axis-priority",
    vendorKey: "quickparts",
    supplier: "Axis Manufacturing",
    totalPriceUsd: 610,
    leadTimeBusinessDays: 7,
    tier: "Priority",
    sourcing: "Fast turnaround",
  }),
  createExampleQuote({
    key: "summit-rush",
    vendorKey: "protolabs",
    supplier: "Summit Prototype",
    totalPriceUsd: 690,
    leadTimeBusinessDays: 5,
    tier: "Expedited",
    sourcing: "Fastest",
  }),
] as const;

const resolvedDefaultQuote = anonymousHomeExampleQuotes.find(
  (quote) => quote.key === anonymousHomeDefaultQuoteKey,
);

if (!resolvedDefaultQuote) {
  throw new Error("Anonymous homepage example is missing its default quote.");
}

export const anonymousHomeDefaultQuote = resolvedDefaultQuote;
export const anonymousHomeLowestPriceQuote = anonymousHomeExampleQuotes.reduce((lowest, quote) =>
  quote.totalPriceUsd < lowest.totalPriceUsd ? quote : lowest,
);
export const anonymousHomeFastestQuote = anonymousHomeExampleQuotes.reduce((fastest, quote) =>
  quote.leadTimeBusinessDays < fastest.leadTimeBusinessDays ? quote : fastest,
);
