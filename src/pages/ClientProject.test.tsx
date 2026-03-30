import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientProject from "./ClientProject";

const { api, mockUseAppSession, prefetchProjectPage, prefetchPartPage, toastMock } = vi.hoisted(() => ({
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
  useIsMobile: () => false,
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
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([
      {
        job: {
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
          requested_by_date: "2026-04-15",
          requested_quote_quantities: [10],
          archived_at: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
          selected_vendor_quote_offer_id: null,
        },
        part: {
          id: "part-1",
          job_id: "job-1",
          organization_id: "org-1",
          name: "Bracket",
          normalized_key: "bracket",
          cad_file_id: "cad-1",
          drawing_file_id: null,
          quantity: 10,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
          cadFile: {
            id: "cad-1",
            job_id: "job-1",
            organization_id: "org-1",
            file_kind: "cad",
            blob_id: "blob-1",
            storage_bucket: "job-files",
            storage_path: "cad.step",
            normalized_name: "cad.step",
            original_name: "cad.step",
            size_bytes: 123,
            mime_type: "application/step",
            content_sha256: "hash",
            matched_part_key: null,
            uploaded_by: "user-1",
            created_at: "2026-03-01T00:00:00Z",
          },
          drawingFile: null,
          extraction: null,
          approvedRequirement: {
            id: "requirement-1",
            part_id: "part-1",
            organization_id: "org-1",
            approved_by: "user-1",
            description: "Bracket",
            part_number: "BRKT-001",
            revision: "A",
            material: "6061-T6",
            finish: null,
            tightest_tolerance_inch: null,
            quantity: 10,
            quote_quantities: [10],
            requested_by_date: "2026-04-15",
            applicable_vendors: ["xometry"],
            spec_snapshot: {},
            approved_at: "2026-03-01T00:00:00Z",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
          vendorQuotes: [],
        },
        summary: {
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
        files: [],
        projectIds: ["project-1"],
        drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
        latestQuoteRequest: null,
        latestQuoteRun: null,
      },
    ]);
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
    expect(screen.queryByText("Project inspector")).not.toBeInTheDocument();
    expect(screen.queryByText("Line item detail")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Part Number" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "CAD" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "DWG" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Quote" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Creation Date" })).toBeInTheDocument();
    expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    expect(screen.getByText("Bracket")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);
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

  it("renders the placeholder assignee when no assignee profile resolves for a row", async () => {
    api.fetchProjectAssigneeProfiles.mockResolvedValue([]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);
  });

  it("keeps the placeholder assignee while assignee lookups are pending", async () => {
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
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);

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
      expect(screen.getByRole("table")).toBeInTheDocument();
    });
  });

  it("keeps the placeholder assignee when assignee lookup fails", async () => {
    api.fetchProjectAssigneeProfiles.mockRejectedValue(new Error("lookup failed"));

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("table")).toBeInTheDocument();
    });

    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);
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
