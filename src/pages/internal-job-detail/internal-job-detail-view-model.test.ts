import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovedPartRequirement, JobAggregate, PublishedPackageAggregate, VendorQuoteAggregate } from "@/features/quotes/types";
import {
  buildOptionKindsByOfferId,
  buildVisibleQuoteRows,
  resolveClientSummary,
  resolveDraftForUpdate,
  useInternalJobDetailViewModel,
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


describe("internal quantity validation", () => {
  const job = {
    job: { id: "job-1", title: "Bracket" },
    parts: [{ id: "part-a", quantity: 10, vendorQuotes: [] }],
    packages: [],
  } as unknown as JobAggregate;

  it("keeps the real draft unsaved until invalid quote text is corrected", () => {
    const { result } = renderHook(() => useInternalJobDetailViewModel({ job, latestQuoteRun: null }));
    const draft = result.current.drafts["part-a"];
    expect(draft.quantity).toBe(10);
    act(() => result.current.setQuoteQuantityInputs({ "part-a": "10/12.5" }));
    act(() => result.current.commitQuoteQuantityInput("part-a", draft));
    expect(result.current.quoteQuantityInputs["part-a"]).toBe("10/12.5");
    expect(result.current.drafts["part-a"]).toEqual(draft);
    expect(result.current.requirementsBlocked).toBe(true);
    expect(() => result.current.getRequirementsForSave()).toThrow("Enter whole numbers");
    act(() => result.current.setQuoteQuantityInputs({ "part-a": "10/25" }));
    expect(result.current.requirementsBlocked).toBe(false);
    act(() => { expect(result.current.getRequirementsForSave()[0].quoteQuantities).toEqual([10, 25]); });
  });

  it.each(["", "12.5", "-1", "0", "abc", "1,000"])("retains invalid Quantity %j without changing the draft", (text) => {
    const { result } = renderHook(() => useInternalJobDetailViewModel({ job, latestQuoteRun: null }));
    const draft = result.current.drafts["part-a"];
    act(() => result.current.setDraftQuantity("part-a", draft, text));
    expect(result.current.getQuantityInput("part-a", draft)).toBe(text);
    expect(result.current.drafts["part-a"].quantity).toBe(10);
    expect(result.current.requirementsBlocked).toBe(true);
    expect(() => result.current.getRequirementsForSave()).toThrow("Enter a whole number");
    act(() => result.current.setDraftQuantity("part-a", draft, "50"));
    act(() => { expect(result.current.getRequirementsForSave()[0].quantity).toBe(50); });
  });
  it.each([
    { old: 10, quantities: [10, 25, 100], text: "50", expected: [50, 25, 100] },
    { old: 10, quantities: [10, 25, 50], text: "5", expected: [5, 25, 50] },
    { old: 25, quantities: [10, 25, 50], text: "5", expected: [5, 10, 50] },
    { old: 7, quantities: [10, 25, 50], text: "5", expected: [5, 10, 25, 50] },
  ])("commits $old to $text on save without intermediate quantities", ({ old, quantities, text, expected }) => {
    const requestedJob = {
      ...job,
      job: { ...job.job, requested_quote_quantities: quantities },
      parts: [{ ...job.parts[0], quantity: old }],
    };
    const { result } = renderHook(() => useInternalJobDetailViewModel({ job: requestedJob, latestQuoteRun: null }));
    const draft = result.current.drafts["part-a"];
    for (const input of ["", text[0], text]) {
      act(() => result.current.setDraftQuantity("part-a", result.current.drafts["part-a"], input));
      expect(result.current.drafts["part-a"]).toEqual(draft);
      expect(result.current.quoteQuantityInputs["part-a"]).toBe(quantities.join("/"));
    }
    act(() => {
      const saved = result.current.getRequirementsForSave()[0];
      expect(saved.quantity).toBe(Number(text));
      expect(saved.quoteQuantities).toEqual(expected);
    });
  });

  it.each(["50", "12.5"])("blocks hidden pending Quantity %s instead of submitting a stale draft", (text) => {
    const { result } = renderHook(() => useInternalJobDetailViewModel({ job, latestQuoteRun: null }));
    act(() => result.current.setDraftQuantity("part-a", result.current.drafts["part-a"], text));
    act(() => result.current.updateDraft("part-a", (draft) => ({
      ...draft, requestedServiceKinds: ["cad_modeling"], primaryServiceKind: "cad_modeling",
    })));
    expect(result.current.requirementsBlocked).toBe(true);
    expect(() => result.current.getRequirementsForSave()).toThrow("Restore quote services");
  });

  it.each(["10/50", "10/12.5"])("blocks hidden pending Quote quantities %s", (text) => {
    const { result } = renderHook(() => useInternalJobDetailViewModel({ job, latestQuoteRun: null }));
    act(() => result.current.setQuoteQuantityInputs({ "part-a": text }));
    act(() => result.current.updateDraft("part-a", (draft) => ({
      ...draft, requestedServiceKinds: ["cad_modeling"], primaryServiceKind: "cad_modeling",
    })));
    expect(result.current.requirementsBlocked).toBe(true);
    expect(() => result.current.getRequirementsForSave()).toThrow("Restore quote services");
  });

  it("keeps a clean save and refetch clean when quote fields are then hidden", () => {
    const { result, rerender } = renderHook(({ currentJob }) => useInternalJobDetailViewModel({
      job: currentJob, latestQuoteRun: null,
    }), { initialProps: { currentJob: job } });
    act(() => result.current.setDraftQuantity("part-a", result.current.drafts["part-a"], "50"));
    act(() => { result.current.getRequirementsForSave(); });
    rerender({ currentJob: { ...job, parts: [{ ...job.parts[0], quantity: 50 }] } });
    act(() => result.current.updateDraft("part-a", (draft) => ({
      ...draft, requestedServiceKinds: ["cad_modeling"], primaryServiceKind: "cad_modeling",
    })));
    expect(result.current.requirementsBlocked).toBe(false);
    act(() => {
      expect(result.current.getRequirementsForSave()[0]).toMatchObject({ quantity: 50, quoteQuantities: [50] });
    });
  });

});
