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
  mergeRequirementDraftState,
  normalizeClientPartMetadata,
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
  it("normalizes drawing extraction payloads and keeps a legacy raw-only tolerance unparsed", () => {
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
      threads: [],
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
      geometryProjection: null,
      tightestTolerance: {
        raw: "+/- .002 in",
        valueInch: null,
        unit: null,
        hint: "Check the drawing: the units could not be determined. Extracted text: +/- .002 in",
        confidence: 0.47,
      },
      evidence: [],
      warnings: ["Verify finish callout"],
      reviewFields: [],
      status: "approved",
    });
  });

  it("normalizes project-side property state and thread callouts from client metadata", () => {
    const metadata = normalizeClientPartMetadata({
      partId: "part-1",
      jobId: "job-1",
      organizationId: "org-1",
      description: "Effective bracket",
      partNumber: "BRKT-200",
      revision: "B",
      material: "7075-T6",
      finish: "Black anodize",
      threads: "1/4-20 UNC-2B",
      tightestToleranceInch: "0.003",
      quantity: 12,
      quoteQuantities: [12, 24],
      requestedByDate: "2026-04-08",
      projectPartProperties: {
        defaults: {
          description: "Bracket",
          partNumber: "BRKT-100",
          material: "6061-T6",
          finish: null,
          tightestToleranceInch: 0.005,
          threads: null,
        },
        overrides: {
          description: "Effective bracket",
          partNumber: "BRKT-200",
          material: "7075-T6",
          finish: "Black anodize",
          tightestToleranceInch: 0.003,
          threads: "1/4-20 UNC-2B",
        },
        createdAt: "2026-04-02T01:00:00.000Z",
        updatedAt: "2026-04-02T02:00:00.000Z",
      },
      hasCadFile: true,
      hasDrawingFile: true,
      lifecycle: "partial",
      warningCount: 1,
      warnings: ["Verify thread engagement"],
      missingFields: [],
      reviewFields: ["finish"],
      pageCount: 2,
      updatedAt: "2026-04-02T02:00:00.000Z",
    });

    expect(metadata).toMatchObject({
      partId: "part-1",
      jobId: "job-1",
      organizationId: "org-1",
      requirement: {
        description: "Effective bracket",
        partNumber: "BRKT-200",
        material: "7075-T6",
        finish: "Black anodize",
        threads: "1/4-20 UNC-2B",
        tightestToleranceInch: 0.003,
        projectPartProperties: {
          defaults: {
            description: "Bracket",
            partNumber: "BRKT-100",
            material: "6061-T6",
            finish: null,
            tightestToleranceInch: 0.005,
            threads: null,
          },
          overrides: {
            description: "Effective bracket",
            partNumber: "BRKT-200",
            material: "7075-T6",
            finish: "Black anodize",
            tightestToleranceInch: 0.003,
            threads: "1/4-20 UNC-2B",
          },
          createdAt: "2026-04-02T01:00:00.000Z",
          updatedAt: "2026-04-02T02:00:00.000Z",
        },
      },
    });
  });

  it("normalizes imported part numbers without turning embedded revisions into explicit revision fields", () => {
    const metadata = normalizeClientPartMetadata({
      partId: "part-1",
      jobId: "job-1",
      organizationId: "org-1",
      partNumber: "1093-05589 rev 2",
      revision: null,
      quantity: 1,
    });

    expect(metadata).toMatchObject({
      requirement: {
        partNumber: "1093-05589",
        revision: null,
      },
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
      threads: null,
      tightestToleranceInch: 0.002,
      process: "CNC Machining",
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
      applicableVendors: ["xometry", "fictiv", "protolabs", "emachineshop"],
    });
  });

  it("normalizes geometry projection payloads and clamps invalid numeric fields", () => {
    const extraction = makeExtractionRecord({
      extraction: {
        geometryProjection: {
          schemaVersion: "2026-03-29",
          extractorVersion: "worker-geometry-v1",
          generatedFrom: {
            drawingExtraction: true,
            approvedRequirement: false,
          },
          scene: {
            width: "bad-width",
            height: 24,
            depth: 12,
            primitives: [
              {
                id: "pocket-a",
                kind: "cutout",
                position: { x: "oops", y: 2, z: 3 },
                size: { x: 10, y: "invalid", z: 4 },
                metadata: {
                  featureClass: "pocket",
                  confidence: "bad-confidence",
                },
              },
            ],
          },
        },
      },
    });

    expect(normalizeDrawingExtraction(extraction, "part-1").geometryProjection).toEqual({
      schemaVersion: "2026-03-29",
      extractorVersion: "worker-geometry-v1",
      generatedFrom: {
        drawingExtraction: true,
        approvedRequirement: false,
      },
      scene: {
        width: 0,
        height: 24,
        depth: 12,
        primitives: [
          {
            id: "pocket-a",
            kind: "cutout",
            position: { x: 0, y: 2, z: 3 },
            size: { x: 10, y: 0, z: 4 },
            metadata: {
              featureClass: "pocket",
              confidence: 0,
            },
          },
        ],
      },
    });
  });

  it("never surfaces the raw finish extraction object as the quote finish", () => {
    const extraction = makeExtractionRecord({
      extraction: {
        finish: { raw: null, reasons: [], confidence: 0, normalized: null, reviewNeeded: false },
      },
    });
    const normalized = normalizeDrawingExtraction(extraction, "part-1");

    expect(normalized.quoteFinish).toBeNull();
    expect(normalized.finish.normalized).toBeNull();
    expect(normalized.rawFields.finish.raw).toBeNull();
  });

  it("skips non-string finish candidates in every extraction field", () => {
    const blob = { raw: null, reasons: [], confidence: 0, normalized: null, reviewNeeded: false };
    const normalized = normalizeDrawingExtraction(
      makeExtractionRecord({
        extraction: {
          extractedFinishRaw: { value: blob },
          finish: { raw: blob, raw_text: blob, normalized: blob },
        },
      }),
      "part-1",
    );

    expect(normalized.rawFields.finish.raw).toBeNull();
    expect(normalized.finish.raw).toBeNull();
    expect(normalized.finish.normalized).toBeNull();
    expect(normalized.quoteFinish).toBeNull();

    const fallback = normalizeDrawingExtraction(
      makeExtractionRecord({
        extraction: {
          extractedFinishRaw: { value: blob },
          finish: { raw: blob, raw_text: "Clear anodize", normalized: "Clear anodize" },
        },
      }),
      "part-1",
    );

    expect(fallback.rawFields.finish.raw).toBe("Clear anodize");
    expect(fallback.finish.raw).toBe("Clear anodize");
    expect(fallback.finish.normalized).toBe("Clear anodize");
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

  it("does not repopulate a user-cleared approved field from extraction", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "Auto extracted description",
          quoteDescription: "Auto extracted description",
          extractedDescriptionRaw: {
            value: "Auto extracted description",
            confidence: 0.97,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
        },
        updated_at: "2026-03-04T00:00:00Z",
      }),
      approvedRequirement: {
        id: "req-cleared",
        part_id: "part-1",
        organization_id: "org-1",
        description: null,
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
          fieldSources: {
            description: "user",
          },
          fieldOverrides: {
            description: true,
          },
        },
        approved_at: "2026-03-03T00:00:00Z",
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(resolveRequirementField(part, "description")).toMatchObject({
      value: null,
      source: "approved_user",
      approvedSource: "user",
      extractionValue: "Auto extracted description",
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

  it("preserves existing draft edits when reseeding parts after debug polling", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
        extraction: {
          description: "Server description",
          quoteDescription: "Server description",
          extractedDescriptionRaw: {
            value: "Server description",
            confidence: 0.98,
            reviewNeeded: false,
            reasons: ["label_match"],
            sourceRegion: null,
          },
        },
      }),
    });

    const currentDrafts = {
      "part-1": {
        ...buildRequirementDraft(part),
        description: "Unsaved local edit",
      },
    };

    const merged = mergeRequirementDraftState({
      parts: [part],
      currentDrafts,
      currentQuoteQuantityInputs: {
        "part-1": "3/12",
      },
    });

    expect(merged.drafts["part-1"].description).toBe("Unsaved local edit");
    expect(merged.quoteQuantityInputs["part-1"]).toBe("3/12");
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
          { offerId: "fast", supplier: "C", totalPriceUsd: "$150.00", unitPriceUsd: "75", leadTimeBusinessDays: "6 business days" },
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
    expect(getImportedVendorOffers(quote)[0]?.leadTimeBusinessDays).toBe(6);
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

