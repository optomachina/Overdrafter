import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  admitPrice,
  PRICE_TOLERANCE_CENTS_PER_PIECE,
  type AdmitPriceInput,
  type PricedQuantity,
} from "./pricedQuantity.js";

// Property tests for admitPrice. See /workspace/plans/xometry-quantity-replan.md
// section 3 "Property tests". Fixed seed so a failure reproduces exactly.
const params = { seed: 20261024, numRuns: 500 } as const;

// Bounded so unit × qty (and any k-scaled total) stays a safe integer.
const MAX_QTY = 100_000;
const MAX_UNIT_CENTS = 1_000_000_000;
const MAX_SCALE = 1_000;

const qtyArb = fc.integer({ min: 1, max: MAX_QTY });
const multiQtyArb = fc.integer({ min: 2, max: MAX_QTY });
const centsArb = fc.integer({ min: 1, max: MAX_UNIT_CENTS });
const unitLabelArb = fc.constantFrom("each" as const, "per_part" as const);
const totalLabelArb = fc.constantFrom("total" as const, "subtotal" as const);

const unitOf = (cents: number, label: "each" | "per_part" = "each") => ({ cents, currency: "USD", label });
const totalOf = (cents: number, label: "total" | "subtotal" = "total") => ({ cents, currency: "USD", label });

const tolerance = (qty: number) => PRICE_TOLERANCE_CENTS_PER_PIECE * qty;

const pageQty = (value: number) => ({ value, sourceText: `Quantity ${value}` });

const priced = (unitCents: number, totalCents: number, qty: number): AdmitPriceInput => ({
  requestedQuantity: qty,
  quantity: qty,
  pageQuantity: pageQty(qty),
  unit: unitOf(unitCents),
  total: totalOf(totalCents),
});

