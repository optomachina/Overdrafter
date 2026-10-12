import { describe, expect, it } from "vitest";
import {
  DELIVERED_COST_ARRIVAL_CONTRACT_VERSION,
  MAX_SHIPPING_SCENARIOS,
  projectDeliveredCostAndArrival,
  type DeliveryProjectionScenario,
  type HypotheticalShippingScenario,
  type ProviderDeliveryObservation,
} from "./delivered-cost-arrival";

// Pacific calendar. October 2026 is PDT (UTC-7): 14:00 PT == 21:00Z.
// 2026-10-09 is a Friday, 2026-10-10 Saturday, 2026-10-12 Monday.
const PACIFIC = { timeZone: "America/Los_Angeles" } as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function makeObservation(
  overrides: Partial<ProviderDeliveryObservation> = {},
): ProviderDeliveryObservation {
  return {
    offerId: "offer-1",
    provider: "xometry",
    partsSubtotalUsd: 120,
    feesUsd: null,
    taxUsd: null,
    shippingOptions: [],
    leadTime: { kind: "business_days", businessDays: 3 },
    orderCutoffLocalTime: "14:00",
    validUntil: "2026-10-30T23:59:59.999Z",
    invalidatedAt: null,
    ...overrides,
  };
}

function makeScenario(
  overrides: Partial<DeliveryProjectionScenario> = {},
): DeliveryProjectionScenario {
  return {
    orderAt: "2026-10-09T17:00:00.000Z",
    calendar: PACIFIC,
    ...overrides,
  };
}

const groundEstimate: HypotheticalShippingScenario = {
  id: "ground",
  label: "Ground (estimate)",
  estimatedCostUsd: 18.5,
  estimatedTransitBusinessDays: 4,
};

describe("projectDeliveredCostAndArrival: immutable provider observations", () => {
  it("never mutates deep-frozen observations across order-date and shipping scenario changes", () => {
    const observation = deepFreeze(
      makeObservation({
        feesUsd: 12,
        shippingOptions: [
          { id: "ups-2day", label: "UPS 2nd Day", costUsd: 42, transitBusinessDays: 2 },
        ],
      }),
    );
    const snapshot = structuredClone(observation);
    const scenarios = [
      makeScenario(),
      makeScenario({ orderAt: "2026-10-10T18:00:00.000Z" }),
      makeScenario({ orderAt: "2026-11-25T16:00:00.000Z", estimatedTaxRate: 0.0825 }),
      makeScenario({ hypotheticalShipping: [groundEstimate] }),
      makeScenario({ calendar: { timeZone: "UTC", holidays: ["2026-10-12"] } }),
    ].map(deepFreeze);
    const scenarioSnapshots = structuredClone(scenarios);

    const projections = scenarios.map((scenario) =>
      projectDeliveredCostAndArrival(observation, scenario),
    );

    expect(observation).toEqual(snapshot);
    expect(scenarios).toEqual(scenarioSnapshots);
    expect(new Set(projections.map((p) => p.scenarios[0]?.arrival.shipDate)).size).toBeGreaterThan(1);
  });

  it("returns frozen output that does not alias input arrays", () => {
    const observation = makeObservation({
      shippingOptions: [{ id: "a", label: "A", costUsd: 5, transitBusinessDays: 1 }],
    });
    const projection = projectDeliveredCostAndArrival(observation, makeScenario());

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.scenarios)).toBe(true);
    expect(Object.isFrozen(projection.scenarios[0].cost.components.shipping)).toBe(true);
    expect(Object.isFrozen(projection.scenarios[0].arrival.missing)).toBe(true);
    expect(projection.scenarios).not.toBe(observation.shippingOptions);
    expect(projection.contractVersion).toBe(DELIVERED_COST_ARRIVAL_CONTRACT_VERSION);
  });

  it("is deterministic for identical inputs", () => {
    const observation = makeObservation({ feesUsd: 3 });
    const scenario = makeScenario({ hypotheticalShipping: [groundEstimate], estimatedTaxRate: 0.07 });
    expect(projectDeliveredCostAndArrival(observation, scenario)).toEqual(
      projectDeliveredCostAndArrival(observation, scenario),
    );
  });
});

