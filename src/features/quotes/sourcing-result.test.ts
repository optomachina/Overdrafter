import { describe, expect, it } from "vitest";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import { buildClientSourcingResult } from "@/features/quotes/sourcing-result";
import type {
  PartAggregate,
  VendorCapabilityProfileRecord,
} from "@/features/quotes/types";
import type { VendorName } from "@/integrations/supabase/types";

function makeProfile(
  vendorName: VendorName,
  overrides: Partial<VendorCapabilityProfileRecord> = {},
): VendorCapabilityProfileRecord {
  return {
    vendor_name: vendorName,
    process_types: ["cnc_milling", "cnc_turning"],
    materials: ["aluminum"],
    tolerance_min_mm: 0.005,
    tolerance_max_mm: 0.2,
    max_part_size_mm: 1000,
    min_quantity: 1,
    max_quantity: null,
    geographic_region: "US",
    certifications: ["ISO9001"],
    quality_score: 80,
    lead_time_reliability: 80,
    cost_competitiveness: 70,
    domestic_us: true,
    updated_at: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeSupportedPart(): PartAggregate {
  const part = createClientQuoteWorkspaceItemFixture().part!;
  part.quantity = 1;
  part.approvedRequirement = {
    ...part.approvedRequirement!,
    material: "6061-T6 aluminum",
    quantity: 1,
    quote_quantities: [1],
    spec_snapshot: {
      process: "CNC milling",
    },
  };
  return part;
}

describe("buildClientSourcingResult", () => {
  it("returns ranked potential providers for a supported Free package", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [
        makeProfile("xometry"),
        makeProfile("fictiv", { quality_score: 92 }),
        makeProfile("sendcutsend", { process_types: ["sheet_metal"] }),
      ],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result.outcome).toBe("provider_recommendations_available");

    if (result.outcome !== "provider_recommendations_available") {
      throw new Error("Expected provider recommendations.");
    }

    expect(result.reason).toBe("free_preview");
    expect(result.recommendations.map((recommendation) => recommendation.vendorName)).toEqual([
      "fictiv",
      "xometry",
    ]);
    expect(result.recommendations[0]).toMatchObject({
      provenance: "reviewed_provider_capability_profile",
      officialRfqUrl: "https://app.fictiv.com/pages/quotes/upload",
    });
  });

  it("keeps recommendations as fallback context when live offers exist", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-live",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-1",
          quoteResultUpdatedAt: "2026-07-30T00:00:00.000Z",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
        {
          offerKey: "fictiv-live",
          vendorKey: "fictiv",
          vendorStatus: "official_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "https://app.fictiv.com/quotes/quote-2",
          quoteResultUpdatedAt: "2026-07-30T00:00:00.000Z",
          quoteResultRawPayload: {
            source: "fictiv-live-adapter",
            mode: "live",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "live_offers_available",
      liveOfferCount: 2,
      liveOfferKeys: ["xometry-live", "fictiv-live"],
    });
  });

  it("uses the immutable offer creation time when a live adapter omits quote_date", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [],
      liveOffers: [
        {
          offerKey: "xometry-live-without-quote-date",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: null,
          offerCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/quote/Q64-TEST",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "instant_quote",
          },
        },
      ],
      automaticCollectionEnabled: true,
      capabilityDataAvailable: false,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toEqual({
      outcome: "live_offers_available",
      liveOfferCount: 1,
      liveOfferKeys: ["xometry-live-without-quote-date"],
      recommendations: [],
    });
  });

  it("returns an automatic fallback instead of a stalled state when no offer exists", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("xometry")],
      liveOffers: [],
      automaticCollectionEnabled: true,
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("bounds unsupported materials with a useful next action", () => {
    const part = makeSupportedPart();
    part.approvedRequirement = {
      ...part.approvedRequirement!,
      material: "17-4 PH stainless steel",
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result).toMatchObject({
      outcome: "unsupported_package",
      reason: "unsupported_material",
    });
  });

  it("requires an explicit milling or turning process", () => {
    const part = makeSupportedPart();
    part.approvedRequirement = {
      ...part.approvedRequirement!,
      spec_snapshot: {
        process: "CNC machining",
      },
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result).toMatchObject({
      outcome: "unsupported_package",
      reason: "process_unresolved",
    });
  });

  it("requires a STEP model before recommending providers", () => {
    const part = makeSupportedPart();
    part.cadFile = {
      ...part.cadFile!,
      original_name: "bracket.iges",
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result).toMatchObject({
      outcome: "unsupported_package",
      reason: "step_required",
    });
  });

  it("does not fabricate guidance when reviewed capability data cannot be loaded", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [],
      liveOffers: [],
      automaticCollectionEnabled: false,
      capabilityDataAvailable: false,
    });

    expect(result).toMatchObject({
      outcome: "unsupported_package",
      reason: "capability_data_unavailable",
    });
  });

  it("falls back to recommendations for stale or simulated prices", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-stale",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-06-01T00:00:00.000Z",
          quoteResultCreatedAt: "2026-06-01T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/old-quote",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
        {
          offerKey: "xometry-simulated",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "simulated://xometry/quote",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "simulate",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("does not refresh an old provider quote when its database row changes", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-mutated-stale",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: null,
          offerCreatedAt: "2026-06-01T00:00:00.000Z",
          quoteResultCreatedAt: "2026-06-01T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/old-quote",
          quoteResultUpdatedAt: "2026-07-30T23:00:00.000Z",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("keeps a verified live result available when capability guidance cannot load", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [],
      liveOffers: [
        {
          offerKey: "xometry-live",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-1",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
      ],
      automaticCollectionEnabled: true,
      capabilityDataAvailable: false,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toEqual({
      outcome: "live_offers_available",
      liveOfferCount: 1,
      liveOfferKeys: ["xometry-live"],
      recommendations: [],
    });
  });

  it("does not reuse an offer created before the reviewed requirements changed", () => {
    const part = makeSupportedPart();
    part.approvedRequirement = {
      ...part.approvedRequirement!,
      updated_at: "2026-07-30T12:00:00.000Z",
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-before-approved-edit",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T10:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T10:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-before-edit",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("rejects an offer persisted after requirements changed when quoting captured the prior revision", () => {
    const part = makeSupportedPart();
    part.approvedRequirement = {
      ...part.approvedRequirement!,
      updated_at: "2026-07-30T12:00:00.000Z",
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-persisted-after-edit",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: null,
          offerCreatedAt: "2026-07-30T12:05:00.000Z",
          quoteResultCreatedAt: "2026-07-30T11:55:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-after-edit",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
            requirementCapturedAt: "2026-07-30T11:55:00.000Z",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("does not invalidate an offer when only non-requirement part metadata changes", () => {
    const part = makeSupportedPart();
    part.updated_at = "2026-07-30T12:00:00.000Z";
    part.approvedRequirement = null;
    part.clientRequirement = {
      description: "Bracket",
      partNumber: "BR-1",
      revision: "B",
      material: "6061-T6 aluminum",
      finish: null,
      tightestToleranceInch: 0.005,
      process: "CNC milling",
      notes: null,
      quantity: 1,
      quoteQuantities: [1],
      requestedByDate: null,
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-before-part-edit",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T10:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T10:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-before-edit",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "live_offers_available",
      liveOfferKeys: ["xometry-before-part-edit"],
    });
  });

  it("invalidates an offer after a later client requirement override", () => {
    const part = makeSupportedPart();
    part.updated_at = "2026-07-30T10:00:00.000Z";
    part.clientRequirement = {
      description: "Bracket",
      partNumber: "BR-1",
      revision: "B",
      material: "6061-T6 aluminum",
      finish: null,
      tightestToleranceInch: 0.005,
      process: "CNC milling",
      notes: null,
      quantity: 2,
      quoteQuantities: [2],
      requestedByDate: null,
      projectPartProperties: {
        defaults: {},
        overrides: { material: "7075 aluminum" },
        createdAt: "2026-07-30T09:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      },
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [
        {
          offerKey: "xometry-before-client-edit",
          vendorKey: "xometry",
          vendorStatus: "instant_quote_received",
          requestedQuantity: 2,
          quoteDateIso: "2026-07-30T11:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T11:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/quote-before-client-edit",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            detectedFlow: "quote_ready",
          },
        },
      ],
      automaticCollectionEnabled: true,
      now: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
    });
  });

  it("excludes profiles that do not prove aluminum and tolerance fit", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [
        makeProfile("xometry", { materials: ["stainless_steel"] }),
        makeProfile("fictiv", {
          tolerance_min_mm: 0.2,
          tolerance_max_mm: 0.5,
        }),
        makeProfile("protolabs"),
      ],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result.outcome).toBe("provider_recommendations_available");

    if (result.outcome !== "provider_recommendations_available") {
      throw new Error("Expected a reviewed provider recommendation.");
    }

    expect(result.recommendations.map((recommendation) => recommendation.vendorName)).toEqual([
      "protolabs",
    ]);
    expect(result.recommendations[0]?.fitReasons).toContain(
      "Reviewed capability data includes aluminum",
    );
  });

  it("keeps tighter-capability providers eligible for a looser tolerance", () => {
    const part = makeSupportedPart();
    part.approvedRequirement = {
      ...part.approvedRequirement!,
      tightest_tolerance_inch: 0.04,
    };

    const result = buildClientSourcingResult({
      part,
      profiles: [makeProfile("xometry")],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result.outcome).toBe("provider_recommendations_available");

    if (result.outcome !== "provider_recommendations_available") {
      throw new Error("Expected a reviewed provider recommendation.");
    }

    expect(result.recommendations[0]).toMatchObject({
      vendorName: "xometry",
    });
  });
});
