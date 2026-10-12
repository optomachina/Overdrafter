/**
 * OVD-569: pure delivered-cost and arrival projection.
 *
 * Projects a provider offer observation onto a hypothetical order instant and a
 * bounded set of shipping scenarios. The observation is evidence: it is never
 * mutated, and nothing it omits is invented. Missing tax, fees, shipping,
 * transit, lead time and expiry stay `unknown` (never 0); caller assumptions
 * are always labeled `estimated`. All calendar math is on civil dates in the
 * caller-supplied calendar time zone, so results do not depend on the host
 * clock or zone. Consumed by the OVD-571 delivered-cost chart and table.
 */

export const DELIVERED_COST_ARRIVAL_CONTRACT_VERSION = "ovd-569.delivered-cost-arrival.v1" as const;

/** Upper bound on projected shipping scenarios per offer (provider options first). */
export const MAX_SHIPPING_SCENARIOS = 6;

export type ValueProvenance = "confirmed" | "estimated" | "unknown";

/** Civil calendar date, `YYYY-MM-DD`. */
export type IsoCalendarDate = string;

export type ProviderShippingOption = {
  id: string;
  label: string;
  costUsd: number | null;
  transitBusinessDays: number | null;
};

export type ProviderLeadTime =
  | { kind: "business_days"; businessDays: number }
  | { kind: "fixed_delivery_date"; date: IsoCalendarDate }
  | { kind: "unknown" };

/** Provider-stated facts for one offer. `null` means the provider did not state it. */
export type ProviderDeliveryObservation = {
  offerId: string;
  provider: string;
  partsSubtotalUsd: number | null;
  feesUsd: number | null;
  taxUsd: number | null;
  shippingOptions: readonly ProviderShippingOption[];
  leadTime: ProviderLeadTime;
  /** Provider order cutoff, `HH:MM` (24h) in the scenario calendar time zone. */
  orderCutoffLocalTime: string | null;
  /** Inclusive expiry instant; a bare date is inclusive through 23:59:59.999 UTC. */
  validUntil: string | null;
  invalidatedAt: string | null;
};

/** A caller assumption about shipping. Always projected as `estimated`. */
export type HypotheticalShippingScenario = {
  id: string;
  label: string;
  estimatedCostUsd: number | null;
  estimatedTransitBusinessDays: number | null;
};

export type BusinessCalendar = {
  /** IANA time zone used for the order date, cutoff and business days. */
  timeZone: string;
  holidays?: readonly IsoCalendarDate[];
};

export type DeliveryProjectionScenario = {
  /** Hypothetical order instant (ISO 8601). */
  orderAt: string;
  calendar: BusinessCalendar;
  hypotheticalShipping?: readonly HypotheticalShippingScenario[];
  /** Applied to a known parts subtotal only when the provider stated no tax. */
  estimatedTaxRate?: number | null;
};

export type CostComponentKey = "parts" | "fees" | "tax" | "shipping";

export type CostComponent =
  | { provenance: "confirmed" | "estimated"; amountUsd: number }
  | { provenance: "unknown"; amountUsd: null };

export type DeliveredCostTotal = {
  /** `unknown` if any component is unknown, else `estimated` if any is estimated. */
  provenance: ValueProvenance;
  /** Complete delivered total, or `null` while any component is unknown. */
  amountUsd: number | null;
  /** Sum of the known (confirmed and estimated) components only. */
  knownAmountUsd: number;
  unknownComponents: readonly CostComponentKey[];
  estimatedComponents: readonly CostComponentKey[];
};

export type DeliveredCost = {
  components: Readonly<Record<CostComponentKey, CostComponent>>;
  total: DeliveredCostTotal;
};

export type ArrivalBasis = "lead_time" | "fixed_provider_delivery_date" | "unknown";
export type ArrivalMissingInput = "lead_time" | "transit";

export type ArrivalProjection = {
  basis: ArrivalBasis;
  provenance: ValueProvenance;
  /** First business day production can start for this order instant. */
  orderReceivedDate: IsoCalendarDate;
  shipDate: IsoCalendarDate | null;
  arrivalDate: IsoCalendarDate | null;
  /** Calendar days from the local order date to arrival (negative if a fixed date passed). */
  calendarDaysFromOrder: number | null;
  missing: readonly ArrivalMissingInput[];
  fixedDatePassed: boolean;
};

