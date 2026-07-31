type ClientWorkspacePollingItem = {
  part?: {
    clientExtraction?: {
      lifecycle?: string | null;
    } | null;
  } | null;
  latestQuoteRequest?: {
    status?: string | null;
    request_mode?: string | null;
    updated_at?: string | null;
  } | null;
  quoteDiagnostics?: {
    rawOfferCount?: number;
  } | null;
};

const ACTIVE_EXTRACTION_LIFECYCLES = new Set([
  "queued",
  "extracting",
  "uploaded",
]);
const ACTIVE_QUOTE_REQUEST_STATUSES = new Set(["queued", "requesting"]);
const RECEIVED_WITHOUT_OFFER_GRACE_MS = 60_000;

/**
 * Returns whether a client quote workspace should refresh while background
 * extraction or vendor quoting is still active.
 */
export function shouldPollClientWorkspaceState(input: {
  extractionLifecycle: string | null | undefined;
  quoteRequestStatus: string | null | undefined;
  quoteRequestMode?: string | null;
  quoteRequestUpdatedAt?: string | null;
  hasPersistedOffers?: boolean;
  nowMs?: number;
}) {
  const requestUpdatedAt = input.quoteRequestUpdatedAt
    ? new Date(input.quoteRequestUpdatedAt).getTime()
    : Number.NaN;
  const receiptAgeMs = (input.nowMs ?? Date.now()) - requestUpdatedAt;
  const automaticQuoteRequest = input.quoteRequestMode !== "manual";
  const receivedWithoutOfferIsSettling =
    automaticQuoteRequest &&
    input.quoteRequestStatus === "received" &&
    !input.hasPersistedOffers &&
    Number.isFinite(requestUpdatedAt) &&
    receiptAgeMs >= 0 &&
    receiptAgeMs < RECEIVED_WITHOUT_OFFER_GRACE_MS;

  return (
    ACTIVE_EXTRACTION_LIFECYCLES.has(input.extractionLifecycle ?? "") ||
    (automaticQuoteRequest &&
      ACTIVE_QUOTE_REQUEST_STATUSES.has(input.quoteRequestStatus ?? "")) ||
    receivedWithoutOfferIsSettling
  );
}

/**
 * Returns whether any item in a client project still has background quote work.
 */
export function clientWorkspaceItemsNeedPolling(
  items: ClientWorkspacePollingItem[] | undefined,
) {
  return (items ?? []).some((item) =>
    shouldPollClientWorkspaceState({
      extractionLifecycle: item.part?.clientExtraction?.lifecycle,
      quoteRequestStatus: item.latestQuoteRequest?.status,
      quoteRequestMode: item.latestQuoteRequest?.request_mode,
      quoteRequestUpdatedAt: item.latestQuoteRequest?.updated_at,
      hasPersistedOffers: (item.quoteDiagnostics?.rawOfferCount ?? 0) > 0,
    }),
  );
}
