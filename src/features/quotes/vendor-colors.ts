import type { VendorName } from "@/integrations/supabase/types";
import type { ChartConfig } from "@/components/ui/chart";

const VENDOR_COLOR_MAP: Record<VendorName, string> = {
  xometry: "#4f7cff",
  fictiv: "#7c5cff",
  protolabs: "#ff5c6a",
  sendcutsend: "#3dd68c",
  partsbadger: "#f5c542",
  fastdms: "#8899aa",
};

const VENDOR_DISPLAY_NAME: Record<VendorName, string> = {
  xometry: "Xometry",
  fictiv: "Fictiv",
  protolabs: "Protolabs",
  sendcutsend: "SendCutSend",
  partsbadger: "PartsBadger",
  fastdms: "FastDMS",
};

const FALLBACK_COLOR = "#6b738f";

export function getVendorColor(vendorKey: VendorName): string {
  return VENDOR_COLOR_MAP[vendorKey] ?? FALLBACK_COLOR;
}

export function getVendorDisplayName(vendorKey: VendorName): string {
  return VENDOR_DISPLAY_NAME[vendorKey] ?? vendorKey;
}

export function buildVendorChartConfig(vendorKeys: readonly VendorName[]): ChartConfig {
  const unique = [...new Set(vendorKeys)].sort();

  return Object.fromEntries(
    unique.map((key) => [
      key,
      {
        label: VENDOR_DISPLAY_NAME[key] ?? key,
        color: VENDOR_COLOR_MAP[key] ?? FALLBACK_COLOR,
      },
    ]),
  );
}
