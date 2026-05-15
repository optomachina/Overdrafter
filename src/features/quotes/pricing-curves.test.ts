import { describe, expect, it } from "vitest";
import type { VendorQuoteAggregate } from "@/features/quotes/types";
import { buildVendorPricingCurves, classifyPricingCurveTrend } from "@/features/quotes/pricing-curves";

function makeQuote(overrides: Partial<VendorQuoteAggregate> = {}): VendorQuoteAggregate {
  return {
    id: overrides.id ?? "quote-1",
    organization_id: overrides.organization_id ?? "org-1",
    quote_run_id: overrides.quote_run_id ?? "run-1",
    part_id: overrides.part_id ?? "part-1",
    vendor: overrides.vendor ?? "xometry",
    status: overrides.status ?? "instant_quote_received",
    requested_quantity: overrides.requested_quantity ?? 10,
    unit_price_usd: overrides.unit_price_usd ?? 5,
    total_price_usd: overrides.total_price_usd ?? 50,
    lead_time_business_days: overrides.lead_time_business_days ?? 8,
    quote_url: overrides.quote_url ?? null,
    dfm_issues: overrides.dfm_issues ?? [],
    notes: overrides.notes ?? [],
    raw_payload: overrides.raw_payload ?? {},
    created_at: overrides.created_at ?? "2026-04-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-01T00:00:00.000Z",
    offers: overrides.offers ?? [],
    artifacts: overrides.artifacts ?? [],
  };
}

describe("pricing-curves", () => {
  it("groups vendor quantity curves by requested quantity and keeps manual-review gaps", () => {
    const curves = buildVendorPricingCurves([
      makeQuote({ id: "x-100", vendor: "xometry", requested_quantity: 100, unit_price_usd: 3 }),
      makeQuote({
        id: "x-10",
        vendor: "xometry",
        requested_quantity: 10,
        unit_price_usd: null,
        total_price_usd: null,
        status: "manual_review_pending",
      }),
      makeQuote({ id: "f-1", vendor: "fictiv", requested_quantity: 1, unit_price_usd: 8 }),
    ]);

    expect(curves.map((curve) => curve.vendor)).toEqual(["fictiv", "xometry"]);
    expect(curves[1].points.map((point) => [point.requestedQuantity, point.status])).toEqual([
      [10, "manual_review"],
      [100, "quoted"],
    ]);
    expect(curves[1].gapPoints).toHaveLength(1);
    expect(curves[1].gapPoints[0]).toMatchObject({
      vendorQuoteResultId: "x-10",
      requestedQuantity: 10,
      status: "manual_review",
    });
  });

  it("classifies pricing curve trends from quoted unit prices only", () => {
    const decreasing = buildVendorPricingCurves([
      makeQuote({ id: "q-1", requested_quantity: 1, unit_price_usd: 10 }),
      makeQuote({ id: "q-10", requested_quantity: 10, unit_price_usd: 8 }),
      makeQuote({ id: "q-100", requested_quantity: 100, unit_price_usd: 4 }),
    ]);

    expect(decreasing[0].trend).toBe("decreasing");
    expect(
      classifyPricingCurveTrend([
        { ...decreasing[0].points[1], status: "manual_review", unitPriceUsd: null },
        decreasing[0].points[0],
      ]),
    ).toBe("insufficient_data");
  });

  it("classifies trends after sorting unsorted input by requested quantity", () => {
    const curve = buildVendorPricingCurves([
      makeQuote({ id: "q-100", requested_quantity: 100, unit_price_usd: 4 }),
      makeQuote({ id: "q-1", requested_quantity: 1, unit_price_usd: 10 }),
      makeQuote({ id: "q-10", requested_quantity: 10, unit_price_usd: 8 }),
    ])[0];

    expect(classifyPricingCurveTrend([curve.points[2], curve.points[0], curve.points[1]])).toBe("decreasing");
  });
});
