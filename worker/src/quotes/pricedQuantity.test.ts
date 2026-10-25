import { describe, expect, it } from "vitest";
import {
  admitPrice,
  PAGE_QUANTITY_UNITS,
  PRICE_TOLERANCE_CENTS_PER_PIECE,
  type AdmitPriceInput,
  type PriceVerdictReason,
} from "./pricedQuantity.js";

const each = (cents: number) => ({ cents, currency: "USD", label: "each" as const });
const total = (cents: number) => ({ cents, currency: "USD", label: "total" as const });
const bare = (cents: number) => ({ cents, currency: "USD" });
const page = (value: number) => ({ value, sourceText: `Quantity ${value}` });

const refusals: Array<[string, AdmitPriceInput, PriceVerdictReason]> = [
  // Named regressions from the replan, section 3.
  ["requested 1, card $432.10 with Qty 10", { requestedQuantity: 1, quantity: 10, pageQuantity: page(1), total: total(43210) }, "qty_mismatch"],
  ["requested 1, lone unlabeled $432.10", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), total: bare(43210) }, "ambiguous_label"],
  ["requested missing", { requestedQuantity: undefined, quantity: 1, pageQuantity: page(1), total: total(43210) }, "qty_missing"],
  ["requested null", { requestedQuantity: null, quantity: 1, pageQuantity: page(1), total: total(43210) }, "qty_missing"],
  ["requested 0", { requestedQuantity: 0, quantity: 1, pageQuantity: page(1), total: total(43210) }, "qty_missing"],
  ["page qty 10, card qty 1, requested 1", { requestedQuantity: 1, quantity: 1, pageQuantity: page(10), total: total(43210) }, "qty_mismatch"],
  ["page quantity missing", { requestedQuantity: 1, quantity: 1, pageQuantity: undefined, total: total(43210) }, "qty_missing"],
  ["page quantity null", { requestedQuantity: 1, quantity: 1, pageQuantity: null, total: total(43210) }, "qty_missing"],
  ["page quantity 0", { requestedQuantity: 1, quantity: 1, pageQuantity: { value: 0, sourceText: "Quantity 0" }, total: total(43210) }, "qty_missing"],
  ["page source text empty", { requestedQuantity: 1, quantity: 1, pageQuantity: { value: 1, sourceText: "  " }, total: total(43210) }, "qty_missing"],
  ["page source text lacks the number", { requestedQuantity: 1, quantity: 1, pageQuantity: { value: 1, sourceText: "Quantity 10" }, total: total(43210) }, "qty_missing"],
  ["page source text has 1 only inside 1.5", { requestedQuantity: 1, quantity: 1, pageQuantity: { value: 1, sourceText: "Qty 1.5" }, total: total(43210) }, "qty_missing"],
  ["requested 10, lone unlabeled $43.21", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), total: bare(4321) }, "ambiguous_label"],
  ["requested 10, lone $43.21 labeled total", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), total: total(4321) }, "ambiguous_label"],
  ["requested 10, lone $43.21 ea", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: each(4321) }, "ambiguous_label"],
  // Every other reason.
  ["observed quantity missing", { requestedQuantity: 1, quantity: undefined, pageQuantity: page(1), total: total(100) }, "qty_missing"],
  ["non-integer quantity", { requestedQuantity: 2.5, quantity: 2.5, pageQuantity: page(1), unit: each(100), total: total(250) }, "qty_missing"],
  ["negative quantity", { requestedQuantity: -1, quantity: -1, pageQuantity: page(1), total: total(100) }, "qty_missing"],
  ["nothing observed", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1) }, "both_derived"],
  ["nothing observed (nulls)", { requestedQuantity: 3, quantity: 3, pageQuantity: page(3), unit: null, total: null }, "both_derived"],
  ["non-USD total", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), total: { cents: 100, currency: "EUR", label: "total" } }, "currency"],
  ["zero cents", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), total: total(0) }, "non_positive"],
  ["negative cents", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), unit: each(-5) }, "non_positive"],
  ["fractional cents", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), unit: each(10.5) }, "non_positive"],
  ["NaN cents", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), unit: each(Number.NaN) }, "non_positive"],
  ["lone unlabeled unit at qty 1", { requestedQuantity: 1, quantity: 1, pageQuantity: page(1), unit: bare(4321) }, "ambiguous_label"],
  ["unlabeled unit beside labeled total", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: bare(4321), total: total(43210) }, "ambiguous_label"],
  ["labeled unit beside unlabeled total", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: each(4321), total: bare(43210) }, "ambiguous_label"],
  ["total relabeled as unit at qty 10", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: each(43210), total: total(43210) }, "invariant_failed"],
  ["unit relabeled as total at qty 10", { requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: each(4321), total: total(4321) }, "invariant_failed"],
  ["overflowing unit × qty", { requestedQuantity: 1_000_000, quantity: 1_000_000, pageQuantity: page(1_000_000), unit: each(Number.MAX_SAFE_INTEGER), total: total(Number.MAX_SAFE_INTEGER) }, "invariant_failed"],
];