describe("admitPrice properties", () => {
  it("admits a labeled unit and total = unit × qty for any qty >= 1", () => {
    fc.assert(
      fc.property(qtyArb, centsArb, unitLabelArb, totalLabelArb, (qty, unitCents, unitLabel, totalLabel) => {
        const verdict = admitPrice({
          requestedQuantity: qty,
          quantity: qty,
          pageQuantity: pageQty(qty),
          unit: unitOf(unitCents, unitLabel),
          total: totalOf(unitCents * qty, totalLabel),
        });
        expect(verdict).toEqual({
          ok: true,
          value: {
            quantity: qty,
            requestedQuantity: qty,
            unit: { cents: unitCents, currency: "USD" },
            total: { cents: unitCents * qty, currency: "USD" },
            unitSource: "observed",
            totalSource: "observed",
          },
        });
      }),
      params,
    );
  });

  it("admits any total within ±1¢ × qty of unit × qty", () => {
    const arb = fc
      .tuple(qtyArb, centsArb)
      .chain(([qty, unitCents]) =>
        fc.tuple(
          fc.constant(qty),
          fc.constant(unitCents),
          // Keep the total positive; non-positive amounts are a different refusal.
          fc.integer({ min: Math.max(-tolerance(qty), 1 - unitCents * qty), max: tolerance(qty) }),
        ),
      );
    fc.assert(
      fc.property(arb, ([qty, unitCents, delta]) => {
        const verdict = admitPrice(priced(unitCents, unitCents * qty + delta, qty));
        expect(verdict.ok).toBe(true);
      }),
      params,
    );
  });

  it("accepts |total − unit × qty| == 1¢ × qty and refuses 1¢ × qty + 1 for any qty >= 2", () => {
    // admitPrice refuses only when the gap is strictly greater than the tolerance.
    // unit >= 2 keeps unit × qty − (1¢ × qty + 1) = qty(unit − 1) − 1 >= 1.
    fc.assert(
      fc.property(multiQtyArb, fc.integer({ min: 2, max: MAX_UNIT_CENTS }), fc.constantFrom(1, -1), (qty, unitCents, sign) => {
        const expected = unitCents * qty;
        const atBoundary = expected + sign * tolerance(qty);
        expect(admitPrice(priced(unitCents, atBoundary, qty))).toMatchObject({
          ok: true,
          value: { unit: { cents: unitCents }, total: { cents: atBoundary } },
        });
        const pastBoundary = expected + sign * (tolerance(qty) + 1);
        expect(admitPrice(priced(unitCents, pastBoundary, qty))).toEqual({
          ok: false,
          reason: "invariant_failed",
          detail: { unitCents, totalCents: pastBoundary, quantity: qty, toleranceCents: tolerance(qty) },
        });
      }),
      params,
    );
  });

  it("refuses a total relabeled as a unit (unit = total = X) for any qty >= 2", () => {
    // X(qty − 1) > qty for every X >= 3 and qty >= 2. Below that the gap is
    // inside the per-piece rounding tolerance; the next property pins that edge.
    fc.assert(
      fc.property(multiQtyArb, fc.integer({ min: 3, max: MAX_UNIT_CENTS }), (qty, x) => {
        const verdict = admitPrice(priced(x, x, qty));
        expect(verdict).toMatchObject({ ok: false, reason: "invariant_failed" });
      }),
      params,
    );
  });

  it("decides unit = total = X exactly by the tolerance for any X and qty >= 2", () => {
    fc.assert(
      fc.property(multiQtyArb, centsArb, (qty, x) => {
        const verdict = admitPrice(priced(x, x, qty));
        expect(verdict.ok).toBe(x * (qty - 1) <= tolerance(qty));
      }),
      params,
    );
  });

  it("refuses total = unit × qty × k for integer k >= 2 once the gap exceeds tolerance", () => {
    fc.assert(
      fc.property(
        qtyArb,
        fc.integer({ min: 1, max: MAX_UNIT_CENTS / MAX_SCALE }),
        fc.integer({ min: 2, max: MAX_SCALE }),
        (qty, unitCents, k) => {
          const expected = unitCents * qty;
          const scaled = expected * k;
          const verdict = admitPrice(priced(unitCents, scaled, qty));
          if (Math.abs(scaled - expected) > tolerance(qty)) {
            expect(verdict).toMatchObject({ ok: false, reason: "invariant_failed" });
          } else {
            expect(verdict.ok).toBe(true);
          }
        },
      ),
      params,
    );
  });

  it("refuses total = unit × qty ÷ k for integer k >= 2 once the gap exceeds tolerance", () => {
    fc.assert(
      fc.property(qtyArb, centsArb, fc.integer({ min: 2, max: MAX_SCALE }), (qty, unitCents, k) => {
        const expected = unitCents * qty;
        const divided = Math.floor(expected / k);
        fc.pre(divided >= 1);
        const verdict = admitPrice(priced(unitCents, divided, qty));
        if (Math.abs(divided - expected) > tolerance(qty)) {
          expect(verdict).toMatchObject({ ok: false, reason: "invariant_failed" });
        } else {
          expect(verdict.ok).toBe(true);
        }
      }),
      params,
    );
  });

  it("refuses a card or page quantity != requestedQuantity with qty_mismatch", () => {
    const arb = fc
      .tuple(qtyArb, qtyArb)
      .filter(([other, requested]) => other !== requested);
    const mismatchedArb = fc.constantFrom("card" as const, "page" as const, "both" as const);
    fc.assert(
      fc.property(arb, mismatchedArb, centsArb, centsArb, ([other, requestedQuantity], mismatched, unitCents, totalCents) => {
        const verdict = admitPrice({
          requestedQuantity,
          quantity: mismatched === "page" ? requestedQuantity : other,
          pageQuantity: pageQty(mismatched === "card" ? requestedQuantity : other),
          unit: unitOf(unitCents),
          total: totalOf(totalCents),
        });
        expect(verdict).toMatchObject({ ok: false, reason: "qty_mismatch" });
      }),
      params,
    );
  });

  it("never admits a missing, zero, negative or non-integer requestedQuantity", () => {
    const invalidRequested = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer({ min: -MAX_QTY, max: 0 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1),
    );
    fc.assert(
      fc.property(invalidRequested, qtyArb, centsArb, (requestedQuantity, quantity, unitCents) => {
        const verdict = admitPrice({
          requestedQuantity,
          quantity,
          pageQuantity: pageQty(quantity),
          unit: unitOf(unitCents),
          total: totalOf(unitCents * quantity),
        });
        expect(verdict).toMatchObject({ ok: false, reason: "qty_missing" });
      }),
      params,
    );
  });

  it("never admits a missing, invalid or unsupported pageQuantity", () => {
    const invalidPage = (qty: number) =>
      fc.oneof(
        fc.constant(undefined),
        fc.constant(null),
        fc.integer({ min: -MAX_QTY, max: 0 }).map((value) => ({ value, sourceText: `Quantity ${value}` })),
        fc.double({ noInteger: true }).map((value) => ({ value, sourceText: `Quantity ${value}` })),
        // A valid value whose source text is blank or does not show that number.
        fc.constantFrom("", "   ", "Quantity", `Quantity ${qty + 1}`, `Quantity ${qty}0`).map((sourceText) => ({
          value: qty,
          sourceText,
        })),
      );
    const arb = qtyArb.chain((qty) => fc.tuple(fc.constant(qty), invalidPage(qty)));
    fc.assert(
      fc.property(arb, centsArb, ([qty, pageQuantity], unitCents) => {
        const verdict = admitPrice({
          requestedQuantity: qty,
          quantity: qty,
          pageQuantity,
          unit: unitOf(unitCents),
          total: totalOf(unitCents * qty),
        });
        expect(verdict).toMatchObject({ ok: false, reason: "qty_missing" });
      }),
      params,
    );
  });

  it("re-admits a JSON round-tripped admitted value to a deep-equal value", () => {
    // Both sides observed for any qty, or one side observed for qty 1.
    const admittedInput: fc.Arbitrary<AdmitPriceInput> = fc.oneof(
      fc
        .tuple(qtyArb, centsArb, unitLabelArb, totalLabelArb)
        .chain(([qty, unitCents, unitLabel, totalLabel]) =>
          fc
            .integer({ min: Math.max(-tolerance(qty), 1 - unitCents * qty), max: tolerance(qty) })
            .map((delta) => ({
              requestedQuantity: qty,
              quantity: qty,
              pageQuantity: pageQty(qty),
              unit: unitOf(unitCents, unitLabel),
              total: totalOf(unitCents * qty + delta, totalLabel),
            })),
        ),
      fc.tuple(centsArb, unitLabelArb).map(([cents, label]) => ({
        requestedQuantity: 1,
        quantity: 1,
        pageQuantity: pageQty(1),
        unit: unitOf(cents, label),
      })),
      fc.tuple(centsArb, totalLabelArb).map(([cents, label]) => ({
        requestedQuantity: 1,
        quantity: 1,
        pageQuantity: pageQty(1),
        total: totalOf(cents, label),
      })),
    );
    fc.assert(
      fc.property(admittedInput, (input) => {
        const first = admitPrice(input);
        if (!first.ok) throw new Error(`generator produced a refused input: ${first.reason}`);
        const stored = JSON.parse(JSON.stringify(first.value)) as PricedQuantity;
        const again = admitPrice({
          requestedQuantity: stored.requestedQuantity,
          quantity: stored.quantity,
          pageQuantity: pageQty(stored.requestedQuantity),
          unit: stored.unitSource === "observed" ? { ...stored.unit, label: "each" } : null,
          total: stored.totalSource === "observed" ? { ...stored.total, label: "total" } : null,
        });
        expect(again).toEqual({ ok: true, value: first.value });
      }),
      params,
    );
  });

  it("never admits a qty-piece page total when one piece was requested", () => {
    // The page priced qty >= 2 pieces: unitCents each, pageTotal for all of them.
    // The adapter may report or lose the card and page quantities (or misread the
    // page control as 1) and may label any of the page amounts any way; none of
    // that may publish pageTotal for one piece.
    const amountArb = (pageAmounts: number[]) =>
      fc.oneof(fc.constantFrom(...pageAmounts), centsArb);
    const arb = fc
      .tuple(multiQtyArb, fc.integer({ min: 1, max: MAX_UNIT_CENTS / 10 }))
      .chain(([qty, unitCents]) => {
        const pageTotal = unitCents * qty;
        const page = [unitCents, pageTotal];
        const input: fc.Arbitrary<AdmitPriceInput> = fc.record({
          requestedQuantity: fc.constant(1),
          quantity: fc.constantFrom<number | null | undefined>(qty, null, undefined, 0),
          pageQuantity: fc.constantFrom<AdmitPriceInput["pageQuantity"]>(
            pageQty(qty),
            pageQty(1),
            { value: 1, sourceText: `Quantity ${qty}` },
            null,
            undefined,
          ),
          unit: fc.option(
            fc.record(
              { cents: amountArb(page), currency: fc.constant("USD"), label: unitLabelArb },
              { requiredKeys: ["cents", "currency"] },
            ),
          ),
          total: fc.option(
            fc.record(
              { cents: amountArb(page), currency: fc.constant("USD"), label: totalLabelArb },
              { requiredKeys: ["cents", "currency"] },
            ),
          ),
        });
        return fc.tuple(fc.constant(pageTotal), input);
      });
    fc.assert(
      fc.property(arb, ([pageTotal, input]) => {
        const verdict = admitPrice(input);
        expect(verdict.ok && verdict.value.total.cents === pageTotal).toBe(false);
      }),
      params,
    );
  });
});
