import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientPartRequirementView,
  ClientQuoteWorkspaceItem,
  ClientQuoteRequestStatus,
  QuoteRequestRecord,
  QuoteRunRecord,
  VendorCapabilityProfileRecord,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import { createWorkspaceAccessScope } from "@/features/quotes/workspace-navigation";
import ClientProject from "./ClientProject";

const {
  api,
  mockQuoteCollectionMode,
  mockUseAppSession,
  mockUseIsMobile,
  prefetchProjectPage,
  prefetchPartPage,
  toastMock,
} = vi.hoisted(() => ({
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
    fetchVendorCapabilityProfiles: vi.fn(),
    fetchJobVendorPreferenceContext: vi.fn(),
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
    setJobVendorPreferences: vi.fn(),
    setJobSelectedVendorQuoteOffer: vi.fn(),
    setProjectVendorPreferences: vi.fn(),
    unarchiveJob: vi.fn(),
    unarchiveProject: vi.fn(),
    unpinJob: vi.fn(),
    unpinProject: vi.fn(),
    updateClientPartRequest: vi.fn(),
    updateProject: vi.fn(),
    uploadFilesToJob: vi.fn(),
  },
  mockQuoteCollectionMode: vi.fn(() => ({
    automaticEnabled: true,
    hasAutomaticEntitlement: true,
    isLoading: false,
    plan: "pro" as "free" | "pro" | null,
    setAutomaticEnabled: vi.fn(),
  })),
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
  requestManualQuotes: api.requestQuotes,
  requestQuotes: api.requestQuotes,
  setJobSelectedVendorQuoteOffer: api.setJobSelectedVendorQuoteOffer,
}));
vi.mock("@/features/quotes/organization-entitlements", () => ({
  useOrganizationQuoteCollectionMode: () => mockQuoteCollectionMode(),
}));
vi.mock("@/features/quotes/api/vendor-preferences-api", () => ({
  fetchJobVendorPreferenceContext: api.fetchJobVendorPreferenceContext,
  setJobVendorPreferences: api.setJobVendorPreferences,
  setProjectVendorPreferences: api.setProjectVendorPreferences,
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
  fetchVendorCapabilityProfiles: api.fetchVendorCapabilityProfiles,
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
    return (
      <>
        <div data-testid="location-path">{location.pathname}</div>
        <div data-testid="location-search">{location.search}</div>
      </>
    );
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
    request_mode: "automatic",
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
  const workspaceItem = createClientQuoteWorkspaceItemFixture(overrides);

  if (
    overrides.approvedRequirement === undefined &&
    workspaceItem.part?.approvedRequirement
  ) {
    workspaceItem.part.approvedRequirement = {
      ...workspaceItem.part.approvedRequirement,
      spec_snapshot: {
        ...((workspaceItem.part.approvedRequirement.spec_snapshot as Record<string, unknown> | null) ?? {}),
        process: "CNC milling",
      },
    };
  }

  return workspaceItem;
}

function createVendorCapabilityProfile(
  overrides: Partial<VendorCapabilityProfileRecord> = {},
): VendorCapabilityProfileRecord {
  return {
    vendor_name: "xometry",
    process_types: ["cnc_milling"],
    materials: ["aluminum"],
    tolerance_min_mm: 0.01,
    tolerance_max_mm: 1,
    max_part_size_mm: 1000,
    min_quantity: 1,
    max_quantity: 1000,
    geographic_region: "United States",
    certifications: ["ISO 9001"],
    quality_score: 90,
    lead_time_reliability: 88,
    cost_competitiveness: 85,
    domestic_us: true,
    updated_at: "2026-07-31T00:00:00Z",
    ...overrides,
  };
}

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

function createProjectSummaryWorkspaceItem(input: {
  jobId: string;
  partId: string;
  partNumber: string;
  description: string;
  totalPriceUsd?: number | null;
  leadTimeBusinessDays?: number | null;
  quoteStatus?: ClientQuoteRequestStatus;
}): ClientQuoteWorkspaceItem {
  const base = createWorkspaceItemFixture();
  const offerId = `${input.jobId}-offer-1`;
  const selectedPriceUsd = input.totalPriceUsd ?? null;
  const selectedLeadTimeBusinessDays = input.leadTimeBusinessDays ?? null;
  const hasSelection = selectedPriceUsd !== null && selectedLeadTimeBusinessDays !== null;
  const vendorQuotes = hasSelection
    ? [
        markQuoteAsTrustedLive(createVendorQuoteFixture({
          resultId: `${input.jobId}-result-1`,
          offerId,
          supplier: `${input.partNumber} Supplier`,
          totalPriceUsd: selectedPriceUsd,
          leadTimeBusinessDays: selectedLeadTimeBusinessDays,
        })),
      ]
    : [];

  return {
    ...base,
    job: {
      ...base.job,
      id: input.jobId,
      title: input.partNumber,
      selected_vendor_quote_offer_id: hasSelection ? offerId : null,
    },
    summary: {
      ...base.summary,
      jobId: input.jobId,
      partNumber: input.partNumber,
      description: input.description,
      selectedSupplier: hasSelection ? `${input.partNumber} Supplier` : null,
      selectedPriceUsd,
      selectedLeadTimeBusinessDays,
    },
    part: base.part
      ? {
          ...base.part,
          id: input.partId,
          job_id: input.jobId,
          name: input.partNumber,
          approvedRequirement: base.part.approvedRequirement
            ? {
                ...base.part.approvedRequirement,
                part_id: input.partId,
                part_number: input.partNumber,
                description: input.description,
              }
            : null,
          vendorQuotes,
        }
      : null,
    latestQuoteRequest:
      input.quoteStatus && input.quoteStatus !== "not_requested"
        ? createQuoteRequestFixture({
            id: `${input.jobId}-request`,
            job_id: input.jobId,
            status: input.quoteStatus,
            received_at: input.quoteStatus === "received" ? "2026-03-01T02:00:00Z" : null,
          })
        : null,
  };
}

function createProjectJobFixture(input: {
  jobId: string;
  title: string;
  selectedVendorQuoteOfferId?: string | null;
}) {
  return {
    id: input.jobId,
    organization_id: "org-1",
    project_id: "project-1",
    created_by: "user-1",
    title: input.title,
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
    selected_vendor_quote_offer_id: input.selectedVendorQuoteOfferId ?? null,
  };
}

function createProjectMembershipFixture(jobId: string) {
  return { project_id: "project-1", job_id: jobId, created_by: "user-1" };
}

function createSelectedSummaryFixture(input: {
  jobId: string;
  partNumber: string;
  description: string;
  selectedPriceUsd?: number | null;
  selectedLeadTimeBusinessDays?: number | null;
}) {
  return {
    jobId: input.jobId,
    partNumber: input.partNumber,
    revision: "A",
    description: input.description,
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    quantity: 10,
    requestedQuoteQuantities: [10],
    requestedByDate: "2026-04-15",
    importedBatch: null,
    selectedSupplier: input.selectedPriceUsd === null || input.selectedPriceUsd === undefined ? null : `${input.partNumber} Supplier`,
    selectedPriceUsd: input.selectedPriceUsd ?? null,
    selectedLeadTimeBusinessDays: input.selectedLeadTimeBusinessDays ?? null,
  };
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
    mockQuoteCollectionMode.mockReturnValue({
      automaticEnabled: true,
      hasAutomaticEntitlement: true,
      isLoading: false,
      plan: "pro",
      setAutomaticEnabled: vi.fn(),
    });
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
    api.fetchVendorCapabilityProfiles.mockResolvedValue([
      createVendorCapabilityProfile(),
    ]);
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
    api.fetchJobVendorPreferenceContext.mockResolvedValue({
      jobId: "job-1",
      projectId: "project-1",
      organizationId: "org-1",
      availableVendors: ["xometry", "fictiv", "protolabs"],
      projectVendorPreferences: {
        includedVendors: [],
        excludedVendors: [],
        updatedAt: null,
      },
      jobVendorPreferences: {
        includedVendors: [],
        excludedVendors: [],
        updatedAt: null,
      },
    });
    api.setProjectVendorPreferences.mockResolvedValue({
      includedVendors: ["xometry"],
      excludedVendors: [],
      updatedAt: "2026-04-08T19:00:00Z",
    });
    api.setJobVendorPreferences.mockResolvedValue({
      includedVendors: ["xometry"],
      excludedVendors: [],
      updatedAt: "2026-04-08T19:00:00Z",
    });
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
    expect(screen.queryByText("Provider recommendations available")).not.toBeInTheDocument();
    expect(screen.queryByText("Action needed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Reviewing sourcing options/i)).not.toBeInTheDocument();
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
    expect(screen.getByRole("columnheader", { name: "Sourcing" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Assignee" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Creation Date" })).toBeInTheDocument();
    expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    expect(screen.getByText("Machined mounting bracket")).toBeInTheDocument();
    expect(screen.getByText("1 provider")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getAllByText("BW").length).toBeGreaterThan(0);
  });

  it("uses the accessible project summary for the project part count when the detailed project query is empty", async () => {
    api.fetchAccessibleProjects.mockResolvedValueOnce([
      {
        project: {
          id: "project-1",
          name: "Bracket Project",
          organization_id: "org-1",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
        partCount: 2,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchJobsByProject.mockResolvedValueOnce([]);

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Bracket Project" })).toBeInTheDocument();
    });

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(screen.getByText("Parts: 2")).toBeInTheDocument();
    expect(inspector).toBeInTheDocument();
  });

  it("renders a project summary with spend, critical path, coverage, and spend distribution", async () => {
    const projectJobs = [
      createProjectJobFixture({
        jobId: "job-1",
        title: "BRKT-001",
        selectedVendorQuoteOfferId: "job-1-offer-1",
      }),
      createProjectJobFixture({
        jobId: "job-2",
        title: "BRKT-002",
        selectedVendorQuoteOfferId: "job-2-offer-1",
      }),
      createProjectJobFixture({
        jobId: "job-3",
        title: "BRKT-003",
      }),
    ];

    api.fetchAccessibleProjects.mockResolvedValueOnce([
      {
        project: {
          id: "project-1",
          name: "Bracket Project",
          organization_id: "org-1",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
        partCount: 3,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchAccessibleJobs.mockResolvedValueOnce(projectJobs);
    api.fetchJobPartSummariesByJobIds.mockResolvedValueOnce([
      createSelectedSummaryFixture({
        jobId: "job-1",
        partNumber: "BRKT-001",
        description: "Primary bracket",
        selectedPriceUsd: 1200,
        selectedLeadTimeBusinessDays: 14,
      }),
      createSelectedSummaryFixture({
        jobId: "job-2",
        partNumber: "BRKT-002",
        description: "Support arm",
        selectedPriceUsd: 800,
        selectedLeadTimeBusinessDays: 22,
      }),
      createSelectedSummaryFixture({
        jobId: "job-3",
        partNumber: "BRKT-003",
        description: "Cover plate",
      }),
    ]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValueOnce([
      createProjectMembershipFixture("job-1"),
      createProjectMembershipFixture("job-2"),
      createProjectMembershipFixture("job-3"),
    ]);
    api.fetchJobsByProject.mockResolvedValueOnce(projectJobs);
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      createProjectSummaryWorkspaceItem({
        jobId: "job-1",
        partId: "part-1",
        partNumber: "BRKT-001",
        description: "Primary bracket",
        totalPriceUsd: 1200,
        leadTimeBusinessDays: 14,
        quoteStatus: "received",
      }),
      createProjectSummaryWorkspaceItem({
        jobId: "job-2",
        partId: "part-2",
        partNumber: "BRKT-002",
        description: "Support arm",
        totalPriceUsd: 800,
        leadTimeBusinessDays: 22,
        quoteStatus: "received",
      }),
      createProjectSummaryWorkspaceItem({
        jobId: "job-3",
        partId: "part-3",
        partNumber: "BRKT-003",
        description: "Cover plate",
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteStatus: "not_requested",
      }),
    ]);

    renderWithClient("/projects/project-1");

    expect(await screen.findByRole("region", { name: "Project summary" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Budget, coverage, and schedule at a glance")).toBeInTheDocument();
      expect(screen.getByText("$2,000")).toBeInTheDocument();
      expect(screen.getByText("22 bd")).toBeInTheDocument();
      expect(screen.getAllByText("67%")).toHaveLength(2);
      expect(screen.getByText("1 part unquoted")).toBeInTheDocument();
      expect(screen.getByText("BRKT-001 is 60% of spend")).toBeInTheDocument();
      expect(screen.getByText("BRKT-002 sets the schedule at 22 business days.")).toBeInTheDocument();
      expect(screen.getByText("1 part has not been quoted yet.")).toBeInTheDocument();
    });
  });

  it.each(["simulated", "stale"] as const)(
    "excludes %s stored prices from project totals and coverage",
    async (untrustedReason) => {
    const projectJob = createProjectJobFixture({
      jobId: "job-1",
      title: "BRKT-001",
      selectedVendorQuoteOfferId: "job-1-offer-1",
    });
    const workspaceItem = createProjectSummaryWorkspaceItem({
      jobId: "job-1",
      partId: "part-1",
      partNumber: "BRKT-001",
      description: "Primary bracket",
      totalPriceUsd: 1200,
      leadTimeBusinessDays: 14,
      quoteStatus: "received",
    });

    api.fetchAccessibleJobs.mockResolvedValueOnce([projectJob]);
    api.fetchJobsByProject.mockResolvedValueOnce([projectJob]);
    api.fetchJobPartSummariesByJobIds.mockResolvedValueOnce([
      createSelectedSummaryFixture({
        jobId: "job-1",
        partNumber: "BRKT-001",
        description: "Primary bracket",
        selectedPriceUsd: 1200,
        selectedLeadTimeBusinessDays: 14,
      }),
    ]);
    const staleTimestamp = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      {
        ...workspaceItem,
        part: workspaceItem.part
          ? {
              ...workspaceItem.part,
              vendorQuotes: workspaceItem.part.vendorQuotes.map((quote) => {
                if (untrustedReason === "simulated") {
                  return {
                    ...quote,
                    raw_payload: { mode: "simulate" },
                  };
                }

                return {
                  ...quote,
                  raw_payload: {
                    automationVersion: "xometry-worker-v1",
                    detectedFlow: "quote_ready",
                    requirementCapturedAt: staleTimestamp,
                  },
                  created_at: staleTimestamp,
                  updated_at: staleTimestamp,
                  offers: quote.offers.map((offer) => ({
                    ...offer,
                    quote_date: staleTimestamp.slice(0, 10),
                    created_at: staleTimestamp,
                    updated_at: staleTimestamp,
                  })),
                };
              }),
            }
          : null,
      },
    ]);

    renderWithClient("/projects/project-1");

    const summary = await screen.findByRole("region", { name: "Project summary" });
    await waitFor(() => {
      expect(within(summary).getByText("$0")).toBeInTheDocument();
      expect(within(summary).getByText("No selections yet")).toBeInTheDocument();
      expect(within(summary).getByText("1 part unquoted")).toBeInTheDocument();
      expect(within(summary).queryByText("$1,200")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("1 provider")).toBeInTheDocument();

    fireEvent.click(screen.getByText("BRKT-001"));
    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("Provider recommendations available")).toBeInTheDocument();
    expect(within(inspector).queryByText("Live offers available")).not.toBeInTheDocument();
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
    expect(within(inspector).getByText("±0.005 in")).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Full workspace" })).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-1");
  });

  it("shows reviewed provider guidance for a Free project part", async () => {
    mockQuoteCollectionMode.mockReturnValue({
      automaticEnabled: false,
      hasAutomaticEntitlement: false,
      isLoading: false,
      plan: "free",
      setAutomaticEnabled: vi.fn(),
    });

    renderWithClient("/projects/project-1");

    const partNumber = await screen.findByText("BRKT-001");
    expect(screen.getByText("1 provider")).toBeInTheDocument();
    fireEvent.click(partNumber);

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("Provider recommendations available")).toBeInTheDocument();
    expect(within(inspector).queryByText(/potential providers ranked/i)).not.toBeInTheDocument();
    const officialRfqLink = within(inspector).getByRole("link", { name: /open official rfq/i });
    expect(officialRfqLink).toHaveAttribute(
      "href",
      "https://www.xometry.com/quoting/home/",
    );
    expect(officialRfqLink.closest("article")?.parentElement).not.toHaveClass("lg:grid-cols-3");
  });

  it("shows an explicit reviewing state while provider capabilities load", async () => {
    const capabilityProfiles = createDeferredPromise<VendorCapabilityProfileRecord[]>();
    api.fetchVendorCapabilityProfiles.mockReturnValueOnce(capabilityProfiles.promise);

    renderWithClient("/projects/project-1");

    expect(await screen.findByText("Reviewing")).toBeInTheDocument();
    fireEvent.click(screen.getByText("BRKT-001"));
    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText(/Reviewing sourcing options/i)).toBeInTheDocument();

    await act(async () => {
      capabilityProfiles.resolve([createVendorCapabilityProfile()]);
      await capabilityProfiles.promise;
    });

    expect(await screen.findByText("1 provider")).toBeInTheDocument();
    expect(within(inspector).getByText("Provider recommendations available")).toBeInTheDocument();
  });

  it("shows an explicit action when provider capability data fails", async () => {
    api.fetchVendorCapabilityProfiles.mockRejectedValueOnce(new Error("capability lookup failed"));

    renderWithClient("/projects/project-1");

    expect((await screen.findAllByText("Action needed")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("BRKT-001"));
    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(
      within(inspector).getByRole("heading", { name: "Provider guidance is temporarily unavailable" }),
    ).toBeInTheDocument();
  });

  it("distinguishes a current trusted Pro offer from provider recommendations", async () => {
    const workspaceItem = createWorkspaceItemFixture();
    const liveTimestamp = new Date().toISOString();
    const liveQuote = createVendorQuoteFixture({
      resultId: "live-result-1",
      offerId: "live-offer-1",
      supplier: "Xometry",
      totalPriceUsd: 100,
      leadTimeBusinessDays: 7,
    });
    liveQuote.raw_payload = {
      automationVersion: "xometry-worker-2026-08",
      requirementCapturedAt: liveTimestamp,
    };
    liveQuote.created_at = liveTimestamp;
    liveQuote.updated_at = liveTimestamp;
    liveQuote.offers = liveQuote.offers.map((offer) => ({
      ...offer,
      quote_date: liveTimestamp.slice(0, 10),
      created_at: liveTimestamp,
      updated_at: liveTimestamp,
    }));
    if (!workspaceItem.part) {
      throw new Error("Expected a part fixture.");
    }
    workspaceItem.part.vendorQuotes = [liveQuote];
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([workspaceItem]);

    renderWithClient("/projects/project-1");

    const partNumber = await screen.findByText("BRKT-001");
    expect(await screen.findByText("1 live")).toBeInTheDocument();
    fireEvent.click(partNumber);

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(within(inspector).getByText("Live offers available")).toBeInTheDocument();
    expect(within(inspector).getByRole("heading", { name: /1 live offer/i })).toBeInTheDocument();
  });

  it("shows an explicit unsupported-package result in the project ledger and inspector", async () => {
    const baseRequirement = createWorkspaceItemFixture().part?.approvedRequirement;
    if (!baseRequirement) {
      throw new Error("Expected an approved requirement fixture.");
    }
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
      createWorkspaceItemFixture({
        approvedRequirement: {
          ...baseRequirement,
          material: "17-4 PH stainless steel",
          spec_snapshot: {
            ...((baseRequirement.spec_snapshot as Record<string, unknown> | null) ?? {}),
            process: "CNC milling",
          },
        },
      }),
    ]);

    renderWithClient("/projects/project-1");

    const partNumber = await screen.findByText("BRKT-001");
    expect((await screen.findAllByText("Action needed")).length).toBeGreaterThan(0);
    fireEvent.click(partNumber);

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    expect(
      within(inspector).getByRole("heading", { name: "This material is outside the launch scope" }),
    ).toBeInTheDocument();
    expect(within(inspector).getByText(/currently supports machined aluminum parts/i)).toBeInTheDocument();
  });

  it.each(["queued", "failed"] as const)(
    "degrades a Pro %s request to reviewed provider guidance",
    async (status) => {
      api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValueOnce([
        buildWorkspaceItemWithQuoteStatus(status),
      ]);

      renderWithClient("/projects/project-1");

      const partNumber = await screen.findByText("BRKT-001");
      expect(await screen.findByText("1 provider")).toBeInTheDocument();
      fireEvent.click(partNumber);

      const inspector = screen.getByRole("complementary", { name: "Project inspector" });
      expect(within(inspector).getByText("Provider recommendations available")).toBeInTheDocument();
      expect(
        within(inspector).getByRole("heading", { name: "Qualified next steps, available now" }),
      ).toBeInTheDocument();
      expect(within(inspector).queryByText(/automatic collection has not produced/i)).not.toBeInTheDocument();
    },
  );

  it("lets users pin or exclude vendors at project and part scopes from the inspector", async () => {
    api.fetchJobVendorPreferenceContext.mockResolvedValueOnce({
      jobId: "job-1",
      projectId: "project-1",
      organizationId: "org-1",
      availableVendors: ["xometry", "fictiv"],
      projectVendorPreferences: {
        includedVendors: [],
        excludedVendors: [],
        updatedAt: null,
      },
      jobVendorPreferences: {
        includedVendors: [],
        excludedVendors: [],
        updatedAt: null,
      },
    });

    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project Xometry pin" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Project Xometry pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Part Fictiv exclude" }));

    await waitFor(() => {
      expect(api.setProjectVendorPreferences).toHaveBeenCalledWith({
        projectId: "project-1",
        includedVendors: ["xometry"],
        excludedVendors: [],
      });
      expect(api.setJobVendorPreferences).toHaveBeenCalledWith({
        jobId: "job-1",
        includedVendors: [],
        excludedVendors: ["fictiv"],
      });
    });
  });

  it("navigates to the part workspace from the inspector CTA", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByText("BRKT-001")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("BRKT-001"));
    fireEvent.click(screen.getByRole("button", { name: "Full workspace" }));

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

  it("hydrates the quick preview from the project route query param", async () => {
    renderWithClient("/projects/project-1?part=job-1");

    await waitFor(() => {
      expect(screen.getAllByText("BRKT-001").length).toBeGreaterThan(0);
    });

    const inspector = screen.getByRole("complementary", { name: "Project inspector" });
    const selectedRow = screen.getAllByText("BRKT-001")[0]?.closest("tr");
    expect(selectedRow).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByRole("heading", { name: "BRKT-001" })).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-1");
    expect(screen.getByTestId("location-search")).toHaveTextContent("?part=job-1");
  });

  it("preserves iOS app mode after account sign-out completes", async () => {
    renderWithClient("/projects/project-1?app=ios");

    await screen.findByText("Account Menu");
    expect(lastAccountMenuProps?.onSignedOut).toEqual(expect.any(Function));

    act(() => {
      (lastAccountMenuProps?.onSignedOut as () => void)();
    });

    expect(screen.getByTestId("location-path")).toHaveTextContent("/");
    expect(screen.getByTestId("location-search")).toHaveTextContent("?app=ios");
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
    expect(within(inspectorSheet).getByText("Provider recommendations available")).toBeInTheDocument();
    expect(within(inspectorSheet).getByRole("link", { name: /open official rfq/i })).toHaveAttribute(
      "href",
      "https://www.xometry.com/quoting/home/",
    );
    expect(within(inspectorSheet).getByRole("button", { name: "Full workspace" })).toBeInTheDocument();
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
      accessScope: createWorkspaceAccessScope({
        userId: "user-1",
        organizationId: "org-1",
        role: "client",
      }),
      enabled: false,
    });
  });

  it("requests quotes for ready project parts", async () => {
    renderWithClient("/projects/project-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /request (manual )?1 quote/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /request (manual )?1 quote/i }));

    await waitFor(() => {
      expect(api.requestQuotes).toHaveBeenCalledWith(["job-1"], false);
    });
  });

  it("keeps automatic project quotes unavailable on the Free plan", async () => {
    mockQuoteCollectionMode.mockReturnValue({
      automaticEnabled: false,
      hasAutomaticEntitlement: false,
      isLoading: false,
      plan: "free",
      setAutomaticEnabled: vi.fn(),
    });

    renderWithClient("/projects/project-1");

    const quoteButton = await screen.findByRole("button", {
      name: "Pro required for automatic quotes",
    });
    expect(quoteButton).toBeDisabled();

    fireEvent.click(quoteButton);
    expect(api.requestQuotes).not.toHaveBeenCalled();
  });

  it("keeps automatic project quotes disabled while entitlement access loads", async () => {
    mockQuoteCollectionMode.mockReturnValue({
      automaticEnabled: false,
      hasAutomaticEntitlement: false,
      isLoading: true,
      plan: null,
      setAutomaticEnabled: vi.fn(),
    });

    renderWithClient("/projects/project-1");

    const quoteButton = await screen.findByRole("button", {
      name: "Loading quote access…",
    });
    expect(quoteButton).toBeDisabled();

    fireEvent.click(quoteButton);
    expect(api.requestQuotes).not.toHaveBeenCalled();
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
      expect(screen.getByRole("button", { name: /request (manual )?1 quote/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /request (manual )?1 quote/i }));

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

    const headerButton = await screen.findByRole("button", { name: /request (manual )?1 quote/i });

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
      expect(screen.getByTestId("location-path")).toHaveTextContent("/projects/project-2");
      expect(screen.getByTestId("location-search")).toHaveTextContent("?part=job-2");
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