describe("admitPrice refusals", () => {
  it.each(refusals)("%s -> %s", (_name, input, reason) => {
    const verdict = admitPrice(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe(reason);
  });

  it("reports numeric detail, never page text", () => {
    const verdict = admitPrice({ requestedQuantity: 1, quantity: 10, pageQuantity: page(1), total: total(43210) });
    expect(verdict).toEqual({
      ok: false,
      reason: "qty_mismatch",
      detail: { quantity: 10, requestedQuantity: 1, pageQuantity: 1 },
    });
  });
});

describe("admitPrice admissions", () => {
  it("admits requested 10 with $43.21 ea / $432.10 at page qty 10", () => {
    expect(
      admitPrice({ requestedQuantity: 10, quantity: 10, pageQuantity: page(10), unit: each(4321), total: total(43210) }),
    ).toEqual({
      ok: true,
      value: {
        quantity: 10,
        requestedQuantity: 10,
        unit: { cents: 4321, currency: "USD" },
        total: { cents: 43210, currency: "USD" },
        unitSource: "observed",
        totalSource: "observed",
      },
    });
  });

  it("derives the unit from a labeled lone total at qty 1", () => {
    const verdict = admitPrice({ requestedQuantity: 1, quantity: 1, pageQuantity: page(1), total: { ...total(43210), label: "subtotal" } });
    expect(verdict.ok && verdict.value).toMatchObject({
      unit: { cents: 43210 },
      total: { cents: 43210 },
      unitSource: "derived",
      totalSource: "observed",
    });
  });

  it("admits a lone labeled total at qty 1 only when the page quantity is 1", () => {
    const input = { requestedQuantity: 1, quantity: 1, total: total(43210) };
    expect(admitPrice({ ...input, pageQuantity: page(1) }).ok).toBe(true);
    expect(admitPrice({ ...input, pageQuantity: page(10) })).toMatchObject({ ok: false, reason: "qty_mismatch" });
  });

  it("reads plain integer page quantities", () => {
    const pageQuantity = { value: 1000, sourceText: "Qty: 1000 pcs" };
    expect(admitPrice({ requestedQuantity: 1000, quantity: 1000, pageQuantity, unit: each(5), total: total(5000) }).ok).toBe(true);
  });

  it("derives the total from a labeled lone unit at qty 1", () => {
    const verdict = admitPrice({ requestedQuantity: 1, quantity: 1, pageQuantity: page(1), unit: { ...each(4321), label: "per_part" } });
    expect(verdict.ok && verdict.value).toMatchObject({
      unit: { cents: 4321 },
      total: { cents: 4321 },
      unitSource: "observed",
      totalSource: "derived",
    });
  });
});

describe("page quantity labeled tokens", () => {
  it.each([
    ["Quantity 10; part 1", 1],
    ["part 1", 1],
    ["Qty -1", 1],
    ["Qty +1", 1],
    ["Qty 1.5", 1],
    ["Qty 1e3", 1],
    ["Qty 1e3", 1000],
    ["Qty 1E3", 1],
    ["Qty 1E3", 1000],
    ["Qty 1; Quantity 10", 1],
    ["Qty 10; Quantity 1", 1],
    ["Qty 1,00", 100],
    ["Qty 01", 1],
    ["Qty 1/2", 1],
    ["Qty 1 / 2", 1],
    ["Qty 1'000", 1],
    ["Qty 1_000", 1],
    ["Qty 1–10", 1],
    ["Qty 1 - 10", 1],
    ["Qty 1 e3", 1],
    ["Qty 1 x 1000", 1],
    ["Qty 1\u200b000", 1],
    ["Qty 1\u0660\u0660\u0660", 1],
  ])("rejects %s with page value %i", (sourceText, quantity) => {
    expect(admitPrice({
      requestedQuantity: quantity,
      quantity,
      pageQuantity: { value: quantity, sourceText },
      unit: each(5),
      total: total(5 * quantity),
    })).toMatchObject({
      ok: false,
      reason: "qty_missing",
      detail: { pageQuantitySourceValid: false },
    });
  });

  it.each(["1 000", "1,000", "1, 000", "1;000", "1|000", "1.000", "1\u2009000", "1\u202f000", "1\u00a0000"])(
    "rejects grouped quantity %s without accepting its prefix or normalizing it",
    (token) => {
      for (const quantity of [1, 1000]) {
        expect(admitPrice({
          requestedQuantity: quantity,
          quantity,
          pageQuantity: { value: quantity, sourceText: `Qty ${token}` },
          unit: each(5),
          total: total(5 * quantity),
        })).toMatchObject({
          ok: false,
          reason: "qty_missing",
          detail: { pageQuantitySourceValid: false },
        });
      }
    },
  );

  it.each([
    ["Qty 1", 1],
    ["Qty 1000", 1000],
    ["Qty: 1000", 1000],
    ["qty 1000", 1000],
    ["QUANTITY = 10", 10],
    ["Qty 10; Quantity: 10; part 1", 10],
    ["Quantity = 25 pcs", 25],
    ["Qty 5 each;", 5],
    ["Qty 1\n", 1],
    ["Qty 7)", 7],
    ["Qty 3 units, Unit price $4.00", 3],
  ])("admits %s with page value %i", (sourceText, quantity) => {
    expect(admitPrice({
      requestedQuantity: quantity,
      quantity,
      pageQuantity: { value: quantity, sourceText },
      unit: each(5),
      total: total(5 * quantity),
    }).ok).toBe(true);
  });
});

const pageQuantityVerdict = (sourceText: string, quantity: number) =>
  admitPrice({
    requestedQuantity: quantity,
    quantity,
    pageQuantity: { value: quantity, sourceText },
    unit: each(5),
    total: total(5 * quantity),
  });

describe("page quantity suffix allowlist", () => {
  it.each([
    "Qty 1 to 10",
    "Qty 1 through 10",
    "Qty 1 - 10",
    "Qty 1-10",
    "Qty 1 or more",
    "Qty 1 k",
    "Qty 1k",
    "Qty 1 thousand",
    "Qty 1 x 1000",
    "Qty 1 of 10",
    "Qty1000",
    "Quantity1000",
    "qty1",
    "Qty 10 Qty1000",
    "Qty 1 widgets",
  ])("rejects %j for requested 1, 10 and 1000", (sourceText) => {
    for (const quantity of [1, 10, 1000]) {
      expect(pageQuantityVerdict(sourceText, quantity)).toMatchObject({
        ok: false,
        reason: "qty_missing",
        detail: { pageQuantitySourceValid: false },
      });
    }
  });

  it("rejects random words after the integer unless they are allow-listed units", () => {
    // Deterministic mulberry32 so failures reproduce.
    let seed = 0x1091;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const allowed = new Set<string>(PAGE_QUANTITY_UNITS);
    let admitted = 0;
    let refused = 0;

    for (let i = 0; i < 2000; i++) {
      const word =
        random() < 0.25
          ? [...pick(PAGE_QUANTITY_UNITS)].map((c) => (random() < 0.5 ? c.toUpperCase() : c)).join("")
          : Array.from({ length: 1 + Math.floor(random() * 8) }, () => pick([...letters])).join("");
      const quantity = pick([1, 10, 1000]);
      const sourceText = `Qty ${quantity}${pick([" ", "  ", ""])}${word}${pick(["", ";", " ,", ")"])}`;
      const verdict = pageQuantityVerdict(sourceText, quantity);
      if (allowed.has(word.toLowerCase())) {
        expect(verdict.ok, sourceText).toBe(true);
        admitted++;
      } else {
        expect(verdict, sourceText).toMatchObject({ ok: false, reason: "qty_missing" });
        refused++;
      }
    }
    expect(admitted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});

describe("runtime price label allowlists", () => {
  // Runtime observations can violate the TypeScript label unions.
  it.each(["total", "unknown", "", 123, null, undefined, true])("rejects unit label %j", (label) => {
    const input = {
      requestedQuantity: 1,
      quantity: 1,
      pageQuantity: page(1),
      unit: { ...each(100), label },
      total: total(100),
    } as unknown as AdmitPriceInput;
    expect(admitPrice(input)).toMatchObject({ ok: false, reason: "ambiguous_label" });
  });

  it.each(["each", "unknown", "", 123, null, undefined, true])("rejects total label %j", (label) => {
    const input = {
      requestedQuantity: 1,
      quantity: 1,
      pageQuantity: page(1),
      unit: each(100),
      total: { ...total(100), label },
    } as unknown as AdmitPriceInput;
    expect(admitPrice(input)).toMatchObject({ ok: false, reason: "ambiguous_label" });
  });

  it.each([
    ["each", "total"],
    ["each", "subtotal"],
    ["per_part", "total"],
    ["per_part", "subtotal"],
  ] as const)("admits unit %s with total %s", (unitLabel, totalLabel) => {
    expect(admitPrice({
      requestedQuantity: 10,
      quantity: 10,
      pageQuantity: page(10),
      unit: { ...each(100), label: unitLabel },
      total: { ...total(1000), label: totalLabel },
    }).ok).toBe(true);
  });
});

describe("admitPrice tolerance", () => {
  const qty = 7;
  const unitCents = 1234;
  const exact = unitCents * qty;
  const tol = PRICE_TOLERANCE_CENTS_PER_PIECE * qty;

  it.each([
    [exact, true],
    [exact + tol, true],
    [exact - tol, true],
    [exact + tol + 1, false],
    [exact - tol - 1, false],
  ])("total %i cents admitted: %s", (totalCents, admitted) => {
    const verdict = admitPrice({ requestedQuantity: qty, quantity: qty, pageQuantity: page(qty), unit: each(unitCents), total: total(totalCents) });
    expect(verdict.ok).toBe(admitted);
    if (!verdict.ok) expect(verdict.reason).toBe("invariant_failed");
  });
});

describe("10-piece total regression", () => {
  it("never admits a price observed at Qty 10 as a 1-piece price", () => {
    const units = [undefined, each(43210), bare(43210), each(4321)];
    const totals = [undefined, total(43210), bare(43210)];
    const quantities = [undefined, null, 0, 1, 10];
    for (const requestedQuantity of quantities) {
      for (const unit of units) {
        for (const t of totals) {
          const verdict = admitPrice({ requestedQuantity, quantity: 10, pageQuantity: page(10), unit, total: t });
          if (verdict.ok) {
            expect(verdict.value.quantity).toBe(10);
            expect(verdict.value.requestedQuantity).toBe(10);
            expect(verdict.value.total.cents).toBe(43210);
            expect(verdict.value.unit.cents).toBe(4321);
          }
        }
      }
    }
  });
});
