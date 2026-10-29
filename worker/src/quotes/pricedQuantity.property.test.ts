// @vitest-environment node

import fc from "fast-check";
import type { Page } from "patchright";
import { readPricedCardQuantity } from "../adapters/xometry.js";
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

const pageQty = (value: number) => ({ value, source: "page_dom" as const, sourceText: `Quantity ${value}` });

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
    const counts = { admitted: 0, invariant_failed: 0 };
    const scaledArb = fc.oneof(
      fc.tuple(qtyArb, fc.constant(1), fc.constant(2)), // Exactly at tolerance.
      fc.tuple(
        qtyArb,
        fc.integer({ min: 2, max: MAX_UNIT_CENTS / MAX_SCALE }),
        fc.integer({ min: 2, max: MAX_SCALE }),
      ),
    );
    fc.assert(
      fc.property(
        scaledArb,
        ([qty, unitCents, k]) => {
          const expected = unitCents * qty;
          const scaled = expected * k;
          const verdict = admitPrice(priced(unitCents, scaled, qty));
          if (Math.abs(scaled - expected) > tolerance(qty)) {
            expect(verdict).toMatchObject({ ok: false, reason: "invariant_failed" });
            counts.invariant_failed++;
          } else {
            expect(verdict).toMatchObject({ ok: true, value: { total: { cents: scaled } } });
            counts.admitted++;
          }
        },
      ),
      params,
    );
    expect(counts.admitted).toBeGreaterThanOrEqual(50);
    expect(counts.invariant_failed).toBeGreaterThanOrEqual(50);
    console.log("×k coverage", counts);
  });

  it("refuses total = unit × qty ÷ k for integer k >= 2 once the gap exceeds tolerance", () => {
    const counts = { admitted: 0, invariant_failed: 0, unitOneAdmitted: 0 };
    const dividedArb = fc.oneof(
      fc.tuple(qtyArb, fc.constant(2), fc.constant(2)), // Exactly at tolerance.
      // unit = 1, qty >= k: gap = qty − floor(qty / k) <= qty, so admitted for
      // any k and qty, not just one hand-built edge input.
      fc
        .integer({ min: 2, max: MAX_SCALE })
        .chain((k) => fc.tuple(fc.integer({ min: k, max: MAX_QTY }), fc.constant(1), fc.constant(k))),
      fc.tuple(
        qtyArb,
        fc.integer({ min: MAX_SCALE, max: MAX_UNIT_CENTS }),
        fc.integer({ min: 2, max: MAX_SCALE }),
      ), // Constructively keeps the divided total positive.
    );
    fc.assert(
      fc.property(dividedArb, ([qty, unitCents, k]) => {
        const expected = unitCents * qty;
        const divided = Math.floor(expected / k);
        const verdict = admitPrice(priced(unitCents, divided, qty));
        if (Math.abs(divided - expected) > tolerance(qty)) {
          expect(verdict).toMatchObject({ ok: false, reason: "invariant_failed" });
          counts.invariant_failed++;
        } else {
          expect(verdict).toMatchObject({ ok: true, value: { total: { cents: divided } } });
          counts.admitted++;
          if (unitCents === 1 && k > 2) counts.unitOneAdmitted++;
        }
      }),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("÷k coverage", counts);
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
        fc.integer({ min: -MAX_QTY, max: 0 }).map((value) => ({ value, source: "page_dom" as const, sourceText: `Quantity ${value}` })),
        fc.double({ noInteger: true }).map((value) => ({ value, source: "page_dom" as const, sourceText: `Quantity ${value}` })),
        // A valid value whose source text is blank or does not show that number.
        fc.constantFrom("", "   ", "Quantity", `Quantity ${qty + 1}`, `Quantity ${qty}0`).map((sourceText) => ({
          value: qty,
          source: "page_dom" as const, sourceText,
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

  it("admits canonical labeled page tokens and refuses malformed tokens with qty_missing", () => {
    const counts: Record<string, number> = { admitted: 0 };
    const kinds = ["leadingZero", "grouping", "exponent", "hex", "spacedDigit", "fraction", "nonAscii", "conflict"] as const;
    for (const kind of kinds) counts[kind] = 0;
    fc.assert(
      fc.property(
        qtyArb,
        fc.constantFrom("Quantity", "qty", "QTY"),
        fc.constantFrom(" ", ": ", " = "),
        fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
        fc.constantFrom(...kinds),
        (qty, label, separator, canonical, malformed) => {
          const badTokens: Record<string, string> = {
            leadingZero: `0${qty}`,
            grouping: `${qty},000`,
            exponent: `${qty}e3`,
            hex: `${qty}x2`,
            spacedDigit: `${qty} 0`,
            fraction: `${qty}.5`,
            nonAscii: String(qty).replace(/[0-9]/g, (digit) => String.fromCharCode(0x660 + Number(digit))),
            conflict: `${qty}; qty ${qty + 1}`,
          };
          const input = priced(100, 100 * qty, qty);
          input.pageQuantity = { value: qty, source: "page_dom" as const, sourceText: `${label}${separator}${canonical ? qty : badTokens[malformed]}` };
          const verdict = admitPrice(input);
          if (canonical) {
            expect(verdict).toMatchObject({ ok: true, value: { quantity: qty } });
            counts.admitted++;
          } else {
            expect(verdict).toMatchObject({ ok: false, reason: "qty_missing" });
            counts[malformed]++;
          }
        },
      ),
      params,
    );
    // Floor per malformed kind so no single kind can silently stop being generated.
    expect(counts.admitted).toBeGreaterThanOrEqual(50);
    for (const kind of kinds) expect(counts[kind]).toBeGreaterThanOrEqual(30);
    console.log("page token coverage", counts);
  });

  it("refuses unit × quantity overflow with invariant_failed", () => {
    // Straddles the boundary: offset 0 keeps unit × qty safe (ordinary gap refusal),
    // offset >= 1 overflows. Both arms must be reached.
    const counts = { overflow: 0, safeAtBoundary: 0 };
    fc.assert(
      fc.property(multiQtyArb, fc.integer({ min: 0, max: 3 }), (qty, offset) => {
        // Both observed amounts remain safe integers; only their product may overflow.
        const unitCents = Math.floor(Number.MAX_SAFE_INTEGER / qty) + offset;
        const verdict = admitPrice(priced(unitCents, 1, qty));
        if (offset === 0) {
          expect(verdict).toEqual({
            ok: false,
            reason: "invariant_failed",
            detail: { unitCents, totalCents: 1, quantity: qty, toleranceCents: tolerance(qty) },
          });
          counts.safeAtBoundary++;
        } else {
          expect(verdict).toEqual({
            ok: false,
            reason: "invariant_failed",
            detail: { unitCents, totalCents: 1, quantity: qty, overflow: true },
          });
          counts.overflow++;
        }
      }),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("overflow coverage", counts);
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

  it("admits the observed multi-piece total when every quantity signal incorrectly says 1", () => {
    // admitPrice cannot detect a stale multi-piece amount when every quantity
    // signal says 1. OVD-1094's readPricedCardQuantity independently reads the
    // printed card; the properties below and xometryPricedCardQuantity.test.ts
    // pin stale-card, provenance and race refusals. This property preserves
    // the residual limit when even the provider's printed evidence is wrong.
    const counts = { unitOnly: 0, totalOnly: 0, both: 0 };
    fc.assert(
      fc.property(
        multiQtyArb,
        centsArb,
        fc.constantFrom("unitOnly" as const, "totalOnly" as const, "both" as const),
        (actualPageQty, unitCents, observed) => {
          const observedCents = unitCents * actualPageQty;
          const verdict = admitPrice({
            requestedQuantity: 1,
            quantity: 1,
            pageQuantity: pageQty(1),
            unit: observed === "totalOnly" ? null : unitOf(observedCents),
            total: observed === "unitOnly" ? null : totalOf(observedCents),
          });
          expect(verdict).toEqual({
            ok: true,
            value: {
              quantity: 1,
              requestedQuantity: 1,
              unit: { cents: observedCents, currency: "USD" },
              total: { cents: observedCents, currency: "USD" },
              unitSource: observed === "totalOnly" ? "derived" : "observed",
              totalSource: observed === "unitOnly" ? "derived" : "observed",
            },
          });
          counts[observed]++;
        },
      ),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("all signals say 1: admitted coverage", counts);
  });

  it("refuses a card quantity other than 1 when one piece was requested", () => {
    const counts = { qty_missing: 0, qty_mismatch: 0 };
    const cardQtyArb = fc.oneof(
      multiQtyArb,
      fc.constantFrom(null, undefined, 0),
    );
    fc.assert(
      fc.property(cardQtyArb, centsArb, (quantity, observedCents) => {
        const reason = quantity == null || quantity === 0 ? "qty_missing" : "qty_mismatch";
        const verdict = admitPrice({
          requestedQuantity: 1,
          quantity,
          pageQuantity: pageQty(1),
          unit: unitOf(observedCents),
          total: totalOf(observedCents),
        });
        expect(verdict).toMatchObject({ ok: false, reason });
        counts[reason]++;
      }),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("card quantity other than 1 coverage", counts);
  });

  it("refuses both amounts absent with both_derived", () => {
    // Count each absent-amount shape (null/undefined per side) so every combination is hit.
    const counts: Record<string, number> = { "null/null": 0, "null/undefined": 0, "undefined/null": 0, "undefined/undefined": 0 };
    fc.assert(
      fc.property(qtyArb, fc.constantFrom(null, undefined), fc.constantFrom(null, undefined), (qty, unit, total) => {
        expect(admitPrice({ ...priced(1, qty, qty), unit, total })).toEqual({
          ok: false,
          reason: "both_derived",
          detail: { unitObserved: false, totalObserved: false },
        });
        counts[`${unit}/${total}`]++;
      }),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("both_derived coverage", counts);
  });

  it("refuses non-USD observed amounts with currency", () => {
    const counts = { unit: 0, total: 0, both: 0 };
    fc.assert(
      fc.property(
        qtyArb, centsArb,
        fc.constantFrom("EUR", "CAD", "usd", ""),
        fc.constantFrom("unit" as const, "total" as const, "both" as const),
        (qty, unitCents, currency, side) => {
          const input = priced(unitCents, unitCents * qty, qty);
          if (side !== "total") input.unit = { ...unitOf(unitCents), currency };
          if (side !== "unit") input.total = { ...totalOf(unitCents * qty), currency };
          expect(admitPrice(input)).toMatchObject({ ok: false, reason: "currency" });
          counts[side]++;
        },
      ),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("currency coverage", counts);
  });

  it("refuses non-positive or unsafe observed cents with non_positive", () => {
    const counts = { unit: 0, total: 0, both: 0 };
    const invalidCentsArb = fc.oneof(
      fc.integer({ min: -MAX_UNIT_CENTS, max: 0 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1),
    );
    fc.assert(
      fc.property(
        qtyArb, centsArb, invalidCentsArb,
        fc.constantFrom("unit" as const, "total" as const, "both" as const),
        (qty, unitCents, invalidCents, side) => {
          const input = priced(unitCents, unitCents * qty, qty);
          if (side !== "total") input.unit = unitOf(invalidCents);
          if (side !== "unit") input.total = totalOf(invalidCents);
          expect(admitPrice(input)).toMatchObject({ ok: false, reason: "non_positive" });
          counts[side]++;
        },
      ),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("non_positive coverage", counts);
  });

  it("refuses missing or unsupported observed labels with ambiguous_label", () => {
    const counts = { unit: 0, total: 0 };
    fc.assert(
      fc.property(
        qtyArb, centsArb,
        fc.constantFrom(undefined, "", "price", "wrongSide"),
        fc.boolean(),
        (qty, unitCents, label, onUnit) => {
          const input = priced(unitCents, unitCents * qty, qty);
          // Deliberately model malformed runtime labels beyond the static union.
          if (onUnit) {
            input.unit = { ...unitOf(unitCents), label: (label === "wrongSide" ? "total" : label) as "each" | undefined };
          } else {
            input.total = { ...totalOf(unitCents * qty), label: (label === "wrongSide" ? "each" : label) as "total" | undefined };
          }
          expect(admitPrice(input)).toMatchObject({ ok: false, reason: "ambiguous_label" });
          counts[onUnit ? "unit" : "total"]++;
        },
      ),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("ambiguous_label: invalid labels coverage", counts);
  });

  it("refuses a lone labeled amount for multiple pieces with ambiguous_label", () => {
    const counts = { unitOnly: 0, totalOnly: 0 };
    fc.assert(
      fc.property(multiQtyArb, centsArb, fc.boolean(), (qty, unitCents, unitOnly) => {
        const input = priced(unitCents, unitCents * qty, qty);
        if (unitOnly) input.total = null;
        else input.unit = null;
        expect(admitPrice(input)).toEqual({
          ok: false,
          reason: "ambiguous_label",
          detail: {
            unitObserved: unitOnly,
            totalObserved: !unitOnly,
            unitLabeled: unitOnly,
            totalLabeled: !unitOnly,
            quantity: qty,
          },
        });
        counts[unitOnly ? "unitOnly" : "totalOnly"]++;
      }),
      params,
    );
    for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(50);
    console.log("ambiguous_label: lone amount coverage", counts);
  });
});


// A rendered-text-only Page double: any input access throws. It advances one
// snapshot per read, so properties exercise the adapter's actual retry logic.
function cardPage(reads: Array<{ quantity: number; price: number }>): Page {
  let index = 0;
  return {
    locator() {
      const read = reads[Math.min(index++, reads.length - 1)];
      const node = {
        isVisible: async () => true,
        innerText: async () => `Qty ${read.quantity} pcs; $${read.price}`,
        inputValue: () => { throw new Error("input echo forbidden"); },
        locator: () => ({ count: async () => 1, first: () => ({
          isVisible: async () => true,
          innerText: async () => `Qty ${read.quantity} pcs; $${read.price}`,
          locator: () => ({ count: async () => 1, nth: () => ({
            isVisible: async () => true, innerText: async () => `Qty ${read.quantity} pcs`,
          }) }),
        }) }),
      };
      return { count: async () => 1, nth: () => node };
    },
    waitForTimeout: async (ms: number) => { expect(ms).toBeGreaterThanOrEqual(250); },
  } as unknown as Page;
}

describe("OVD-1094 independent printed quantity properties", () => {
  it("refuses every N >= 2 printed on the card when requested and parsed quantity are 1", async () => {
    await fc.assert(fc.asyncProperty(multiQtyArb, fc.integer(), async (quantity, cents) => {
      const read = await readPricedCardQuantity(cardPage([{ quantity, price: cents }]));
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.reason);
      expect(admitPrice({
        requestedQuantity: 1, quantity: 1, pageQuantity: read.value, total: totalOf(cents),
      })).toMatchObject({ ok: false, reason: "qty_mismatch" });
    }), params);
  });

  it("refuses every non-page_dom source for every input", () => {
    const sourceArb = fc.oneof(fc.constant("input_echo"), fc.string()).filter((source) => source !== "page_dom");
    fc.assert(fc.property(qtyArb, qtyArb, fc.integer(), sourceArb, (requestedQuantity, quantity, cents, source) => {
      expect(admitPrice({
        requestedQuantity, quantity,
        pageQuantity: { ...pageQty(quantity), source: source as "input_echo" },
        total: totalOf(cents),
      })).toMatchObject({ ok: false, reason: "page_qty_unproven" });
    }), params);
  });

  it("never admits two reads that differ in quantity or price, including the retry", async () => {
    await fc.assert(fc.asyncProperty(qtyArb, centsArb, fc.constantFrom("quantity", "price", "both"), async (quantity, price, changed) => {
      const first = { quantity, price };
      const second = {
        quantity: changed === "price" ? quantity : quantity + 1,
        price: changed === "quantity" ? price : price + 1,
      };
      expect(await readPricedCardQuantity(cardPage([first, second, first, second])))
        .toMatchObject({ ok: false, reason: "page_qty_unstable" });
    }), params);
  });
});
