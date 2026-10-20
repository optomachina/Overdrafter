import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InternalJobVendorCompareSection } from "./InternalJobVendorCompareSection";
import type { JobAggregate, VendorQuoteAggregate } from "@/features/quotes/types";

// OVD-982: the worker no longer writes its automation status into the offer `notes` column
// (customer-visible when provider notes are enabled). Operators still see it here, from
// raw_payload.workerNotes, on an internal-only page.

function makeQuote(): VendorQuoteAggregate {
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
    notes: [],
    raw_payload: {},
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    artifacts: [],
    offers: [
      {
        id: "offer-1",
        vendor_quote_result_id: "quote-1",
        organization_id: "org-1",
        offer_key: "xometry-10",
        supplier: "Xometry",
        lane_label: "Standard",
        sourcing: null,
        tier: null,
        quote_ref: null,
        quote_date: "2026-03-01",
        unit_price_usd: 11,
        total_price_usd: 110,
        lead_time_business_days: 7,
        ship_receive_by: null,
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
        raw_payload: { workerNotes: ["Live Xometry quote captured via Playwright."] },
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ],
  } as unknown as VendorQuoteAggregate;
}

describe("InternalJobVendorCompareSection worker notes", () => {
  it("shows worker automation notes, labelled as such, for operators", () => {
    const quote = makeQuote();
    render(
      <InternalJobVendorCompareSection
        activeCompareRequestedQuantity={null}
        compareQuantities={[10]}
        job={{ parts: [{ id: "part-1", name: "Bracket" }] } as unknown as JobAggregate}
        onChangeQuantity={() => undefined}
        optionKindsByOfferId={new Map()}
        quoteRows={[quote]}
        visibleQuoteRows={[quote]}
      />,
    );

    expect(screen.getByTestId("offer-worker-notes")).toHaveTextContent(
      "Worker notes: Live Xometry quote captured via Playwright.",
    );
  });
});
