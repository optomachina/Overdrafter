import { describe, expect, it } from "vitest";
import type { ApprovedPartRequirement, PublishedPackageAggregate, VendorQuoteAggregate } from "@/features/quotes/types";
import {
  buildOptionKindsByOfferId,
  buildVisibleQuoteRows,
  resolveClientSummary,
  resolveDraftForUpdate,
} from "./internal-job-detail-view-model";

function makeQuote(overrides: Partial<VendorQuoteAggregate> = {}): VendorQuoteAggregate {
  return {
    id: "quote-1",
    created_at: "2026-03-19T00:00:00.000Z",
    updated_at: "2026-03-19T00:00:00.000Z",
    quote_run_id: "run-1",
    vendor: "xometry",
    part_id: "part-a",
    status: "official_quote_received",
    requested_quantity: 10,
    total_price_usd: 100,
    lead_time_business_days: 5,
    quote_url: null,
    raw_response: null,
    dfm_issues: null,
    vendor_payload: null,
    ...overrides,
  } as VendorQuoteAggregate;
}

describe("internal job detail view model helpers", () => {
  it("groups published option kinds by source offer id", () => {
    const latestPackage = {
      options: [
        {
          id: "option-1",
          option_kind: "balanced",
          source_vendor_quote_offer_id: "offer-1",
        },
        {
          id: "option-2",
          option_kind: "lowest_cost",
          source_vendor_quote_offer_id: "offer-1",
        },
        {
          id: "option-3",
          option_kind: "fastest_delivery",
          source_vendor_quote_offer_id: "offer-2",
        },
      ],
    } as unknown as PublishedPackageAggregate;

    expect(buildOptionKindsByOfferId(latestPackage)).toEqual(
      new Map([
        ["offer-1", ["Balanced", "Lowest Cost"]],
        ["offer-2", ["Fastest Delivery"]],
      ]),
    );
  });

  it("filters and sorts visible quote rows by quantity, part id, and vendor", () => {
    const rows = [
      makeQuote({ id: "quote-3", requested_quantity: 25, part_id: "part-b", vendor: "fictiv" }),
      makeQuote({ id: "quote-2", requested_quantity: 10, part_id: "part-b", vendor: "fictiv" }),
      makeQuote({ id: "quote-1", requested_quantity: 10, part_id: "part-a", vendor: "xometry" }),
      makeQuote({ id: "quote-4", requested_quantity: 10, part_id: "part-a", vendor: "fictiv" }),
    ];

    expect(buildVisibleQuoteRows(rows, 10).map((row) => row.id)).toEqual([
      "quote-4",
      "quote-1",
      "quote-2",
    ]);
    expect(buildVisibleQuoteRows(rows, "all").map((row) => row.id)).toEqual([
      "quote-4",
      "quote-1",
      "quote-2",
      "quote-3",
    ]);
  });

  it("resets client summary when the active job changes", () => {
    expect(
      resolveClientSummary({
        current: "Old job summary",
        didJobChange: true,
        jobTitle: "New job",
        latestPackageSummary: null,
      }),
    ).toBe("Curated CNC quote package for New job.");

    expect(
      resolveClientSummary({
        current: "Edited summary",
        didJobChange: false,
        jobTitle: "Same job",
        latestPackageSummary: "Published summary",
      }),
    ).toBe("Edited summary");
  });

  it("keeps updateDraft safe when a part id is no longer available", () => {
    const currentDraft = {
      partId: "part-a",
      requestedServiceKinds: ["cnc_milling"],
      primaryServiceKind: "cnc_milling",
      serviceNotes: null,
      description: "Bracket",
      partNumber: "BRKT-001",
      revision: "A",
      material: "6061 Aluminum",
      finish: "As machined",
      tightestToleranceInch: 0.005,
      process: null,
      notes: null,
      quantity: 1,
      quoteQuantities: [1],
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
      applicableVendors: ["xometry"],
    } as ApprovedPartRequirement;

    expect(
      resolveDraftForUpdate({
        currentDraft,
        job: null,
        jobRequestDefaults: {
          requested_service_kinds: [],
          primary_service_kind: null,
          service_notes: null,
          requested_quote_quantities: [],
          requested_by_date: null,
        },
        partId: "part-a",
      }),
    ).toBe(currentDraft);

    expect(
      resolveDraftForUpdate({
        currentDraft: undefined,
        job: null,
        jobRequestDefaults: {
          requested_service_kinds: [],
          primary_service_kind: null,
          service_notes: null,
          requested_quote_quantities: [],
          requested_by_date: null,
        },
        partId: "missing-part",
      }),
    ).toBeNull();
  });
});
