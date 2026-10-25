// The single place a unit price and a total price are bound to a quantity.
// Adapters report what they observed; admitPrice decides whether that is a
// publishable PricedQuantity. Nothing defaults to quantity 1, unit and total
// are never inferred from unlabeled amounts, and all math is integer cents.
// The quantity must also be read back from the page's quantity control after
// pricing (pageQuantity, with the text it was read from) and agree with both
// the requested quantity and the quantity the price card states.
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

export type PageQuantity = { value: number; sourceText: string };

export const UNIT_PRICE_LABELS = ["each", "per_part"] as const;
export const TOTAL_PRICE_LABELS = ["total", "subtotal"] as const;
export type UnitPriceLabel = (typeof UNIT_PRICE_LABELS)[number];
export type TotalPriceLabel = (typeof TOTAL_PRICE_LABELS)[number];

export type AdmitPriceInput = {
  requestedQuantity: number | null | undefined;
  /** The quantity the price card states for this price. */
  quantity: number | null | undefined;
  /** The quantity read from the page's quantity control after pricing, and the exact text span it was read from. */
  pageQuantity: PageQuantity | null | undefined;
  unit?: ObservedAmount<UnitPriceLabel> | null;
  total?: ObservedAmount<TotalPriceLabel> | null;
};

/**
 * Allowed |unit × qty − total| per piece, for per-piece rounding. A gap equal to
 * the tolerance is admitted; only a strictly larger gap is refused.
 *
 * Known limit: at qty 1–2 the tolerance is only 1–2¢, and at qty 1 unit equals
 * total by definition, so a unit/total mix-up whose amounts differ by 2¢ or less
 * (qty 1, or tiny unit prices) passes this arithmetic check. There the amount
 * labels and the pageQuantity read are the guard, not the invariant.
 */
export const PRICE_TOLERANCE_CENTS_PER_PIECE = 1;

const isQuantity = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/**
 * Read only canonical unsigned integer tokens following quantity/qty labels. Every label
 * must name the expected value; unrelated numbers cannot supply the quantity.
 * Scan each label and its token once, without a backtracking number search.
 */
const sourceShowsQuantity = (sourceText: string, value: number) => {
  const labels = /\b(?:quantity|qty)\b/gi;
  let found = false;
  for (const label of sourceText.matchAll(labels)) {
    let cursor = label.index + label[0].length;
    let whitespaceStart = cursor;
    while (cursor < sourceText.length && /\s/.test(sourceText[cursor])) cursor++;
    if (sourceText[cursor] === ":" || sourceText[cursor] === "=") {
      whitespaceStart = ++cursor;
      while (cursor < sourceText.length && /\s/.test(sourceText[cursor])) cursor++;
    }
    if (cursor === whitespaceStart) return false;

    const start = cursor;
    while (cursor < sourceText.length && /[0-9]/.test(sourceText[cursor])) cursor++;
    const token = sourceText.slice(start, cursor);
    let suffix = cursor;
    while (suffix < sourceText.length && /\s/.test(sourceText[suffix])) suffix++;
    // Only whitespace, prose or a field delimiter may follow the integer.
    // A digit after whitespace is still part of an ambiguous numeric form;
    // never validate just its prefix or normalize grouping separators away.
    if (
      !/^[1-9][0-9]*$/.test(token) ||
      (cursor < sourceText.length && !/[\s;]/.test(sourceText[cursor])) ||
      (suffix < sourceText.length && !/[A-Za-z;]/.test(sourceText[suffix])) ||
      /^[ex]\s*[+-]?\s*[0-9]/i.test(sourceText.slice(suffix)) ||
      Number(token) !== value
    ) {
      return false;
    }
    found = true;
  }
  return found;
};

const refuse = (reason: PriceVerdictReason, detail: PriceVerdictDetail): PriceVerdict => ({
  ok: false,
  reason,
  detail,
});

const usd = (cents: number): Money => ({ cents, currency: "USD" });

export function admitPrice(input: AdmitPriceInput): PriceVerdict {
  const { requestedQuantity, quantity } = input;
  const pageQuantity = input.pageQuantity?.value;
  const pageSourceText = input.pageQuantity?.sourceText ?? "";
  const unit = input.unit ?? null;
  const total = input.total ?? null;

  const pageQuantityValid = isQuantity(pageQuantity);
  const pageQuantitySourceValid =
    pageQuantityValid && pageSourceText.trim() !== "" && sourceShowsQuantity(pageSourceText, pageQuantity);
  if (!isQuantity(requestedQuantity) || !isQuantity(quantity) || !pageQuantityValid || !pageQuantitySourceValid) {
    return refuse("qty_missing", {
      requestedQuantityValid: isQuantity(requestedQuantity),
      quantityValid: isQuantity(quantity),
      pageQuantityValid,
      pageQuantitySourceValid,
    });
  }
  if (quantity !== requestedQuantity || pageQuantity !== requestedQuantity) {
    return refuse("qty_mismatch", { quantity, requestedQuantity, pageQuantity });
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
  if (
    (unit && !UNIT_PRICE_LABELS.some((label) => label === unit.label)) ||
    (total && !TOTAL_PRICE_LABELS.some((label) => label === total.label))
  ) {
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
