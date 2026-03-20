import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientPartReview from "./ClientPartReview";
import ClientProjectReview from "./ClientProjectReview";

const { api, mockUseAppSession } = vi.hoisted(() => ({
  api: {
    fetchAccessibleJobs: vi.fn(),
    fetchClientQuoteWorkspaceByJobIds: vi.fn(),
    fetchJobPartSummariesByJobIds: vi.fn(),
    fetchJobsByProject: vi.fn(),
    fetchProject: vi.fn(),
  },
  mockUseAppSession: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => api);
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleJobs: api.fetchAccessibleJobs,
  fetchClientQuoteWorkspaceByJobIds: api.fetchClientQuoteWorkspaceByJobIds,
  fetchJobPartSummariesByJobIds: api.fetchJobPartSummariesByJobIds,
  fetchJobsByProject: api.fetchJobsByProject,
  fetchProject: api.fetchProject,
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
    children,
    sidebarContent,
  }: {
    children?: ReactNode;
    sidebarContent?: ReactNode;
  }) => (
    <div>
      <div>{sidebarContent}</div>
      <div>{children}</div>
    </div>
  ),
}));

function renderWithClient(component: React.ReactNode, initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>{component}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("client review pages", () => {
  beforeEach(() => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: null,
      signOut: vi.fn(),
    });

    api.fetchAccessibleJobs.mockResolvedValue([]);
    api.fetchJobPartSummariesByJobIds.mockResolvedValue([]);
    api.fetchJobsByProject.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: "project-1",
        selected_vendor_quote_offer_id: "offer-1",
        created_by: "user-1",
        title: "Bracket",
        description: "Project job",
        status: "quoted",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        requested_quote_quantities: [10],
        requested_by_date: "2026-04-15",
        archived_at: null,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
      },
    ]);
    api.fetchProject.mockResolvedValue({
      id: "project-1",
      name: "Bracket RFQ",
      description: null,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    });
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([
      {
        job: {
          id: "job-1",
          organization_id: "org-1",
          project_id: "project-1",
          selected_vendor_quote_offer_id: "offer-1",
          created_by: "user-1",
          title: "Bracket",
          description: "Need this soon",
          status: "quoted",
          source: "client_home",
          active_pricing_policy_id: null,
          tags: [],
          requested_quote_quantities: [10],
          requested_by_date: "2026-04-15",
          archived_at: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
        files: [],
        summary: {
          jobId: "job-1",
          partNumber: "BRKT-001",
          revision: "A",
          description: "Bracket",
          quantity: 10,
          requestedQuoteQuantities: [10],
          requestedByDate: "2026-04-15",
          importedBatch: null,
          selectedSupplier: "Xometry",
          selectedPriceUsd: 100,
          selectedLeadTimeBusinessDays: 7,
        },
        part: {
          id: "part-1",
          job_id: "job-1",
          organization_id: "org-1",
          name: "Bracket",
          normalized_key: "bracket",
          cad_file_id: null,
          drawing_file_id: null,
          quantity: 10,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
          cadFile: null,
          drawingFile: null,
          extraction: null,
          approvedRequirement: null,
          vendorQuotes: [
            {
              id: "quote-1",
              quote_run_id: "run-1",
              part_id: "part-1",
              organization_id: "org-1",
              vendor: "xometry",
              requested_quantity: 10,
              status: "official_quote_received",
              unit_price_usd: 10,
              total_price_usd: 100,
              lead_time_business_days: 7,
              quote_url: null,
              dfm_issues: [],
              notes: [],
              raw_payload: {},
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
              offers: [
                {
                  id: "offer-1",
                  vendor_quote_result_id: "quote-1",
                  organization_id: "org-1",
                  offer_key: "offer-1",
                  supplier: "X Supplier",
                  lane_label: "Standard",
                  sourcing: "USA",
                  tier: null,
                  quote_ref: null,
                  quote_date: "2026-03-01",
                  unit_price_usd: 10,
                  total_price_usd: 100,
                  lead_time_business_days: 7,
                  ship_receive_by: "2026-04-10",
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
                  raw_payload: {},
                  created_at: "2026-03-01T00:00:00Z",
                  updated_at: "2026-03-01T00:00:00Z",
                },
              ],
              artifacts: [],
            },
          ],
        },
        projectIds: ["project-1"],
        drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
        latestQuoteRequest: null,
        latestQuoteRun: null,
      },
    ]);
  });

  it("renders the part review summary with structured procurement handoff state", async () => {
    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId/review" element={<ClientPartReview />} />
        <Route path="/parts/:jobId" element={<div>Part Edit</div>} />
      </Routes>,
      "/parts/job-1/review",
    );

    await waitFor(() => {
      expect(screen.getByText("Selected option")).toBeInTheDocument();
    });

    expect(screen.getByText("Xometry")).toBeInTheDocument();
    expect(screen.getByText("Procurement handoff")).toBeInTheDocument();
    expect(screen.queryByText(/Checkout backend wiring is not available/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/ship-to contact/i), {
      target: { value: "Jamie Buyer" },
    });
    fireEvent.change(screen.getByLabelText(/ship-to location/i), {
      target: { value: "Phoenix, AZ" },
    });
    fireEvent.change(screen.getByLabelText(/billing contact name/i), {
      target: { value: "Jordan Procure" },
    });
    fireEvent.change(screen.getByLabelText(/billing contact email/i), {
      target: { value: "buyer@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /PO required/i }));
    fireEvent.click(screen.getByRole("button", { name: /review handoff/i }));

    expect(await screen.findByText(/manual release coordination/i)).toBeInTheDocument();
    expect(screen.getByText("Jamie Buyer · Phoenix, AZ")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to edit/i }));
    expect(await screen.findByText("Part Edit")).toBeInTheDocument();
  });

  it("renders the project review summary with the same procurement handoff model", async () => {
    renderWithClient(
      <Routes>
        <Route path="/projects/:projectId/review" element={<ClientProjectReview />} />
      </Routes>,
      "/projects/project-1/review",
    );

    await waitFor(() => {
      expect(screen.getByText("Line items")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Bracket RFQ").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("Procurement handoff")).toBeInTheDocument();
    expect(
      screen.getByText(/captures shipping, billing, and PO context for OverDrafter follow-up/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Placeholder surface for shipping method, billing, and purchase-order collection/i)).not.toBeInTheDocument();
  });

  it("holds the protected review route during auth initialization instead of redirecting", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      signOut: vi.fn(),
      isAuthInitializing: true,
    });

    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId/review" element={<ClientPartReview />} />
        <Route path="/" element={<div>Signed Out Home</div>} />
      </Routes>,
      "/parts/job-1/review",
    );

    expect(screen.getByText("Restoring your review session.")).toBeInTheDocument();
    expect(screen.queryByText("Signed Out Home")).not.toBeInTheDocument();
  });
});