describe("projectDeliveredCostAndArrival: unknown stays unknown", () => {
  it("keeps missing tax, fees, shipping and transit unknown rather than zero", () => {
    const projection = projectDeliveredCostAndArrival(makeObservation(), makeScenario());

    expect(projection.scenarios).toHaveLength(1);
    const [only] = projection.scenarios;
    expect(only.source).toBe("unspecified");
    expect(only.cost.components.parts).toEqual({ provenance: "confirmed", amountUsd: 120 });
    expect(only.cost.components.fees).toEqual({ provenance: "unknown", amountUsd: null });
    expect(only.cost.components.tax).toEqual({ provenance: "unknown", amountUsd: null });
    expect(only.cost.components.shipping).toEqual({ provenance: "unknown", amountUsd: null });
    expect(only.cost.total).toEqual({
      provenance: "unknown",
      amountUsd: null,
      knownAmountUsd: 120,
      unknownComponents: ["fees", "tax", "shipping"],
      estimatedComponents: [],
    });
    expect(only.arrival.shipDate).toBe("2026-10-14");
    expect(only.arrival.arrivalDate).toBeNull();
    expect(only.arrival.calendarDaysFromOrder).toBeNull();
    expect(only.arrival.provenance).toBe("unknown");
    expect(only.arrival.missing).toEqual(["transit"]);
  });

  it("keeps a missing expiry unknown instead of treating it as valid", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ validUntil: null }),
      makeScenario(),
    );
    expect(projection.validityAtOrder).toEqual({ status: "unknown", validUntil: null });
  });

  it("treats unparseable expiry as unknown", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ validUntil: "soon" }),
      makeScenario(),
    );
    expect(projection.validityAtOrder.status).toBe("unknown");
  });

  it("treats non-finite or negative provider amounts as unknown, but keeps a stated zero", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ feesUsd: Number.NaN, taxUsd: 0, partsSubtotalUsd: -1 }),
      makeScenario(),
    );
    const { components, total } = projection.scenarios[0].cost;
    expect(components.fees).toEqual({ provenance: "unknown", amountUsd: null });
    expect(components.tax).toEqual({ provenance: "confirmed", amountUsd: 0 });
    expect(components.parts).toEqual({ provenance: "unknown", amountUsd: null });
    expect(total.amountUsd).toBeNull();
    expect(total.knownAmountUsd).toBe(0);
  });

  it("keeps lead time unknown when the provider did not state one", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ leadTime: { kind: "unknown" } }),
      makeScenario({ hypotheticalShipping: [groundEstimate] }),
    );
    const { arrival } = projection.scenarios[0];
    expect(arrival.basis).toBe("unknown");
    expect(arrival.shipDate).toBeNull();
    expect(arrival.arrivalDate).toBeNull();
    expect(arrival.provenance).toBe("unknown");
    expect(arrival.missing).toEqual(["lead_time"]);
  });

  it("treats fractional or negative lead and transit days as unknown", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({
        leadTime: { kind: "business_days", businessDays: 2.5 },
        shippingOptions: [{ id: "x", label: "X", costUsd: 10, transitBusinessDays: -1 }],
      }),
      makeScenario(),
    );
    expect(projection.scenarios[0].arrival.missing).toEqual(["lead_time", "transit"]);
  });

  it("does not estimate tax when the parts subtotal is unknown", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ partsSubtotalUsd: null }),
      makeScenario({ estimatedTaxRate: 0.1 }),
    );
    expect(projection.scenarios[0].cost.components.tax).toEqual({
      provenance: "unknown",
      amountUsd: null,
    });
  });
});

