import { supabase } from "@/integrations/supabase/client";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import type { VendorCapabilityProfileRecord } from "@/features/quotes/types";
import { ensureData } from "./shared/response";

/**
 * Load the reviewed provider capabilities that are safe to use for client
 * sourcing guidance. Write access remains restricted to internal users by RLS.
 */
export async function fetchVendorCapabilityProfiles(): Promise<VendorCapabilityProfileRecord[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchVendorCapabilityProfiles();
  }

  const { data, error } = await supabase
    .from("vendor_capability_profiles")
    .select(
      "vendor_name, process_types, materials, tolerance_min_mm, tolerance_max_mm, max_part_size_mm, min_quantity, max_quantity, geographic_region, certifications, quality_score, lead_time_reliability, cost_competitiveness, domestic_us, updated_at",
    )
    .order("vendor_name", { ascending: true });

  return ensureData(data, error) as VendorCapabilityProfileRecord[];
}
