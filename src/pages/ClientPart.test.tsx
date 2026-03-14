import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientPart from "./ClientPart";

const { api, mockUseAppSession, prefetchProjectPage, prefetchPartPage } = vi.hoisted(() => ({
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
  prefetchProjectPage: vi.fn(),
  prefetchPartPage: vi.fn(),
}));

let lastSidebarProps: Record<string, unknown> | null = null;

vi.mock("@/features/quotes/api", () => api);

vi.mock("@/features/quotes/workspace-navigation", async () => {
  const actual = await vi.importActual<typeof import("@/features/quotes/workspace-navigation")>(
    "@/features/quotes/workspace-navigation",
  );

  return {
    ...actual,
    prefetchProjectPage,
    prefetchPartPage,
  };
});

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
  WorkspaceSidebar: (props: Record<string, unknown>) => {
    lastSidebarProps = props;

    return (
      <div>
        <button type="button" onClick={() => void (props.onPrefetchProject as ((id: string) => void) | undefined)?.("project-2")}>
          Prefetch project
        </button>
        Sidebar
      </div>
    );
  },
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

vi.mock("@/components/quotes/ClientPartRequestEditor", () => ({
  ClientPartRequestEditor: ({ onSave }: { onSave: () => void }) => (
    <button type="button" onClick={onSave}>
      Save Request
    </button>
  ),
}));

function renderWithClient(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/parts/:jobId" element={<ClientPart />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("ClientPart", () => {
  beforeEach(() => {
    lastSidebarProps = null;
    vi.clearAllMocks();

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
    api.updateClientPartRequest.mockResolvedValue(undefined);
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
    expect(screen.queryByText("This part could not be loaded.")).not.toBeInTheDocument();
    expect(api.fetchPartDetail).toHaveBeenCalledTimes(1);
  });

  it("passes the collaboration gate through sidebar project prefetch", async () => {
    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(true);

    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByText("Sidebar")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Prefetch project" }));

    expect(prefetchProjectPage).toHaveBeenCalledWith(expect.anything(), "project-2", {
      enabled: false,
    });
  });

  it("invalidates shared and part-specific queries when saving request details", async () => {
    const { queryClient } = renderWithClient("/parts/job-1");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save Request" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Request" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalled();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["client-jobs"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["client-part-summaries"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["part-detail"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["part-detail", "job-1"] });
  });
});
