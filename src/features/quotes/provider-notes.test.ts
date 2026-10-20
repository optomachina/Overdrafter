import { describe, expect, it } from "vitest";
import { resolveProviderNotes, readWorkerNotes } from "@/features/quotes/provider-notes";
import { buildClientQuoteSelectionResult } from "@/features/quotes/selection";
import type { VendorQuoteAggregate } from "@/features/quotes/types";

// OVD-982: the customer "Provider notes" block may only show offer notes that the
// worker marked as provider-written (`raw_payload.notesSource === "provider"`, written by
// worker/src/vendorQuoteOffer.ts). Rows persisted before that change hold worker
// automation text in `notes` with no marker, so the client cannot trust `notes` alone.

const AUTOMATION_TEXT = "Live Xometry quote captured via Playwright.";

function makeQuote(offerNotes: string | null, offerRawPayload: Record<string, unknown>): VendorQuoteAggregate {
  return {
    id: "quote-1",
    quote_run_id: "run-1",
    part_id: "part-1",
    organization_id: "org-1",
    vendor: "xometry",
    requested_quantity: 10,
    status: "instant_quote_received",
    unit_price_usd: 11,
    total_price_usd: 110,
    lead_time_business_days: 7,
    quote_url: null,
    dfm_issues: [],
    notes: [AUTOMATION_TEXT],
    // Result-level payload is never a source for the customer notes block.
    raw_payload: { notesSource: "provider" },
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    artifacts: [],
    offers: [
      {
        id: "offer-1",
        vendor_quote_result_id: "quote-1",
        organization_id: "org-1",
        offer_key: "xometry-10",
        supplier: "Supplier",
        lane_label: "Standard",
        sourcing: "Domestic",
        tier: null,
        quote_ref: null,
        quote_date: "2026-03-01",
        unit_price_usd: 11,
        total_price_usd: 110,
        lead_time_business_days: 7,
        ship_receive_by: "2026-03-10",
        due_date: null,
        process: "CNC",
        material: "6061",
        finish: null,
        tightest_tolerance: null,
        tolerance_source: null,
        thread_callouts: null,
        thread_match_notes: null,
        notes: offerNotes,
        sort_rank: 0,
        raw_payload: offerRawPayload as VendorQuoteAggregate["offers"][number]["raw_payload"],
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  };
}

function providerNotesFor(quote: VendorQuoteAggregate) {
  const [option] = buildClientQuoteSelectionResult({ vendorQuotes: [quote] }).options;
  expect(option).toBeDefined();
  return option!.providerNotes;
}

describe("resolveProviderNotes", () => {
  it("returns notes only for an explicit provider marker", () => {
    expect(resolveProviderNotes("Anodize adds 2 days", { notesSource: "provider" })).toBe("Anodize adds 2 days");
  });

  it.each([
    ["no marker (historical row)", {}],
    ["null payload", null],
    ["array payload", ["provider"]],
    ["string payload", "provider"],
    ["a different source", { notesSource: "worker" }],
    ["a truthy non-string marker", { notesSource: true }],
    ["wrong case", { notesSource: "Provider" }],
    ["a nested marker", { raw: { notesSource: "provider" } }],
  ])("returns null for %s", (_name, payload) => {
    expect(resolveProviderNotes(AUTOMATION_TEXT, payload)).toBeNull();
  });

  it("returns null for blank or non-string notes even with the marker", () => {
    expect(resolveProviderNotes(null, { notesSource: "provider" })).toBeNull();
    expect(resolveProviderNotes("   ", { notesSource: "provider" })).toBeNull();
    expect(resolveProviderNotes(undefined, { notesSource: "provider" })).toBeNull();
  });
});

describe("readWorkerNotes", () => {
  it("reads only string entries of raw_payload.workerNotes", () => {
    expect(readWorkerNotes({ workerNotes: ["a", 3, "", " b "] })).toEqual(["a", "b"]);
    expect(readWorkerNotes({ workerNotes: "a" })).toEqual([]);
    expect(readWorkerNotes(null)).toEqual([]);
    expect(readWorkerNotes({})).toEqual([]);
  });
});

describe("client quote option providerNotes (OVD-982)", () => {
  it("a historical row holding automation text without a marker exposes no provider notes", () => {
    const providerNotes = providerNotesFor(makeQuote(AUTOMATION_TEXT, { source: "xometry-live-adapter" }));
    expect(providerNotes).toBeNull();
  });

  it("a worker-written row (null notes, automation only in workerNotes) exposes no provider notes", () => {
    const providerNotes = providerNotesFor(makeQuote(null, { workerNotes: [AUTOMATION_TEXT] }));
    expect(providerNotes).toBeNull();
  });

  it("a row marked provider-sourced exposes its notes", () => {
    const providerNotes = providerNotesFor(
      makeQuote("Anodize adds 2 business days.", { notesSource: "provider", workerNotes: [AUTOMATION_TEXT] }),
    );
    expect(providerNotes).toBe("Anodize adds 2 business days.");
  });

  it("only the offer's own payload counts: a marker on the parent result does not promote offer notes", () => {
    expect(providerNotesFor(makeQuote(AUTOMATION_TEXT, {}))).toBeNull();
  });
});
