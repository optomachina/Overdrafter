import { describe, expect, it } from "vitest";
import type {
  DrawingExtractionRecord,
  DrawingPreviewAssetRecord,
  PartAggregate,
  VendorQuoteAggregate,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
} from "./types";
import {
  buildRequirementDraft,
  getImportedVendorOffers,
  getJobSummaryMetrics,
  hasManualQuoteIntakeSource,
  listStaleAutoRequirementFields,
  normalizeDrawingExtraction,
  normalizeDrawingPreview,
  projectedClientPrice,
  resolveRequirementField,
} from "./utils";

function makeExtractionRecord(
  overrides: Partial<DrawingExtractionRecord> = {},
): DrawingExtractionRecord {
  return {
    id: "extract-1",
    part_id: "part-1",
    organization_id: "org-1",
    extraction: null,
    warnings: [],
    confidence: 0.42,
    status: "needs_review",
    created_at: "2026-03-03T00:00:00Z",
    updated_at: "2026-03-03T00:00:00Z",
    ...overrides,
  } as DrawingExtractionRecord;
}

function makePartAggregate(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "widget-plate",
    normalized_key: "widget-plate",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 3,
    cadFile: null,
    drawingFile: null,
    extraction: null,
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  } as PartAggregate;
}

function makeOffer(
  overrides: Partial<VendorQuoteOfferRecord> = {},
): VendorQuoteOfferRecord {
  return {
    id: "offer-1",
    vendor_quote_result_id: "quote-1",
    organization_id: "org-1",
    offer_key: "lane-a",
    supplier: "Vendor A",
    lane_label: "Lane A",
    sourcing: null,
    tier: null,
    quote_ref: null,
    quote_date: null,
    total_price_usd: 100,
    unit_price_usd: 50,
    lead_time_business_days: 5,
    ship_receive_by: null,
    due_date: null,
    process: null,
    material: null,
    finish: null,
    tightest_tolerance: null,
    tolerance_source: null,
    thread_callouts: null,
    thread_match_notes: null,
    notes: null,
    sort_rank: 1,
    raw_payload: {},
    created_at: "2026-03-03T00:00:00Z",
    updated_at: "2026-03-03T00:00:00Z",
    ...overrides,
  } as VendorQuoteOfferRecord;
}