export type OfferValidityStatus = "valid" | "expired" | "invalidated" | "unknown";

export type OfferValidityAtOrder = {
  status: OfferValidityStatus;
  validUntil: string | null;
};

export type ShippingScenarioSource = "provider_option" | "hypothetical" | "unspecified";

export type ShippingScenarioProjection = {
  scenarioId: string;
  label: string;
  source: ShippingScenarioSource;
  cost: DeliveredCost;
  arrival: ArrivalProjection;
};

export type DeliveredCostArrivalProjection = {
  contractVersion: typeof DELIVERED_COST_ARRIVAL_CONTRACT_VERSION;
  offerId: string;
  provider: string;
  orderAt: string;
  orderLocalDate: IsoCalendarDate;
  validityAtOrder: OfferValidityAtOrder;
  scenarios: readonly ShippingScenarioProjection[];
  omittedShippingScenarioCount: number;
};

type ResolvedShipping = {
  scenarioId: string;
  label: string;
  source: ShippingScenarioSource;
  cost: CostComponent;
  transitBusinessDays: number | null;
  transitProvenance: ValueProvenance;
};

const DAY_MS = 86_400_000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UNKNOWN_COST: CostComponent = { provenance: "unknown", amountUsd: null };
const COST_COMPONENT_KEYS: readonly CostComponentKey[] = ["parts", "fees", "tax", "shipping"];

/**
 * Projects delivered cost and arrival for one offer at a hypothetical order
 * instant. Pure: no clock, network or input mutation; output is deep-frozen.
 */
export function projectDeliveredCostAndArrival(
  observation: ProviderDeliveryObservation,
  scenario: DeliveryProjectionScenario,
): DeliveredCostArrivalProjection {
  const orderAtMs = Date.parse(scenario.orderAt);
  if (!Number.isFinite(orderAtMs)) {
    throw new RangeError(`Invalid orderAt instant: ${scenario.orderAt}`);
  }
  const cutoffMinutes = parseCutoffMinutes(observation.orderCutoffLocalTime);
  const holidays = parseHolidays(scenario.calendar.holidays ?? []);
  const taxRate = parseTaxRate(scenario.estimatedTaxRate);

  const local = localDateTime(orderAtMs, scenario.calendar.timeZone);
  const isBusinessDay = (day: number) => isBusinessEpochDay(day, holidays);
  const beforeCutoff = cutoffMinutes === null || local.minutes < cutoffMinutes;
  const orderReceivedDay = isBusinessDay(local.epochDay) && beforeCutoff
    ? local.epochDay
    : nextBusinessDay(local.epochDay, isBusinessDay);

  const parts = providerCost(observation.partsSubtotalUsd);
  const fees = providerCost(observation.feesUsd);
  const tax = resolveTax(observation.taxUsd, parts, taxRate);

  const { shipping, omitted } = resolveShippingScenarios(
    observation.shippingOptions,
    scenario.hypotheticalShipping ?? [],
  );

  const scenarios = shipping.map((resolved): ShippingScenarioProjection => ({
    scenarioId: resolved.scenarioId,
    label: resolved.label,
    source: resolved.source,
    cost: buildDeliveredCost({ parts, fees, tax, shipping: resolved.cost }),
    arrival: projectArrival({
      leadTime: observation.leadTime,
      shipping: resolved,
      orderLocalDay: local.epochDay,
      orderReceivedDay,
      isBusinessDay,
    }),
  }));

  return deepFreeze({
    contractVersion: DELIVERED_COST_ARRIVAL_CONTRACT_VERSION,
    offerId: observation.offerId,
    provider: observation.provider,
    orderAt: scenario.orderAt,
    orderLocalDate: formatEpochDay(local.epochDay),
    validityAtOrder: resolveValidity(observation, orderAtMs),
    scenarios,
    omittedShippingScenarioCount: omitted,
  });
}

