/**
 * Client flag for the legacy "Review order" procurement handoff on part and project pages.
 * Default off: the friends release has no ordering or checkout (OVD-968 step 7, OVD-1011).
 */
export function isOrderReviewEnabled(
  value: string | undefined = import.meta.env.VITE_ENABLE_ORDER_REVIEW,
): boolean {
  return value === "1";
}
