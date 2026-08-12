import type { ClientQuoteRequestStatus } from "@/features/quotes/types";

// Canonical client-facing badge tokens for quote request statuses.
const NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME =
  "rounded-[2px] border border-paper-hairline bg-paper-surface font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-paper-ink";

const QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES: Record<ClientQuoteRequestStatus, string> = {
  not_requested: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
  queued: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
  requesting: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
  received: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
  failed: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
  canceled: NEUTRAL_QUOTE_REQUEST_STATUS_BADGE_CLASS_NAME,
};

export function getQuoteRequestStatusBadgeClassName(status: ClientQuoteRequestStatus): string {
  return QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES[status];
}
