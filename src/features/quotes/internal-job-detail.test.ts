import { describe, expect, it } from "vitest";
import {
  getInternalJobRefetchInterval,
  getInternalJobVisibleQuoteRows,
} from "@/features/quotes/internal-job-detail";
import type { JobAggregate, VendorQuoteAggregate } from "@/features/quotes/types";

function makeQuote(
  overrides: Partial<VendorQuoteAggregate> = {},
): VendorQuoteAggregate {
  return {
    id: "quote-1",
    quote_run_id: "run-1",
    organization_id: "org-1",
    part_id: "part-b",
    vendor: "xometry",
    requested_quantity: 10,
    status: "official_quote_received",
    unit_price_usd: 10,
    total_price_usd: 100,
    lead_time_business_days: 5,
    quote_url: null,
    raw_payload: {},
    dfm_issues: [],
    summary_notes: null,
    failure_reason: null,
    created_at: "2026-03-19T00:00:00.000Z",
    updated_at: "2026-03-19T00:00:00.000Z",
    offers: [],
    artifacts: [],
    ...overrides,
  } as VendorQuoteAggregate;
}

function makeJobAggregate(
  overrides: Partial<JobAggregate> = {},
): JobAggregate {
  return {
    job: {
      id: "job-1",
      organization_id: "org-1",
      selected_vendor_quote_offer_id: null,
      created_by: "user-1",
      title: "Optic mount",
      description: null,
      status: "internal_review",
      source: "manual",
      active_pricing_policy_id: null,
      tags: [],
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      requested_quote_quantities: [1],
      requested_by_date: null,
      archived_at: null,
      created_at: "2026-03-19T00:00:00.000Z",
      updated_at: "2026-03-19T00:00:00.000Z",
    },
    files: [],
    parts: [],
    quoteRuns: [],
    packages: [],
    pricingPolicy: null,
    workQueue: [],
    drawingPreviewAssets: [],
    debugExtractionRuns: [],
    ...overrides,
  } as JobAggregate;
}

describe("internal job detail helpers", () => {
  it("polls while a debug extraction run is queued or running", () => {
    expect(
      getInternalJobRefetchInterval(
        makeJobAggregate({
          debugExtractionRuns: [
            {
              id: "debug-1",
              job_id: "job-1",
              part_id: "part-1",
              organization_id: "org-1",
              requested_model: "gpt-5.4",
              status: "queued",
              error: null,
              started_at: null,
              completed_at: null,
              result: {},
              created_at: "2026-03-19T00:00:00.000Z",
              updated_at: "2026-03-19T00:00:00.000Z",
            },
          ] as JobAggregate["debugExtractionRuns"],
        }),
      ),
    ).toBe(2500);
  });

  it("polls while a debug extraction task is queued or running", () => {
    expect(
      getInternalJobRefetchInterval(
        makeJobAggregate({
          workQueue: [
            {
              id: "task-1",
              organization_id: "org-1",
              task_type: "debug_extract_part",
              status: "running",
              payload: {},
              job_id: "job-1",
              part_id: "part-1",
              quote_run_id: null,
              package_id: null,
              attempts: 0,
              available_at: "2026-03-19T00:00:00.000Z",
              locked_at: null,
              locked_by: null,
              last_error: null,
              created_at: "2026-03-19T00:00:00.000Z",
              updated_at: "2026-03-19T00:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe(2500);
  });

  it("stops polling when no debug work is in flight", () => {
    expect(getInternalJobRefetchInterval(makeJobAggregate())).toBe(false);
  });

  it("filters and sorts vendor quote rows deterministically", () => {
    const quoteRows = [
      makeQuote({ id: "quote-3", requested_quantity: 20, part_id: "part-a", vendor: "protolabs" }),
      makeQuote({ id: "quote-1", requested_quantity: 10, part_id: "part-b", vendor: "xometry" }),
      makeQuote({ id: "quote-2", requested_quantity: 10, part_id: "part-a", vendor: "fictiv" }),
    ];

    expect(
      getInternalJobVisibleQuoteRows({
        quoteRows,
        activeCompareRequestedQuantity: "all",
      }).map((quote) => quote.id),
    ).toEqual(["quote-2", "quote-1", "quote-3"]);

    expect(
      getInternalJobVisibleQuoteRows({
        quoteRows,
        activeCompareRequestedQuantity: 10,
      }).map((quote) => quote.id),
    ).toEqual(["quote-2", "quote-1"]);
  });
});
