/** Proposal v1: pure arithmetic over already scope-bound observations, NOT production policy.
 * Evidence references/status are preserved assertions, not verified provenance or authority.
 */
export type Fact<T> =
  | { readonly status: "confirmed"; readonly value: T; readonly evidenceRefs: readonly string[] }
  | { readonly status: "estimated"; readonly value: T; readonly evidenceRefs: readonly string[]; readonly method: string }
  | { readonly status: "unknown"; readonly reason: string };
export type Currency = { readonly code: string; readonly exponent: number };
export type Money = { readonly currency: string; readonly exponent: number; readonly minorUnits: string };
export const categories = ["manufacturing", "shipping", "tax", "fees"] as const;
export type Category = typeof categories[number];
export type ChargeGroup = {
  readonly id: string;
  readonly covers: readonly Category[];
  readonly amount: Fact<Money>;
};
export type CostObservation = {
  readonly observationId: string;
  readonly scopeId: string;
  readonly currency: Currency;
  readonly groups: readonly ChargeGroup[];
  readonly waived: readonly { readonly category: Category; readonly fact: Fact<true> }[];
  readonly coverageComplete: Fact<boolean>;
};
export type CostProjection = {
  readonly contract: "commercial-proposal-v1";
  readonly observationId: string;
  readonly scopeId: string;
  readonly derivation: "computed";
  readonly total: Fact<Money>;
  readonly groupIds: readonly string[];
};

function validCurrency(currency: Currency): boolean {
  return /^[A-Z]{3}$/.test(currency.code) && Number.isInteger(currency.exponent)
    && currency.exponent >= 0 && currency.exponent <= 6;
}

/** No rounding: even an extra trailing zero exceeds the declared source precision. */
export function parseExactMoney(decimal: string, currency: Currency):
  { readonly ok: true; readonly money: Money } | { readonly ok: false; readonly reason: string } {
  if (!validCurrency(currency)) return { ok: false, reason: "invalid_currency_contract" };
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(decimal)) return { ok: false, reason: "invalid_decimal" };
  const [whole, fraction = ""] = decimal.split(".");
  if (fraction.length > currency.exponent) return { ok: false, reason: "excess_precision" };
  return { ok: true, money: { currency: currency.code, exponent: currency.exponent,
    minorUnits: BigInt(whole + fraction.padEnd(currency.exponent, "0")).toString() } };
}

/** Each category must be covered exactly once, or explicitly waived. Unknown is never zero.
 * The category taxonomy/coverage assertion require business approval before integration.
 */
export function projectCost(input: CostObservation): CostProjection {
  const base = { contract: "commercial-proposal-v1" as const, observationId: input.observationId,
    scopeId: input.scopeId, derivation: "computed" as const, groupIds: input.groups.map((g) => g.id) };
  const unknown = (reason: string): CostProjection => ({ ...base, total: { status: "unknown", reason } });
  if (!validCurrency(input.currency)) return unknown("invalid_currency_contract");
  const covered = new Set<Category>();
  const ids = new Set<string>();
  // Validate topology before amounts: a cheaper known value cannot resolve a conflict.
  for (const group of input.groups) {
    if (!group.id || ids.has(group.id)) return unknown("duplicate_or_empty_group_id");
    ids.add(group.id);
    if (!group.covers.length) return unknown("empty_group_coverage");
    for (const category of group.covers) {
      if (!categories.includes(category)) return unknown("unsupported_category");
      if (covered.has(category)) return unknown("overlapping_coverage");
      covered.add(category);
    }
  }
  for (const waiver of input.waived) {
    if (!categories.includes(waiver.category)) return unknown("unsupported_category");
    if (covered.has(waiver.category)) return unknown("conflicting_waiver");
    covered.add(waiver.category);
  }
  if (categories.some((category) => !covered.has(category))) return unknown("incomplete_categories");
  if (input.coverageComplete.status === "unknown" || input.coverageComplete.value !== true) {
    return unknown("coverage_not_established");
  }
  const dependencies = [input.coverageComplete, ...input.waived.map((w) => w.fact), ...input.groups.map((g) => g.amount)];
  const refs: string[] = [];
  let estimated = false;
  for (const fact of dependencies) {
    if (fact.status === "unknown") return unknown("unknown_required_fact");
    if (!fact.evidenceRefs.length || fact.evidenceRefs.some((ref) => !ref.trim())) return unknown("missing_evidence_reference");
    refs.push(...fact.evidenceRefs);
    if (fact.status === "estimated") {
      if (!fact.method.trim()) return unknown("missing_estimation_method");
      estimated = true;
    }
  }
  if (input.waived.some((w) => w.fact.status !== "unknown" && w.fact.value !== true)) return unknown("invalid_waiver");
  let sum = 0n;
  for (const group of input.groups) {
    if (group.amount.status === "unknown") return unknown("unknown_required_fact");
    const money = group.amount.value;
    if (money.currency !== input.currency.code) return unknown("currency_mismatch");
    if (money.exponent !== input.currency.exponent) return unknown("currency_precision_mismatch");
    if (!/^(0|[1-9]\d*)$/.test(money.minorUnits)) return unknown("invalid_minor_units");
    sum += BigInt(money.minorUnits);
  }
  const value = { currency: input.currency.code, exponent: input.currency.exponent, minorUnits: sum.toString() };
  const evidenceRefs = [...new Set(refs)];
  return { ...base, total: estimated
    ? { status: "estimated", value, evidenceRefs, method: "commercial-proposal-v1:sum-once" }
    : { status: "confirmed", value, evidenceRefs } };
}

export type DateObservation = {
  readonly observationId: string;
  readonly scopeId: string;
  readonly endpoint: "receive" | "ship" | "unknown";
  readonly fixedDate: Fact<string>;
  readonly timezone: Fact<string>;
  readonly validity: Fact<string>;
};
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
/** Date-only passthrough. No order-date input, inferred transit, timezone or expiry renewal. */
export function projectReceiveDate(input: DateObservation) {
  let receiveDate: Fact<string> = structuredClone(input.fixedDate);
  if (input.endpoint !== "receive") receiveDate = { status: "unknown", reason: "receive_endpoint_not_established" };
  else if (receiveDate.status !== "unknown") {
    if (!isCalendarDate(receiveDate.value)) receiveDate = { status: "unknown", reason: "invalid_fixed_date" };
    else if (!receiveDate.evidenceRefs.length || receiveDate.evidenceRefs.some((ref) => !ref.trim())) {
      receiveDate = { status: "unknown", reason: "missing_evidence_reference" };
    } else if (receiveDate.status === "estimated" && !receiveDate.method.trim()) {
      receiveDate = { status: "unknown", reason: "missing_estimation_method" };
    }
  }
  return { contract: "commercial-proposal-v1" as const, observationId: input.observationId,
    scopeId: input.scopeId, derivation: "observed" as const, receiveDate,
    timezone: structuredClone(input.timezone), validity: structuredClone(input.validity) };
}
