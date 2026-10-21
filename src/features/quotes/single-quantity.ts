import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";

/**
 * Single Quantity mode of the part request editor (OVD-997, slice P1 of OVD-987).
 *
 * One request is quoted at one quantity. The only bound the client applies is the PostgreSQL
 * `integer` maximum, because `parts.quantity` is an integer column; there is no product cap
 * (Blaine, 2026-10-19: "Let the user decide"). Whether a quantity above 1 is offered at all is
 * the server's call (quantity-scope.ts), and the server enforces it again when a quote is requested.
 */
export const MAX_REQUEST_QUANTITY = 2_147_483_647;

export const QUANTITY_FORMAT_ERROR = "Enter a whole number from 1 to 2,147,483,647.";
export const QUANTITY_FIXED_COPY =
  "The controlled beta quotes 1 piece per request. Larger quantities are turned on for specific requests only.";
export const QUANTITY_ALLOWED_COPY = "Each request is quoted at one quantity.";
export const QUANTITY_CHECKING_COPY = "Checking which quantities this request can use.";
export const QUANTITY_UNAVAILABLE_COPY =
  "Could not check which quantities this request can use, so the quantity stays as saved. Reload the page to try again.";

export type SingleQuantityState = {
  /** True only when the server scoped a quantity above 1 to this request or participant. */
  allowAboveOne: boolean;
  /** True while the server answer is pending; Save waits for it. */
  loading: boolean;
  /**
   * True when there is no verified server answer (the read failed or did not match). This is not
   * the server saying single only: the field is read only and a save keeps the saved quantities.
   */
  unavailable: boolean;
};

export function isRequestQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REQUEST_QUANTITY;
}

const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** The typed Quantity as a whole number from 1 to the integer limit, or null when the text is not one. */
export function parseRequestQuantityText(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER_PATTERN.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return isRequestQuantity(value) ? value : null;
}

/**
 * The request a save sends: exactly one quantity, in both `quantity` and `requestedQuoteQuantities`.
 * The server stores `quote_quantities[1]` as the quantity, so sending a list that still holds an old
 * value would discard an edited Quantity without a message. Returns null when nothing may be saved
 * yet (server answer pending, or no valid quantity). When the server answer is unavailable the field
 * is read only and the quantities in the draft are sent back as they are, never replaced by 1.
 */
export function buildSingleQuantityRequest(
  draft: ClientPartRequestUpdateInput,
  state: SingleQuantityState,
): ClientPartRequestUpdateInput | null {
  if (state.loading) {
    return null;
  }
  if (state.unavailable) {
    return {
      ...draft,
      requestedQuoteQuantities:
        draft.requestedQuoteQuantities.length > 0 ? draft.requestedQuoteQuantities : [draft.quantity],
    };
  }
  const quantity = state.allowAboveOne ? draft.quantity : 1;
  if (!isRequestQuantity(quantity)) {
    return null;
  }
  return { ...draft, quantity, requestedQuoteQuantities: [quantity] };
}

/**
 * A plain note when the saved request does not match what a save would write, so a save never
 * changes the quantity without saying so. Null when the saved quantities already match.
 */
export function describeSavedQuantities(
  draft: Pick<ClientPartRequestUpdateInput, "quantity" | "requestedQuoteQuantities">,
  state: SingleQuantityState,
): string | null {
  if (state.loading) {
    return null;
  }
  const saved = draft.requestedQuoteQuantities.length > 0 ? draft.requestedQuoteQuantities : [draft.quantity];
  const label = saved.length > 1 ? "quantities" : "quantity";
  const list = saved.join(", ");
  if (state.unavailable) {
    return saved.length > 1 ? `This request is saved with quantities ${list}. Saving keeps them as they are.` : null;
  }
  if (state.allowAboveOne) {
    return saved.length > 1
      ? `This request is saved with ${label} ${list}. Saving keeps only quantity ${draft.quantity}.`
      : null;
  }
  return saved.length === 1 && saved[0] === 1
    ? null
    : `This request is saved with ${label} ${list}. Saving sets the quantity to 1.`;
}