describe("quotes utils", () => {
  it("normalizes drawing extraction payloads and parses tolerance values", () => {
    const extraction = makeExtractionRecord({
      extraction: {
        desc: "Widget plate",
        pn: "1093-05589",
        rev: "A",
        material: {
          raw_text: "6061-T6 AL",
          normalized: "6061 aluminum",
          confidence: 0.91,
        },
        finish: {
          raw: "Anodize",
        },
        tolerances: {
          tightest: "+/- .002 in",
        },
      },
      warnings: ["Verify finish callout"],
      confidence: 0.47,
      status: "approved",
      part_id: "part-7",
    });

    expect(normalizeDrawingExtraction(extraction, "part-7")).toEqual({
      partId: "part-7",
      description: "Widget plate",
      partNumber: "1093-05589",
      revision: "A",
      workerBuildVersion: null,
      extractorVersion: null,
      quoteDescription: "Widget plate",
      quoteFinish: "Anodize",
      model: {
        fallbackUsed: false,
        name: null,
        promptVersion: null,
      },
      fieldSelections: {
        description: undefined,
        partNumber: undefined,
        revision: undefined,
        material: undefined,
        finish: undefined,
        process: undefined,
      },
      rawFields: {
        description: {
          raw: "Widget plate",
          confidence: 0.47,
          reviewNeeded: false,
          reasons: [],
        },
        partNumber: {
          raw: "1093-05589",
          confidence: 0.47,
          reviewNeeded: false,
          reasons: [],
        },
        revision: {
          raw: "A",
          confidence: 0.47,
          reviewNeeded: false,
          reasons: [],
        },
        finish: {
          raw: "Anodize",
          confidence: 0.47,
          reviewNeeded: false,
          reasons: [],
        },
      },
      material: {
        raw: "6061-T6 AL",
        normalized: "6061 aluminum",
        confidence: 0.91,
        reviewNeeded: false,
        reasons: [],
      },
      finish: {
        raw: "Anodize",
        normalized: null,
        confidence: 0.47,
        reviewNeeded: false,
        reasons: [],
      },
      tightestTolerance: {
        raw: "+/- .002 in",
        valueInch: 0.002,
        confidence: 0.47,
      },
      evidence: [],
      warnings: ["Verify finish callout"],
      reviewFields: [],
      status: "approved",
    });
  });

  it("builds requirement drafts from extraction data and excludes SendCutSend for tight tolerances", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        status: "approved",
        extraction: {
          description: "Optic bracket",
          partNumber: "1093-03242",
          revision: "B",
          material: {
            raw: "17-4PH",
            normalized: "17-4 stainless",
          },
          finish: {
            raw: "Passivate",
          },
          tolerances: {
            tightest: "0.002",
            valueInch: 0.002,
          },
        },
      }),
    });

    expect(buildRequirementDraft(part)).toEqual({
      partId: "part-1",
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      description: "Optic bracket",
      partNumber: "1093-03242",
      revision: "B",
      material: "17-4 stainless",
      finish: "Passivate",
      tightestToleranceInch: 0.002,
      process: null,
      notes: null,
      quantity: 3,
      quoteQuantities: [3],
      requestedByDate: null,
      shipping: {
        requestedByDateOverride: null,
        packagingNotes: null,
        shippingNotes: null,
      },
      certifications: {
        requiredCertifications: [],
        materialCertificationRequired: null,
        certificateOfConformanceRequired: null,
        inspectionLevel: null,
        notes: null,
      },
      sourcing: {
        regionPreferenceOverride: null,
        preferredSuppliers: [],
        materialProvisioning: null,
        notes: null,
      },
      release: {
        releaseStatus: null,
        reviewDisposition: null,
        quoteBlockedUntilRelease: null,
        notes: null,
      },
      applicableVendors: ["xometry", "fictiv", "protolabs"],
    });
  });

  it("normalizes drawing preview metadata from extraction and stored assets", () => {
    const extraction = makeExtractionRecord({
      extraction: {
        pageCount: 5,
      },
    });

    expect(
      normalizeDrawingPreview(extraction, [
        {
          id: "asset-thumb",
          part_id: "part-1",
          organization_id: "org-1",
          page_number: 1,
          kind: "thumbnail",
          storage_bucket: "quote-artifacts",
          storage_path: "thumb.png",
          width: 320,
          height: 240,
          created_at: "2026-03-03T00:00:00Z",
          updated_at: "2026-03-03T00:00:00Z",
        },
        {
          id: "asset-page-2",
          part_id: "part-1",
          organization_id: "org-1",
          page_number: 2,
          kind: "page",
          storage_bucket: "quote-artifacts",
          storage_path: "page-2.png",
          width: 1200,
          height: 900,
          created_at: "2026-03-03T00:00:00Z",
          updated_at: "2026-03-03T00:00:00Z",
        },
        {
          id: "asset-page-1",
          part_id: "part-1",
          organization_id: "org-1",
          page_number: 1,
          kind: "page",
          storage_bucket: "quote-artifacts",
          storage_path: "page-1.png",
          width: 1200,
          height: 900,
          created_at: "2026-03-03T00:00:00Z",
          updated_at: "2026-03-03T00:00:00Z",
        },
      ] as DrawingPreviewAssetRecord[]),
    ).toEqual({
      pageCount: 5,
      thumbnail: {
        pageNumber: 1,
        storageBucket: "quote-artifacts",
        storagePath: "thumb.png",
        width: 320,
        height: 240,
      },
      pages: [
        {
          pageNumber: 1,
          storageBucket: "quote-artifacts",
          storagePath: "page-1.png",
          width: 1200,
          height: 900,
        },
        {
          pageNumber: 2,
          storageBucket: "quote-artifacts",
          storagePath: "page-2.png",
          width: 1200,
          height: 900,
        },
      ],
    });
  });

  it("prefers approved requirement values over extracted values", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "Ignored description",
          material: {
            raw: "6061",
          },
        },
      }),
      approvedRequirement: {
        id: "req-1",
        part_id: "part-1",
        organization_id: "org-1",
        description: "Approved bracket",
        part_number: "PN-001",
        revision: "C",
        material: "7075 aluminum",
        finish: "Black anodize",
        tightest_tolerance_inch: 0.01,
        approved_by: "user-1",
        quantity: 9,
        quote_quantities: [9],
        requested_by_date: null,
        applicable_vendors: ["partsbadger"],
        spec_snapshot: {
          shipping: {
            packagingNotes: "Ship in trays",
          },
          certifications: {
            requiredCertifications: ["AS9100"],
            certificateOfConformanceRequired: true,
          },
          sourcing: {
            regionPreferenceOverride: "domestic_preferred",
          },
          release: {
            releaseStatus: "pre_release",
            reviewDisposition: "needs_review",
            quoteBlockedUntilRelease: true,
          },
        },
        approved_at: "2026-03-03T00:00:00Z",
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(buildRequirementDraft(part)).toMatchObject({
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: null,
      description: "Approved bracket",
      partNumber: "PN-001",
      revision: "C",
      material: "7075 aluminum",
      finish: "Black anodize",
      tightestToleranceInch: 0.01,
      quantity: 9,
      quoteQuantities: [9],
      requestedByDate: null,
      shipping: expect.objectContaining({
        packagingNotes: "Ship in trays",
      }),
      certifications: expect.objectContaining({
        requiredCertifications: ["AS9100"],
        certificateOfConformanceRequired: true,
      }),
      sourcing: expect.objectContaining({
        regionPreferenceOverride: "domestic_preferred",
      }),
      release: expect.objectContaining({
        releaseStatus: "pre_release",
        reviewDisposition: "needs_review",
        quoteBlockedUntilRelease: true,
      }),
      applicableVendors: ["partsbadger"],
    });
  });

  it("treats legacy approved rows without provenance as auto-managed when extraction is newer", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "BONDED, CARBON FIBER END ATTACHMENT",
          partNumber: "1093-05589",
          revision: "02",
          quoteDescription: "BONDED, CARBON FIBER END ATTACHMENT",
          quoteFinish: "Black Anodize, Type II",
          extractedDescriptionRaw: {
            value: "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
            confidence: 0.97,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedPartNumberRaw: {
            value: "1093-05589",
            confidence: 0.99,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedRevisionRaw: {
            value: "02",
            confidence: 0.96,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedFinishRaw: {
            value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
            confidence: 0.93,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          finish: {
            raw: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
            normalized: "Black Anodize, Type II",
            confidence: 0.93,
          },
          material: {
            raw: "6061 Alloy",
            normalized: "6061 Alloy",
            confidence: 0.88,
          },
        },
        updated_at: "2026-03-04T00:00:00Z",
      }),
      approvedRequirement: {
        id: "req-legacy",
        part_id: "part-1",
        organization_id: "org-1",
        description: "87654321",
        part_number: "A-8625F",
        revision: "S",
        material: "6061 Alloy",
        finish: "ENGINEER TIM 10/29/2013",
        tightest_tolerance_inch: 0,
        approved_by: "user-1",
        quantity: 3,
        quote_quantities: [3],
        requested_by_date: null,
        applicable_vendors: ["xometry"],
        spec_snapshot: {},
        approved_at: "2026-03-03T00:00:00Z",
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(resolveRequirementField(part, "description")).toMatchObject({
      value: "BONDED, CARBON FIBER END ATTACHMENT",
      source: "extraction",
      approvedSource: "auto",
      staleAuto: true,
      approvedValue: "87654321",
    });
    expect(resolveRequirementField(part, "partNumber")).toMatchObject({
      value: "1093-05589",
      source: "extraction",
      approvedSource: "auto",
      staleAuto: true,
      approvedValue: "A-8625F",
    });
    expect(resolveRequirementField(part, "revision")).toMatchObject({
      value: "02",
      source: "extraction",
      approvedSource: "auto",
      staleAuto: true,
      approvedValue: "S",
    });
    expect(resolveRequirementField(part, "finish")).toMatchObject({
      value: "Black Anodize, Type II",
      source: "extraction",
      approvedSource: "auto",
      staleAuto: true,
      approvedValue: "ENGINEER TIM 10/29/2013",
    });
    expect(listStaleAutoRequirementFields(part)).toEqual([
      "description",
      "partNumber",
      "revision",
      "finish",
    ]);
    expect(buildRequirementDraft(part)).toMatchObject({
      description: "BONDED, CARBON FIBER END ATTACHMENT",
      partNumber: "1093-05589",
      revision: "02",
      finish: "Black Anodize, Type II",
    });
  });

  it("preserves explicit user-owned approved fields over newer extraction", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "Auto extracted description",
          partNumber: "1093-05589",
          revision: "02",
          quoteDescription: "Auto extracted description",
          quoteFinish: "Black Anodize, Type II",
          extractedDescriptionRaw: {
            value: "Auto extracted description",
            confidence: 0.97,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedPartNumberRaw: {
            value: "1093-05589",
            confidence: 0.99,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedRevisionRaw: {
            value: "02",
            confidence: 0.96,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          extractedFinishRaw: {
            value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
            confidence: 0.93,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
          finish: {
            raw: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
            normalized: "Black Anodize, Type II",
            confidence: 0.93,
          },
          material: {
            raw: "6061 Alloy",
            normalized: "6061 Alloy",
            confidence: 0.88,
          },
        },
        updated_at: "2026-03-04T00:00:00Z",
      }),
      approvedRequirement: {
        id: "req-user",
        part_id: "part-1",
        organization_id: "org-1",
        description: "Reviewed description",
        part_number: "PN-REVIEWED",
        revision: "R1",
        material: "6061 Alloy",
        finish: "Reviewed finish",
        tightest_tolerance_inch: 0.005,
        approved_by: "user-1",
        quantity: 3,
        quote_quantities: [3],
        requested_by_date: null,
        applicable_vendors: ["xometry"],
        spec_snapshot: {
          quoteDescription: "Reviewed description",
          quoteFinish: "Reviewed finish",
          fieldSources: {
            description: "user",
            partNumber: "user",
            revision: "user",
            finish: "user",
          },
          fieldOverrides: {
            description: true,
            partNumber: true,
            revision: true,
            finish: true,
          },
        },
        approved_at: "2026-03-03T00:00:00Z",
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(resolveRequirementField(part, "description")).toMatchObject({
      value: "Reviewed description",
      source: "approved_user",
      approvedSource: "user",
      staleAuto: false,
    });
    expect(resolveRequirementField(part, "finish")).toMatchObject({
      value: "Reviewed finish",
      source: "approved_user",
      approvedSource: "user",
      staleAuto: false,
    });
    expect(buildRequirementDraft(part)).toMatchObject({
      description: "Reviewed description",
      partNumber: "PN-REVIEWED",
      revision: "R1",
      finish: "Reviewed finish",
    });
  });

  it("keeps approved auto values when newer extraction is review-blocked", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "New extracted description",
          quoteDescription: "New extracted description",
          extractedDescriptionRaw: {
            value: "New extracted description",
            confidence: 0.41,
            reviewNeeded: true,
            reasons: ["model_conflict"],
            sourceRegion: null,
          },
        },
        updated_at: "2026-03-04T00:00:00Z",
      }),
      approvedRequirement: {
        id: "req-auto",
        part_id: "part-1",
        organization_id: "org-1",
        description: "Existing approved description",
        part_number: null,
        revision: null,
        material: "6061 Alloy",
        finish: null,
        tightest_tolerance_inch: null,
        approved_by: "user-1",
        quantity: 3,
        quote_quantities: [3],
        requested_by_date: null,
        applicable_vendors: ["xometry"],
        spec_snapshot: {
          quoteDescription: "Existing approved description",
          fieldSources: {
            description: "auto",
          },
          fieldOverrides: {
            description: false,
          },
        },
        approved_at: "2026-03-03T00:00:00Z",
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(resolveRequirementField(part, "description")).toMatchObject({
      value: "Existing approved description",
      source: "approved_auto",
      approvedSource: "auto",
      staleAuto: false,
      reviewBlocked: true,
    });
  });

  it("does not auto-populate editable fields from legacy needs-review extraction rows", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        status: "needs_review",
        extraction: {
          description: "8 7 6 5 4 3 2 1",
          partNumber: "A-8625F",
          revision: "S",
          finish: {
            raw: "ENGINEER TIM 10/29/2013",
            normalized: "ENGINEER TIM 10/29/2013",
            confidence: 0.6,
          },
          material: {
            raw: "6061 Alloy",
            normalized: "6061 Alloy",
            confidence: 0.72,
          },
        },
        updated_at: "2026-03-17T07:53:20Z",
      }),
      approvedRequirement: null,
    });

    const normalizedExtraction = normalizeDrawingExtraction(part.extraction, part.id);

    expect(normalizedExtraction.reviewFields).toEqual([
      "description",
      "partNumber",
      "revision",
      "material",
      "finish",
    ]);
    expect(normalizedExtraction.rawFields.partNumber.reviewNeeded).toBe(true);
    expect(normalizedExtraction.rawFields.description.reviewNeeded).toBe(true);
    expect(normalizedExtraction.rawFields.revision.reviewNeeded).toBe(true);
    expect(normalizedExtraction.rawFields.finish.reviewNeeded).toBe(true);
    expect(resolveRequirementField(part, "partNumber", normalizedExtraction)).toMatchObject({
      value: null,
      source: "extraction",
      reviewBlocked: true,
      extractionValue: "A-8625F",
    });
    expect(buildRequirementDraft(part)).toMatchObject({
      description: null,
      partNumber: null,
      revision: null,
      finish: null,
      material: "6061 Alloy",
    });
  });

  it("sorts imported vendor offers by sort rank first and then price", () => {
    const quote = {
      raw_payload: {},
      offers: [
        makeOffer({ id: "offer-2", offer_key: "lane-z", total_price_usd: 80, sort_rank: 2 }),
        makeOffer({ id: "offer-1", offer_key: "lane-a", total_price_usd: 110, sort_rank: 1 }),
        makeOffer({ id: "offer-3", offer_key: "lane-b", total_price_usd: 90, sort_rank: 1 }),
      ],
    } as unknown as VendorQuoteAggregate;

    expect(getImportedVendorOffers(quote).map((offer) => [offer.offerId, offer.requestedQuantity])).toEqual([
      ["lane-b", 1],
      ["lane-a", 1],
      ["lane-z", 1],
    ]);
  });

  it("falls back to raw payload offers and filters out invalid price rows", () => {
    const quote = {
      id: "quote-1",
      quote_run_id: "run-1",
      part_id: "part-1",
      organization_id: "org-1",
      vendor: "xometry",
      requested_quantity: 1,
      status: "official_quote_received",
      unit_price_usd: null,
      total_price_usd: null,
      lead_time_business_days: null,
      quote_url: null,
      dfm_issues: [],
      notes: [],
      raw_payload: {
        source: "manual-quote-intake",
        offers: [
          { offerId: "slow", supplier: "A", totalPriceUsd: 200, unitPriceUsd: 100 },
          { offerId: "bad", supplier: "B", totalPriceUsd: "n/a" },
          { offerId: "fast", supplier: "C", totalPriceUsd: 150, unitPriceUsd: 75 },
        ],
      },
      created_at: "2026-03-03T00:00:00Z",
      updated_at: "2026-03-03T00:00:00Z",
    } as unknown as VendorQuoteResultRecord;

    expect(hasManualQuoteIntakeSource(quote)).toBe(true);
    expect(getImportedVendorOffers(quote).map((offer) => [offer.offerId, offer.requestedQuantity])).toEqual([
      ["fast", 1],
      ["slow", 1],
    ]);
  });

  it("computes headline metrics and projected client prices", () => {
    expect(
      getJobSummaryMetrics([
        { status: "needs_spec_review" },
        { status: "internal_review" },
        { status: "quoting" },
        { status: "published" },
        { status: "draft" },
      ]),
    ).toEqual({
      totalJobs: 5,
      needsReview: 2,
      published: 1,
      quoted: 1,
    });

    expect(projectedClientPrice(10.001)).toBe(12.01);
    expect(projectedClientPrice(null)).toBeNull();
  });
});
