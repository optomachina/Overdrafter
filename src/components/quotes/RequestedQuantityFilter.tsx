import type { RequestedQuantityFilterValue } from "@/features/quotes/request-scenarios";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RequestedQuantityFilterProps = {
  quantities: readonly number[];
  value: RequestedQuantityFilterValue | null;
  onChange: (value: RequestedQuantityFilterValue) => void;
  includeAll?: boolean;
  className?: string;
};

export function RequestedQuantityFilter({
  quantities,
  value,
  onChange,
  includeAll = true,
  className,
}: RequestedQuantityFilterProps) {
  if (quantities.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {includeAll ? (
        <Button
          type="button"
          variant={value === "all" ? "default" : "outline"}
          className={cn(
            "rounded-full border-white/10",
            value === "all"
              ? "bg-white text-black hover:bg-white/90"
              : "bg-transparent text-white hover:bg-white/6",
          )}
          onClick={() => onChange("all")}
        >
          All
        </Button>
      ) : null}
      {quantities.map((quantity) => (
        <Button
          key={quantity}
          type="button"
          variant={value === quantity ? "default" : "outline"}
          className={cn(
            "rounded-full border-white/10",
            value === quantity
              ? "bg-white text-black hover:bg-white/90"
              : "bg-transparent text-white hover:bg-white/6",
          )}
          onClick={() => onChange(quantity)}
        >
          Qty {quantity}
        </Button>
      ))}
    </div>
  );
}
