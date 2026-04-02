import { Badge } from "@/components/ui/badge";
import {
  formatRequestedByDateLabel,
  formatRequestedQuoteQuantitiesLabel,
} from "@/features/quotes/request-intake";
import {
  formatRequestedServiceKindLabel,
  normalizeRequestedServiceKinds,
  requestedServicesSupportQuoteFields,
} from "@/features/quotes/service-intent";
import { cn } from "@/lib/utils";

type RequestSummaryBadgesProps = {
  requestedServiceKinds?: readonly string[] | null;
  quantity?: number | null;
  requestedQuoteQuantities?: readonly number[] | null;
  requestedByDate?: string | null;
  className?: string;
};

export function RequestSummaryBadges({
  requestedServiceKinds = [],
  quantity = null,
  requestedQuoteQuantities = [],
  requestedByDate = null,
  className,
}: RequestSummaryBadgesProps) {
  const normalizedServiceKinds = normalizeRequestedServiceKinds(requestedServiceKinds);
  const showQuoteFields = requestedServicesSupportQuoteFields(normalizedServiceKinds);
  const needByLabel = showQuoteFields ? formatRequestedByDateLabel(requestedByDate) : null;
  const quoteQuantityLabel =
    showQuoteFields && requestedQuoteQuantities.length > 0
      ? formatRequestedQuoteQuantitiesLabel(requestedQuoteQuantities)
      : null;

  if (normalizedServiceKinds.length === 0 && !quantity && !quoteQuantityLabel && !needByLabel) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {normalizedServiceKinds.map((serviceKind) => (
        <Badge
          key={serviceKind}
          className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
        >
          {formatRequestedServiceKindLabel(serviceKind)}
        </Badge>
      ))}
      {showQuoteFields && quantity ? (
        <Badge className="border border-white/10 bg-white/6 text-white/75">
          Qty {quantity}
        </Badge>
      ) : null}
      {quoteQuantityLabel ? (
        <Badge className="border border-sky-400/25 bg-sky-500/10 text-sky-200">
          Quote qty {quoteQuantityLabel}
        </Badge>
      ) : null}
      {needByLabel ? (
        <Badge className="border border-amber-400/25 bg-amber-500/10 text-amber-200">
          Need by {needByLabel}
        </Badge>
      ) : null}
    </div>
  );
}
