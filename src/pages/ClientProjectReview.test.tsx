import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import type { VendorQuoteAggregate } from "@/features/quotes/types";
import ClientProjectReview from "./ClientProjectReview";

const api = vi.hoisted(() => ({
  fetchProject: vi.fn(),
  fetchJobsByProject: vi.fn(),
  fetchClientQuoteWorkspaceByJobIds: vi.fn(),
}));
vi.mock("@/features/quotes/api/workspace-access", () => api);
vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({ user: { id: "client" }, isAuthInitializing: false }),
}));
vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

function markQuoteAsTrustedLive(quote: VendorQuoteAggregate) {
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

function createVendorQuoteFixture(input: {
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

beforeEach(() => {
  vi.resetAllMocks();
  api.fetchProject.mockResolvedValue({ id: "project-1", name: "Project one" });
  api.fetchJobsByProject.mockResolvedValue([{ id: "job-1" }]);
  api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([]);
});
afterEach(cleanup);

describe("project review quote-options failures", () => {
  it.each(["jobs", "workspace"])("shows an error and disables handoff when %s fails", async (failedQuery) => {
    const query = failedQuery === "jobs" ? api.fetchJobsByProject : api.fetchClientQuoteWorkspaceByJobIds;
    query.mockRejectedValue(new Error("Query unavailable"));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Unable to load quote options. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review handoff" })).toBeDisabled();
    expect(screen.queryByText(/Choose a (quote|package option) to continue/)).not.toBeInTheDocument();
    if (failedQuery === "jobs") expect(api.fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });
});

describe("project review background failures", () => {
  it.each(["jobs", "workspace"])("keeps handoff enabled after a background %s failure", async (failedQuery) => {
    const item = createClientQuoteWorkspaceItemFixture();
    item.part!.vendorQuotes = [markQuoteAsTrustedLive(createVendorQuoteFixture({
      resultId: "result-1", offerId: "offer-1", supplier: "Supplier",
      totalPriceUsd: 100, leadTimeBusinessDays: 7,
    }))];
    item.publishedQuoteOptions = [{
      id: "option-A", package_id: "package-1", organization_id: "org-1",
      option_kind: "lowest_cost", label: "Lowest cost", requested_quantity: 10,
      published_price_usd: 100, lead_time_business_days: 7,
      source_vendor_quote_id: "result-1", source_vendor_quote_offer_id: "offer-1",
      comparison_summary: null, markup_policy_version: "v1", created_at: new Date().toISOString(),
    }];
    item.publishedQuoteSelection = {
      id: "selection-1", option_id: "option-A", package_id: "package-1",
      organization_id: "org-1", selected_by: "client", note: null, created_at: new Date().toISOString(),
    };
    api.fetchJobsByProject.mockResolvedValue([item.job]);
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([item]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: "Review handoff" });
    await waitFor(() => expect(button).toBeEnabled());
    const query = failedQuery === "jobs" ? api.fetchJobsByProject : api.fetchClientQuoteWorkspaceByJobIds;
    query.mockRejectedValue(new Error("Background refetch unavailable"));
    const calls = query.mock.calls.length;
    await act(async () => { await client.refetchQueries(); });
    expect(query.mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(client.getQueryCache().getAll().some(
      (entry) => entry.state.status === "error" && entry.state.data !== undefined,
    )).toBe(true));
    expect(button).toBeEnabled();
    expect(screen.queryByText("Unable to load quote options. Please try again.")).not.toBeInTheDocument();
  });
});
