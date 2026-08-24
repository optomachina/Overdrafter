// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildVendorQuoteOfferPayload,
  buildVendorQuoteOfferPayloads,
} from "./vendorQuoteOffer";
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
  updated_at: "2026-07-30T11:55:00.000Z",
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
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result,
    })).toEqual({
      vendor_quote_result_id: "result-1",
      organization_id: "organization-1",
      offer_key: "xometry-10",
      supplier: "xometry",
      lane_label: "xometry quote",
      sourcing: "automated",
      geographic_origin: "unknown",
      tier: "Instant",
      quote_ref: null,
      quote_date: null,
      quoted_at: null,
      valid_until: null,
      validity_duration_days: null,
      validity_source: null,
      validity_terms: null,
      provenance_status: "unverified",
      unit_price_usd: 9.2,
      total_price_usd: 92,
      lead_time_business_days: 6,
      ship_receive_by: null,
      process: "CNC Machining",
      material: "6061 Alloy",
      finish: "Black Anodize, Type II",
      tightest_tolerance: "0.005",
      notes: "Instant quote",
      sort_rank: 0,
      raw_payload: {
        source: "simulate",
        providerOptionId: "10",
        providerLabel: "xometry quote",
        quoteUrl: "https://example.com/quote/1",
        quotedAt: null,
        validUntil: null,
        validityDurationDays: null,
        validitySource: null,
        validityTerms: null,
        requestedQuantity: 10,
        requirementCapturedAt: "2026-07-30T11:55:00.000Z",
        provenance: {
          containerSelector: "compatibility_summary",
          providerOptionIdSource: "provider_label",
          priceSource: "selector",
          leadTimeSource: "selector",
          geographicOriginSource: "none",
        },
      },
    });
  });

  it("builds one canonical row for every adapter offer", () => {
    const payloads = buildVendorQuoteOfferPayloads({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        offers: [
          {
            providerOptionId: "domestic-standard",
            providerLabel: "Domestic Standard",
            quoteRef: "Q05-1234",
            quoteUrl: "https://www.xometry.com/quoting/quote/Q05-1234",
            unitPriceUsd: 12,
            totalPriceUsd: 120,
            leadTimeBusinessDays: 8,
            shipReceiveBy: "Aug 31, 2026",
            tier: "Standard",
            sourcing: "Made in USA",
            geographicOrigin: "domestic",
            sortRank: 0,
            provenance: {
              containerSelector: "button[data-option-id]",
              providerOptionIdSource: "attribute",
              priceSource: "selector",
              leadTimeSource: "selector",
              geographicOriginSource: "provider_text",
            },
            rawPayload: { providerText: "Domestic Standard" },
          },
          {
            providerOptionId: "economy",
            providerLabel: "Economy",
            quoteRef: "Q05-1234",
            quoteUrl: "https://www.xometry.com/quoting/quote/Q05-1234",
            unitPriceUsd: 9,
            totalPriceUsd: 90,
            leadTimeBusinessDays: 12,
            shipReceiveBy: null,
            tier: "Economy",
            sourcing: null,
            geographicOrigin: "unknown",
            sortRank: 1,
            provenance: {
              containerSelector: "button[data-option-id]",
              providerOptionIdSource: "attribute",
              priceSource: "selector",
              leadTimeSource: "selector",
              geographicOriginSource: "none",
            },
            rawPayload: { providerText: "Economy" },
          },
        ],
      },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.offer_key)).toEqual([
      "xometry-domestic-standard",
      "xometry-economy",
    ]);
    expect(payloads[0]).toMatchObject({
      geographic_origin: "domestic",
      quote_ref: "Q05-1234",
      ship_receive_by: "Aug 31, 2026",
      sort_rank: 0,
    });
    expect(payloads[1]).toMatchObject({
      geographic_origin: "unknown",
      sort_rank: 1,
    });
    expect(payloads[0]).not.toHaveProperty("invalidated_at");
    expect(payloads[0]).not.toHaveProperty("invalidated_by");
    expect(payloads[0]).not.toHaveProperty("invalidation_reason");
  });

  it("persists explicit vendor validity independently from collection freshness", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        quotedAt: "2026-07-30T12:00:00.000Z",
        validityDurationDays: 30,
        validitySource: "vendor_duration",
        validityTerms: "Pricing valid for 30 days",
        rawPayload: { source: "xometry-live-adapter" },
      },
    })).toMatchObject({
      quoted_at: "2026-07-30T12:00:00.000Z",
      valid_until: null,
      validity_duration_days: 30,
      validity_source: "vendor_duration",
      validity_terms: "Pricing valid for 30 days",
      provenance_status: "trusted_adapter",
    });
  });

  it("normalizes date-only expiration through the inclusive vendor date", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        validUntil: "2026-09-11",
        validitySource: "vendor_date",
      },
    })).toMatchObject({
      valid_until: "2026-09-11T23:59:59.999999Z",
      validity_source: "vendor_date",
    });
  });

  it("keeps malformed validity unknown instead of failing the offer insert", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        validUntil: "not-a-date",
        validityDurationDays: 0,
        validitySource: "vendor_date",
      },
    })).toMatchObject({
      valid_until: null,
      validity_duration_days: null,
      validity_source: null,
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
        requirementCapturedAt: "2026-07-30T11:55:00.000Z",
        result,
      }).process,
    ).toBeNull();
  });

  it("recognizes a non-simulated Xometry automation result as trusted provenance", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        rawPayload: {
          automationVersion: "xometry-worker-2026-08-12",
          detectedFlow: "instant_quote",
        },
      },
    })).toMatchObject({ provenance_status: "trusted_adapter" });
  });

  it("does not trust a non-Xometry workflow from automation metadata alone", () => {
    expect(buildVendorQuoteOfferPayload({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "fictiv",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: {
        ...result,
        rawPayload: {
          automationVersion: "portal-workflow-v1",
          detectedFlow: "instant_quote",
        },
      },
    })).toMatchObject({ provenance_status: "unverified" });
  });
});
