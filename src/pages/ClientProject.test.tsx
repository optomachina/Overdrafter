import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientPartRequirementView,
  ClientQuoteRequestStatus,
  QuoteRequestRecord,
  QuoteRunRecord,
} from "@/features/quotes/types";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import ClientProject from "./ClientProject";

const { api, mockUseAppSession, mockUseIsMobile, prefetchProjectPage, prefetchPartPage, toastMock } = vi.hoisted(() => ({
  api: {
    archiveJob: vi.fn(),
    archiveProject: vi.fn(),
    assignJobToProject: vi.fn(),
    createClientDraft: vi.fn(),
    createJobsFromUploadFiles: vi.fn(),
    createProject: vi.fn(),
    deleteArchivedJob: vi.fn(),
    deleteArchivedJobs: vi.fn(),
    dissolveProject: vi.fn(),
    fetchAccessibleJobs: vi.fn(),
    fetchAccessibleProjects: vi.fn(),
    fetchArchivedJobs: vi.fn(),
    fetchArchivedProjects: vi.fn(),
    fetchClientActivityEventsByJobIds: vi.fn(),
    fetchClientQuoteWorkspaceByJobIds: vi.fn(),
    fetchProjectAssigneeProfiles: vi.fn(),
    fetchJobPartSummariesByJobIds: vi.fn(),
    fetchJobsByProject: vi.fn(),
    fetchProject: vi.fn(),
    fetchProjectInvites: vi.fn(),
    fetchProjectJobMembershipsByJobIds: vi.fn(),
    fetchProjectMemberships: vi.fn(),
    fetchSidebarPins: vi.fn(),
    inviteProjectMember: vi.fn(),
    isArchivedDeleteCapabilityError: vi.fn(() => false),
    isProjectCollaborationSchemaUnavailable: vi.fn(),
    pinJob: vi.fn(),
    pinProject: vi.fn(),
    reconcileJobParts: vi.fn(),
    removeJobFromProject: vi.fn(),
    removeProjectMember: vi.fn(),
    cancelQuoteRequest: vi.fn(),
    requestExtraction: vi.fn(),
    requestQuotes: vi.fn(),
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
  mockUseIsMobile: vi.fn(() => false),
  prefetchProjectPage: vi.fn(),
  prefetchPartPage: vi.fn(),
  toastMock: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/features/quotes/api", () => api);
vi.mock("@/features/quotes/api/archive-api", () => ({
  archiveJob: api.archiveJob,
  deleteArchivedJobs: api.deleteArchivedJobs,
  isArchivedDeleteCapabilityError: api.isArchivedDeleteCapabilityError,
  unarchiveJob: api.unarchiveJob,
}));
vi.mock("@/features/quotes/api/extraction-api", () => ({
  reconcileJobParts: api.reconcileJobParts,
  requestExtraction: api.requestExtraction,
}));
vi.mock("@/features/quotes/api/jobs-api", () => ({
  createClientDraft: api.createClientDraft,
  updateClientPartRequest: api.updateClientPartRequest,
}));
vi.mock("@/features/quotes/api/projects-api", () => ({
  archiveProject: api.archiveProject,
  assignJobToProject: api.assignJobToProject,
  createProject: api.createProject,
  dissolveProject: api.dissolveProject,
  fetchProject: api.fetchProject,
  fetchProjectInvites: api.fetchProjectInvites,
  fetchProjectMemberships: api.fetchProjectMemberships,
  inviteProjectMember: api.inviteProjectMember,
  pinJob: api.pinJob,
  pinProject: api.pinProject,
  removeJobFromProject: api.removeJobFromProject,
  removeProjectMember: api.removeProjectMember,
  unarchiveProject: api.unarchiveProject,
  unpinJob: api.unpinJob,
  unpinProject: api.unpinProject,
  updateProject: api.updateProject,
}));
vi.mock("@/features/quotes/api/quote-requests-api", () => ({
  cancelQuoteRequest: api.cancelQuoteRequest,
  requestQuotes: api.requestQuotes,
  setJobSelectedVendorQuoteOffer: api.setJobSelectedVendorQuoteOffer,
}));
vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: api.isProjectCollaborationSchemaUnavailable,
}));
vi.mock("@/features/quotes/api/uploads-api", () => ({
  createJobsFromUploadFiles: api.createJobsFromUploadFiles,
  uploadFilesToJob: api.uploadFilesToJob,
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleJobs: api.fetchAccessibleJobs,
  fetchAccessibleProjects: api.fetchAccessibleProjects,
  fetchArchivedJobs: api.fetchArchivedJobs,
  fetchArchivedProjects: api.fetchArchivedProjects,
  fetchClientActivityEventsByJobIds: api.fetchClientActivityEventsByJobIds,
  fetchClientQuoteWorkspaceByJobIds: api.fetchClientQuoteWorkspaceByJobIds,
  fetchProjectAssigneeProfiles: api.fetchProjectAssigneeProfiles,
  fetchJobPartSummariesByJobIds: api.fetchJobPartSummariesByJobIds,
  fetchJobsByProject: api.fetchJobsByProject,
  fetchProjectJobMembershipsByJobIds: api.fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins: api.fetchSidebarPins,
}));

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

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

let lastAccountMenuProps: Record<string, unknown> | null = null;

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
    children,
    sidebarContent,
    sidebarFooter,
    headerContent,
    topRightContent,
  }: {
    children?: ReactNode;
    sidebarContent?: ReactNode;
    sidebarFooter?: ReactNode;
    headerContent?: ReactNode;
    topRightContent?: ReactNode;
  }) => (
    <div>
      <div data-testid="shell-header">{headerContent}</div>
      <div data-testid="shell-top-right">{topRightContent}</div>
      <div>{sidebarContent}</div>
      <div>{children}</div>
      <div>{sidebarFooter}</div>
    </div>
  ),
}));

