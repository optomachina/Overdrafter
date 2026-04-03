import type { ClientQuoteRequestStatus } from "@/features/quotes/types";

// Canonical client-facing badge tokens for quote request statuses.
const QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES: Record<ClientQuoteRequestStatus, string> = {
  not_requested: "border border-white/10 bg-white/6 text-white/70",
  queued: "border border-amber-400/20 bg-amber-500/10 text-amber-100",
  requesting: "border border-amber-400/20 bg-amber-500/10 text-amber-100",
  received: "border border-emerald-400/20 bg-emerald-500/10 text-emerald-100",
  failed: "border border-rose-400/20 bg-rose-500/10 text-rose-100",
  canceled: "border border-rose-400/20 bg-rose-500/10 text-rose-100",
};

export function getQuoteRequestStatusBadgeClassName(status: ClientQuoteRequestStatus): string {
  return QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES[status];
}
