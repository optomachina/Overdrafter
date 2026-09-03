import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";

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
  const allowedDomains = PROVIDER_CATALOG[option.vendorKey]?.purchasingDomains;
  const candidate = option.quoteUrl?.trim();

  if (!allowedDomains || allowedDomains.length === 0 || !candidate) {
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
