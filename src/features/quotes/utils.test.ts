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
  normalizeDrawingExtraction,
  normalizeDrawingPreview,
  projectedClientPrice,
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
    offer_key: "lane-a",
    supplier: "Vendor A",
    lane_label: null,
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
      material: {
        raw: "6061-T6 AL",
        normalized: "6061 aluminum",
        confidence: 0.91,
      },
      finish: {
        raw: "Anodize",
        normalized: null,
        confidence: 0.47,
      },
      tightestTolerance: {
        raw: "+/- .002 in",
        valueInch: 0.002,
        confidence: 0.47,
      },
      evidence: [],
      warnings: ["Verify finish callout"],
      status: "approved",
    });
  });

  it("builds requirement drafts from extraction data and excludes SendCutSend for tight tolerances", () => {
    const part = makePartAggregate({
      extraction: makeExtractionRecord({
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
        quantity: 9,
        applicable_vendors: ["partsbadger"],
        created_at: "2026-03-03T00:00:00Z",
        updated_at: "2026-03-03T00:00:00Z",
      } as PartAggregate["approvedRequirement"],
    });

    expect(buildRequirementDraft(part)).toMatchObject({
      description: "Approved bracket",
      partNumber: "PN-001",
      revision: "C",
      material: "7075 aluminum",
      finish: "Black anodize",
      tightestToleranceInch: 0.01,
      quantity: 9,
      quoteQuantities: [9],
      requestedByDate: null,
      applicableVendors: ["partsbadger"],
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
    } as VendorQuoteAggregate;

    expect(getImportedVendorOffers(quote).map((offer) => [offer.offerId, offer.requestedQuantity])).toEqual([
      ["lane-b", 1],
      ["lane-a", 1],
      ["lane-z", 1],
    ]);
  });

  it("falls back to raw payload offers and filters out invalid price rows", () => {
    const quote = {
      raw_payload: {
        source: "manual-quote-intake",
        offers: [
          { offerId: "slow", supplier: "A", totalPriceUsd: 200, unitPriceUsd: 100 },
          { offerId: "bad", supplier: "B", totalPriceUsd: "n/a" },
          { offerId: "fast", supplier: "C", totalPriceUsd: 150, unitPriceUsd: 75 },
        ],
      },
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
