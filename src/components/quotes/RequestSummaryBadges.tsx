import { Badge } from "@/components/ui/badge";
import {
  formatRequestedByDateLabel,
  formatRequestedQuoteQuantitiesLabel,
} from "@/features/quotes/request-intake";
import { cn } from "@/lib/utils";

type RequestSummaryBadgesProps = {
  quantity?: number | null;
  requestedQuoteQuantities?: readonly number[] | null;
  requestedByDate?: string | null;
  className?: string;
};

export function RequestSummaryBadges({
  quantity = null,
  requestedQuoteQuantities = [],
  requestedByDate = null,
  className,
}: RequestSummaryBadgesProps) {
  const needByLabel = formatRequestedByDateLabel(requestedByDate);
  const quoteQuantityLabel =
    requestedQuoteQuantities.length > 0
      ? formatRequestedQuoteQuantitiesLabel(requestedQuoteQuantities)
      : null;

  if (!quantity && !quoteQuantityLabel && !needByLabel) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {quantity ? (
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
