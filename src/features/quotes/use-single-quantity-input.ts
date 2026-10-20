import { useState } from "react";
import {
  describeSavedQuantities,
  parseRequestQuantityText,
  type SingleQuantityState,
} from "@/features/quotes/single-quantity";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";

/**
 * State of the single Quantity field (OVD-997). It keeps the typed text locally, for the same reason
 * as the tolerance field: clearing the field to retype must not snap back to a number on every
 * keystroke. Only a whole number reaches the draft, so a half typed value can never be saved.
 * `state` is undefined when the mode is off; the field then does nothing and never blocks Save.
 */
export function useSingleQuantityInput(
  draft: ClientPartRequestUpdateInput,
  state: SingleQuantityState | undefined,
  onChange: (next: Partial<ClientPartRequestUpdateInput>) => void,
) {
  const [text, setText] = useState(() => (Number.isFinite(draft.quantity) ? String(draft.quantity) : ""));
  const [seenQuantity, setSeenQuantity] = useState(draft.quantity);
  const [touched, setTouched] = useState(false);
  if (!Object.is(draft.quantity, seenQuantity)) {
    setSeenQuantity(draft.quantity);
    if (parseRequestQuantityText(text) !== draft.quantity) {
      setText(Number.isFinite(draft.quantity) ? String(draft.quantity) : "");
    }
  }

  const loading = state?.loading ?? false;
  const editable = Boolean(state?.allowAboveOne) && !loading;
  const invalid = editable && parseRequestQuantityText(text) === null;
  return {
    state,
    // Fixed at 1 shows 1; while the answer is pending the field shows the draft's own quantity.
    value: editable || loading ? text : "1",
    editable,
    blocked: loading || invalid,
    showError: invalid && (text.trim().length > 0 || touched),
    onTextChange: (nextText: string) => {
      if (!editable) {
        return;
      }
      setText(nextText);
      setTouched(false);
      const parsed = parseRequestQuantityText(nextText);
      if (parsed !== null) {
        onChange({ quantity: parsed });
      }
    },
    onBlur: () => setTouched(true),
    note: state ? describeSavedQuantities(draft, state) : null,
  };
}

export type SingleQuantityInput = ReturnType<typeof useSingleQuantityInput>;
