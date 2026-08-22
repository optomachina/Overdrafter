import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { VendorName } from "@/integrations/supabase/types";

const PURCHASING_LINK_VENDOR_DOMAINS: Partial<Record<VendorName, readonly string[]>> = {
  xometry: ["xometry.com"],
  fictiv: ["fictiv.com"],
  protolabs: ["protolabs.com"],
  sendcutsend: ["sendcutsend.com"],
  emachineshop: ["emachineshop.com"],
};

export type VendorPurchasingLink = {
  url: string;
  vendorLabel: string;
};

function isDomainOrSubdomain(hostname: string, allowedDomain: string): boolean {
  return hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`);
}

/**
 * Resolve a customer-visible vendor quote link only for vendors with a
 * documented purchasing-share workflow and a matching HTTPS domain.
 */
export function resolveVendorPurchasingLink(
  option: Pick<ClientQuoteSelectionOption, "quoteUrl" | "vendorKey" | "vendorLabel">,
): VendorPurchasingLink | null {
  const allowedDomains = PURCHASING_LINK_VENDOR_DOMAINS[option.vendorKey];
  const candidate = option.quoteUrl?.trim();

  if (!allowedDomains || !candidate) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const domainAllowed = allowedDomains.some((domain) =>
      isDomainOrSubdomain(hostname, domain),
    );

    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !domainAllowed
    ) {
      return null;
    }

    return {
      url: parsed.toString(),
      vendorLabel: option.vendorLabel,
    };
  } catch {
    return null;
  }
}
