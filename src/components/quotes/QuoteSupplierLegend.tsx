import type { VendorName } from "@/integrations/supabase/types";
import { getVendorColor, getVendorDisplayName } from "@/features/quotes/vendor-colors";

type QuoteSupplierLegendProps = {
  vendorKeys: readonly VendorName[];
};

export function QuoteSupplierLegend({ vendorKeys }: QuoteSupplierLegendProps) {
  const unique = [...new Set(vendorKeys)].sort();

  if (unique.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {unique.map((key) => (
        <div key={key} className="flex items-center gap-1.5 text-xs text-white/50">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: getVendorColor(key) }}
          />
          {getVendorDisplayName(key)}
        </div>
      ))}
    </div>
  );
}