describe("projectDeliveredCostAndArrival: estimates are labeled", () => {
  it("labels hypothetical shipping and tax-rate assumptions as estimated", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ feesUsd: 10 }),
      makeScenario({ hypotheticalShipping: [groundEstimate], estimatedTaxRate: 0.0825 }),
    );
    const [ground] = projection.scenarios;
    expect(ground.source).toBe("hypothetical");
    expect(ground.cost.components.shipping).toEqual({ provenance: "estimated", amountUsd: 18.5 });
    expect(ground.cost.components.tax).toEqual({ provenance: "estimated", amountUsd: 9.9 });
    expect(ground.cost.total).toEqual({
      provenance: "estimated",
      amountUsd: 158.4,
      knownAmountUsd: 158.4,
      unknownComponents: [],
      estimatedComponents: ["tax", "shipping"],
    });
    // Fri 10:00 PT before cutoff: received Fri, +3 => Wed 10-14, +4 transit => Tue 10-20.
    expect(ground.arrival).toMatchObject({
      basis: "lead_time",
      provenance: "estimated",
      orderReceivedDate: "2026-10-09",
      shipDate: "2026-10-14",
      arrivalDate: "2026-10-20",
      calendarDaysFromOrder: 11,
      missing: [],
    });
  });

  it("never lets an estimate override a provider-stated value", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ taxUsd: 4.25, feesUsd: 0 }),
      makeScenario({ estimatedTaxRate: 0.5 }),
    );
    expect(projection.scenarios[0].cost.components.tax).toEqual({
      provenance: "confirmed",
      amountUsd: 4.25,
    });
  });

  it("reports a fully provider-stated scenario as confirmed", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({
        feesUsd: 7.1,
        taxUsd: 0.2,
        shippingOptions: [{ id: "ups", label: "UPS", costUsd: 0.1, transitBusinessDays: 1 }],
      }),
      makeScenario(),
    );
    const [ups] = projection.scenarios;
    expect(ups.source).toBe("provider_option");
    expect(ups.cost.total).toMatchObject({ provenance: "confirmed", amountUsd: 127.4 });
    expect(ups.arrival).toMatchObject({ provenance: "confirmed", arrivalDate: "2026-10-15" });
  });

  it("keeps provider options before hypotheses and bounds the scenario count", () => {
    const hypotheses = Array.from({ length: MAX_SHIPPING_SCENARIOS + 2 }, (_, index) => ({
      ...groundEstimate,
      id: `h-${index}`,
    }));
    const projection = projectDeliveredCostAndArrival(
      makeObservation({
        shippingOptions: [{ id: "p", label: "P", costUsd: 1, transitBusinessDays: 1 }],
      }),
      makeScenario({ hypotheticalShipping: hypotheses }),
    );
    expect(projection.scenarios).toHaveLength(MAX_SHIPPING_SCENARIOS);
    expect(projection.scenarios[0].scenarioId).toBe("p");
    expect(projection.scenarios[1].scenarioId).toBe("h-0");
    expect(projection.omittedShippingScenarioCount).toBe(3);
  });

  it("rejects duplicate scenario ids and invalid tax rates", () => {
    expect(() =>
      projectDeliveredCostAndArrival(
        makeObservation({
          shippingOptions: [{ id: "ground", label: "P", costUsd: 1, transitBusinessDays: 1 }],
        }),
        makeScenario({ hypotheticalShipping: [groundEstimate] }),
      ),
    ).toThrow(/duplicate shipping scenario id/i);
    expect(() =>
      projectDeliveredCostAndArrival(makeObservation(), makeScenario({ estimatedTaxRate: -0.1 })),
    ).toThrow(RangeError);
  });
});

