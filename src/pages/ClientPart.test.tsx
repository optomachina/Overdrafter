import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientPart from "./ClientPart";

const { api, mockUseAppSession } = vi.hoisted(() => ({
  api: {
    archiveJob: vi.fn(),
    archiveProject: vi.fn(),
    assignJobToProject: vi.fn(),
    createJobsFromUploadFiles: vi.fn(),
    createProject: vi.fn(),
    deleteArchivedJob: vi.fn(),
    dissolveProject: vi.fn(),
    fetchAccessibleJobs: vi.fn(),
    fetchAccessibleProjects: vi.fn(),
    fetchArchivedJobs: vi.fn(),
    fetchArchivedProjects: vi.fn(),
    fetchJobPartSummariesByJobIds: vi.fn(),
    fetchPartDetail: vi.fn(),
    fetchProjectJobMembershipsByJobIds: vi.fn(),
    fetchSidebarPins: vi.fn(),
    isProjectCollaborationSchemaUnavailable: vi.fn(),
    pinJob: vi.fn(),
    pinProject: vi.fn(),
    reconcileJobParts: vi.fn(),
    removeJobFromProject: vi.fn(),
    requestExtraction: vi.fn(),
    setJobSelectedVendorQuoteOffer: vi.fn(),
    unarchiveJob: vi.fn(),
    unarchiveProject: vi.fn(),
    unpinJob: vi.fn(),
    unpinProject: vi.fn(),
    updateClientPartRequest: vi.fn(),
    updateProject: vi.fn(),
    uploadFilesToJob: vi.fn(),
  },
  mockUseAppSession: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => api);

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/components/chat/ChatWorkspaceLayout", () => ({
  ChatWorkspaceLayout: ({
    children,
    sidebarContent,
    sidebarFooter,
  }: {
    children?: ReactNode;
    sidebarContent?: ReactNode;
    sidebarFooter?: ReactNode;
  }) => (
    <div>
      <div>{sidebarContent}</div>
      <div>{children}</div>
      <div>{sidebarFooter}</div>
    </div>
  ),
}));

vi.mock("@/components/chat/WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div>Sidebar</div>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => <div>Account Menu</div>,
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/chat/PartActionsMenu", () => ({
  PartDropdownMenuActions: () => null,
}));

vi.mock("@/components/quotes/ClientQuoteAssetPanels", () => ({
  ClientCadPreviewPanel: () => <div>CAD</div>,
  ClientDrawingPreviewPanel: () => <div>Drawing</div>,
}));

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: () => <div>Chart</div>,
}));

vi.mock("@/components/quotes/DrawingPreviewDialog", () => ({
  DrawingPreviewDialog: () => null,
}));

function renderWithClient(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/parts/:jobId" element={<ClientPart />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ClientPart", () => {
  beforeEach(() => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: null,
      signOut: vi.fn(),
    });

    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(false);
    api.fetchAccessibleProjects.mockResolvedValue([]);
    api.fetchAccessibleJobs.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
        created_by: "user-1",
        title: "Bracket",
        description: null,
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
    api.fetchJobPartSummariesByJobIds.mockResolvedValue([
      {
        jobId: "job-1",
        partNumber: "BRKT-001",
        revision: "A",
        description: "Bracket",
        quantity: 10,
        importedBatch: null,
        requestedQuoteQuantities: [10],
        requestedByDate: "2026-04-15",
        selectedSupplier: "Vendor A",
        selectedPriceUsd: 100,
        selectedLeadTimeBusinessDays: 7,
      },
    ]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValue([]);
    api.fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    api.fetchArchivedProjects.mockResolvedValue([]);
    api.fetchArchivedJobs.mockResolvedValue([]);
    api.fetchPartDetail.mockResolvedValue({
      job: {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
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
        selected_vendor_quote_offer_id: "offer-1",
      },
      files: [],
      summary: {
        jobId: "job-1",
        partNumber: "BRKT-001",
        revision: "A",
        description: "Bracket",
        quantity: 10,
        importedBatch: null,
        requestedQuoteQuantities: [10],
        requestedByDate: "2026-04-15",
        selectedSupplier: "Vendor A",
        selectedPriceUsd: 100,
        selectedLeadTimeBusinessDays: 7,
      },
      packages: [],
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
        vendorQuotes: [],
      },
      projectIds: [],
      drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
      latestQuoteRun: null,
      revisionSiblings: [
        {
          jobId: "job-2",
          revision: "B",
          title: "BRKT-001 rev B",
        },
      ],
    });
  });

  it("uses revision siblings from the main part detail aggregate", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /prev rev/i })).toBeInTheDocument();
    expect(api.fetchPartDetail).toHaveBeenCalledTimes(1);
  });
});
