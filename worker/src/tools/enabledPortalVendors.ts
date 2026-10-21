import type { LiveAutomationVendorName } from "../types.js";

/** Bulk tools skip source-disabled portals; single-provider callers still refuse at execution. */
export function enabledPortalVendors(
  vendors: LiveAutomationVendorName[],
  bulk = vendors.length > 1,
): LiveAutomationVendorName[] {
  if (!bulk) return vendors;
  return vendors.filter((vendor) => {
    if (vendor !== "oshcut") return true;
    console.info("Skipping oshcut: portal automation is disabled (OVD-1022).");
    return false;
  });
}