describe("projectDeliveredCostAndArrival: cutoff and business calendar", () => {
  const shipping = { hypotheticalShipping: [groundEstimate] };

  it("starts lead time the same business day before the provider cutoff", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation(),
      makeScenario({ ...shipping, orderAt: "2026-10-09T20:59:00.000Z" }),
    );
    expect(projection.orderLocalDate).toBe("2026-10-09");
    expect(projection.scenarios[0].arrival.orderReceivedDate).toBe("2026-10-09");
    expect(projection.scenarios[0].arrival.shipDate).toBe("2026-10-14");
  });

  it("rolls to the next business day at or after the cutoff", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation(),
      makeScenario({ ...shipping, orderAt: "2026-10-09T21:00:00.000Z" }),
    );
    expect(projection.scenarios[0].arrival.orderReceivedDate).toBe("2026-10-12");
    expect(projection.scenarios[0].arrival.shipDate).toBe("2026-10-15");
  });

  it("evaluates the order date in the calendar time zone, not UTC", () => {
    // 02:00Z Saturday is still Friday 19:00 in Los Angeles.
    const noCutoff = makeObservation({ orderCutoffLocalTime: null });
    const projection = projectDeliveredCostAndArrival(
      noCutoff,
      makeScenario({ ...shipping, orderAt: "2026-10-10T02:00:00.000Z" }),
    );
    expect(projection.orderLocalDate).toBe("2026-10-09");
    expect(projection.scenarios[0].arrival.orderReceivedDate).toBe("2026-10-09");

    const utc = projectDeliveredCostAndArrival(
      noCutoff,
      makeScenario({ ...shipping, orderAt: "2026-10-10T02:00:00.000Z", calendar: { timeZone: "UTC" } }),
    );
    expect(utc.orderLocalDate).toBe("2026-10-10");
    expect(utc.scenarios[0].arrival.orderReceivedDate).toBe("2026-10-12");
  });

  it("starts weekend orders on the next business day", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ leadTime: { kind: "business_days", businessDays: 1 } }),
      makeScenario({ ...shipping, orderAt: "2026-10-10T16:00:00.000Z" }),
    );
    const { arrival } = projection.scenarios[0];
    expect(arrival.orderReceivedDate).toBe("2026-10-12");
    expect(arrival.shipDate).toBe("2026-10-13");
    // +4 business days transit => Mon 10-19; Sat 10-10 -> Mon 10-19 is 9 days.
    expect(arrival.arrivalDate).toBe("2026-10-19");
    expect(arrival.calendarDaysFromOrder).toBe(9);
  });

  it("skips calendar holidays for production and transit", () => {
    // Wed 2026-11-25 08:00 PST (16:00Z), Thanksgiving Thu 11-26 is a holiday.
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ leadTime: { kind: "business_days", businessDays: 1 } }),
      makeScenario({
        orderAt: "2026-11-25T16:00:00.000Z",
        calendar: { timeZone: "America/Los_Angeles", holidays: ["2026-11-26"] },
        hypotheticalShipping: [{ ...groundEstimate, estimatedTransitBusinessDays: 1 }],
      }),
    );
    expect(projection.scenarios[0].arrival).toMatchObject({
      orderReceivedDate: "2026-11-25",
      shipDate: "2026-11-27",
      arrivalDate: "2026-11-30",
      calendarDaysFromOrder: 5,
    });
  });

  it("ships on the received day for a zero-day lead time", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ leadTime: { kind: "business_days", businessDays: 0 } }),
      makeScenario({ hypotheticalShipping: [{ ...groundEstimate, estimatedTransitBusinessDays: 0 }] }),
    );
    expect(projection.scenarios[0].arrival).toMatchObject({
      shipDate: "2026-10-09",
      arrivalDate: "2026-10-09",
      calendarDaysFromOrder: 0,
    });
  });

  it("rejects invalid order instants, time zones, cutoffs and holidays", () => {
    expect(() => projectDeliveredCostAndArrival(makeObservation(), makeScenario({ orderAt: "today" }))).toThrow(RangeError);
    expect(() =>
      projectDeliveredCostAndArrival(makeObservation(), makeScenario({ calendar: { timeZone: "Mars/Olympus" } })),
    ).toThrow(RangeError);
    expect(() =>
      projectDeliveredCostAndArrival(makeObservation({ orderCutoffLocalTime: "2pm" }), makeScenario()),
    ).toThrow(RangeError);
    expect(() =>
      projectDeliveredCostAndArrival(
        makeObservation(),
        makeScenario({ calendar: { timeZone: "UTC", holidays: ["11/26/2026"] } }),
      ),
    ).toThrow(RangeError);
  });
});

