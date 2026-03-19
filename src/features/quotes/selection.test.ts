import { describe, expect, it } from "vitest";
import type { VendorQuoteAggregate } from "@/features/quotes/types";
import {
  applyBulkPresetSelection,
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  pickPresetOption,
  revertBulkPresetSelection,
  summarizeSelectedQuoteOptions,
} from "@/features/quotes/selection";

function makeQuoteAggregate(
  overrides: Partial<VendorQuoteAggregate> = {},
): VendorQuoteAggregate {
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
        ship_receive_by: "2026-03-10",
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

describe("selection helpers", () => {
  it("ignores excluded vendors when ranking cheapest preset", () => {
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: [
        makeQuoteAggregate({
          id: "quote-x",
          vendor: "xometry",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-x",
              vendor_quote_result_id: "quote-x",
              total_price_usd: 100,
              unit_price_usd: 10,
            },
          ],
        }),
        makeQuoteAggregate({
          id: "quote-f",
          vendor: "fictiv",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-f",
              vendor_quote_result_id: "quote-f",
              sourcing: "Foreign",
              total_price_usd: 125,
              unit_price_usd: 12.5,
            },
          ],
        }),
      ],
      excludedVendorKeys: ["xometry"],
    });

    expect(pickPresetOption(options, "cheapest")?.persistedOfferId).toBe("offer-f");
  });

  it("filters out late options when a requested due date exists", () => {
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: [
        makeQuoteAggregate({
          id: "quote-late",
          vendor: "xometry",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-late",
              vendor_quote_result_id: "quote-late",
              total_price_usd: 90,
              unit_price_usd: 9,
              ship_receive_by: "2026-03-20",
            },
          ],
        }),
        makeQuoteAggregate({
          id: "quote-on-time",
          vendor: "fictiv",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-on-time",
              vendor_quote_result_id: "quote-on-time",
              total_price_usd: 115,
              unit_price_usd: 11.5,
              ship_receive_by: "2026-03-09",
            },
          ],
        }),
      ],
      requestedByDate: "2026-03-12",
    });

    expect(pickPresetOption(options, "cheapest")?.persistedOfferId).toBe("offer-on-time");
    expect(options.find((option) => option.persistedOfferId === "offer-late")?.dueDateEligible).toBe(false);
  });

  it("prefers domestic options for the domestic preset and preserves unknown when signals are missing", () => {
    const vendorLabels = buildVendorLabelMap(["xometry", "fictiv", "protolabs"]);
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: [
        makeQuoteAggregate({
          id: "quote-foreign",
          vendor: "xometry",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-foreign",
              vendor_quote_result_id: "quote-foreign",
              sourcing: "Overseas",
              total_price_usd: 80,
              unit_price_usd: 8,
            },
          ],
        }),
        makeQuoteAggregate({
          id: "quote-domestic",
          vendor: "fictiv",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-domestic",
              vendor_quote_result_id: "quote-domestic",
              sourcing: "Domestic",
              total_price_usd: 95,
              unit_price_usd: 9.5,
            },
          ],
        }),
        makeQuoteAggregate({
          id: "quote-unknown",
          vendor: "protolabs",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-unknown",
              vendor_quote_result_id: "quote-unknown",
              sourcing: null,
              raw_payload: {},
              total_price_usd: 85,
              unit_price_usd: 8.5,
            },
          ],
        }),
      ],
      vendorLabels,
    });

    expect(pickPresetOption(options, "domestic")?.persistedOfferId).toBe("offer-domestic");
    expect(options.find((option) => option.persistedOfferId === "offer-unknown")?.domesticStatus).toBe("unknown");
    expect(vendorLabels.get("xometry")).toBe("Xometry");
    expect(vendorLabels.get("protolabs")).toBe("Protolabs");
  });

  it("supports multiple offers from one vendor and picks the best selectable lane", () => {
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: [
        makeQuoteAggregate({
          id: "quote-x",
          vendor: "xometry",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-expedite",
              vendor_quote_result_id: "quote-x",
              offer_key: "expedite",
              lane_label: "Expedite",
              total_price_usd: 160,
              unit_price_usd: 16,
              lead_time_business_days: 3,
            },
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-standard",
              vendor_quote_result_id: "quote-x",
              offer_key: "standard",
              lane_label: "Standard",
              total_price_usd: 120,
              unit_price_usd: 12,
              lead_time_business_days: 7,
            },
          ],
        }),
      ],
    });

    expect(pickPresetOption(options, "cheapest")?.persistedOfferId).toBe("offer-standard");
    expect(pickPresetOption(options, "fastest")?.persistedOfferId).toBe("offer-expedite");
  });

  it("reverts only rows still on the bulk-applied offer", () => {
    const bulkResult = applyBulkPresetSelection({
      optionsByJobId: {
        "job-1": buildClientQuoteSelectionOptions({
          vendorQuotes: [
            makeQuoteAggregate({
              id: "quote-job-1",
              offers: [
                {
                  ...makeQuoteAggregate().offers[0]!,
                  id: "offer-job-1",
                  vendor_quote_result_id: "quote-job-1",
                  total_price_usd: 100,
                  unit_price_usd: 10,
                },
              ],
            }),
          ],
        }),
        "job-2": buildClientQuoteSelectionOptions({
          vendorQuotes: [
            makeQuoteAggregate({
              id: "quote-job-2",
              offers: [
                {
                  ...makeQuoteAggregate().offers[0]!,
                  id: "offer-job-2",
                  vendor_quote_result_id: "quote-job-2",
                  total_price_usd: 90,
                  unit_price_usd: 9,
                },
              ],
            }),
          ],
        }),
      },
      currentSelectedOfferIdsByJobId: {
        "job-1": "manual-1",
        "job-2": "manual-2",
      },
      preset: "cheapest",
    });

    const reverted = revertBulkPresetSelection({
      currentSelectedOfferIdsByJobId: {
        "job-1": "offer-job-1",
        "job-2": "manual-override",
      },
      lastBulkAction: bulkResult.changes,
    });

    expect(reverted.nextSelectedOfferIdsByJobId["job-1"]).toBe("manual-1");
    expect(reverted.nextSelectedOfferIdsByJobId["job-2"]).toBe("manual-override");
    expect(reverted.restoredJobIds).toEqual(["job-1"]);
  });

  it("summarizes totals from selected options using total price", () => {
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: [
        makeQuoteAggregate({
          id: "quote-1",
          vendor: "xometry",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-1",
              vendor_quote_result_id: "quote-1",
              total_price_usd: 100,
              unit_price_usd: 10,
              sourcing: "Domestic",
            },
          ],
        }),
        makeQuoteAggregate({
          id: "quote-2",
          vendor: "fictiv",
          offers: [
            {
              ...makeQuoteAggregate().offers[0]!,
              id: "offer-2",
              vendor_quote_result_id: "quote-2",
              total_price_usd: 200,
              unit_price_usd: 20,
              sourcing: "Foreign",
            },
          ],
        }),
      ],
    });

    const summary = summarizeSelectedQuoteOptions(options);

    expect(summary.totalPriceUsd).toBe(300);
    expect(summary.selectedCount).toBe(2);
    expect(summary.domesticCount).toBe(1);
    expect(summary.foreignCount).toBe(1);
  });
});
