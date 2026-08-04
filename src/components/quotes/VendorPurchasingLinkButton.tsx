import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { resolveVendorPurchasingLink } from "@/features/quotes/vendor-purchasing-links";
import { cn } from "@/lib/utils";

type VendorPurchasingLinkButtonProps = {
  option: Pick<ClientQuoteSelectionOption, "quoteUrl" | "vendorKey" | "vendorLabel">;
  label?: string;
  className?: string;
};

/** Render a customer-safe outbound action when a supported vendor quote URL is available. */
export function VendorPurchasingLinkButton({
  option,
  label = "Open vendor quote",
  className,
}: Readonly<VendorPurchasingLinkButtonProps>) {
  const purchasingLink = resolveVendorPurchasingLink(option);

  if (!purchasingLink) {
    return null;
  }

  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className={cn("rounded-full", className)}
    >
      <a
        href={purchasingLink.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label} from ${purchasingLink.vendorLabel}`}
        title={`Opens on ${purchasingLink.vendorLabel}. Vendor sign-in or guest access may be required.`}
        onClick={(event) => event.stopPropagation()}
      >
        {label}
        <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
      </a>
    </Button>
  );
}
