import { describe, expect, it } from "vitest";
import {
  buildClientQuoteSelectionOptions,
  type ClientQuoteSelectionOption,
} from "@/features/quotes/selection";
import type {
  JobPartSummary,
  JobRecord,
  PartAggregate,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import {
  buildClientWorkspaceState,
  describeClientPresetUnavailableReason,
  getClientQuoteOptionStateReasons,
  summarizeClientWorkspaceStates,
} from "@/features/quotes/client-workspace-state";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Bracket",
    description: null,
    status: "published",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    requested_quote_quantities: [10],
    requested_by_date: "2026-04-15",
    archived_at: null,
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-00001",
    revision: "A",
    description: "Bracket",
    quantity: 10,
    requestedQuoteQuantities: [10],
    requestedByDate: "2026-04-15",
    importedBatch: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

function makeQuoteAggregate(overrides: Partial<VendorQuoteAggregate> = {}): VendorQuoteAggregate {
  return {
    id: overrides.id ?? "quote-1",
    quote_run_id: overrides.quote_run_id ?? "run-1",
    part_id: overrides.part_id ?? "part-1",
    organization_id: overrides.organization_id ?? "org-1",
    vendor: overrides.vendor ?? "xometry",
    requested_quantity: overrides.requested_quantity ?? 10,
    status: overrides.status ?? "official_quote_received",
    unit_price_usd: overrides.unit_price_usd ?? 11,
    total_price_usd: overrides.total_price_usd ?? 110,
    lead_time_business_days: overrides.lead_time_business_days ?? 7,
    quote_url: overrides.quote_url ?? null,
    dfm_issues: overrides.dfm_issues ?? [],
    notes: overrides.notes ?? [],
    raw_payload: overrides.raw_payload ?? {},
    created_at: overrides.created_at ?? "2026-03-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-03-01T00:00:00.000Z",
    artifacts: overrides.artifacts ?? [],
    offers: overrides.offers ?? [
      {
        id: "offer-1",
        vendor_quote_result_id: overrides.id ?? "quote-1",
        organization_id: "org-1",
        offer_key: "lane-1",
        supplier: "Supplier",
        lane_label: "Standard",
        sourcing: "Domestic",
        tier: null,
        quote_ref: null,
        quote_date: "2026-03-01",
        unit_price_usd: 11,
        total_price_usd: 110,
        lead_time_business_days: 7,
        ship_receive_by: "2026-04-10",
        due_date: null,
        process: "CNC",
        material: "6061",
        finish: null,
        tightest_tolerance: null,
        tolerance_source: null,
        thread_callouts: null,
        thread_match_notes: null,
        notes: null,
        sort_rank: 0,
        raw_payload: {},
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  };
}

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: "cad-1",
    drawing_file_id: "drawing-1",
    quantity: 10,
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad",
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "cad.step",
      normalized_name: "cad.step",
      original_name: "cad.step",
      size_bytes: 100,
      mime_type: "application/step",
      content_sha256: "abc",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-01T00:00:00.000Z",
    },
    drawingFile: null,
    extraction: null,
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  };
}

function buildOptions(vendorQuotes: VendorQuoteAggregate[]): ClientQuoteSelectionOption[] {
  return buildClientQuoteSelectionOptions({
    vendorQuotes,
    requestedByDate: "2026-04-15",
  });
}

describe("client workspace state", () => {
  it("surfaces extraction warnings and quote failures as warnings when options still exist", () => {
    const options = buildOptions([
      makeQuoteAggregate(),
      makeQuoteAggregate({
        id: "quote-2",
        vendor: "fictiv",
        status: "failed",
        offers: [
          {
            ...makeQuoteAggregate().offers[0]!,
            id: "offer-2",
            vendor_quote_result_id: "quote-2",
            ship_receive_by: "2026-04-20",
          },
        ],
      }),
    ]);

    const state = buildClientWorkspaceState({
      job: makeJob(),
      summary: makeSummary(),
      part: makePart({
        extraction: {
          id: "extraction-1",
          part_id: "part-1",
          organization_id: "org-1",
          extractor_version: "test",
          extraction: {},
          evidence: [],
          warnings: ["Verify finish callout"],
          confidence: 0.7,
          status: "needs_review",
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
        vendorQuotes: [
          makeQuoteAggregate(),
          makeQuoteAggregate({
            id: "quote-failed",
            vendor: "fictiv",
            status: "failed",
            offers: [],
          }),
        ],
      }),
      options,
    });

    expect(state.tone).toBe("warning");
    expect(state.selection.label).toBe("Ready to select");
    expect(state.reasons.map((reason) => reason.label)).toContain("1 extraction warning need review");
    expect(state.reasons.map((reason) => reason.label)).toContain("1 quote lane failed");
  });

  it("marks review routes as blocked when a selection is still needed", () => {
    const options = buildOptions([makeQuoteAggregate()]);
    const state = buildClientWorkspaceState({
      job: makeJob(),
      summary: makeSummary(),
      part: makePart({
        vendorQuotes: [makeQuoteAggregate()],
      }),
      options,
      selectedOption: null,
      requireSelection: true,
    });

    expect(state.tone).toBe("blocked");
    expect(state.selection.label).toBe("Selection needed");
    expect(state.selection.detail).toContain("1 eligible option");
  });

  it("describes preset failures and option issues consistently", () => {
    const options = buildOptions([
      makeQuoteAggregate({
        id: "quote-late",
        vendor: "xometry",
        offers: [
          {
            ...makeQuoteAggregate().offers[0]!,
            id: "offer-late",
            vendor_quote_result_id: "quote-late",
            ship_receive_by: "2026-04-25",
            sourcing: "Foreign",
          },
        ],
      }),
    ]);

    const optionReasons = getClientQuoteOptionStateReasons({
      option: options[0]!,
      requestedByDate: "2026-04-15",
      preset: "domestic",
    });

    expect(optionReasons.map((reason) => reason.label)).toEqual([
      "Misses requested date 2026-04-15",
      "Not eligible for Domestic preset",
    ]);
    expect(
      describeClientPresetUnavailableReason({
        options,
        preset: "domestic",
        requestedByDate: "2026-04-15",
      }),
    ).toBe("No quote currently meets the requested date of 2026-04-15.");
  });

  it("summarizes ready, warning, and blocked counts for aggregate views", () => {
    const counts = summarizeClientWorkspaceStates([
      buildClientWorkspaceState({
        job: makeJob(),
        summary: makeSummary(),
        part: makePart({
          vendorQuotes: [makeQuoteAggregate()],
        }),
        options: buildOptions([makeQuoteAggregate()]),
      }),
      buildClientWorkspaceState({
        job: makeJob({ status: "quoting" }),
        summary: makeSummary(),
        part: makePart(),
      }),
      buildClientWorkspaceState({
        job: makeJob({ status: "ready_to_quote" }),
        summary: makeSummary(),
      }),
    ]);

    expect(counts).toEqual({
      ready: 1,
      warning: 1,
      blocked: 1,
    });
  });
});