function providerCost(value: number | null): CostComponent {
  return isNonNegativeFinite(value) ? { provenance: "confirmed", amountUsd: value } : UNKNOWN_COST;
}

function estimatedCost(value: number | null): CostComponent {
  return isNonNegativeFinite(value) ? { provenance: "estimated", amountUsd: value } : UNKNOWN_COST;
}

function resolveTax(providerTax: number | null, parts: CostComponent, taxRate: number | null): CostComponent {
  const stated = providerCost(providerTax);
  if (stated.provenance !== "unknown" || taxRate === null || parts.amountUsd === null) {
    return stated;
  }
  return { provenance: "estimated", amountUsd: roundCents(parts.amountUsd * taxRate) };
}

function resolveShippingScenarios(
  providerOptions: readonly ProviderShippingOption[],
  hypotheses: readonly HypotheticalShippingScenario[],
): { shipping: ResolvedShipping[]; omitted: number } {
  const all: ResolvedShipping[] = [
    ...providerOptions.map((option): ResolvedShipping => {
      const transit = nonNegativeInteger(option.transitBusinessDays);
      return {
        scenarioId: option.id,
        label: option.label,
        source: "provider_option",
        cost: providerCost(option.costUsd),
        transitBusinessDays: transit,
        transitProvenance: transit === null ? "unknown" : "confirmed",
      };
    }),
    ...hypotheses.map((hypothesis): ResolvedShipping => {
      const transit = nonNegativeInteger(hypothesis.estimatedTransitBusinessDays);
      return {
        scenarioId: hypothesis.id,
        label: hypothesis.label,
        source: "hypothetical",
        cost: estimatedCost(hypothesis.estimatedCostUsd),
        transitBusinessDays: transit,
        transitProvenance: transit === null ? "unknown" : "estimated",
      };
    }),
  ];

  const seen = new Set<string>();
  for (const entry of all) {
    if (seen.has(entry.scenarioId)) {
      throw new RangeError(`Duplicate shipping scenario id: ${entry.scenarioId}`);
    }
    seen.add(entry.scenarioId);
  }

  if (all.length === 0) {
    return {
      shipping: [{
        scenarioId: "unspecified",
        label: "Shipping not specified",
        source: "unspecified",
        cost: UNKNOWN_COST,
        transitBusinessDays: null,
        transitProvenance: "unknown",
      }],
      omitted: 0,
    };
  }

  return {
    shipping: all.slice(0, MAX_SHIPPING_SCENARIOS),
    omitted: Math.max(0, all.length - MAX_SHIPPING_SCENARIOS),
  };
}

function buildDeliveredCost(components: Record<CostComponentKey, CostComponent>): DeliveredCost {
  const unknownComponents = COST_COMPONENT_KEYS.filter((key) => components[key].provenance === "unknown");
  const estimatedComponents = COST_COMPONENT_KEYS.filter((key) => components[key].provenance === "estimated");
  const knownAmountUsd = roundCents(
    COST_COMPONENT_KEYS.reduce((sum, key) => sum + (components[key].amountUsd ?? 0), 0),
  );
  const provenance: ValueProvenance = unknownComponents.length > 0
    ? "unknown"
    : estimatedComponents.length > 0 ? "estimated" : "confirmed";

  return {
    components: { ...components },
    total: {
      provenance,
      amountUsd: unknownComponents.length > 0 ? null : knownAmountUsd,
      knownAmountUsd,
      unknownComponents,
      estimatedComponents,
    },
  };
}

