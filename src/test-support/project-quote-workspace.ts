import { onlineManager, QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, type Mock } from "vitest";
import type { VendorQuoteAggregate, PublishedQuoteOptionRecord } from "@/features/quotes/types";

export function markQuoteAsTrustedLive(quote: VendorQuoteAggregate) {
  const collectedAt = new Date().toISOString();

  return {
    ...quote,
    quote_url: `https://www.xometry.com/quoting/home/${quote.id}`,
    raw_payload: {
      automationVersion: "xometry-worker-v1",
      detectedFlow: "quote_ready",
      requirementCapturedAt: collectedAt,
    },
    created_at: collectedAt,
    updated_at: collectedAt,
    offers: quote.offers.map((offer) => ({
      ...offer,
      quote_date: collectedAt.slice(0, 10),
      created_at: collectedAt,
      updated_at: collectedAt,
    })),
  } satisfies VendorQuoteAggregate;
}

export function createVendorQuoteFixture(input: {
  resultId: string;
  offerId: string;
  vendor?: VendorQuoteAggregate["vendor"];
  supplier: string;
  totalPriceUsd: number;
  leadTimeBusinessDays: number;
}): VendorQuoteAggregate {
  return {
    id: input.resultId,
    quote_run_id: "run-1",
    part_id: "part-1",
    organization_id: "org-1",
    vendor: input.vendor ?? "xometry",
    requested_quantity: 10,
    status: "instant_quote_received",
    unit_price_usd: input.totalPriceUsd / 10,
    total_price_usd: input.totalPriceUsd,
    lead_time_business_days: input.leadTimeBusinessDays,
    quote_url: `https://example.test/${input.resultId}`,
    dfm_issues: [],
    notes: [],
    raw_payload: { domestic: true },
    created_at: "2026-03-01T01:00:00Z",
    updated_at: "2026-03-01T01:00:00Z",
    offers: [
      {
        id: input.offerId,
        vendor_quote_result_id: input.resultId,
        organization_id: "org-1",
        offer_key: input.offerId,
        supplier: input.supplier,
        lane_label: "Standard",
        sourcing: "Domestic",
        tier: "standard",
        quote_ref: `${input.offerId}-ref`,
        quote_date: "2026-03-01",
        unit_price_usd: input.totalPriceUsd / 10,
        total_price_usd: input.totalPriceUsd,
        lead_time_business_days: input.leadTimeBusinessDays,
        ship_receive_by: null,
        due_date: null,
        process: "CNC mill",
        material: "6061-T6",
        finish: "As machined",
        tightest_tolerance: "+/-0.005",
        tolerance_source: "fixture",
        thread_callouts: null,
        thread_match_notes: null,
        notes: "Fixture lane",
        sort_rank: 0,
        raw_payload: { domestic: true },
        created_at: "2026-03-01T01:00:00Z",
        updated_at: "2026-03-01T01:00:00Z",
      },
    ],
    artifacts: [],
  };
}

export function createPublishedQuoteOptionsFixture(): PublishedQuoteOptionRecord[] {
  return [{
    id: "option-A", package_id: "package-1", organization_id: "org-1",
    option_kind: "lowest_cost", label: "Lowest cost", requested_quantity: 10,
    published_price_usd: 100, lead_time_business_days: 7,
    source_vendor_quote_id: "result-1", source_vendor_quote_offer_id: "offer-1",
    comparison_summary: null, markup_policy_version: "v1", created_at: new Date().toISOString(),
  }];
}

type OfflineApi = { fetchJobsByProject: Mock; fetchClientQuoteWorkspaceByJobIds: Mock };

export function createOfflineQuoteOptionsClient(scenario: string, api: OfflineApi) {
  if (scenario === "cold open") onlineManager.setOnline(false);
  else api.fetchClientQuoteWorkspaceByJobIds.mockImplementationOnce(async () => {
    onlineManager.setOnline(false);
    throw new Error("Offline during workspace retry");
  });
  return new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
}

export async function expectOfflineQuoteOptionsRecovery(client: QueryClient, scenario: string, api: OfflineApi) {
  await waitFor(() => expect(client.getQueryCache().getAll().some(
    (query) => query.state.fetchStatus === "paused",
  )).toBe(true));
  // Let React render the paused state; reading the DOM straight away can still see
  // the earlier fetching render and pass even when paused queries are mishandled.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(await screen.findByText("Loading quote options…")).toBeInTheDocument();
  expect(screen.queryByText(/Choose a (quote|package option) to continue/)).not.toBeInTheDocument();
  if (scenario === "cold open") expect(api.fetchJobsByProject).not.toHaveBeenCalled();
  else expect(api.fetchClientQuoteWorkspaceByJobIds).toHaveBeenCalledTimes(1);
  await act(async () => { onlineManager.setOnline(true); });
  expect(await screen.findByText(/Choose a package option to continue/)).toBeInTheDocument();
  expect(screen.queryByText("Loading quote options…")).not.toBeInTheDocument();
}