describe("projectDeliveredCostAndArrival: fixed provider delivery dates", () => {
  const fixed = makeObservation({
    leadTime: { kind: "fixed_delivery_date", date: "2026-10-23" },
  });

  it("keeps a fixed provider date independent of order date and shipping scenario", () => {
    const early = projectDeliveredCostAndArrival(
      fixed,
      makeScenario({ hypotheticalShipping: [groundEstimate] }),
    );
    const later = projectDeliveredCostAndArrival(
      fixed,
      makeScenario({
        orderAt: "2026-10-12T16:00:00.000Z",
        hypotheticalShipping: [{ ...groundEstimate, estimatedTransitBusinessDays: 9 }],
      }),
    );

    for (const projection of [early, later]) {
      expect(projection.scenarios[0].arrival).toMatchObject({
        basis: "fixed_provider_delivery_date",
        provenance: "confirmed",
        shipDate: null,
        arrivalDate: "2026-10-23",
        missing: [],
        fixedDatePassed: false,
      });
    }
    expect(early.scenarios[0].arrival.calendarDaysFromOrder).toBe(14);
    expect(later.scenarios[0].arrival.calendarDaysFromOrder).toBe(11);
    // Shipping cost is still a separate, labeled component.
    expect(early.scenarios[0].cost.components.shipping.provenance).toBe("estimated");
  });

  it("does not need transit to project a fixed delivery date", () => {
    const projection = projectDeliveredCostAndArrival(fixed, makeScenario());
    expect(projection.scenarios[0].arrival).toMatchObject({
      arrivalDate: "2026-10-23",
      provenance: "confirmed",
      missing: [],
    });
  });

  it("flags a fixed date that has already passed for the hypothetical order date", () => {
    const projection = projectDeliveredCostAndArrival(
      fixed,
      makeScenario({ orderAt: "2026-10-26T16:00:00.000Z" }),
    );
    expect(projection.scenarios[0].arrival).toMatchObject({
      arrivalDate: "2026-10-23",
      fixedDatePassed: true,
      calendarDaysFromOrder: -3,
    });
  });

  it("treats a malformed fixed date as unknown lead time", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ leadTime: { kind: "fixed_delivery_date", date: "Oct 23" } }),
      makeScenario(),
    );
    expect(projection.scenarios[0].arrival).toMatchObject({
      basis: "unknown",
      arrivalDate: null,
      missing: ["lead_time", "transit"],
    });
  });
});

describe("projectDeliveredCostAndArrival: offer validity at the hypothetical order instant", () => {
  it("reports valid, expired and invalidated offers without changing the evidence", () => {
    const observation = deepFreeze(makeObservation({ validUntil: "2026-10-12T23:59:59.999Z" }));
    expect(projectDeliveredCostAndArrival(observation, makeScenario()).validityAtOrder.status).toBe("valid");
    expect(
      projectDeliveredCostAndArrival(observation, makeScenario({ orderAt: "2026-10-13T00:00:00.000Z" }))
        .validityAtOrder,
    ).toEqual({ status: "expired", validUntil: "2026-10-12T23:59:59.999Z" });
    expect(
      projectDeliveredCostAndArrival(
        makeObservation({ invalidatedAt: "2026-10-01T00:00:00.000Z" }),
        makeScenario(),
      ).validityAtOrder.status,
    ).toBe("invalidated");
  });

  it("treats a date-only expiry as inclusive through the end of that UTC day", () => {
    const observation = makeObservation({ validUntil: "2026-10-09" });
    expect(
      projectDeliveredCostAndArrival(observation, makeScenario({ orderAt: "2026-10-09T23:59:59.000Z" }))
        .validityAtOrder.status,
    ).toBe("valid");
    expect(
      projectDeliveredCostAndArrival(observation, makeScenario({ orderAt: "2026-10-10T00:00:00.000Z" }))
        .validityAtOrder.status,
    ).toBe("expired");
  });

  it("accepts the microsecond inclusive bound written by the offer normalizer", () => {
    const projection = projectDeliveredCostAndArrival(
      makeObservation({ validUntil: "2026-10-09T23:59:59.999999Z" }),
      makeScenario({ orderAt: "2026-10-09T23:59:59.999Z" }),
    );
    expect(projection.validityAtOrder.status).toBe("valid");
  });
});
