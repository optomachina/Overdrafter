// The single place a unit price and a total price are bound to a quantity.
// Adapters report what they observed; admitPrice decides whether that is a
// publishable PricedQuantity. Nothing defaults to quantity 1, unit and total
// are never inferred from unlabeled amounts, and all math is integer cents.
// See /workspace/plans/xometry-quantity-replan.md sections 1, 2a, 3 and Decisions.

export type Money = { cents: number; currency: "USD" };

export type PricedQuantity = {
  /** The quantity the price was quoted for, as observed. */
  quantity: number;
  /** The quantity we asked for. Never defaulted. */
  requestedQuantity: number;
  unit: Money;
  total: Money;
  unitSource: "observed" | "derived";
  totalSource: "observed" | "derived";
};

export type PriceVerdictReason =
  | "qty_missing"
  | "qty_mismatch"
  | "invariant_failed"
  | "both_derived"
  | "ambiguous_label"
  | "non_positive"
  | "currency";

/** Why a price was refused. Numbers and flags only, never page text. */
export type PriceVerdictDetail = Readonly<Record<string, number | boolean>>;

export type PriceVerdict =
  | { ok: true; value: PricedQuantity }
  | { ok: false; reason: PriceVerdictReason; detail: PriceVerdictDetail };

export type ObservedAmount<Label extends string> = {
  cents: number;
  currency: string;
  /** The label observed next to the amount; absent if the amount was unlabeled. */
  label?: Label;
};

export type AdmitPriceInput = {
  requestedQuantity: number | null | undefined;
  /** The quantity the page showed for this price. */
  quantity: number | null | undefined;
  unit?: ObservedAmount<"each" | "per_part"> | null;
  total?: ObservedAmount<"total" | "subtotal"> | null;
};

/** Allowed |unit × qty − total| per piece, for per-piece rounding. */
export const PRICE_TOLERANCE_CENTS_PER_PIECE = 1;

const isQuantity = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const refuse = (reason: PriceVerdictReason, detail: PriceVerdictDetail): PriceVerdict => ({
  ok: false,
  reason,
  detail,
});

const usd = (cents: number): Money => ({ cents, currency: "USD" });

export function admitPrice(input: AdmitPriceInput): PriceVerdict {
  const { requestedQuantity, quantity } = input;
  const unit = input.unit ?? null;
  const total = input.total ?? null;

  if (!isQuantity(requestedQuantity) || !isQuantity(quantity)) {
    return refuse("qty_missing", {
      requestedQuantityValid: isQuantity(requestedQuantity),
      quantityValid: isQuantity(quantity),
    });
  }
  if (quantity !== requestedQuantity) {
    return refuse("qty_mismatch", { quantity, requestedQuantity });
  }

  const observed = { unitObserved: unit !== null, totalObserved: total !== null };
  if (!unit && !total) {
    return refuse("both_derived", observed);
  }

  const amounts = [unit, total].filter((amount) => amount !== null);
  if (amounts.some((amount) => amount.currency !== "USD")) {
    return refuse("currency", observed);
  }
  if (amounts.some((amount) => !Number.isSafeInteger(amount.cents) || amount.cents <= 0)) {
    return refuse("non_positive", observed);
  }

  const labels = {
    unitLabeled: unit?.label !== undefined,
    totalLabeled: total?.label !== undefined,
  };
  if ((unit && !unit.label) || (total && !total.label)) {
    return refuse("ambiguous_label", { ...observed, ...labels });
  }
  // Approved decision: for qty > 1 both unit and total must be read from the page.
  if (quantity > 1 && (!unit || !total)) {
    return refuse("ambiguous_label", { ...observed, ...labels, quantity });
  }

  // From here quantity is 1 whenever one side is missing, so unit equals total.
  const unitCents = unit?.cents ?? total!.cents;
  const totalCents = total?.cents ?? unit!.cents;

  const expectedTotal = unitCents * quantity;
  const toleranceCents = PRICE_TOLERANCE_CENTS_PER_PIECE * quantity;
  if (!Number.isSafeInteger(expectedTotal) || !Number.isSafeInteger(toleranceCents)) {
    return refuse("invariant_failed", { unitCents, totalCents, quantity, overflow: true });
  }
  if (Math.abs(expectedTotal - totalCents) > toleranceCents) {
    return refuse("invariant_failed", { unitCents, totalCents, quantity, toleranceCents });
  }

  return {
    ok: true,
    value: {
      quantity,
      requestedQuantity,
      unit: usd(unitCents),
      total: usd(totalCents),
      unitSource: unit ? "observed" : "derived",
      totalSource: total ? "observed" : "derived",
    },
  };
}
