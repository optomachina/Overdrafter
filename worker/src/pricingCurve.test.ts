// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  analyzePricingCurve,
  estimateUnitPriceAtQuantity,
  shouldUsePricingEstimate,
  type PricingCurveObservation,
} from "./pricingCurve";

describe("analyzePricingCurve", () => {
  it("analyzes a complete quantity curve with price breaks and lead-time changes", () => {
    const observations: PricingCurveObservation[] = [
      {
        requestedQuantity: 100,
        unitPriceUsd: 7,
        totalPriceUsd: 700,
        leadTimeBusinessDays: 12,
        vendorStatus: "official_quote_received",
      },
      {
        requestedQuantity: 1,
        unitPriceUsd: 30,
        totalPriceUsd: 30,
        leadTimeBusinessDays: 6,
        vendorStatus: "instant_quote_received",
      },
      {
        requestedQuantity: 10,
        unitPriceUsd: 12,
        totalPriceUsd: 120,
        leadTimeBusinessDays: 8,
        vendorStatus: "instant_quote_received",
      },
    ];

    const analysis = analyzePricingCurve(observations);

    expect(analysis.reliable).toBe(true);
    expect(analysis.reason).toBe("ok");
    expect(analysis.completeness).toBe(1);
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.9);
    expect(analysis.pricedObservations.map((observation) => observation.requestedQuantity)).toEqual([1, 10, 100]);
    expect(analysis.gapObservations).toEqual([]);
    expect(analysis.priceBreaks).toEqual([
      {
        fromQuantity: 1,
        toQuantity: 10,
        unitPriceChangeUsd: -18,
        unitPriceChangePercent: -0.6,
        totalPriceChangeUsd: 90,
        leadTimeChangeBusinessDays: 2,
      },
      {
        fromQuantity: 10,
        toQuantity: 100,
        unitPriceChangeUsd: -5,
        unitPriceChangePercent: -0.4167,
        totalPriceChangeUsd: 580,
        leadTimeChangeBusinessDays: 4,
      },
    ]);
    expect(analysis.leadTimeChanges).toEqual([
      { fromQuantity: 1, toQuantity: 10, changeBusinessDays: 2 },
      { fromQuantity: 10, toQuantity: 100, changeBusinessDays: 4 },
    ]);
    expect(analysis.unitPriceLogSlope).toBeLessThan(0);
  });

  it("keeps manual-review rows as gaps without inventing prices", () => {
    const analysis = analyzePricingCurve([
      {
        requestedQuantity: 1,
        unitPriceUsd: 40,
        totalPriceUsd: 40,
        leadTimeBusinessDays: 5,
        vendorStatus: "instant_quote_received",
      },
      {
        requestedQuantity: 10,
        unitPriceUsd: null,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        vendorStatus: "manual_review_pending",
      },
      {
        requestedQuantity: 100,
        unitPriceUsd: 9,
        totalPriceUsd: 900,
        leadTimeBusinessDays: 15,
        vendorStatus: "official_quote_received",
      },
    ]);

    expect(analysis.reliable).toBe(true);
    expect(analysis.completeness).toBe(0.6667);
    expect(analysis.gapObservations).toHaveLength(1);
    expect(analysis.gapObservations[0]).toMatchObject({
      requestedQuantity: 10,
      unitPriceUsd: null,
      totalPriceUsd: null,
      vendorStatus: "manual_review_pending",
    });
    expect(analysis.priceBreaks).toHaveLength(1);
    expect(analysis.priceBreaks[0]).toMatchObject({
      fromQuantity: 1,
      toQuantity: 100,
      unitPriceChangeUsd: -31,
    });
  });

  it("reports no reliable curve when fewer than two priced quantities exist", () => {
    const manualOnly = analyzePricingCurve([
      {
        requestedQuantity: 1,
        unitPriceUsd: null,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        vendorStatus: "manual_review",
      },
    ]);
    const onePricedRow = analyzePricingCurve([
      {
        requestedQuantity: 10,
        unitPriceUsd: 14,
        totalPriceUsd: 140,
        leadTimeBusinessDays: 8,
        vendorStatus: "instant_quote_received",
      },
    ]);

    expect(manualOnly).toMatchObject({
      reliable: false,
      reason: "not_enough_priced_quantities",
      confidence: 0,
      unitPriceLogSlope: null,
    });
    expect(onePricedRow).toMatchObject({
      reliable: false,
      reason: "not_enough_priced_quantities",
      confidence: 0,
      unitPriceLogSlope: null,
    });
    expect(estimateUnitPriceAtQuantity(manualOnly, 50, 0.7)).toBeNull();
    expect(estimateUnitPriceAtQuantity(onePricedRow, 50, 0.7)).toBeNull();
  });

  it("hides estimates below the configured confidence threshold and marks usable estimates as internal only", () => {
    const analysis = analyzePricingCurve([
      {
        requestedQuantity: 1,
        unitPriceUsd: 50,
        totalPriceUsd: 50,
        leadTimeBusinessDays: 5,
        vendorStatus: "instant_quote_received",
      },
      {
        requestedQuantity: 10,
        unitPriceUsd: 18,
        totalPriceUsd: 180,
        leadTimeBusinessDays: 8,
        vendorStatus: "official_quote_received",
      },
      {
        requestedQuantity: 100,
        unitPriceUsd: 8,
        totalPriceUsd: 800,
        leadTimeBusinessDays: 11,
        vendorStatus: "official_quote_received",
      },
    ]);

    expect(shouldUsePricingEstimate(analysis, 0.99)).toBe(false);
    expect(estimateUnitPriceAtQuantity(analysis, 50, 0.99)).toBeNull();

    const estimate = estimateUnitPriceAtQuantity(analysis, 50, 0.7);

    expect(estimate).toMatchObject({
      requestedQuantity: 50,
      confidence: analysis.confidence,
      estimateOnly: true,
      requiresLiveVerification: true,
      countsAsRealQuote: false,
    });
    expect(estimate?.estimatedUnitPriceUsd).toBeGreaterThan(0);
    expect(estimate?.estimatedTotalPriceUsd).toBeGreaterThan(0);
  });
});
