import type { VendorName } from "@/integrations/supabase/types";
import type { ChartConfig } from "@/components/ui/chart";
import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";

const FALLBACK_COLOR = "#6b738f";

export function getVendorColor(vendorKey: VendorName): string {
  return PROVIDER_CATALOG[vendorKey]?.color ?? FALLBACK_COLOR;
}

export function getVendorDisplayName(vendorKey: VendorName): string {
  return PROVIDER_CATALOG[vendorKey]?.displayName ?? vendorKey;
}

export function buildVendorChartConfig(vendorKeys: readonly VendorName[]): ChartConfig {
  const unique = [...new Set(vendorKeys)].sort();

  return Object.fromEntries(
    unique.map((key) => [
      key,
      {
        label: PROVIDER_CATALOG[key]?.displayName ?? key,
        color: PROVIDER_CATALOG[key]?.color ?? FALLBACK_COLOR,
      },
    ]),
  );
}
