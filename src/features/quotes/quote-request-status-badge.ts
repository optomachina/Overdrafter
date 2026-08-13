import type { ClientQuoteRequestStatus } from "@/features/quotes/types";

// Canonical client-facing badge tokens for quote request statuses.
const QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES: Record<ClientQuoteRequestStatus, string> = {
  not_requested: "border border-border bg-accent text-foreground/80",
  queued: "border border-amber-300 bg-amber-300 text-amber-950 hover:bg-amber-300",
  requesting: "border border-amber-300 bg-amber-300 text-amber-950 hover:bg-amber-300",
  received: "border border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-700",
  failed: "border border-rose-700 bg-rose-700 text-white hover:bg-rose-700",
  canceled: "border border-rose-700 bg-rose-700 text-white hover:bg-rose-700",
};

export function getQuoteRequestStatusBadgeClassName(status: ClientQuoteRequestStatus): string {
  return QUOTE_REQUEST_STATUS_BADGE_CLASS_NAMES[status];
}
