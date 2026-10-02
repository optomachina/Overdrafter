import { describe, expect, it } from "vitest";
import { categories, parseExactMoney, projectCost, projectReceiveDate, type CostObservation, type Fact, type Money } from "./contract";
const confirmed = <T>(value: T): Fact<T> => ({ status: "confirmed", value, evidenceRefs: ["synthetic:statement"] });
const amount = (minorUnits: string, currency = "USD") => confirmed<Money>({ currency, exponent: 2, minorUnits });
const allIn = (): CostObservation => ({ observationId: "quote-1", scopeId: "scope-1",
  currency: { code: "USD", exponent: 2 }, groups: [{ id: "all-in", covers: [...categories], amount: amount("12000") }],
  waived: [], coverageComplete: confirmed(true) });
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
describe("commercial proposal: cost facts", () => {
  it("adds separated charges once with an explicit waived fee", () => {
    const input: CostObservation = { ...allIn(), groups: [
      { id: "manufacturing", covers: ["manufacturing"], amount: amount("10000") },
      { id: "shipping", covers: ["shipping"], amount: amount("1000") },
      { id: "tax", covers: ["tax"], amount: amount("880") },
    ], waived: [{ category: "fees", fact: confirmed(true) }] };
    expect(projectCost(input).total).toEqual({ status: "confirmed", value: { currency: "USD", exponent: 2, minorUnits: "11880" }, evidenceRefs: ["synthetic:statement"] });
  });
  it("keeps an all-in total once without inventing internal allocations", () => {
    const input = freezeDeep(allIn());
    const before = JSON.stringify(input);
    expect(projectCost(input)).toMatchObject({ scopeId: "scope-1", groupIds: ["all-in"], total: { status: "confirmed", value: { minorUnits: "12000" } } });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("does not promote a precise estimated amount", () => {
    const input: CostObservation = { ...allIn(), groups: [{ ...allIn().groups[0], amount: {
      status: "estimated", value: { currency: "USD", exponent: 2, minorUnits: "12000" }, method: "provider-estimate-v1", evidenceRefs: ["synthetic:estimate"],
    } }] };
    expect(projectCost(input).total).toMatchObject({ status: "estimated", value: { minorUnits: "12000" } });
  });
  it("propagates estimated coverage even when money is confirmed", () => {
    expect(projectCost({ ...allIn(), coverageComplete: { status: "estimated", value: true, evidenceRefs: ["synthetic:coverage"], method: "provider-estimate-v1" } }).total.status).toBe("estimated");
  });
  it.each([
    ["unknown amount", { ...allIn(), groups: [{ ...allIn().groups[0], amount: { status: "unknown", reason: "not_supplied" } }] }, "unknown_required_fact"],
    ["missing coverage assertion", { ...allIn(), coverageComplete: { status: "unknown", reason: "not_supplied" } }, "coverage_not_established"],
    ["incomplete coverage assertion", { ...allIn(), coverageComplete: confirmed(false) }, "coverage_not_established"],
    ["shipping embedded with unknown tax/fees", { ...allIn(), groups: [{ id: "subtotal", covers: ["manufacturing", "shipping"], amount: amount("10000") }] }, "incomplete_categories"],
    ["additional shipping already included", { ...allIn(), groups: [...allIn().groups, { id: "extra", covers: ["shipping"], amount: amount("1500") }] }, "overlapping_coverage"],
    ["duplicate group", { ...allIn(), groups: [...allIn().groups, allIn().groups[0]] }, "duplicate_or_empty_group_id"],
    ["waived but already charged", { ...allIn(), waived: [{ category: "tax", fact: confirmed(true) }] }, "conflicting_waiver"],
    ["mixed currency", { ...allIn(), groups: [{ id: "base", covers: ["manufacturing", "tax", "fees"], amount: amount("10000", "EUR") }, { id: "shipping", covers: ["shipping"], amount: amount("1000") }] }, "currency_mismatch"],
    ["fractional minor units", { ...allIn(), groups: [{ ...allIn().groups[0], amount: amount("12.5") }] }, "invalid_minor_units"],
    ["no evidence reference", { ...allIn(), coverageComplete: { status: "confirmed", value: true, evidenceRefs: [] } }, "missing_evidence_reference"],
  ] as const)("leaves %s unknown", (_name, input, reason) => {
    expect(projectCost(input as CostObservation).total).toEqual({ status: "unknown", reason });
  });
  it("rejects same-currency scale mismatch and preserves precision in output", () => {
    const parsed = parseExactMoney("1", { code: "USD", exponent: 3 });
    if (!parsed.ok) throw new Error("fixture parse failed");
    expect(projectCost({ ...allIn(), groups: [{ ...allIn().groups[0], amount: confirmed(parsed.money) }] }).total)
      .toEqual({ status: "unknown", reason: "currency_precision_mismatch" });
    expect(projectCost(allIn()).total).toMatchObject({ value: { exponent: 2 } });
  });
  it("distinguishes confirmed zero from missing price and sums beyond float precision", () => {
    expect(projectCost({ ...allIn(), groups: [{ ...allIn().groups[0], amount: amount("0") }] }).total).toMatchObject({ status: "confirmed", value: { minorUnits: "0" } });
    expect(projectCost({ ...allIn(), groups: [
      { id: "base", covers: ["manufacturing", "tax", "fees"], amount: amount("9007199254740993") },
      { id: "shipping", covers: ["shipping"], amount: amount("1") },
    ] }).total).toMatchObject({ value: { minorUnits: "9007199254740994" } });
  });
});
describe("exact source decimal parsing, never rounding", () => {
  it.each([
    ["12.34", "USD", 2, "1234"], ["0.01", "USD", 2, "1"], ["12", "JPY", 0, "12"],
    ["1.234", "KWD", 3, "1234"], ["90071992547409.93", "USD", 2, "9007199254740993"],
  ])("parses %s in %s at declared precision", (decimal, code, exponent, minorUnits) => {
    expect(parseExactMoney(String(decimal), { code: String(code), exponent: Number(exponent) })).toEqual({ ok: true, money: { currency: code, exponent, minorUnits } });
  });
  it.each(["1.005", "1.999", "1.230"])("does not round %s to cents", (decimal) => {
    expect(parseExactMoney(decimal, { code: "USD", exponent: 2 })).toEqual({ ok: false, reason: "excess_precision" });
  });
  it.each(["-1", "1e2", "$1.00", " 1", "NaN", "01.00"])("rejects ambiguous decimal %s", (decimal) => {
    expect(parseExactMoney(decimal, { code: "USD", exponent: 2 }).ok).toBe(false);
  });
});
describe("fixed receive-date passthrough", () => {
  const input = { observationId: "quote-1", scopeId: "scope-1", endpoint: "receive" as const,
    fixedDate: confirmed("2026-10-14"), timezone: { status: "unknown" as const, reason: "unstated" }, validity: { status: "unknown" as const, reason: "unstated" } };
  it("preserves the exact date, unknown timezone and validity, without mutating or sharing source objects", () => {
    freezeDeep(input);
    const result = projectReceiveDate(input);
    expect(result.receiveDate).toEqual(input.fixedDate);
    expect(result.receiveDate).not.toBe(input.fixedDate);
    expect(result.timezone).toEqual(input.timezone);
    expect(result.validity).toEqual(input.validity);
    expect(result.scopeId).toBe("scope-1");
  });
  it.each(["ship", "unknown"] as const)("does not turn %s endpoint into receipt", (endpoint) => {
    expect(projectReceiveDate({ ...input, endpoint }).receiveDate.status).toBe("unknown");
  });
  it.each(["3 business days", "2026-02-29", "2026-10-14T00:00:00Z"])("does not infer receipt from %s", (value) => {
    expect(projectReceiveDate({ ...input, fixedDate: confirmed(value) }).receiveDate.status).toBe("unknown");
  });
  it("preserves estimated and unknown receive facts", () => {
    const estimated: Fact<string> = { status: "estimated", value: "2028-02-29", method: "provider-date-estimate", evidenceRefs: ["synthetic:date"] };
    expect(projectReceiveDate({ ...input, fixedDate: estimated }).receiveDate).toEqual(estimated);
    const unknown: Fact<string> = { status: "unknown", reason: "contradictory_dates" };
    expect(projectReceiveDate({ ...input, fixedDate: unknown }).receiveDate).toEqual(unknown);
  });
});
