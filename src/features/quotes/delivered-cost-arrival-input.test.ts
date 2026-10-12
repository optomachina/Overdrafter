import { describe, expect, it } from "vitest";
import { makeClientQuoteOption } from "@/components/quotes/test-option-factory";
import { projectDeliveredCostAndArrival } from "../../../shared/delivered-cost-arrival";
import { toProviderDeliveryObservation } from "./delivered-cost-arrival-input";

const referenceDate = new Date("2026-10-09T12:00:00.000Z");

describe("toProviderDeliveryObservation", () => {
  it("maps provider-stated price, lead time and validity without inventing tax, fees or shipping", () => {
    const option = Object.freeze(
      makeClientQuoteOption({
        offerId: "offer-a",
        persistedOfferId: "row-a",
        vendorKey: "fictiv",
        totalPriceUsd: 240,
        leadTimeBusinessDays: 5,
        validUntil: "2026-10-30T23:59:59.999999Z",
        invalidatedAt: null,
      }),
    );
    const snapshot = structuredClone(option);

    const observation = toProviderDeliveryObservation(option, { referenceDate });

    expect(option).toEqual(snapshot);
    expect(observation).toEqual({
      offerId: "row-a",
      provider: "fictiv",
      partsSubtotalUsd: 240,
      feesUsd: null,
      taxUsd: null,
      shippingOptions: [],
      leadTime: { kind: "business_days", businessDays: 5 },
      orderCutoffLocalTime: null,
      validUntil: "2026-10-30T23:59:59.999999Z",
      invalidatedAt: null,
    });
  });

  it("prefers the provider's fixed receive-by date over lead-time duration", () => {
    const observation = toProviderDeliveryObservation(
      makeClientQuoteOption({ shipReceiveBy: "Oct 23", leadTimeBusinessDays: 5 }),
      { referenceDate },
    );
    expect(observation.leadTime).toEqual({ kind: "fixed_delivery_date", date: "2026-10-23" });
  });

  it("keeps an unknown lead time and expiry unknown", () => {
    const observation = toProviderDeliveryObservation(
      makeClientQuoteOption({ leadTimeBusinessDays: null, validUntil: undefined }),
      { referenceDate },
    );
    expect(observation.leadTime).toEqual({ kind: "unknown" });
    expect(observation.validUntil).toBeNull();
  });

  it("feeds the shared projection contract", () => {
    const projection = projectDeliveredCostAndArrival(
      toProviderDeliveryObservation(makeClientQuoteOption({ totalPriceUsd: 120 }), { referenceDate }),
      { orderAt: "2026-10-09T17:00:00.000Z", calendar: { timeZone: "America/Los_Angeles" } },
    );
    expect(projection.scenarios[0].cost.total).toMatchObject({
      provenance: "unknown",
      amountUsd: null,
      knownAmountUsd: 120,
    });
    expect(projection.scenarios[0].arrival.shipDate).toBe("2026-10-20");
  });
});
