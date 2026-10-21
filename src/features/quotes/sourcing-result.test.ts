import { describe, expect, it } from "vitest";
import { buildClientPartAggregateFromMetadata } from "@/features/quotes/api/shared/normalizers";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import metadataFixture from "@/features/quotes/client-part-metadata-projection.fixture.json";
import { normalizeClientPartMetadata } from "@/features/quotes/utils";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import {
  buildClientQuoteComparisonOptions,
  buildClientSourcingResult,
  resolveWorkspaceStoredQuoteSelection,
  PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS,
} from "@/features/quotes/sourcing-result";
import type {
  ClientExtractionLifecycle,
  PartAggregate,
  PublishedQuoteOptionRecord,
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

describe("buildClientQuoteComparisonOptions", () => {
  const candidate = {
    key: "offer-row-1",
    offerId: "vendor-offer-1",
    persistedOfferId: "offer-row-1",
    vendorKey: "fastdms",
    vendorQuoteResultId: "vendor-result-1",
    vendorStatus: "official_quote_received",
    vendorLabel: "FastDMS",
    supplier: "FastDMS",
    requestedQuantity: 1,
    unitPriceUsd: 100,
    totalPriceUsd: 100,
    leadTimeBusinessDays: 10,
    resolvedDeliveryDate: null,
    domesticStatus: "domestic",
    geographicOrigin: "domestic",
    excluded: false,
    dueDateEligible: true,
    eligible: true,
    isSelectable: true,
    expedite: false,
    shipReceiveBy: null,
    dueDate: null,
    quoteDateIso: "2026-03-02",
    quoteResultRawPayload: { importSource: { batch: "QB00001" } },
    sourcing: "USA",
    tier: "Standard",
    laneLabel: "Standard",
    process: "CNC milling",
    material: "6061-T6 aluminum",
    finish: "Black anodize",
    tightestTolerance: "±.005\"",
    notes: "Internal supplier note",
    rawPayload: { supplierTotal: 100 },
  } satisfies ClientQuoteSelectionOption;
  const publishedOption = {
    id: "published-option-1",
    package_id: "published-package-1",
    organization_id: "org-1",
    option_kind: "lowest_cost",
    label: "Lowest Cost",
    requested_quantity: 1,
    published_price_usd: 125,
    lead_time_business_days: 8,
    comparison_summary: "Best published price.",
    source_vendor_quote_id: candidate.vendorQuoteResultId,
    source_vendor_quote_offer_id: candidate.persistedOfferId,
    markup_policy_version: "v1_markup_20",
    created_at: "2026-03-02T00:00:00Z",
  } satisfies PublishedQuoteOptionRecord;

  it("requires a published selection even when an old pointer matches a package source", () => {
    const options = buildClientQuoteComparisonOptions({ candidates: [candidate], liveOfferKeys: new Set(), publishedOptions: [publishedOption], requestedByDate: null });
    const item = { ...createClientQuoteWorkspaceItemFixture(), publishedQuoteOptions: [publishedOption], publishedQuoteSelection: null };
    item.job.selected_vendor_quote_offer_id = candidate.persistedOfferId;
    expect(resolveWorkspaceStoredQuoteSelection(options, item)).toEqual({ selectedOption: null, previousSelectionUnavailable: false });
    expect(resolveWorkspaceStoredQuoteSelection([], item)).toEqual({ selectedOption: null, previousSelectionUnavailable: false });
  });

  it("keeps the legacy selection before publication", () => {
    const item = createClientQuoteWorkspaceItemFixture();
    item.job.selected_vendor_quote_offer_id = candidate.persistedOfferId;
    expect(resolveWorkspaceStoredQuoteSelection([candidate], { ...item, publishedQuoteOptions: [], publishedQuoteSelection: null }).selectedOption).toBe(candidate);
  });

  it("uses published client pricing instead of raw supplier amounts", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [candidate],
      liveOfferKeys: new Set(),
      publishedOptions: [publishedOption],
      requestedByDate: null,
    });

    expect(result).toMatchObject({
      totalPriceUsd: 125,
      unitPriceUsd: 125,
      laneLabel: "Lowest Cost",
      notes: "Best published price.",
      persistedOfferId: candidate.persistedOfferId,
      selectionTarget: {
        kind: "published_quote_option",
        packageId: publishedOption.package_id,
        optionId: publishedOption.id,
      },
      rawPayload: null,
      quoteResultRawPayload: null,
    });
  });

  it("fails closed when published options cannot be matched to the current run", () => {
    expect(
      buildClientQuoteComparisonOptions({
        candidates: [candidate],
        liveOfferKeys: new Set([candidate.key]),
        publishedOptions: [
          {
            ...publishedOption,
            source_vendor_quote_offer_id: "offer-from-older-published-run",
          },
        ],
        requestedByDate: null,
      }),
    ).toEqual([]);
  });

  it("preserves distinct published choices that share one source offer", () => {
    const results = buildClientQuoteComparisonOptions({
      candidates: [candidate],
      liveOfferKeys: new Set(),
      publishedOptions: [
        publishedOption,
        {
          ...publishedOption,
          id: "published-option-2",
          option_kind: "fastest_delivery",
          label: "Fastest Delivery",
          published_price_usd: 150,
        },
      ],
      requestedByDate: null,
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.selectionTarget)).toEqual([
      {
        kind: "published_quote_option",
        packageId: publishedOption.package_id,
        optionId: publishedOption.id,
      },
      {
        kind: "published_quote_option",
        packageId: publishedOption.package_id,
        optionId: "published-option-2",
      },
    ]);
  });

  it("falls back only to trusted live keys before publication", () => {
    expect(
      buildClientQuoteComparisonOptions({
        candidates: [candidate],
        liveOfferKeys: new Set(),
        publishedOptions: [],
        requestedByDate: null,
      }),
    ).toEqual([]);
    expect(
      buildClientQuoteComparisonOptions({
        candidates: [candidate],
        liveOfferKeys: new Set([candidate.key]),
        publishedOptions: [],
        requestedByDate: null,
      }),
    ).toEqual([candidate]);
  });

  it("makes a published faster lead time eligible when it meets the requested date", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [
        {
          ...candidate,
          resolvedDeliveryDate: "2026-03-16",
          dueDateEligible: false,
          eligible: false,
        },
      ],
      liveOfferKeys: new Set(),
      publishedOptions: [publishedOption],
      requestedByDate: "2026-03-13",
    });

    expect(result).toMatchObject({
      leadTimeBusinessDays: 8,
      resolvedDeliveryDate: "2026-03-12",
      dueDateEligible: true,
      eligible: true,
    });
  });

  it("makes a published slower lead time ineligible when it misses the requested date", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [
        {
          ...candidate,
          leadTimeBusinessDays: 8,
          resolvedDeliveryDate: "2026-03-12",
          dueDateEligible: true,
          eligible: true,
        },
      ],
      liveOfferKeys: new Set(),
      publishedOptions: [
        {
          ...publishedOption,
          lead_time_business_days: 10,
        },
      ],
      requestedByDate: "2026-03-13",
    });

    expect(result).toMatchObject({
      leadTimeBusinessDays: 10,
      resolvedDeliveryDate: "2026-03-16",
      dueDateEligible: false,
      eligible: false,
    });
  });

  it("preserves an authoritative fixed delivery date when publication changes lead time", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [
        {
          ...candidate,
          shipReceiveBy: "2026-03-10",
          resolvedDeliveryDate: "2026-03-10",
        },
      ],
      liveOfferKeys: new Set(),
      publishedOptions: [
        {
          ...publishedOption,
          lead_time_business_days: 20,
        },
      ],
      requestedByDate: "2026-03-13",
    });

    expect(result).toMatchObject({
      leadTimeBusinessDays: 20,
      resolvedDeliveryDate: "2026-03-10",
      dueDateEligible: true,
      eligible: true,
    });
  });

  it("uses a stable persisted timestamp when no quote date is available", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [
        {
          ...candidate,
          quoteDateIso: null,
          offerCreatedAt: "2026-03-02T18:00:00Z",
        },
      ],
      liveOfferKeys: new Set(),
      publishedOptions: [publishedOption],
      requestedByDate: "2026-03-13",
    });

    expect(result).toMatchObject({
      resolvedDeliveryDate: "2026-03-12",
      dueDateEligible: true,
    });
  });

  it("recomputes from published lead time when fixed-date text is invalid", () => {
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [
        {
          ...candidate,
          shipReceiveBy: "TBD",
          resolvedDeliveryDate: "2026-03-16",
        },
      ],
      liveOfferKeys: new Set(),
      publishedOptions: [publishedOption],
      requestedByDate: "2026-03-13",
    });

    expect(result).toMatchObject({
      resolvedDeliveryDate: "2026-03-12",
      dueDateEligible: true,
    });
  });

  it("preserves source-derived lead-time values when publication does not override lead time", () => {
    const sourceDerivedCandidate = {
      ...candidate,
      resolvedDeliveryDate: "2026-03-16",
      dueDateEligible: false,
      eligible: false,
    };
    const [result] = buildClientQuoteComparisonOptions({
      candidates: [sourceDerivedCandidate],
      liveOfferKeys: new Set(),
      publishedOptions: [
        {
          ...publishedOption,
          lead_time_business_days: null,
        },
      ],
      requestedByDate: "2026-03-20",
    });

    expect(result).toMatchObject({
      leadTimeBusinessDays: sourceDerivedCandidate.leadTimeBusinessDays,
      resolvedDeliveryDate: sourceDerivedCandidate.resolvedDeliveryDate,
      dueDateEligible: sourceDerivedCandidate.dueDateEligible,
      eligible: sourceDerivedCandidate.eligible,
    });
  });
});

