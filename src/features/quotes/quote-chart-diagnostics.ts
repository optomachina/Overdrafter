import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type {
  QuoteDataStatus,
  QuoteDiagnostics,
  VendorQuoteAggregate,
} from "@/features/quotes/types";

const QUOTE_CHART_DEBUG_STORAGE_KEY = "overdrafter.quoteChartDebug";

function isQuoteChartDebugEnabled(): boolean {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    return true;
  }

  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(QUOTE_CHART_DEBUG_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function logQuoteFetchDiagnostics(input: {
  partId: string | null;
  organizationId: string | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  rawQuoteRows: VendorQuoteAggregate[];
  diagnostics: QuoteDiagnostics;
}): void {
  if (!isQuoteChartDebugEnabled()) {
    return;
  }

  console.groupCollapsed("[quote-chart] fetch");
  console.log({
    partId: input.partId,
    organizationId: input.organizationId,
    quoteDataStatus: input.quoteDataStatus,
    quoteDataMessage: input.quoteDataMessage,
    rawQuoteRows: input.rawQuoteRows,
    rawQuoteRowCount: input.diagnostics.rawQuoteRowCount,
    rawOfferCount: input.diagnostics.rawOfferCount,
    plottableOfferCount: input.diagnostics.plottableOfferCount,
    excludedOfferCount: input.diagnostics.excludedOfferCount,
    excludedOffers: input.diagnostics.excludedOffers,
    excludedReasonCounts: input.diagnostics.excludedReasonCounts,
  });
  console.groupEnd();
}

export function logQuoteChartPointDiagnostics(input: {
  partId: string | null;
  organizationId: string | null;
  points: Array<Record<string, unknown>>;
  options: readonly ClientQuoteSelectionOption[];
}): void {
  if (!isQuoteChartDebugEnabled()) {
    return;
  }

  console.groupCollapsed("[quote-chart] render");
  console.log({
    partId: input.partId,
    organizationId: input.organizationId,
    pointCount: input.points.length,
    points: input.points,
    optionCount: input.options.length,
  });
  console.groupEnd();
}
