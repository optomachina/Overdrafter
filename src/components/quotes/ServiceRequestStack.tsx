import { Badge } from "@/components/ui/badge";
import { formatRequestedServiceKindLabel } from "@/features/quotes/service-intent";
import { readServiceRequestQuoteQuantities } from "@/features/quotes/service-requests";
import type { ServiceRequestLineItem, ServiceRequestLineItemInput } from "@/features/quotes/types";

type ServiceRequestStackProps = {
  items: readonly (ServiceRequestLineItem | ServiceRequestLineItemInput)[];
  title?: string;
  className?: string;
};

export function ServiceRequestStack({
  items,
  title = "Workpack",
  className = "",
}: ServiceRequestStackProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-3 rounded-[1.75rem] border border-white/8 bg-white/5 p-4 ${className}`.trim()}>
      <div>
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="mt-1 text-xs text-white/50">
          Service requests are tracked explicitly so quote work and non-quote work can coexist on the same part.
        </p>
      </div>

      <div className="space-y-3">
        {items.map((item, index) => {
          const quoteQuantities = readServiceRequestQuoteQuantities(item.detailPayload);

          return (
            <div key={`${item.id ?? item.serviceType}-${index}`} className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-white/10 bg-white/6 text-white/80">
                  {formatRequestedServiceKindLabel(item.serviceType)}
                </Badge>
                <Badge className="border border-white/10 bg-white/6 text-white/60">
                  {(item.scope ?? "job").replace("_", " ")}
                </Badge>
                {item.requestedByDate ? (
                  <Badge className="border border-white/10 bg-white/6 text-white/60">
                    Need by {item.requestedByDate}
                  </Badge>
                ) : null}
                {quoteQuantities.length > 0 ? (
                  <Badge className="border border-white/10 bg-white/6 text-white/60">
                    Qty {quoteQuantities.join(" / ")}
                  </Badge>
                ) : null}
              </div>
              {item.serviceNotes ? (
                <p className="mt-3 text-sm text-white/65">{item.serviceNotes}</p>
              ) : (
                <p className="mt-3 text-sm text-white/40">No extra service notes.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
