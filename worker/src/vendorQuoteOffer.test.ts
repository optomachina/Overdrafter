// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildVendorQuoteOfferPayload } from "./vendorQuoteOffer";
import type {
  ApprovedRequirementRecord,
  VendorQuoteAdapterOutput,
} from "./types";

const requirement: ApprovedRequirementRecord = {
  id: "requirement-1",
  part_id: "part-1",
  description: "End attachment",
  part_number: "1093-05589",
  revision: "02",
  material: "6061 Alloy",
  finish: "Black Anodize, Type II",
  tightest_tolerance_inch: 0.005,
  quantity: 10,
  quote_quantities: [10],
  requested_by_date: null,
  applicable_vendors: ["xometry"],
  spec_snapshot: { process: "  CNC Machining  " },
};

const result: VendorQuoteAdapterOutput = {
  vendor: "xometry",
  status: "instant_quote_received",
  unitPriceUsd: 9.2,
  totalPriceUsd: 92,
  leadTimeBusinessDays: 6,
  quoteUrl: "https://example.com/quote/1",
  dfmIssues: [],
  notes: ["Instant quote"],
  artifacts: [],
  rawPayload: { source: "simulate" },
};

describe("buildVendorQuoteOfferPayload", () => {
  it("persists the approved requested process into the normalized offer", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      result,
    })).toEqual({
      vendor_quote_result_id: "result-1",
      organization_id: "organization-1",
      offer_key: "xometry-10",
      supplier: "xometry",
      lane_label: "xometry quote",
      sourcing: "automated",
      tier: "Instant",
      unit_price_usd: 9.2,
      total_price_usd: 92,
      lead_time_business_days: 6,
      process: "CNC Machining",
      material: "6061 Alloy",
      finish: "Black Anodize, Type II",
      tightest_tolerance: "0.005",
      notes: "Instant quote",
      raw_payload: {
        source: "simulate",
        quoteUrl: "https://example.com/quote/1",
        requestedQuantity: 10,
      },
    });
  });

  it("persists null when no approved requested process exists", () => {
    expect(
      buildVendorQuoteOfferPayload({
        vendorQuoteResultId: "result-1",
        organizationId: "organization-1",
        vendor: "xometry",
        requestedQuantity: 10,
        requirement: {
          ...requirement,
          spec_snapshot: { process: "  " },
        },
        result,
      }).process,
    ).toBeNull();
  });
});