describe("tolerance without re-parsing raw drawing text (OVD-984)", () => {
  function partWithTolerances(
    tolerances: Record<string, string | number | null>,
    overrides: Partial<PartAggregate> = {},
  ) {
    return makePartAggregate({
      extraction: makeExtractionRecord({
        status: "approved",
        extraction: {
          description: "Optic bracket",
          material: { raw: "6061", normalized: "6061 aluminum" },
          tolerances,
        },
      }),
      ...overrides,
    });
  }

  const unresolvedRawCases: Array<[string, string]> = [
    ["mixed mm and inch callouts", "±0.1 mm, ±.3"],
    ["a fraction", "±1/64"],
    ["a bare decimal", "±.3"],
    ["a comma decimal", "0,05"],
    ["a percentage", "±5%"],
  ];

  it.each(unresolvedRawCases)(
    "never prefills a number for stored null with unit unknown (%s)",
    (_label, raw) => {
      const tolerances = { tightest: raw, valueInch: null, unit: "unknown" };
      const extraction = normalizeDrawingExtraction(
        makeExtractionRecord({ extraction: { tolerances } }),
        "part-1",
      );

      expect(extraction.tightestTolerance.valueInch).toBeNull();
      expect(extraction.tightestTolerance.unit).toBe("unknown");
      expect(extraction.tightestTolerance.raw).toBe(raw);
      expect(extraction.tightestTolerance.hint).toBe(
        `Check the drawing: the units could not be determined. Extracted text: ${raw}`,
      );

      const requirement = buildRequirementDraft(partWithTolerances(tolerances));
      expect(requirement.tightestToleranceInch).toBeNull();
    },
  );

  it.each(["mm", "unknown", "", "UNKNOWN"])(
    "does not derive a number when valueInch is null and unit is %j",
    (unit) => {
      const requirement = buildRequirementDraft(
        partWithTolerances({ tightest: "±.3", valueInch: null, unit }),
      );

      expect(requirement.tightestToleranceInch).toBeNull();
    },
  );

  it("does not derive a number when valueInch is null and the unit is absent", () => {
    const tolerances = { tightest: "±.3", valueInch: null };

    expect(buildRequirementDraft(partWithTolerances(tolerances)).tightestToleranceInch).toBeNull();
    expect(
      buildRequirementDraft(partWithTolerances({ tightest: "±.3" })).tightestToleranceInch,
    ).toBeNull();
    expect(
      normalizeDrawingExtraction(makeExtractionRecord({ extraction: { tolerances } }), "part-1")
        .tightestTolerance.hint,
    ).toContain("±.3");
  });

  it("uses a distinct hint when the unit is inches but no value was stored", () => {
    const extraction = normalizeDrawingExtraction(
      makeExtractionRecord({
        extraction: { tolerances: { tightest: "TYP", valueInch: null, unit: "in" } },
      }),
      "part-1",
    );

    expect(extraction.tightestTolerance.valueInch).toBeNull();
    expect(extraction.tightestTolerance.hint).toBe(
      "Check the drawing: the tolerance value could not be read. Extracted text: TYP",
    );
  });

  it("has no hint when no raw text exists or a value is stored", () => {
    const empty = normalizeDrawingExtraction(
      makeExtractionRecord({ extraction: { tolerances: { valueInch: null, unit: "unknown" } } }),
      "part-1",
    );
    const resolved = normalizeDrawingExtraction(
      makeExtractionRecord({
        extraction: { tolerances: { tightest: "±0.005", valueInch: 0.005, unit: "in" } },
      }),
      "part-1",
    );

    expect(empty.tightestTolerance.hint).toBeNull();
    expect(resolved.tightestTolerance.hint).toBeNull();
  });

  it("prefills the stored value with unit in, as before", () => {
    const tolerances = { tightest: "±0.002 in", valueInch: 0.002, unit: "in" };
    const extraction = normalizeDrawingExtraction(
      makeExtractionRecord({ extraction: { tolerances } }),
      "part-1",
    );

    expect(extraction.tightestTolerance).toMatchObject({
      raw: "±0.002 in",
      valueInch: 0.002,
      unit: "in",
      hint: null,
    });
    expect(buildRequirementDraft(partWithTolerances(tolerances)).tightestToleranceInch).toBe(0.002);
  });

  it("prefills a legacy payload with a numeric valueInch and no unit, as before", () => {
    const tolerances = { tightest: "±0.003", valueInch: 0.003 };
    const extraction = normalizeDrawingExtraction(
      makeExtractionRecord({ extraction: { tolerances } }),
      "part-1",
    );

    expect(extraction.tightestTolerance).toMatchObject({
      valueInch: 0.003,
      unit: null,
      hint: null,
    });
    expect(buildRequirementDraft(partWithTolerances(tolerances)).tightestToleranceInch).toBe(0.003);
  });

  it("lets a stored client or approved value outrank an unresolved extraction", () => {
    const tolerances = { tightest: "±1/64", valueInch: null, unit: "unknown" };
    const clientPart = partWithTolerances(tolerances, {
      clientRequirement: { tightestToleranceInch: 0.01 },
    } as Partial<PartAggregate>);
    const approvedPart = partWithTolerances(tolerances, {
      approvedRequirement: {
        id: "req-1",
        part_id: "part-1",
        organization_id: "org-1",
        material: "6061",
        tightest_tolerance_inch: 0.02,
        applicable_vendors: [],
        spec_snapshot: {},
      } as unknown as PartAggregate["approvedRequirement"],
    });

    expect(buildRequirementDraft(clientPart).tightestToleranceInch).toBe(0.01);
    expect(buildRequirementDraft(approvedPart).tightestToleranceInch).toBe(0.02);
  });

  describe("vendor eligibility", () => {
    it("does not treat a null tolerance as 0.005 for SendCutSend", () => {
      const unresolved = buildRequirementDraft(
        partWithTolerances({ tightest: "±.3", valueInch: null, unit: "unknown" }),
      );
      const noTolerance = buildRequirementDraft(partWithTolerances({}));

      expect(unresolved.applicableVendors).not.toContain("sendcutsend");
      expect(noTolerance.applicableVendors).not.toContain("sendcutsend");
      expect(unresolved.applicableVendors).toEqual(["xometry", "fictiv", "protolabs", "emachineshop"]);
    });

    it("keeps SendCutSend eligible at and above 0.005 and excludes it below", () => {
      const at = buildRequirementDraft(
        partWithTolerances({ tightest: "±0.005", valueInch: 0.005, unit: "in" }),
      );
      const below = buildRequirementDraft(
        partWithTolerances({ tightest: "±0.004", valueInch: 0.004, unit: "in" }),
      );

      expect(at.applicableVendors).toContain("sendcutsend");
      expect(below.applicableVendors).not.toContain("sendcutsend");
    });

    it("judges eligibility on the resolved tolerance, so a user-entered value counts", () => {
      const tolerances = { tightest: "±1/64", valueInch: null, unit: "unknown" };
      const loose = buildRequirementDraft(
        partWithTolerances(tolerances, {
          clientRequirement: { tightestToleranceInch: 0.01 },
        } as Partial<PartAggregate>),
      );

      expect(loose.applicableVendors).toContain("sendcutsend");
    });
  });
});
