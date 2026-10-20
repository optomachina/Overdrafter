import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  QUANTITY_ALLOWED_COPY,
  QUANTITY_CHECKING_COPY,
  QUANTITY_FIXED_COPY,
  QUANTITY_FORMAT_ERROR,
  QUANTITY_UNAVAILABLE_COPY,
  type SingleQuantityState,
} from "@/features/quotes/single-quantity";
import type { SingleQuantityInput } from "@/features/quotes/use-single-quantity-input";

const QUANTITY_HELP_ID = "client-request-quantity-help";

function quantityHelpCopy(state: SingleQuantityState): string {
  if (state.loading) {
    return QUANTITY_CHECKING_COPY;
  }
  if (state.unavailable) {
    return QUANTITY_UNAVAILABLE_COPY;
  }
  return state.allowAboveOne ? QUANTITY_ALLOWED_COPY : QUANTITY_FIXED_COPY;
}

export function SingleQuantityField({ input }: { readonly input: SingleQuantityInput }) {
  if (!input.state) {
    return null;
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="client-request-quantity">Quantity</Label>
      <Input
        id="client-request-quantity"
        value={input.value}
        onChange={(event) => input.onTextChange(event.target.value)}
        onBlur={input.onBlur}
        readOnly={!input.editable}
        aria-invalid={input.showError ? true : undefined}
        aria-describedby={QUANTITY_HELP_ID}
        className="border-border bg-muted text-foreground read-only:cursor-not-allowed read-only:opacity-70"
        inputMode="numeric"
      />
      <p id={QUANTITY_HELP_ID} className="text-xs text-muted-foreground">
        {quantityHelpCopy(input.state)}
      </p>
      {input.showError ? (
        <p role="alert" className="text-xs text-destructive">
          {QUANTITY_FORMAT_ERROR}
        </p>
      ) : null}
      {input.note ? <p className="text-xs text-muted-foreground">{input.note}</p> : null}
    </div>
  );
}