describe("buildClientSourcingResult", () => {
  it("returns ranked potential providers for a supported Free package", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [
        makeProfile("xometry"),
        makeProfile("fictiv", { quality_score: 92 }),
        makeProfile("emachineshop"),
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
      liveOfferCount: 1,
      liveOfferKeys: ["xometry-live"],
    });
  });

  it("falls back to recommendations when only an uncertified provider's live-adapter payload exists", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("fictiv")],
      liveOffers: [
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
      outcome: "provider_recommendations_available",
      reason: "automatic_collection_fallback",
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

  it.each([
    ["Unknown material", "succeeded", false, "material_unresolved"],
    ["  UNKNOWN MATERIAL  ", "succeeded", false, "material_unresolved"],
    ["Unknown material", "partial", true, "material_unresolved"],
    ["Unknown material", "failed", true, "material_unresolved"],
    ["", "queued", true, "part_not_ready"],
    ["Unknown material", "queued", false, "part_not_ready"],
    ["", "extracting", true, "part_not_ready"],
    ["Unknown material", "extracting", false, "part_not_ready"],
    ["Unknown material", "uploaded", true, "part_not_ready"],
    ["Unknown material", "uploaded", false, "material_unresolved"],
    ["17-4 PH stainless steel", "queued", true, "unsupported_material"],
    ["6061-T6 aluminum", "queued", true, "free_preview"],
  ] as const)("resolves material %j with %s extraction (drawing: %s) as %s", (
    material, lifecycle: ClientExtractionLifecycle, hasDrawingFile, reason,
  ) => {
    const part = makeSupportedPart();
    part.clientRequirement = {
      description: null, partNumber: null, revision: null, material,
      finish: null, tightestToleranceInch: null, process: "CNC milling",
      notes: null, quantity: 1, quoteQuantities: [1], requestedByDate: null,
    };
    part.clientExtraction = {
      lifecycle, hasDrawingFile, hasCadFile: true, pageCount: 0,
      warningCount: 0, warnings: [], missingFields: [], lastFailureCode: null,
      lastFailureMessage: null, extractedAt: null, failedAt: null, updatedAt: null,
    };

    expect(buildClientSourcingResult({
      part, profiles: [makeProfile("xometry")], liveOffers: [], automaticCollectionEnabled: false,
    })).toMatchObject({ reason });
  });

  describe.each(["liveOvd670", "draft"] as const)("%s metadata sourcing", (projection) => {
    it.each([
      ["complete", "succeeded", "material_unresolved", "Confirm the material"],
      ["partial", "partial", "material_unresolved", "Confirm the material"],
      ["failed", "failed", "material_unresolved", "Confirm the material"],
      ["queued", "queued", "part_not_ready", "Requirements are still being prepared"],
      ["queued", "extracting", "part_not_ready", "Requirements are still being prepared"],
    ] as const)("resolves normalized %s / %s extraction as %s", (key, lifecycle, reason, title) => {
      const fixturePart = metadataFixture.parts.find((candidate) => candidate.key === key)!;
      const row = metadataFixture.expected[projection].find((candidate) => candidate.partId === fixturePart.partId)!;
      const metadata = normalizeClientPartMetadata({
        ...row,
        // Live rows use this placeholder when extraction has not resolved material.
        material: "Unknown material",
        ...("clientExtraction" in row
          ? { clientExtraction: { ...row.clientExtraction, lifecycle } }
          : { lifecycle }),
      })!;
      const workspace = createClientQuoteWorkspaceItemFixture();
      const cadFile = workspace.part!.cadFile!;
      const part = buildClientPartAggregateFromMetadata({
        job: { ...workspace.job, id: metadata.jobId, organization_id: metadata.organizationId },
        metadata,
        files: [
          cadFile,
          { ...cadFile, id: "drawing-file", file_kind: "drawing", original_name: "bracket.pdf" },
        ],
        vendorQuotes: [],
      });

      expect(part.clientExtraction?.lifecycle).toBe(lifecycle);
      expect(buildClientSourcingResult({
        part, profiles: [makeProfile("xometry")], liveOffers: [], automaticCollectionEnabled: false,
      })).toMatchObject({ reason, title });
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

  it("fails closed when capability data references a vendor missing from the generated catalog", () => {
    const result = buildClientSourcingResult({
      part: makeSupportedPart(),
      profiles: [makeProfile("missingprovider" as VendorName)],
      liveOffers: [],
      automaticCollectionEnabled: false,
    });

    expect(result).toMatchObject({
      outcome: "unsupported_package",
      reason: "no_reviewed_provider_match",
    });
  });

  it("pins the certified live-offer allowlist to OVD-199 certification reality", () => {
    // The customer-visible live-offer allowlist must change only through a
    // reviewed OVD-199 production certification. Internal evaluation-gate
    // passes (for example the worker OpenClaw gate treating a Fictiv run as
    // real evidence) never qualify a provider for this list.
    expect(PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS).toEqual(["xometry"]);
    expect(PRODUCTION_CERTIFIED_LIVE_OFFER_VENDORS).not.toContain("fictiv");
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
        {
          offerKey: "xometry-simulated-mode",
          vendorKey: "xometry",
          vendorStatus: "official_quote_received",
          requestedQuantity: 1,
          quoteDateIso: "2026-07-30T00:00:00.000Z",
          quoteResultCreatedAt: "2026-07-30T00:00:00.000Z",
          quoteUrl: "https://www.xometry.com/quoting/home/sim-mode",
          quoteResultRawPayload: {
            automationVersion: "xometry-worker-v1",
            mode: "simulate",
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
