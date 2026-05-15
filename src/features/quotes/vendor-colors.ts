import type { VendorName } from "@/integrations/supabase/types";
import type { ChartConfig } from "@/components/ui/chart";

const VENDOR_COLOR_MAP: Record<VendorName, string> = {
  xometry: "#4f7cff",
  fictiv: "#7c5cff",
  protolabs: "#ff5c6a",
  sendcutsend: "#3dd68c",
  oshcut: "#2f9e7d",
  fabworks: "#d4693f",
  ponoko: "#cf4f88",
  quickparts: "#5f7fdb",
  rapiddirect: "#d8a31f",
  geomiq: "#2f8fb8",
  weerg: "#6a9f3f",
  protolabsnetwork: "#a45bd6",
  partsbadger: "#f5c542",
  fastdms: "#8899aa",
  devzmanufacturing: "#e37b2c",
  infraredlaboratories: "#4db3a2",
};

const VENDOR_DISPLAY_NAME: Record<VendorName, string> = {
  xometry: "Xometry",
  fictiv: "Fictiv",
  protolabs: "Protolabs",
  sendcutsend: "SendCutSend",
  oshcut: "OSH Cut",
  fabworks: "Fabworks",
  ponoko: "Ponoko",
  quickparts: "Quickparts",
  rapiddirect: "RapidDirect",
  geomiq: "Geomiq",
  weerg: "Weerg",
  protolabsnetwork: "Protolabs Network",
  partsbadger: "PartsBadger",
  fastdms: "FastDMS",
  devzmanufacturing: "DEVZ Manufacturing",
  infraredlaboratories: "Infrared Laboratories",
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
