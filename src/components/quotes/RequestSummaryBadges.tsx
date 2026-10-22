import { STATUS_TONE } from "@/components/quotes/status-tone";
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
          className={STATUS_TONE.badge}
        >
          {formatRequestedServiceKindLabel(serviceKind)}
        </Badge>
      ))}
      {showQuoteFields && quantity ? (
        <Badge className={STATUS_TONE.badge}>
          Qty {quantity}
        </Badge>
      ) : null}
      {quoteQuantityLabel ? (
        <Badge className={STATUS_TONE.badge}>
          Quote qty {quoteQuantityLabel}
        </Badge>
      ) : null}
      {needByLabel ? (
        <Badge className={STATUS_TONE.badge}>
          Need by {needByLabel}
        </Badge>
      ) : null}
    </div>
  );
}
