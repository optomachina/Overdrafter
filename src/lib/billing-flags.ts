import { isCheckoutCatalogEnabled } from "@/lib/billing-catalog";

export function isBillingTierCatalogUiEnabled(
  selfServiceEnabled = import.meta.env.VITE_BILLING_SELF_SERVICE_ENABLED,
  tierCatalogEnabled = import.meta.env.VITE_BILLING_TIER_CATALOG_ENABLED,
): boolean {
  return isCheckoutCatalogEnabled(selfServiceEnabled, tierCatalogEnabled);
}