function projectArrival(input: {
  leadTime: ProviderLeadTime;
  shipping: ResolvedShipping;
  orderLocalDay: number;
  orderReceivedDay: number;
  isBusinessDay: (day: number) => boolean;
}): ArrivalProjection {
  const orderReceivedDate = formatEpochDay(input.orderReceivedDay);
  const unknownLeadTime: ArrivalProjection = {
    basis: "unknown",
    provenance: "unknown",
    orderReceivedDate,
    shipDate: null,
    arrivalDate: null,
    calendarDaysFromOrder: null,
    missing: input.shipping.transitBusinessDays === null ? ["lead_time", "transit"] : ["lead_time"],
    fixedDatePassed: false,
  };

  if (input.leadTime.kind === "fixed_delivery_date") {
    const fixedDay = parseEpochDay(input.leadTime.date);
    if (fixedDay === null) {
      return unknownLeadTime;
    }
    return {
      basis: "fixed_provider_delivery_date",
      provenance: "confirmed",
      orderReceivedDate,
      shipDate: null,
      arrivalDate: formatEpochDay(fixedDay),
      calendarDaysFromOrder: fixedDay - input.orderLocalDay,
      missing: [],
      fixedDatePassed: fixedDay < input.orderLocalDay,
    };
  }

  const leadDays = input.leadTime.kind === "business_days"
    ? nonNegativeInteger(input.leadTime.businessDays)
    : null;
  if (leadDays === null) {
    return unknownLeadTime;
  }

  const shipDay = addBusinessDays(input.orderReceivedDay, leadDays, input.isBusinessDay);
  const transit = input.shipping.transitBusinessDays;
  const arrivalDay = transit === null ? null : addBusinessDays(shipDay, transit, input.isBusinessDay);

  return {
    basis: "lead_time",
    provenance: input.shipping.transitProvenance,
    orderReceivedDate,
    shipDate: formatEpochDay(shipDay),
    arrivalDate: arrivalDay === null ? null : formatEpochDay(arrivalDay),
    calendarDaysFromOrder: arrivalDay === null ? null : arrivalDay - input.orderLocalDay,
    missing: arrivalDay === null ? ["transit"] : [],
    fixedDatePassed: false,
  };
}

function resolveValidity(observation: ProviderDeliveryObservation, orderAtMs: number): OfferValidityAtOrder {
  const validUntil = observation.validUntil;
  if (observation.invalidatedAt) {
    return { status: "invalidated", validUntil };
  }
  const expiresAtMs = parseInclusiveExpiry(validUntil);
  if (expiresAtMs === null) {
    return { status: "unknown", validUntil };
  }
  return { status: orderAtMs <= expiresAtMs ? "valid" : "expired", validUntil };
}

function parseInclusiveExpiry(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const day = parseEpochDay(value);
  if (day !== null) {
    return (day + 1) * DAY_MS - 1;
  }
  // Date.parse keeps millisecond precision; truncating a microsecond bound
  // (e.g. `.999999Z`) to `.999Z` preserves the inclusive millisecond.
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCutoffMinutes(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Invalid order cutoff local time (expected HH:MM): ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseHolidays(values: readonly IsoCalendarDate[]): ReadonlySet<number> {
  return new Set(values.map((value) => {
    const day = parseEpochDay(value);
    if (day === null) {
      throw new RangeError(`Invalid holiday date (expected YYYY-MM-DD): ${value}`);
    }
    return day;
  }));
}

function parseTaxRate(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(`Invalid estimated tax rate (expected 0 <= rate < 1): ${value}`);
  }
  return value;
}

/** Local civil day (days since epoch) and minutes after local midnight. */
function localDateTime(instantMs: number, timeZone: string): { epochDay: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    epochDay: Math.floor(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS),
    minutes: part("hour") * 60 + part("minute"),
  };
}

function parseEpochDay(value: string): number | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return ms / DAY_MS;
}

function formatEpochDay(epochDay: number): IsoCalendarDate {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

function isBusinessEpochDay(epochDay: number, holidays: ReadonlySet<number>): boolean {
  // 1970-01-01 (epoch day 0) was a Thursday.
  const weekday = (((epochDay + 4) % 7) + 7) % 7;
  return weekday !== 0 && weekday !== 6 && !holidays.has(epochDay);
}

function nextBusinessDay(epochDay: number, isBusinessDay: (day: number) => boolean): number {
  let day = epochDay + 1;
  while (!isBusinessDay(day)) {
    day += 1;
  }
  return day;
}

function addBusinessDays(epochDay: number, count: number, isBusinessDay: (day: number) => boolean): number {
  let day = epochDay;
  for (let remaining = count; remaining > 0; remaining -= 1) {
    day = nextBusinessDay(day, isBusinessDay);
  }
  return day;
}

function isNonNegativeFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return isNonNegativeFinite(value) && Number.isInteger(value) ? value : null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
