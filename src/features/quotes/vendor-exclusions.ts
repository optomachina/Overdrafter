import type { VendorName } from "@/integrations/supabase/types";

const STORAGE_KEY_PREFIX = "overdrafter-excluded-vendors-v1";
const VENDOR_NAMES: VendorName[] = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "partsbadger",
  "fastdms",
  "devzmanufacturing",
  "infraredlaboratories",
];

function getStorageKey(jobId: string): string {
  return `${STORAGE_KEY_PREFIX}:${jobId}`;
}

function isVendorName(value: string): value is VendorName {
  return VENDOR_NAMES.includes(value as VendorName);
}

export function readExcludedVendorKeys(jobId: string): VendorName[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getStorageKey(jobId));

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is VendorName => isVendorName(String(value))) : [];
  } catch {
    return [];
  }
}

export function writeExcludedVendorKeys(jobId: string, vendorKeys: readonly VendorName[]): VendorName[] {
  const normalized = [...new Set(vendorKeys)].filter(isVendorName);

  if (typeof window !== "undefined") {
    window.localStorage.setItem(getStorageKey(jobId), JSON.stringify(normalized));
  }

  return normalized;
}

export function toggleExcludedVendorKey(
  jobId: string,
  vendorKey: VendorName,
  shouldExclude: boolean,
): VendorName[] {
  const current = new Set(readExcludedVendorKeys(jobId));

  if (shouldExclude) {
    current.add(vendorKey);
  } else {
    current.delete(vendorKey);
  }

  return writeExcludedVendorKeys(jobId, [...current]);
}
