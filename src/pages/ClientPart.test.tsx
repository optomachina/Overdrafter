import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientPart from "./ClientPart";

const { api, mockUseAppSession, prefetchProjectPage, prefetchPartPage, toastMock, storedFile } = vi.hoisted(() => ({
  api: {
    archiveJob: vi.fn(),
    archiveProject: vi.fn(),
    assignJobToProject: vi.fn(),
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
    fetchPartDetailByJobId: vi.fn(),
    fetchJobPartSummariesByJobIds: vi.fn(),
    fetchProjectJobMembershipsByJobIds: vi.fn(),
    resolveClientPartDetailRoute: vi.fn(),
    fetchSidebarPins: vi.fn(),
    isArchivedDeleteCapabilityError: vi.fn(() => false),
    isProjectCollaborationSchemaUnavailable: vi.fn(),
    pinJob: vi.fn(),
    pinProject: vi.fn(),
    reconcileJobParts: vi.fn(),
    removeJobFromProject: vi.fn(),
    cancelQuoteRequest: vi.fn(),
    requestQuote: vi.fn(),
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
  toastMock: {
    error: vi.fn(),
    success: vi.fn(),
  },
  storedFile: {
    downloadStoredFileBlob: vi.fn(),
    loadStoredDrawingPreviewPages: vi.fn(),
    loadStoredPdfObjectUrl: vi.fn(),
  },
}));

let lastAccountMenuProps: Record<string, unknown> | null = null;
let lastDrawingPreviewDialogProps: Record<string, unknown> | null = null;
let lastPartInfoPanelProps: Record<string, unknown> | null = null;
let lastQuoteDecisionPanelProps: Record<string, unknown> | null = null;

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
  updateClientPartRequest: api.updateClientPartRequest,
}));
vi.mock("@/features/quotes/api/projects-api", () => ({
  archiveProject: api.archiveProject,
  assignJobToProject: api.assignJobToProject,
  createProject: api.createProject,
  dissolveProject: api.dissolveProject,
  pinJob: api.pinJob,
  pinProject: api.pinProject,
  removeJobFromProject: api.removeJobFromProject,
  unarchiveProject: api.unarchiveProject,
  unpinJob: api.unpinJob,
  unpinProject: api.unpinProject,
  updateProject: api.updateProject,
}));
vi.mock("@/features/quotes/api/quote-requests-api", () => ({
  cancelQuoteRequest: api.cancelQuoteRequest,
  requestQuote: api.requestQuote,
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
  fetchJobPartSummariesByJobIds: api.fetchJobPartSummariesByJobIds,
  fetchPartDetailByJobId: api.fetchPartDetailByJobId,
  fetchProjectJobMembershipsByJobIds: api.fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins: api.fetchSidebarPins,
  resolveClientPartDetailRoute: api.resolveClientPartDetailRoute,
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

vi.mock("@/lib/stored-file", () => ({
  downloadStoredFileBlob: storedFile.downloadStoredFileBlob,
  loadStoredDrawingPreviewPages: storedFile.loadStoredDrawingPreviewPages,
  loadStoredPdfObjectUrl: storedFile.loadStoredPdfObjectUrl,
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
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
    const jobs = Array.isArray(props.jobs)
      ? (props.jobs as Array<{ id: string; title: string }>)
      : [];
    const resolveProjectIdsForJob =
      (props.resolveProjectIdsForJob as ((job: { id: string; title: string }) => string[]) | undefined) ?? null;

    return (
      <div>
        <button type="button" onClick={() => void (props.onPrefetchProject as ((id: string) => void) | undefined)?.("project-2")}>
          Prefetch project
        </button>
        Sidebar
        {jobs.map((job) => (
          <div key={job.id} data-testid={`sidebar-job-${job.id}`}>
            {job.title}:{(resolveProjectIdsForJob?.(job) ?? []).join(",") || "ungrouped"}
          </div>
        ))}
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

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children?: ReactNode;
    onSelect?: (event: { preventDefault: () => void }) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => undefined })}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <div />,
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/chat/PartActionsMenu", () => ({
  PartDropdownMenuActions: () => null,
}));

vi.mock("@/components/quotes/ClientQuoteAssetPanels", () => ({
  ClientCadPreviewPanel: () => <div>CAD</div>,
  ClientDrawingPreviewPanel: (props: { drawingFile?: { original_name?: string | null } | null; pdfUrl?: string | null }) =>
    props.pdfUrl ? (
      <iframe
        title={`${props.drawingFile?.original_name ?? "Drawing"} PDF preview`}
        src={props.pdfUrl}
      />
    ) : (
      <div>Drawing</div>
    ),
}));

vi.mock("@/components/quotes/DrawingPreviewDialog", () => ({
  DrawingPreviewDialog: (props: Record<string, unknown>) => {
    lastDrawingPreviewDialogProps = props;
    return null;
  },
}));

vi.mock("@/components/quotes/ClientPartRequestEditor", () => ({
  ClientPartRequestEditor: ({ onSave }: { onSave: () => void }) => (
    <button type="button" onClick={onSave}>
      Save Request
    </button>
  ),
}));

vi.mock("@/components/quotes/ClientExtractionStatusNotice", () => ({
  ClientExtractionStatusNotice: ({
    diagnostics,
  }: {
    diagnostics?: {
      lifecycle?: string;
      missingFields?: string[];
      lastFailureMessage?: string | null;
    } | null;
  }) => {
    if (diagnostics?.lifecycle === "extracting") {
      return <div>Drawing extraction in progress</div>;
    }

    if (diagnostics?.lifecycle === "partial") {
      return (
        <div>
          <div>Partial drawing metadata found</div>
          <div>Missing: {(diagnostics.missingFields ?? []).join(", ")}</div>
        </div>
      );
    }

    if (diagnostics?.lifecycle === "failed") {
      return (
        <div>
          <div>Drawing extraction failed</div>
          <div>{diagnostics.lastFailureMessage}</div>
        </div>
      );
    }

    return null;
  },
}));

vi.mock("@/components/quotes/ClientWorkspacePanelContent", () => ({
  ClientQuoteRequestStatusCard: ({
    actionLabel,
    actionDisabled,
    isBusy,
    onAction,
  }: {
    actionLabel?: string;
    actionDisabled?: boolean;
    isBusy?: boolean;
    onAction?: (() => void) | null;
  }) =>
    onAction ? (
      <button type="button" disabled={Boolean(actionDisabled || isBusy)} onClick={() => onAction()}>
        {actionLabel ?? "Request Quote"}
      </button>
    ) : null,
}));

vi.mock("@/components/quotes/ClientQuoteDecisionPanel", () => ({
  ClientQuoteDecisionPanel: ({
    options,
    controls,
    headerActions,
  }: {
    options?: Array<{ vendorLabel?: string; tier?: string | null }>;
    controls?: ReactNode;
    headerActions?: ReactNode;
  }) => {
    lastQuoteDecisionPanelProps = { optionCount: options?.length ?? 0 };

    return (
      <div data-testid="quote-decision-panel">
        Quote decision panel
        {headerActions}
        {controls}
        {options?.map((quote) => (
          <div key={`${quote.vendorLabel}-${quote.tier}`}>{[quote.vendorLabel, quote.tier].filter(Boolean).join(" · ")}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/quotes/QuoteSelectionFunctionBar", () => ({
  QuoteSelectionFunctionBar: ({
    requestedByDate,
    onRequestedByDateChange,
  }: {
    requestedByDate?: string | null;
    onRequestedByDateChange?: (next: string | null) => void;
  }) => (
    <div data-testid="quote-selection-function-bar">
      <label htmlFor="mock-due-by">Due by</label>
      <input
        id="mock-due-by"
        aria-label="Due by"
        value={requestedByDate ?? ""}
        onChange={(event) => onRequestedByDateChange?.(event.target.value || null)}
      />
      <button type="button" onClick={() => onRequestedByDateChange?.(null)}>
        Clear
      </button>
      <button type="button">Fast</button>
      <button type="button">Cheap</button>
    </div>
  ),
}));

vi.mock("@/components/workspace/PartInfoPanel", () => ({
  PartInfoPanel: ({
    partNumber,
    description,
    statusContent,
    onSave,
  }: {
    partNumber?: string | null;
    description?: string | null;
    statusContent?: ReactNode;
    onSave?: () => void;
  }) => {
    lastPartInfoPanelProps = {
      partNumber,
      description,
    };

    return (
      <div data-testid="part-info-panel">
        <div>Part information</div>
        {statusContent}
        <button type="button" onClick={() => onSave?.()}>
          Save Request
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/workspace/CadPanel", () => ({
  CadPanel: () => <div data-testid="cad-panel">CAD panel</div>,
}));

vi.mock("@/components/workspace/PdfPanel", () => ({
  PdfPanel: ({
    drawingFile,
    drawingPdfUrl,
  }: {
    drawingFile?: { original_name?: string | null } | null;
    drawingPdfUrl?: string | null;
  }) =>
    drawingPdfUrl ? (
      <iframe title={`${drawingFile?.original_name ?? "Drawing"} PDF preview`} src={drawingPdfUrl} />
    ) : (
      <div>PDF panel</div>
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
            <Route
              path="/parts/:jobId"
              element={
                <>
                  <ClientPart />
                  <LocationEcho />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

async function renderClientPartOnTab(tab?: "Request" | "Files" | "Activity") {
  const result = renderWithClient("/parts/job-1");
  if (tab) {
    await openWorkspaceTab(tab);
  }
  return result;
}

async function openWorkspaceTab(name: "Quote" | "Request" | "Files" | "Activity") {
  const [tab] = await screen.findAllByRole("tab", { name });
  fireEvent.pointerDown(tab, { button: 0, ctrlKey: false });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

async function findRequestButton(name: string | RegExp) {
  await openWorkspaceTab("Request");
  return screen.findByRole("button", { name });
}

async function findRequestQuoteButton() {
  return findRequestButton(/request quote/i);
}

async function clickRequestQuoteButton() {
  const requestQuoteButton = await findRequestQuoteButton();
  await waitFor(() => {
    expect(requestQuoteButton).toBeEnabled();
  });
  fireEvent.click(requestQuoteButton);
}

async function findActivityCommentField() {
  await openWorkspaceTab("Activity");
  return screen.findByLabelText("Leave a comment");
}

async function addActivityComment(comment: string) {
  const commentField = await findActivityCommentField();
  fireEvent.change(commentField, {
    target: { value: comment },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
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

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-path">{location.pathname}</div>;
}

function createPartDetail(overrides: Record<string, unknown> = {}) {
  return {
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
      selectedSupplier: "Xometry",
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
      clientRequirement: null,
      clientExtraction: null,
      vendorQuotes: [],
    },
    projectIds: [],
    drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
    latestQuoteRequest: null,
    latestQuoteRun: null,
    revisionSiblings: [
      {
        jobId: "job-2",
        revision: "B",
        title: "BRKT-001 rev B",
      },
    ],
    ...overrides,
  };
}

describe("ClientPart", () => {
  beforeEach(() => {
    const localStorageState = new Map<string, string>();
    lastAccountMenuProps = null;
    lastDrawingPreviewDialogProps = null;
    lastPartInfoPanelProps = null;
    lastQuoteDecisionPanelProps = null;
    vi.resetAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: vi.fn((key: string) => localStorageState.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageState.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(key);
        }),
        clear: vi.fn(() => {
          localStorageState.clear();
        }),
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      signOut: vi.fn(),
    });

    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(false);
    storedFile.downloadStoredFileBlob.mockResolvedValue(new Blob(["download"]));
    storedFile.loadStoredDrawingPreviewPages.mockResolvedValue([]);
    storedFile.loadStoredPdfObjectUrl.mockResolvedValue("blob:part-drawing-pdf");
    api.fetchClientActivityEventsByJobIds.mockResolvedValue([]);
    api.fetchAccessibleProjects.mockResolvedValue([]);
    api.fetchAccessibleJobs.mockResolvedValue([
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
        created_by: "user-1",
        title: "Bracket",
        description: null,
        status: "ready_to_quote",
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
        selectedSupplier: "Xometry",
        selectedPriceUsd: 100,
        selectedLeadTimeBusinessDays: 7,
      },
    ]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValue([]);
    api.fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    api.fetchArchivedProjects.mockResolvedValue([]);
    api.fetchArchivedJobs.mockResolvedValue([]);
    api.updateClientPartRequest.mockResolvedValue(undefined);
    api.resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "job-1",
      jobId: "job-1",
      source: "job",
    });
    api.fetchPartDetailByJobId.mockResolvedValue(createPartDetail());
    api.requestQuote.mockResolvedValue({
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
    });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses revision siblings from the main part detail aggregate", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "A" })).toBeInTheDocument();
    });

    expect(screen.getByText("Quote decision panel")).toBeInTheDocument();
    expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    await openWorkspaceTab("Request");
    expect(screen.getByText("Part information")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prev rev/i })).toBeInTheDocument();
    expect(screen.queryByText("This part could not be loaded.")).not.toBeInTheDocument();
    expect(api.fetchPartDetailByJobId).toHaveBeenCalledTimes(1);
  });

  it("renders the workspace tabs and switches between quote, request, files, and activity", async () => {
    renderWithClient("/parts/job-1");

    expect(await screen.findByRole("tab", { name: "Quote" })).toBeInTheDocument();
    expect(screen.getByText("Quote decision panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(screen.queryByText("Part information")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cad-panel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Leave a comment")).not.toBeInTheDocument();

    for (const [tab, assertion] of [
      ["Request", () => screen.findByTestId("part-info-panel")],
      ["Files", async () => {
        expect(await screen.findByTestId("cad-panel")).toBeInTheDocument();
        expect(screen.getByText("Attached source files")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
      }],
      ["Activity", () => screen.findByLabelText("Leave a comment")],
    ] as const) {
      await openWorkspaceTab(tab);
      await assertion();
    }
  });

  it("passes part metadata into PartInfoPanel and omits the old workspace badge cluster", async () => {
    await renderClientPartOnTab("Request");
    expect(screen.getByTestId("part-info-panel")).toBeInTheDocument();

    expect(lastPartInfoPanelProps).toMatchObject({
      partNumber: "BRKT-001",
      description: "Bracket",
    });
    expect(screen.queryByText("Standalone part")).not.toBeInTheDocument();
    expect(screen.queryByText("CAD missing")).not.toBeInTheDocument();
    expect(screen.queryByText("Drawing missing")).not.toBeInTheDocument();
  });

  it("renders real vendor quote options instead of the empty comparison state", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        summary: {
          ...createPartDetail().summary,
          selectedSupplier: null,
        },
        part: {
          ...createPartDetail().part,
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
                  offer_key: "xometry-standard",
                  supplier: "Xometry",
                  lane_label: "USA / Standard",
                  sourcing: "USA",
                  tier: "Standard",
                  quote_ref: "Q-1",
                  quote_date: "2026-03-01",
                  unit_price_usd: 10,
                  total_price_usd: 100,
                  lead_time_business_days: 7,
                  ship_receive_by: "2026-03-10",
                  due_date: "2026-04-15",
                  process: "CNC Machining",
                  material: "6061-T6",
                  finish: "Black anodize",
                  tightest_tolerance: "±.005\"",
                  tolerance_source: "Drawing",
                  thread_callouts: null,
                  thread_match_notes: null,
                  notes: null,
                  sort_rank: 0,
                  raw_payload: {},
                  created_at: "2026-03-01T00:00:00Z",
                  updated_at: "2026-03-01T00:00:00Z",
                },
              ],
              artifacts: [],
            },
          ],
        },
      }),
    );

    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByText("Xometry · Standard")).toBeInTheDocument();
    });

    expect(screen.getByText("Quote decision panel")).toBeInTheDocument();
    expect(lastQuoteDecisionPanelProps).toMatchObject({ optionCount: 1 });
  });

  it("canonicalizes legacy part-id routes onto the owning job route", async () => {
    api.resolveClientPartDetailRoute.mockResolvedValueOnce({
      routeId: "part-1",
      jobId: "job-1",
      source: "part",
    });

    const { queryClient } = renderWithClient("/parts/part-1");

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/parts/job-1");
    });

    expect(api.fetchPartDetailByJobId).toHaveBeenCalledWith("job-1");
    expect(queryClient.getQueryState(["part-detail", "part-1"])).toBeUndefined();
    expect(queryClient.getQueryData(["part-detail", "job-1"])).toEqual(createPartDetail());
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
    const { queryClient } = await renderClientPartOnTab("Request");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    expect(screen.getByRole("button", { name: "Save Request" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Request" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalled();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["client-jobs"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["client-part-summaries"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["part-detail"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["part-detail", "job-1"] });
  });

  it("keeps the prior sidebar jobs grouped while the membership refetch is unresolved", async () => {
    const deferredMemberships = createDeferredPromise<Array<{ job_id: string; project_id: string }>>();
    let accessibleJobsFetchCount = 0;
    let projectMembershipFetchCount = 0;

    api.fetchAccessibleProjects.mockResolvedValue([
      {
        project: {
          id: "project-1",
          organization_id: "org-1",
          name: "Bracket Project",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-05T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchAccessibleJobs.mockImplementation(async () => {
      accessibleJobsFetchCount += 1;

      if (accessibleJobsFetchCount === 1) {
        return [
          {
            id: "job-1",
            organization_id: "org-1",
            project_id: null,
            created_by: "user-1",
            title: "Bracket",
            description: null,
            status: "ready_to_quote",
            source: "client_home",
            active_pricing_policy_id: null,
            selected_vendor_quote_offer_id: null,
            tags: [],
            requested_service_kinds: ["manufacturing_quote"],
            primary_service_kind: "manufacturing_quote",
            service_notes: null,
            requested_quote_quantities: [10],
            requested_by_date: "2026-04-15",
            archived_at: null,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ];
      }

      return [
        {
          id: "job-1",
          organization_id: "org-1",
          project_id: null,
          created_by: "user-1",
          title: "Bracket",
          description: null,
          status: "ready_to_quote",
          source: "client_home",
          active_pricing_policy_id: null,
          selected_vendor_quote_offer_id: null,
          tags: [],
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          requested_quote_quantities: [10],
          requested_by_date: "2026-04-15",
          archived_at: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
        {
          id: "job-2",
          organization_id: "org-1",
          project_id: null,
          created_by: "user-1",
          title: "Plate",
          description: null,
          status: "ready_to_quote",
          source: "client_home",
          active_pricing_policy_id: null,
          selected_vendor_quote_offer_id: null,
          tags: [],
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          requested_quote_quantities: [5],
          requested_by_date: "2026-04-15",
          archived_at: null,
          created_at: "2026-03-02T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
      ];
    });
    api.fetchProjectJobMembershipsByJobIds.mockImplementation(async (jobIds: string[]) => {
      projectMembershipFetchCount += 1;

      if (projectMembershipFetchCount === 1) {
        return [{ job_id: "job-1", project_id: "project-1" }];
      }

      expect(jobIds).toEqual(["job-1", "job-2"]);
      return deferredMemberships.promise;
    });

    await renderClientPartOnTab("Request");

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-job-job-1")).toHaveTextContent("Bracket:project-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Request" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(api.fetchProjectJobMembershipsByJobIds).toHaveBeenCalledWith(["job-1", "job-2"]);
    });

    expect(screen.getByTestId("sidebar-job-job-1")).toHaveTextContent("Bracket:project-1");
    expect(screen.queryByTestId("sidebar-job-job-2")).not.toBeInTheDocument();

    deferredMemberships.resolve([
      { job_id: "job-1", project_id: "project-1" },
      { job_id: "job-2", project_id: "project-1" },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-job-job-2")).toHaveTextContent("Plate:project-1");
    });
  });

  it("submits a client quote request when the part is ready", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          status: "ready_to_quote",
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          selected_vendor_quote_offer_id: null,
        },
        summary: {
          ...createPartDetail().summary,
          requestedServiceKinds: ["manufacturing_quote"],
          primaryServiceKind: "manufacturing_quote",
          serviceNotes: null,
          selectedSupplier: null,
          selectedPriceUsd: null,
          selectedLeadTimeBusinessDays: null,
        },
        part: {
          ...createPartDetail().part,
          cad_file_id: "cad-1",
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
        },
        revisionSiblings: [],
      }),
    );

    renderWithClient("/parts/job-1");

    await clickRequestQuoteButton();

    await waitFor(() => {
      expect(api.requestQuote).toHaveBeenCalledWith("job-1", false);
    });
  });

  it("shows the returned rate-limit message when the part quote request is blocked", async () => {
    api.requestQuote.mockResolvedValue({
      jobId: "job-1",
      accepted: false,
      created: false,
      deduplicated: false,
      quoteRequestId: null,
      quoteRunId: null,
      serviceRequestLineItemId: null,
      status: "not_requested",
      reasonCode: "rate_limited_user",
      reason: "You have reached the quote request limit for now. Try again later or contact your estimator.",
      requestedVendors: ["xometry", "fictiv", "protolabs"],
    });

    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          status: "ready_to_quote",
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          selected_vendor_quote_offer_id: null,
        },
        summary: {
          ...createPartDetail().summary,
          requestedServiceKinds: ["manufacturing_quote"],
          primaryServiceKind: "manufacturing_quote",
          serviceNotes: null,
          selectedSupplier: null,
          selectedPriceUsd: null,
          selectedLeadTimeBusinessDays: null,
        },
        part: {
          ...createPartDetail().part,
          cad_file_id: "cad-1",
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
        },
        revisionSiblings: [],
      }),
    );

    renderWithClient("/parts/job-1");

    await clickRequestQuoteButton();

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "You have reached the quote request limit for now. Try again later or contact your estimator.",
      );
    });
  });

  it("blocks duplicate part quote requests while the first request is pending", async () => {
    const deferred = createDeferredPromise<{
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
    }>();
    void deferred.promise.catch(() => undefined);

    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          status: "ready_to_quote",
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          selected_vendor_quote_offer_id: null,
        },
        summary: {
          ...createPartDetail().summary,
          requestedServiceKinds: ["manufacturing_quote"],
          primaryServiceKind: "manufacturing_quote",
          serviceNotes: null,
          selectedSupplier: null,
          selectedPriceUsd: null,
          selectedLeadTimeBusinessDays: null,
        },
        part: {
          ...createPartDetail().part,
          cad_file_id: "cad-1",
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
        },
        revisionSiblings: [],
      }),
    );
    api.requestQuote.mockReturnValue(deferred.promise);

    renderWithClient("/parts/job-1");

    const button = await findRequestQuoteButton();

    expect(button).toBeEnabled();

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.requestQuote).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    deferred.reject(new Error("Request failed"));

    await waitFor(() => {
      expect(button).toBeEnabled();
    });
  });

  it("confirms and cancels an in-flight quote request from the status card", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          status: "quoting",
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          selected_vendor_quote_offer_id: null,
        },
        latestQuoteRequest: {
          id: "request-1",
          organization_id: "org-1",
          job_id: "job-1",
          requested_by: "user-1",
          requested_vendors: ["xometry"],
          status: "queued",
          failure_reason: null,
          received_at: null,
          failed_at: null,
          canceled_at: null,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
        latestQuoteRun: {
          id: "run-1",
          quote_request_id: "request-1",
          job_id: "job-1",
          organization_id: "org-1",
          initiated_by: "user-1",
          status: "running",
          requested_auto_publish: false,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
      }),
    );

    renderWithClient("/parts/job-1");

    fireEvent.click(await findRequestButton("Cancel request"));
    expect(await screen.findByText("Cancel quote request?")).toBeInTheDocument();
    expect(
      await screen.findByText(
        "This stops the current vendor quote request for this package. You can request a new quote again after canceling.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel request" })[0]!);

    await waitFor(() => {
      expect(api.cancelQuoteRequest).toHaveBeenCalledWith("request-1");
    });
  });

  it("saves a due date from the inline function bar", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Due by"), { target: { value: "2026-04-22" } });

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", requestedByDate: "2026-04-22" }),
      );
    });
  });

  it("adds browser-local comments in the activity section", async () => {
    renderWithClient("/parts/job-1");

    await addActivityComment("Need vendor follow-up before approving.");

    await waitFor(() => {
      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        "client-part-comments:user-1:job-1",
        expect.stringContaining("Need vendor follow-up before approving."),
      );
    });
  });

  it("keeps browser-local comments isolated to the active user", async () => {
    const firstRender = renderWithClient("/parts/job-1");

    await addActivityComment("Private follow-up for user one.");

    await waitFor(() => {
      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        "client-part-comments:user-1:job-1",
        expect.stringContaining("Private follow-up for user one."),
      );
    });

    mockUseAppSession.mockReturnValue({
      user: { id: "user-2", email: "other@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      signOut: vi.fn(),
    });

    firstRender.unmount();
    renderWithClient("/parts/job-1");

    await findActivityCommentField();
    await waitFor(() => {
      expect(window.localStorage.getItem).toHaveBeenCalledWith("client-part-comments:user-2:job-1");
    });
  });

  it("toggles favorite with the F hotkey", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /favorite part/i })).toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "f" });

    await waitFor(() => {
      expect(api.pinJob).toHaveBeenCalledWith("job-1");
    });
  });

  it("uses a filled accent treatment for an active favorite", async () => {
    api.fetchSidebarPins.mockResolvedValueOnce({ projectIds: [], jobIds: ["job-1"] });

    renderWithClient("/parts/job-1");

    const favoriteButton = await screen.findByRole("button", { name: /unfavorite part/i });
    expect(favoriteButton.className).toContain("bg-amber-500/16");
    expect(favoriteButton.className).toContain("text-amber-200");
    const icon = favoriteButton.querySelector("svg");
    expect(icon?.className.baseVal ?? "").toContain("fill-current");
  });

  it("does not render the dead workspace breadcrumb button or request summary badges in the header", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "BRKT-001 rev A" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByText("Manufacturing quote")).toBeNull();
    expect(screen.queryByText("Qty 10")).toBeNull();
    expect(screen.queryByText("Quote qty 10")).toBeNull();
    expect(screen.queryByText("Need by Apr 15, 2026")).toBeNull();
  });

  it("drops title-derived revision suffixes from the normalized part heading", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          title: "1093-05589 rev 2",
        },
        summary: {
          ...createPartDetail().summary,
          partNumber: null,
          revision: null,
        },
      }),
    );
    api.fetchAccessibleJobs.mockResolvedValueOnce([
      {
        ...createPartDetail().job,
        title: "1093-05589 rev 2",
      },
    ]);
    api.fetchJobPartSummariesByJobIds.mockResolvedValueOnce([
      {
        ...createPartDetail().summary,
        partNumber: null,
        revision: null,
      },
    ]);

    renderWithClient("/parts/job-1");

    expect(await screen.findByRole("heading", { name: "1093-05589" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "1093-05589 rev 2" })).toBeNull();
  });

  it("clears the inline due date from the function bar", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", requestedByDate: null }),
      );
    });
  });

  it("labels the destructive menu action as archive", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /issue detail actions/i })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /issue detail actions/i }));
    expect(await screen.findByRole("menuitem", { name: /archive part/i })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^delete$/i })).toBeNull();
  });

  it("shows a processing notice while drawing extraction is still running", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        job: {
          ...createPartDetail().job,
          status: "extracting",
        },
        part: {
          ...createPartDetail().part,
          drawingFile: {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
          clientExtraction: {
            lifecycle: "extracting",
            warningCount: 0,
            warnings: [],
            missingFields: [],
            lastFailureCode: null,
            lastFailureMessage: null,
            extractedAt: null,
            failedAt: null,
            updatedAt: null,
            pageCount: 0,
            hasCadFile: false,
            hasDrawingFile: true,
          },
        },
        files: [
          {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ],
      }),
    );

    await renderClientPartOnTab("Request");
    expect(await screen.findAllByText(/drawing extraction in progress/i)).not.toHaveLength(0);
  });

  it("renders an embedded PDF in the part detail pane for uploaded drawing files", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        part: {
          ...createPartDetail().part,
          drawingFile: {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            mime_type: "text/plain",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        },
        files: [
          {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            mime_type: "text/plain",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ],
      }),
    );

    await renderClientPartOnTab("Files");
    expect(await screen.findByTitle("bracket.pdf PDF preview")).toHaveAttribute("src", "blob:part-drawing-pdf");
    expect(storedFile.loadStoredPdfObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        original_name: "bracket.pdf",
        mime_type: "text/plain",
      }),
    );
    expect(screen.queryByText("PDF-1.4")).not.toBeInTheDocument();
  });

  it("keeps dialog page previews hydrated when PDF loading falls back to extracted page images", async () => {
    storedFile.loadStoredPdfObjectUrl.mockRejectedValueOnce(new Error("expired"));
    storedFile.loadStoredDrawingPreviewPages.mockResolvedValueOnce([{ pageNumber: 1, url: "blob:page-1" }]);

    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        drawingPreview: {
          pageCount: 1,
          thumbnail: null,
          pages: [
            {
              pageNumber: 1,
              storageBucket: "quote-artifacts",
              storagePath: "preview/page-1.png",
              width: 800,
              height: 600,
            },
          ],
        },
        part: {
          ...createPartDetail().part,
          drawingFile: {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            mime_type: "application/pdf",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        },
        files: [
          {
            id: "drawing-1",
            job_id: "job-1",
            storage_bucket: "job-files",
            storage_path: "org/bracket.pdf",
            original_name: "bracket.pdf",
            file_kind: "drawing",
            mime_type: "application/pdf",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ],
      }),
    );

    await renderClientPartOnTab("Files");
    await waitFor(() => {
      expect(storedFile.loadStoredDrawingPreviewPages).toHaveBeenCalled();
      expect(lastDrawingPreviewDialogProps?.pages).toEqual([{ pageNumber: 1, url: "blob:page-1" }]);
    });
  });

  it("shows a failure notice when drawing extraction fails", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        part: {
          ...createPartDetail().part,
          clientExtraction: {
            lifecycle: "failed",
            warningCount: 0,
            warnings: [],
            missingFields: ["material"],
            lastFailureCode: "pdf_parse_failed",
            lastFailureMessage: "Could not read text from the uploaded drawing PDF.",
            extractedAt: null,
            failedAt: "2026-03-01T01:00:00Z",
            updatedAt: "2026-03-01T01:00:00Z",
            pageCount: 0,
            hasCadFile: false,
            hasDrawingFile: true,
          },
        },
      }),
    );

    await renderClientPartOnTab("Request");
    expect(await screen.findAllByText(/drawing extraction failed/i)).not.toHaveLength(0);
    expect(await screen.findAllByText(/could not read text from the uploaded drawing pdf/i)).not.toHaveLength(0);
  });

  it("shows a partial notice when drawing extraction is incomplete", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        part: {
          ...createPartDetail().part,
          clientExtraction: {
            lifecycle: "partial",
            warningCount: 2,
            warnings: ["Material was not confidently detected."],
            missingFields: ["material", "finish"],
            lastFailureCode: null,
            lastFailureMessage: null,
            extractedAt: "2026-03-01T01:00:00Z",
            failedAt: null,
            updatedAt: "2026-03-01T01:00:00Z",
            pageCount: 2,
            hasCadFile: false,
            hasDrawingFile: true,
          },
          clientRequirement: {
            description: "Bracket",
            partNumber: "BRKT-001",
            revision: "A",
            material: "Unknown material",
            finish: null,
            tightestToleranceInch: null,
            process: null,
            notes: null,
            quantity: 10,
            quoteQuantities: [10],
            requestedByDate: "2026-04-15",
          },
        },
      }),
    );

    await renderClientPartOnTab("Request");
    await waitFor(() => {
      expect(screen.getByText(/partial drawing metadata found/i)).toBeInTheDocument();
      expect(screen.getByText(/missing: material, finish/i)).toBeInTheDocument();
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
      renderWithClient("/parts/job-1");

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

  it("does not redirect to sign-in while auth restoration is still initializing", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      signOut: vi.fn(),
      isAuthInitializing: true,
    });
    api.fetchAccessibleProjects.mockResolvedValue([]);
    api.fetchAccessibleJobs.mockResolvedValue([]);
    api.fetchArchivedProjects.mockResolvedValue([]);
    api.fetchArchivedJobs.mockResolvedValue([]);

    renderWithClient("/parts/job-1");

    expect(screen.getByText("Restoring your part workspace.")).toBeInTheDocument();
    expect(screen.getByTestId("location-path")).toHaveTextContent("/parts/job-1");
  });
});