vi.mock("@/components/chat/WorkspaceSidebar", () => ({
  WorkspaceSidebar: (props: Record<string, unknown>) => {
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
  WorkspaceAccountMenu: (props: Record<string, unknown>) => {
    lastAccountMenuProps = props;
    return <div>Account Menu</div>;
  },
}));

vi.mock("@/components/chat/ProjectMembersDialog", () => ({
  ProjectMembersDialog: () => null,
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/chat/PromptComposer", () => ({
  PromptComposer: () => <div>Composer</div>,
}));

vi.mock("@/components/quotes/ClientQuoteAssetPanels", () => ({
  ClientCadPreviewPanel: () => <div>CAD</div>,
  ClientDrawingPreviewPanel: () => <div>Drawing</div>,
}));

vi.mock("@/components/quotes/ClientQuoteDecisionPanel", () => ({
  ClientQuoteDecisionPanel: ({
    title,
    quoteDataStatus,
    quoteDataMessage,
    emptyState,
    options,
  }: {
    title?: string;
    quoteDataStatus?: string;
    quoteDataMessage?: string | null;
    emptyState?: string;
    options?: Array<{ vendorLabel?: string }>;
  }) => {
    const deadlinePrefix = "No quotes meet the due date.";
    const deadlineDetail =
      emptyState && emptyState.startsWith(deadlinePrefix)
        ? emptyState.slice(deadlinePrefix.length).trim()
        : null;

    return (
      <div data-testid="quote-decision-panel">
        {title ? <div>{title}</div> : null}
        {quoteDataStatus === "schema_unavailable" ? (
          <>
            <div>Quote comparison is unavailable</div>
            {quoteDataMessage ? <div>{quoteDataMessage}</div> : null}
          </>
        ) : quoteDataStatus === "invalid_for_plotting" ? (
          <>
            <div>Quote rows were loaded but could not be plotted</div>
            {quoteDataMessage ? <div>{quoteDataMessage}</div> : null}
          </>
        ) : options && options.length > 0 ? (
          options.map((option, index) => <div key={`${option.vendorLabel}-${index}`}>{option.vendorLabel}</div>)
        ) : deadlineDetail ? (
          <>
            <div>No quotes meet the due date</div>
            <div>{deadlineDetail}</div>
          </>
        ) : emptyState ? (
          <div>{emptyState}</div>
        ) : null}
      </div>
    );
  },
}));

function buildProjectTree(initialEntry: string, queryClient: QueryClient) {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-path">{location.pathname}</div>;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/projects/:projectId" element={<ClientProject />} />
          <Route path="/parts/:jobId" element={<div>Part Route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderWithClient(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const view = render(buildProjectTree(initialEntry, queryClient));

  return {
    ...view,
    rerenderProject: () => view.rerender(buildProjectTree(initialEntry, queryClient)),
  };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

type InspectorQuoteStatus = Extract<
  ClientQuoteRequestStatus,
  "queued" | "requesting" | "received" | "failed" | "canceled"
>;

type WorkspaceItemOverrides = {
  summary?: ReturnType<typeof createClientQuoteWorkspaceItemFixture>["summary"];
  approvedRequirement?: ReturnType<typeof createClientQuoteWorkspaceItemFixture>["part"]["approvedRequirement"];
  clientRequirement?: ClientPartRequirementView | null;
  latestQuoteRequest?: QuoteRequestRecord | null;
  latestQuoteRun?: QuoteRunRecord | null;
};

function createQuoteRequestFixture(overrides: Partial<QuoteRequestRecord> = {}): QuoteRequestRecord {
  return {
    id: "request-1",
    organization_id: "org-1",
    job_id: "job-1",
    requested_by: "user-1",
    requested_vendors: ["xometry"],
    service_request_line_item_id: null,
    status: "queued",
    failure_reason: null,
    received_at: null,
    failed_at: null,
    canceled_at: null,
    created_at: "2026-03-01T01:00:00Z",
    updated_at: "2026-03-01T01:00:00Z",
    ...overrides,
  };
}

function createQuoteRunFixture(overrides: Partial<QuoteRunRecord> = {}): QuoteRunRecord {
  return {
    id: "run-1",
    quote_request_id: null,
    job_id: "job-1",
    organization_id: "org-1",
    initiated_by: "user-1",
    status: "queued",
    requested_auto_publish: false,
    created_at: "2026-03-01T01:00:00Z",
    updated_at: "2026-03-01T01:00:00Z",
    ...overrides,
  };
}

function createWorkspaceItemFixture(overrides: WorkspaceItemOverrides = {}) {
  return createClientQuoteWorkspaceItemFixture(overrides);
}

function buildWorkspaceItemWithQuoteStatus(status: InspectorQuoteStatus) {
  const latestQuoteRequest = createQuoteRequestFixture({
    status,
    failure_reason:
      status === "failed"
        ? "Quote collection failed before a usable vendor response was received."
        : null,
    received_at: status === "received" ? "2026-03-01T02:00:00Z" : null,
    failed_at: status === "failed" ? "2026-03-01T02:00:00Z" : null,
    canceled_at: status === "canceled" ? "2026-03-01T02:00:00Z" : null,
  });
  const latestQuoteRunStatus =
    status === "received"
      ? "completed"
      : status === "requesting"
        ? "running"
        : status === "canceled"
          ? "failed"
          : status;

  return createWorkspaceItemFixture({
    latestQuoteRequest,
    latestQuoteRun: createQuoteRunFixture({
      quote_request_id: latestQuoteRequest.id,
      status: latestQuoteRunStatus,
    }),
  });
}

describe("ClientProject", () => {
  beforeEach(() => {
    lastAccountMenuProps = null;
    vi.clearAllMocks();
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      signOut: vi.fn(),
    });
    mockUseIsMobile.mockReturnValue(false);
    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(false);
    api.fetchClientActivityEventsByJobIds.mockResolvedValue([]);
    api.fetchAccessibleProjects.mockResolvedValue([
      {
        project: {
          id: "project-1",
          name: "Bracket Project",
          organization_id: "org-1",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchAccessibleJobs.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: "project-1",
        created_by: "user-1",
        title: "Bracket",
        description: null,
        status: "ready_to_quote",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [10],
        requested_by_date: "2026-04-15",
        archived_at: null,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
        selected_vendor_quote_offer_id: null,
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
        selectedSupplier: null,
        selectedPriceUsd: null,
        selectedLeadTimeBusinessDays: null,
      },
    ]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValue([
      { project_id: "project-1", job_id: "job-1", created_by: "user-1" },
    ]);
    api.fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    api.fetchArchivedProjects.mockResolvedValue([]);
    api.fetchArchivedJobs.mockResolvedValue([]);
    api.fetchProject.mockResolvedValue({ id: "project-1", name: "Bracket Project" });
    api.fetchJobsByProject.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: "project-1",
        created_by: "user-1",
        title: "Bracket",
        description: null,
        status: "ready_to_quote",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [10],
        requested_by_date: "2026-04-15",
        archived_at: null,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
        selected_vendor_quote_offer_id: null,
      },
    ]);
    api.fetchProjectAssigneeProfiles.mockResolvedValue([
      {
        userId: "user-1",
        email: "client@example.com",
        givenName: "Blaine",
        familyName: "Wilson",
        fullName: "Blaine Wilson",
      },
    ]);
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([createWorkspaceItemFixture()]);
    api.fetchProjectMemberships.mockResolvedValue([]);
    api.fetchProjectInvites.mockResolvedValue([]);
    api.requestQuotes.mockResolvedValue([
      {
        jobId: "job-1",
        accepted: true,
        created: true,
        deduplicated: false,
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        serviceRequestLineItemId: "line-item-1",
        status: "queued",
        reasonCode: null,
        reason: null,
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
    ]);
    api.cancelQuoteRequest.mockResolvedValue({
      jobId: "job-1",
      accepted: true,
      canceled: true,
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
      status: "canceled",
      reasonCode: "canceled",
      reason: "Quote request canceled.",
    });
  });

  it("renders the dense project ledger with semantic headers", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Bracket Project" })).toBeInTheDocument();
    });

    expect(screen.getByText("Review every part in this project from a single dense ledger view.")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Project inspector" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No part selected" })).toBeInTheDocument();
    expect(
      screen.getByText("Select a row in the ledger to inspect that part without leaving the project workspace."),
    ).toBeInTheDocument();
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Part Number" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "CAD" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "DWG" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Quote" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Creation Date" })).toBeInTheDocument();
    expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    expect(screen.getByText("Machined mounting bracket")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);
  });

  it("selects a row and updates the docked inspector without navigating away", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    const selectedRow = screen.getAllByText("BRKT-001")[0]?.closest("tr");
    expect(selectedRow).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByRole("heading", { name: "BRKT-001" })).toBeInTheDocument();
    expect(within(inspector).getAllByText("Machined mounting bracket").length).toBeGreaterThan(0);
    expect(within(inspector).getByText("Material")).toBeInTheDocument();
    expect(within(inspector).getByText("6061-T6")).toBeInTheDocument();
    expect(within(inspector).getByText("Finish")).toBeInTheDocument();
    expect(within(inspector).getByText("Black anodize")).toBeInTheDocument();
    expect(within(inspector).getByText("Threads")).toBeInTheDocument();
    expect(within(inspector).getByText("2x 1/4-20 UNC")).toBeInTheDocument();
    expect(within(inspector).getByText("Tightest tolerance")).toBeInTheDocument();
    expect(within(inspector).getByText("±0.0050 in")).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Open part workspace" })).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-1");
  });

  it("navigates to the part workspace from the inspector CTA", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));
    fireEvent.click(screen.getByRole("button", { name: "Open part workspace" }));

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/parts/job-1");
    });
  });

  it("double-clicks a row to navigate directly to the part route", async () => {
    renderWithClient("/projects/project-1");

    const partNumberCell = await screen.findByText("BRKT-001");
    fireEvent.doubleClick(partNumberCell);

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/parts/job-1");
    });
  });

  it("falls back to requirement metadata when the summary is missing", async () => {
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      createWorkspaceItemFixture({
        summary: null,
        clientRequirement: {
          partNumber: "BRKT-001",
          description: "Machined mounting bracket",
          revision: "A",
          material: "6061-T6",
          finish: "Black anodize",
          tightestToleranceInch: 0.005,
          process: null,
          notes: null,
          quantity: 10,
          quoteQuantities: [5, 25],
          requestedByDate: "2026-04-22",
        },
      }),
    ]);
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));
    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("5, 25")).toBeInTheDocument();
    expect(within(inspector).getByText("2026-04-22")).toBeInTheDocument();
  });

  it("hides the inspector without clearing selection and reopens it when a row is selected", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    const selectedRow = screen.getAllByText("BRKT-001")[0]?.closest("tr");
    expect(selectedRow).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));

    expect(screen.queryByRole("complementary", { name: "Project inspector" })).not.toBeInTheDocument();
    expect(selectedRow).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByText("BRKT-001"));

    const inspector = await screen.findByRole("complementary", { name: "Project inspector" });
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeInTheDocument();
    expect(within(inspector).getByRole("heading", { name: "BRKT-001" })).toBeInTheDocument();
  });

  it("renders numeric spec snapshot tolerances when normalized tolerance is absent", async () => {
    const baselineRequirement = createWorkspaceItemFixture().part.approvedRequirement;
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      createWorkspaceItemFixture({
        approvedRequirement: {
          ...baselineRequirement,
          tightest_tolerance_inch: null,
          spec_snapshot: {
            threads: "2x 1/4-20 UNC",
            tightest_tolerance: 0.0025,
          },
        },
      }),
    ]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("±0.0025 in")).toBeInTheDocument();
  });

  it("prefers the approved finish over stale spec snapshot finish data", async () => {
    const baselineRequirement = createWorkspaceItemFixture().part?.approvedRequirement;

    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      createWorkspaceItemFixture({
        approvedRequirement: baselineRequirement
          ? {
              ...baselineRequirement,
              finish: "Black anodize",
              spec_snapshot: {
                quoteFinish: "As machined",
              },
            }
          : null,
      }),
    ]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("Black anodize")).toBeInTheDocument();
    expect(within(inspector).queryByText("As machined")).not.toBeInTheDocument();
  });

  it.each([
    {
      status: "queued" as const,
      label: "Queued",
      classes: ["border-amber-400/20", "bg-amber-500/10", "text-amber-100"],
    },
    {
      status: "requesting" as const,
      label: "Requesting",
      classes: ["border-amber-400/20", "bg-amber-500/10", "text-amber-100"],
    },
    {
      status: "received" as const,
      label: "Quoted",
      classes: ["border-emerald-400/20", "bg-emerald-500/10", "text-emerald-100"],
    },
    {
      status: "failed" as const,
      label: "Failed",
      classes: ["border-rose-400/20", "bg-rose-500/10", "text-rose-100"],
    },
    {
      status: "canceled" as const,
      label: "Canceled",
      classes: ["border-rose-400/20", "bg-rose-500/10", "text-rose-100"],
    },
  ])("renders the inspector quote badge for %s status with the correct color treatment", async ({
    status,
    label,
    classes,
  }) => {
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([buildWorkspaceItemWithQuoteStatus(status)]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    const quoteBadge = within(inspector).getByText(label);
    expect(quoteBadge).toHaveClass(...classes);
  });

  it("opens the inspector in a sheet on mobile row selection", async () => {
    mockUseIsMobile.mockReturnValue(true);

    renderWithClient("/projects/project-1");

    const partNumberCell = await screen.findByText("BRKT-001");
    fireEvent.click(partNumberCell);

    const inspectorSheet = await screen.findByRole("dialog");
    expect(screen.queryByRole("complementary", { name: "Project inspector" })).not.toBeInTheDocument();
    expect(within(inspectorSheet).getByRole("heading", { name: "BRKT-001" })).toBeInTheDocument();
    expect(within(inspectorSheet).getAllByText("Machined mounting bracket").length).toBeGreaterThan(0);
    expect(within(inspectorSheet).getByText("Material")).toBeInTheDocument();
    expect(within(inspectorSheet).getByText("6061-T6")).toBeInTheDocument();
    expect(within(inspectorSheet).getByRole("button", { name: "Open part workspace" })).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-1");
  });

  it("clears the selected row on Escape and returns the inspector to the default state", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "No part selected" })).toBeInTheDocument();
    });

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    const selectedRow = screen.getAllByText("BRKT-001")[0]?.closest("tr");
    expect(selectedRow).toHaveAttribute("aria-selected", "false");
    expect(within(inspector).queryByRole("heading", { name: "BRKT-001" })).not.toBeInTheDocument();
    expect(within(inspector).getByText("Properties details appear here after you select a part.")).toBeInTheDocument();
  });

  it("reveals filter controls from the toolbar affordance and applies the local project filter", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Published" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    fireEvent.click(await screen.findByRole("button", { name: "Published" }));

    await waitFor(() => {
      expect(screen.getByText("No parts match the current project filter.")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Filter: Published" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All parts" }));

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });
  });

  it("passes collaboration-disabled project prefetch through to the sidebar callback", async () => {
    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(true);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("Sidebar")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Prefetch project" }));

    expect(prefetchProjectPage).toHaveBeenCalledWith(expect.anything(), "project-2", {
      enabled: false,
    });
  });

  it("requests quotes for ready project parts", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request 1 quote/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /request 1 quote/i }));

    await waitFor(() => {
      expect(api.requestQuotes).toHaveBeenCalledWith(["job-1"], false);
    });
  });

  it("shows a mixed-result success toast when some project quote requests are blocked by the cost ceiling", async () => {
    api.requestQuotes.mockResolvedValue([
      {
        jobId: "job-1",
        accepted: true,
        created: true,
        deduplicated: false,
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        serviceRequestLineItemId: "line-item-1",
        status: "queued",
        reasonCode: null,
        reason: null,
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
      {
        jobId: "job-2",
        accepted: false,
        created: false,
        deduplicated: false,
        quoteRequestId: null,
        quoteRunId: null,
        serviceRequestLineItemId: null,
        status: "not_requested",
        reasonCode: "org_cost_ceiling_reached",
        reason: "Quote requests are temporarily paused for this workspace while current vendor quote requests are still in flight.",
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
    ]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request 1 quote/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /request 1 quote/i }));

    await waitFor(() => {
      expect(api.requestQuotes).toHaveBeenCalledWith(["job-1"], false);
      expect(toastMock.success).toHaveBeenCalledWith("Queued 1 quote request and skipped 1 part.");
    });
  });

  it("blocks duplicate project row quote requests while the batch request is pending", async () => {
    const deferred = createDeferredPromise<
      Array<{
        jobId: string;
        accepted: boolean;
        created: boolean;
        deduplicated: boolean;
        quoteRequestId: string | null;
        quoteRunId: string | null;
        serviceRequestLineItemId: string | null;
        status: string;
        reasonCode: string | null;
        reason: string | null;
        requestedVendors: string[];
      }>
    >();
    void deferred.promise.catch(() => undefined);
    api.requestQuotes.mockReturnValue(deferred.promise);

    renderWithClient("/projects/project-1");

    const headerButton = await screen.findByRole("button", { name: /request 1 quote/i });

    expect(headerButton).toBeEnabled();

    fireEvent.click(headerButton);
    fireEvent.click(headerButton);

    await waitFor(() => {
      expect(api.requestQuotes).toHaveBeenCalledTimes(1);
    });

    expect(api.requestQuotes).toHaveBeenCalledWith(["job-1"], false);

    await waitFor(() => {
      expect(headerButton).toBeDisabled();
    });

    deferred.reject(new Error("Request failed"));

    await waitFor(() => {
      expect(headerButton).toBeEnabled();
    });
  });

  it("renders an explicit unassigned state when no assignee profile resolves for a row", async () => {
    api.fetchProjectAssigneeProfiles.mockResolvedValue([]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders real assignee initials for project rows", async () => {
    renderWithClient("/projects/project-1");

    expect(await screen.findByLabelText("Blaine Wilson assignee")).toBeInTheDocument();
    expect(screen.getByText("BW")).toBeInTheDocument();
  });

  it("renders empty assignee cells while assignee lookups are pending", async () => {
    const assigneeProfiles = createDeferredPromise<
      Array<{
        userId: string;
        email: string;
        givenName: string;
        familyName: string;
        fullName: string;
      }>
    >();
    api.fetchProjectAssigneeProfiles.mockReturnValue(assigneeProfiles.promise);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    expect(screen.queryByText("BW")).not.toBeInTheDocument();

    assigneeProfiles.resolve([
      {
        userId: "user-1",
        email: "client@example.com",
        givenName: "Blaine",
        familyName: "Wilson",
        fullName: "Blaine Wilson",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByLabelText("Blaine Wilson assignee")).toBeInTheDocument();
    });
  });

  it("renders empty assignee cells when assignee lookup fails", async () => {
    api.fetchProjectAssigneeProfiles.mockRejectedValue(new Error("lookup failed"));

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("BW")).not.toBeInTheDocument();
  });

  it("renders the inline search in the shell header and removes the old body search", async () => {
    renderWithClient("/projects/project-1");

    expect(await screen.findByTestId("shell-top-right")).toBeInTheDocument();
    expect(screen.getByLabelText("/ Search")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search project parts" })).not.toBeInTheDocument();
  });

  it("filters autosuggest results across projects and parts and navigates on selection", async () => {
    api.fetchAccessibleProjects.mockResolvedValue([
      {
        project: {
          id: "project-1",
          name: "Bracket Project",
          organization_id: "org-1",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
      {
        project: {
          id: "project-2",
          name: "Valve Project",
          organization_id: "org-1",
          created_at: "2026-03-03T00:00:00Z",
          updated_at: "2026-03-04T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchAccessibleJobs.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: "project-1",
        created_by: "user-1",
        title: "Bracket",
        description: null,
        status: "ready_to_quote",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [10],
        requested_by_date: "2026-04-15",
        archived_at: null,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
        selected_vendor_quote_offer_id: null,
      },
      {
        id: "job-2",
        organization_id: "org-1",
        project_id: "project-2",
        created_by: "user-1",
        title: "Valve Housing",
        description: "Machined housing",
        status: "ready_to_quote",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: ["housing"],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [5],
        requested_by_date: "2026-04-15",
        archived_at: null,
        created_at: "2026-03-02T00:00:00Z",
        updated_at: "2026-03-02T00:00:00Z",
        selected_vendor_quote_offer_id: null,
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
        requestedServiceKinds: ["manufacturing_quote"],
        primaryServiceKind: "manufacturing_quote",
        serviceNotes: null,
        requestedQuoteQuantities: [10],
        requestedByDate: "2026-04-15",
        selectedSupplier: null,
        selectedPriceUsd: null,
        selectedLeadTimeBusinessDays: null,
      },
      {
        jobId: "job-2",
        partNumber: "VALV-001",
        revision: "B",
        description: "Valve Housing",
        quantity: 5,
        importedBatch: null,
        requestedServiceKinds: ["manufacturing_quote"],
        primaryServiceKind: "manufacturing_quote",
        serviceNotes: null,
        requestedQuoteQuantities: [5],
        requestedByDate: "2026-04-15",
        selectedSupplier: null,
        selectedPriceUsd: null,
        selectedLeadTimeBusinessDays: null,
      },
    ]);

    renderWithClient("/projects/project-1");

    const searchInput = (await screen.findByLabelText("/ Search")) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "valve" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear Bracket Project search scope" }));

    expect(await screen.findByText("Valve Project")).toBeInTheDocument();
    expect(screen.getByText("VALV-001 rev B")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Valve Project"));
    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-2");
    });

    fireEvent.change(screen.getByLabelText("/ Search"), {
      target: { value: "housing" },
    });
    fireEvent.click(screen.getByText("VALV-001 rev B"));

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/parts/job-2");
    });
  });

  it("logs structured archived delete failures through the account menu callback", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    api.deleteArchivedJobs.mockRejectedValueOnce({
      message:
        "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
      reporting: {
        operation: "archived_delete",
        fallbackPath: "job-archive-fallback",
        failureCategory: "edge_unreachable",
        failureSummary:
          "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
        likelyCause: "The app could not reach the job-archive-fallback Edge Function endpoint.",
        recommendedChecks: [
          "Verify Edge Function deployment status for job-archive-fallback.",
          "Verify the Supabase function endpoint is reachable from the current environment.",
        ],
        functionName: "job-archive-fallback",
        httpStatus: null,
        hasResponseBody: false,
      },
    });

    try {
      renderWithClient("/projects/project-1");

      await waitFor(() => {
        expect(lastAccountMenuProps).not.toBeNull();
      });

      await expect(
        (lastAccountMenuProps!.onDeleteArchivedParts as (jobIds: string[]) => Promise<void>)(["job-1"]),
      ).rejects.toThrow(
        "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
      );

      expect(toastMock.error).toHaveBeenCalledWith(
        "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Archived part delete failed",
        expect.objectContaining({
          jobIds: ["job-1"],
          organizationId: "org-1",
          userId: "user-1",
          message:
            "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
          error: expect.objectContaining({
            message:
              "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
          }),
          reporting: expect.objectContaining({
            operation: "archived_delete",
            failureCategory: "edge_unreachable",
            fallbackPath: "job-archive-fallback",
            partIds: ["job-1"],
            organizationId: "org-1",
            userId: "user-1",
          }),
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

});
