import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAccessScope } from "@/features/quotes/workspace-navigation";
import ClientPart from "./ClientPart";

const {
  api,
  mockQuoteCollectionMode,
  mockUseAppSession,
  prefetchProjectPage,
  prefetchPartPage,
  toastMock,
  storedFile,
} = vi.hoisted(() => ({
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
    fetchVendorCapabilityProfiles: vi.fn(),
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
    getQuoteLaneEligibility: vi.fn(),
    fetchJobVendorPreferenceContext: vi.fn(),
    requestQuote: vi.fn(),
    requestExtraction: vi.fn(),
    resetClientPartPropertyOverrides: vi.fn(),
    persistClientQuoteSelection: vi.fn(),
    setJobSelectedVendorQuoteOffer: vi.fn(),
    unarchiveJob: vi.fn(),
    unarchiveProject: vi.fn(),
    unpinJob: vi.fn(),
    unpinProject: vi.fn(),
    updateClientPartRequest: vi.fn(),
    updateProject: vi.fn(),
    uploadFilesToJob: vi.fn(),
  },
  mockQuoteCollectionMode: {
    automaticEnabled: true,
    hasAutomaticEntitlement: true,
    isLoading: false,
    plan: "pro",
    setAutomaticEnabled: vi.fn(),
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
let lastQuoteDecisionPanelProps: Record<string, unknown> | null = null;
let lastShellProps: Record<string, unknown> | null = null;

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
  resetClientPartPropertyOverrides: api.resetClientPartPropertyOverrides,
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
  getQuoteLaneEligibility: api.getQuoteLaneEligibility,
  requestManualQuote: api.requestQuote,
  requestQuote: api.requestQuote,
  persistClientQuoteSelection: api.persistClientQuoteSelection,
  setJobSelectedVendorQuoteOffer: api.setJobSelectedVendorQuoteOffer,
}));
vi.mock("@/features/quotes/api/vendor-preferences-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/quotes/api/vendor-preferences-api")
  >("@/features/quotes/api/vendor-preferences-api");
  return {
    ...actual,
    fetchJobVendorPreferenceContext: api.fetchJobVendorPreferenceContext,
  };
});
vi.mock("@/features/quotes/organization-entitlements", () => ({
  useOrganizationQuoteCollectionMode: () => mockQuoteCollectionMode,
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
  fetchVendorCapabilityProfiles: api.fetchVendorCapabilityProfiles,
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

vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({
    children,
    accountSlot,
    title,
    uploadSlot,
  }: {
    children?: ReactNode;
    accountSlot?: ReactNode;
    title?: string;
    uploadSlot?: ReactNode;
  }) => {
    lastShellProps = { title };
    return <div data-testid="client-shell">
      <h1 data-testid="shell-title">{title}</h1>
      <div>{uploadSlot}</div>
      <div>{accountSlot}</div>
      <div>{children}</div>
    </div>;
  },
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: (props: Record<string, unknown>) => {
    lastAccountMenuProps = props;
    return <div>Account Menu</div>;
  },
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
    detail,
    heading,
    isBusy,
    onAction,
  }: {
    actionLabel?: string;
    actionDisabled?: boolean;
    detail?: string;
    heading?: string;
    isBusy?: boolean;
    onAction?: (() => void) | null;
  }) => (
    <div>
      {heading ? <div>{heading}</div> : null}
      {detail ? <div>{detail}</div> : null}
      {onAction ? (
        <button type="button" disabled={Boolean(actionDisabled || isBusy)} onClick={() => onAction()}>
          {actionLabel ?? "Request Quote"}
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/quotes/ClientQuoteDecisionPanel", () => ({
  ClientQuoteDecisionPanel: ({
    options,
    selectedOption,
    controls,
    headerActions,
    onSelect,
  }: {
    options?: Array<{
      key?: string;
      vendorLabel?: string;
      tier?: string | null;
      totalPriceUsd?: number;
      selectionTarget?: unknown;
    }>;
    selectedOption?: {
      key?: string;
      selectionTarget?: unknown;
    } | null;
    controls?: ReactNode;
    headerActions?: ReactNode;
    onSelect?: (option: unknown) => void;
  }) => {
    lastQuoteDecisionPanelProps = {
      optionCount: options?.length ?? 0,
      totalPrices: options?.map((option) => option.totalPriceUsd) ?? [],
      firstOption: options?.[0] ?? null,
      lastOption: options?.at(-1) ?? null,
      selectedOption,
      onSelect,
    };

    return (
      <div data-testid="quote-decision-panel">
        Quote decision panel
        {headerActions}
        {controls}
        <button type="button" onClick={() => onSelect?.(null)}>
          Clear quote selection
        </button>
        {options?.map((quote) => (
          <div key={quote.key ?? `${quote.vendorLabel}-${quote.tier}`}>{[quote.vendorLabel, quote.tier].filter(Boolean).join(" · ")}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/quotes/QuoteSelectionFunctionBar", () => ({
  QuoteSelectionFunctionBar: ({
    requestedByDate,
    onModeChange,
    onRequestedByDateChange,
  }: {
    requestedByDate?: string | null;
    onModeChange?: (next: "balanced" | "cheapest" | "fastest") => void;
    onRequestedByDateChange?: (next: string | null) => void;
  }) => (
    <div data-testid="quote-selection-function-bar">
      <label htmlFor="mock-due-by">Need by date</label>
      <input
        id="mock-due-by"
        aria-label="Need by date"
        value={requestedByDate ?? ""}
        onChange={(event) => onRequestedByDateChange?.(event.target.value || null)}
      />
      <button type="button" onClick={() => onRequestedByDateChange?.(null)}>
        Clear
      </button>
      <button type="button" onClick={() => onModeChange?.("fastest")}>Fast</button>
      <button type="button" onClick={() => onModeChange?.("cheapest")}>Cheap</button>
    </div>
  ),
}));

vi.mock("@/components/workspace/PartInfoPanel", () => ({
  PartInfoPanel: ({
    effectiveRequestDraft,
    onDraftChange,
    statusContent,
    onSave,
    onResetField,
  }: {
    effectiveRequestDraft?: { description?: string | null; notes?: string | null } | null;
    onDraftChange?: (next: { description?: string; notes?: string }) => void;
    statusContent?: ReactNode;
    onSave?: () => void;
    onResetField?: (field: "description") => void;
  }) => {

    return (
      <div data-testid="part-info-panel">
        <div>Part information</div>
        {statusContent}
        <input
          aria-label="Description"
          value={effectiveRequestDraft?.description ?? ""}
          onChange={(event) => onDraftChange?.({ description: event.target.value })}
        />
        <input
          aria-label="Notes"
          value={effectiveRequestDraft?.notes ?? ""}
          onChange={(event) => onDraftChange?.({ notes: event.target.value })}
        />
        <button type="button" onClick={() => onSave?.()}>
          Save Request
        </button>
        <button type="button" onClick={() => onResetField?.("description")}>
          Reset description
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/quotes/PartProductDataBar", () => ({
  PartProductDataBar: () => <div data-testid="part-product-data-bar">Product data</div>,
}));

vi.mock("@/components/quotes/PartViewerRow", () => ({
  PartViewerRow: ({
    drawingFile,
    drawingPdfUrl,
  }: {
    drawingFile?: { original_name?: string | null } | null;
    drawingPdfUrl?: string | null;
  }) =>
    drawingPdfUrl ? (
      <iframe
        title={`${drawingFile?.original_name ?? "Drawing"} PDF preview`}
        src={drawingPdfUrl}
        data-testid="part-viewer-row"
      />
    ) : (
      <div data-testid="part-viewer-row">Viewer row</div>
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
          <LocationEcho />
          <Routes>
            <Route path="/parts/:jobId" element={<ClientPart />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

// PartInfoPanel (the "Request" surface) moved from a workspace tab into the
// shell's right rail (PR-B), so it is always mounted — no tab switch.
async function renderClientPartOnTab(tab?: "Request" | "Activity") {
  const result = renderWithClient("/parts/job-1");
  if (tab === "Activity") {
    await openActivitySection();
  } else if (tab === "Request") {
    await screen.findByTestId("part-info-panel");
  }
  return result;
}

async function openActivitySection() {
  const summary = await screen.findByText("Activity and history");
  fireEvent.click(summary);
}

async function findRequestButton(name: string | RegExp) {
  await screen.findByTestId("part-info-panel");
  return screen.findByRole("button", { name });
}

async function findRequestQuoteButton() {
  return findRequestButton(/request (manual )?quote/i);
}

async function clickRequestQuoteButton() {
  const requestQuoteButton = await findRequestQuoteButton();
  await waitFor(() => {
    expect(requestQuoteButton).toBeEnabled();
  });
  fireEvent.click(requestQuoteButton);
  fireEvent.click(await screen.findByRole("button", { name: "Review what will be shared" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send to 1 vendor" }));
}

async function findActivityCommentField() {
  if (!screen.queryByLabelText("Leave a comment")) {
    await openActivitySection();
  }
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
  return (
    <>
      <div data-testid="location-path">{location.pathname}</div>
      <div data-testid="location-search">{location.search}</div>
    </>
  );
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
    lastQuoteDecisionPanelProps = null;
    lastShellProps = null;
    vi.resetAllMocks();
    mockQuoteCollectionMode.automaticEnabled = true;
    mockQuoteCollectionMode.hasAutomaticEntitlement = true;
    mockQuoteCollectionMode.plan = "pro";
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
    api.fetchVendorCapabilityProfiles.mockResolvedValue([]);
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
    api.resetClientPartPropertyOverrides.mockResolvedValue(undefined);
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
    api.fetchJobVendorPreferenceContext.mockResolvedValue({
      availableVendors: ["xometry"],
      projectVendorPreferences: { includedVendors: [], excludedVendors: [] },
      jobVendorPreferences: { includedVendors: ["xometry"], excludedVendors: [] },
    });
    api.getQuoteLaneEligibility.mockResolvedValue([
      {
        vendor: "xometry",
        partId: "part-1",
        requestedQuantity: 10,
        state: "requestable",
        currentOfferId: null,
        validUntil: null,
        retryAt: null,
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses revision siblings from the main part detail aggregate", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "More part actions" })).toBeInTheDocument();
    });

    expect(screen.getByText("Quote decision panel")).toBeInTheDocument();
    expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    await screen.findByTestId("part-info-panel");
    expect(screen.getByTestId("part-info-panel")).toHaveTextContent("Part information");
    expect(screen.getByRole("region", { name: "Revision navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /previous revision/i })).not.toBeInTheDocument();
    expect(screen.queryByText("This part could not be loaded.")).not.toBeInTheDocument();
    expect(api.fetchPartDetailByJobId).toHaveBeenCalledTimes(1);
  });

  it("keeps the part evidence and quote comparison in one ordered workspace", async () => {
    renderWithClient("/parts/job-1");

    await screen.findByText("Quote decision panel");
    expect(screen.queryByRole("tab", { name: "Quote" })).not.toBeInTheDocument();
    expect(screen.getByText("Quote decision panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review order" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CAD file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload part files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share part" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More part actions" })).toBeInTheDocument();
    expect(lastShellProps?.uploadSlot).toBeUndefined();
    expect(screen.queryByRole("tab", { name: "Files" })).not.toBeInTheDocument();
    // PartInfoPanel renders once in the primary workspace.
    expect(screen.queryByRole("tab", { name: "Request" })).not.toBeInTheDocument();
    expect(screen.getByTestId("part-viewer-row")).toBeInTheDocument();
    expect(screen.getByTestId("part-product-data-bar")).toBeInTheDocument();
    expect(screen.getByTestId("part-info-panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Leave a comment")).not.toBeInTheDocument();

    const viewer = screen.getByTestId("part-viewer-row");
    const productData = screen.getByTestId("part-product-data-bar");
    const partInformation = screen.getByTestId("part-info-panel");
    const quoteDecision = screen.getByTestId("quote-decision-panel");
    expect(viewer.compareDocumentPosition(productData) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(productData.compareDocumentPosition(partInformation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(partInformation.compareDocumentPosition(quoteDecision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await openActivitySection();
    await screen.findByLabelText("Leave a comment");
  });

  it("downloads the CAD file from the Part header", async () => {
    const cadFile = {
      id: "cad-file-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad" as const,
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "org-1/job-1/bracket.step",
      normalized_name: "bracket.step",
      original_name: "bracket.step",
      mime_type: "application/step",
      size_bytes: 1024,
      content_sha256: "hash",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-01T00:00:00Z",
    };
    const baseDetail = createPartDetail();
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        files: [cadFile],
        part: { ...baseDetail.part, cad_file_id: cadFile.id, cadFile },
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:cad-download"),
    });

    renderWithClient("/parts/job-1");
    fireEvent.click(await screen.findByRole("button", { name: "Download CAD file" }));

    await waitFor(() => {
      expect(storedFile.downloadStoredFileBlob).toHaveBeenCalledWith(cadFile);
      expect(click).toHaveBeenCalledTimes(1);
    });
    click.mockRestore();
  });

  it("shares the Part URL with a copy-link fallback", async () => {
    renderWithClient("/parts/job-1");

    fireEvent.click(await screen.findByRole("button", { name: "Share part" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://localhost:3000/parts/job-1");
      expect(toastMock.success).toHaveBeenCalledWith("Part link copied.");
    });
  });

  it("puts provider-only sourcing guidance before an empty quote comparison", async () => {
    const cadFile = {
      id: "cad-file-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad" as const,
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "org-1/job-1/bracket.step",
      normalized_name: "bracket.step",
      original_name: "bracket.step",
      mime_type: "application/step",
      size_bytes: 1024,
      content_sha256: "hash",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-01T00:00:00Z",
    };
    const baseDetail = createPartDetail();

    api.fetchVendorCapabilityProfiles.mockResolvedValue([
      {
        vendor_name: "xometry",
        process_types: ["cnc_milling"],
        materials: ["aluminum"],
        tolerance_min_mm: 0.005,
        tolerance_max_mm: 0.2,
        max_part_size_mm: 1000,
        min_quantity: 1,
        max_quantity: null,
        geographic_region: "US",
        certifications: ["ISO9001"],
        quality_score: 80,
        lead_time_reliability: 80,
        cost_competitiveness: 70,
        domestic_us: true,
        updated_at: "2026-07-30T00:00:00.000Z",
      },
    ]);
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        files: [cadFile],
        part: {
          ...baseDetail.part,
          cadFile,
          approvedRequirement: {
            id: "requirement-1",
            part_id: "part-1",
            organization_id: "org-1",
            description: "Bracket",
            part_number: "BRKT-001",
            revision: "A",
            material: "6061-T6 aluminum",
            finish: "Black anodize",
            tightest_tolerance_inch: 0.005,
            quantity: 10,
            quote_quantities: [10],
            requested_by_date: "2026-04-15",
            applicable_vendors: ["xometry"],
            spec_snapshot: { process: "CNC milling" },
            approved_by: "user-1",
            approved_at: "2026-03-01T00:00:00Z",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
          vendorQuotes: [],
        },
      }),
    );

    renderWithClient("/parts/job-1");

    const recommendations = await screen.findByRole("region", {
      name: "Additional sourcing paths",
    });
    const quoteDecision = screen.getByTestId("quote-decision-panel");
    expect(
      quoteDecision.compareDocumentPosition(recommendations) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(lastQuoteDecisionPanelProps).toMatchObject({ optionCount: 0 });
  });

  it("shows Founding Beta guidance without exposing the manual quote path", async () => {
    mockQuoteCollectionMode.automaticEnabled = false;
    mockQuoteCollectionMode.hasAutomaticEntitlement = false;
    mockQuoteCollectionMode.plan = "free";

    renderWithClient("/parts/job-1");

    expect(await screen.findByText("Automatic quote access")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Automatic quote collection is not enabled for this organization. Provider recommendations and official RFQ links remain available. The Founding Beta is free and invitation-only. No payment card, order, or supplier commitment is created.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request manual quote/i })).not.toBeInTheDocument();
    expect(api.requestQuote).not.toHaveBeenCalled();
  });

  it("renders PartInfoPanel in the right rail and omits the old workspace badge cluster", async () => {
    await renderClientPartOnTab("Request");
    expect(screen.getByTestId("part-info-panel")).toBeInTheDocument();

    expect(screen.queryByText("Standalone part")).not.toBeInTheDocument();
    expect(screen.queryByText("CAD missing")).not.toBeInTheDocument();
    expect(screen.queryByText("Drawing missing")).not.toBeInTheDocument();
  });

  it("renders real vendor quote options instead of the empty comparison state", async () => {
    const liveTimestamp = new Date().toISOString();
    api.fetchVendorCapabilityProfiles.mockReturnValue(new Promise(() => undefined));
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        summary: {
          ...createPartDetail().summary,
          selectedSupplier: null,
        },
        part: {
          ...createPartDetail().part,
          cadFile: {
            id: "cad-file-1",
            job_id: "job-1",
            organization_id: "org-1",
            file_kind: "cad",
            blob_id: "blob-1",
            storage_bucket: "job-files",
            storage_path: "org-1/job-1/bracket.step",
            normalized_name: "bracket.step",
            original_name: "bracket.step",
            mime_type: "application/step",
            size_bytes: 1024,
            content_sha256: "hash",
            matched_part_key: null,
            uploaded_by: "user-1",
            created_at: "2026-03-01T00:00:00Z",
          },
          approvedRequirement: {
            id: "requirement-1",
            part_id: "part-1",
            organization_id: "org-1",
            description: "Bracket",
            part_number: "BRKT-001",
            revision: "A",
            material: "6061-T6 aluminum",
            finish: "Black anodize",
            tightest_tolerance_inch: 0.005,
            quantity: 10,
            quote_quantities: [10],
            requested_by_date: "2026-04-15",
            applicable_vendors: ["xometry"],
            spec_snapshot: { process: "CNC milling" },
            approved_by: "user-1",
            approved_at: "2026-03-01T00:00:00Z",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
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
              quote_url: "https://www.xometry.com/quoting/home/quote-1",
              dfm_issues: [],
              notes: [],
              raw_payload: {
                automationVersion: "xometry-worker-v1",
                detectedFlow: "quote_ready",
                requirementCapturedAt: liveTimestamp,
              },
              created_at: liveTimestamp,
              updated_at: liveTimestamp,
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
                  quote_date: liveTimestamp.slice(0, 10),
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
                  created_at: liveTimestamp,
                  updated_at: liveTimestamp,
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
    expect(lastQuoteDecisionPanelProps).toMatchObject({
      optionCount: 1,
      totalPrices: [100],
    });
  });

  it("renders valid imported quote options without labeling them as live adapter offers", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        summary: {
          ...createPartDetail().summary,
          selectedSupplier: null,
        },
        publishedQuoteOptions: [
          {
            id: "published-option-imported-1",
            package_id: "published-package-imported-1",
            organization_id: "org-1",
            option_kind: "lowest_cost",
            label: "Lowest Cost",
            requested_quantity: 10,
            published_price_usd: 700.7,
            lead_time_business_days: 12,
            comparison_summary: "Best published price.",
            source_vendor_quote_id: "quote-imported-1",
            source_vendor_quote_offer_id: "offer-imported-1",
            markup_policy_version: "v1_markup_20",
            created_at: "2026-03-20T18:20:00Z",
          },
          {
            id: "published-option-imported-2",
            package_id: "published-package-imported-1",
            organization_id: "org-1",
            option_kind: "fastest_delivery",
            label: "Fastest Delivery",
            requested_quantity: 10,
            published_price_usd: 800.8,
            lead_time_business_days: 8,
            comparison_summary: "Fastest published option.",
            source_vendor_quote_id: "quote-imported-1",
            source_vendor_quote_offer_id: "offer-imported-1",
            markup_policy_version: "v1_markup_20",
            created_at: "2026-03-20T18:20:00Z",
          },
        ],
        part: {
          ...createPartDetail().part,
          vendorQuotes: [
            {
              id: "quote-imported-1",
              quote_run_id: "run-imported-1",
              part_id: "part-1",
              organization_id: "org-1",
              vendor: "fastdms",
              requested_quantity: 10,
              status: "official_quote_received",
              unit_price_usd: 58.392,
              total_price_usd: 583.92,
              lead_time_business_days: 12,
              quote_url: null,
              dfm_issues: [],
              notes: ["Imported from Quotes Spreadsheet.xlsx batch QB00001."],
              raw_payload: {
                importSource: {
                  batch: "QB00001",
                  workbookName: "Quotes Spreadsheet.xlsx",
                },
              },
              created_at: "2026-03-20T18:14:11Z",
              updated_at: "2026-03-20T18:14:11Z",
              offers: [
                {
                  id: "offer-imported-1",
                  vendor_quote_result_id: "quote-imported-1",
                  organization_id: "org-1",
                  offer_key: "fastdms-standard",
                  supplier: "FastDMS",
                  lane_label: "Standard",
                  sourcing: "USA",
                  tier: "Standard",
                  quote_ref: "QB00001-1",
                  quote_date: "2026-03-02",
                  unit_price_usd: 58.392,
                  total_price_usd: 583.92,
                  lead_time_business_days: 12,
                  ship_receive_by: null,
                  due_date: null,
                  process: "CNC milling",
                  material: "6061-T6 aluminum",
                  finish: "Black anodize",
                  tightest_tolerance: "±.005\"",
                  tolerance_source: "Drawing",
                  thread_callouts: null,
                  thread_match_notes: null,
                  notes: null,
                  sort_rank: 0,
                  raw_payload: {},
                  created_at: "2026-03-20T18:14:11Z",
                  updated_at: "2026-03-20T18:14:11Z",
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
      expect(screen.getAllByText("FastDMS · Standard")).toHaveLength(2);
    });

    expect(lastQuoteDecisionPanelProps).toMatchObject({
      optionCount: 2,
      totalPrices: [700.7, 800.8],
    });
    await act(async () => {
      const onSelect = lastQuoteDecisionPanelProps?.onSelect as
        | ((option: unknown) => void)
        | undefined;
      onSelect?.(lastQuoteDecisionPanelProps?.lastOption);
    });
    await waitFor(() => {
      expect(api.persistClientQuoteSelection).toHaveBeenCalledWith({
        jobId: "job-1",
        target: {
          kind: "published_quote_option",
          packageId: "published-package-imported-1",
          optionId: "published-option-imported-2",
        },
      });
    });
    expect(lastQuoteDecisionPanelProps?.selectedOption).toMatchObject({
      key: "published:published-option-imported-2",
      selectionTarget: {
        kind: "published_quote_option",
        optionId: "published-option-imported-2",
      },
    });
    expect(api.setJobSelectedVendorQuoteOffer).not.toHaveBeenCalledWith(
      "job-1",
      "offer-imported-1",
    );

    api.persistClientQuoteSelection.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cheap" }));

    await waitFor(() => {
      expect(api.persistClientQuoteSelection).toHaveBeenCalledWith({
        jobId: "job-1",
        target: {
          kind: "published_quote_option",
          packageId: "published-package-imported-1",
          optionId: "published-option-imported-1",
        },
      });
    });
    expect(screen.queryByText("Live offers available")).not.toBeInTheDocument();
  });

  it("fails closed when clearing a package-scoped published selection", async () => {
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        publishedQuoteSelection: {
          id: "selection-published-1",
          package_id: "published-package-1",
          option_id: "published-option-1",
          organization_id: "org-1",
          selected_by: "user-1",
          note: null,
          created_at: "2026-03-20T18:25:00Z",
        },
      }),
    );

    renderWithClient("/parts/job-1");

    fireEvent.click(await screen.findByRole("button", { name: "Clear quote selection" }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Published quote selections cannot be cleared. Select another quote to replace it.",
      );
    });
    expect(api.persistClientQuoteSelection).not.toHaveBeenCalled();
    expect(api.setJobSelectedVendorQuoteOffer).not.toHaveBeenCalledWith("job-1", null);
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
    const accessScope = createWorkspaceAccessScope({
      userId: "user-1",
      organizationId: "org-1",
      role: "client",
    });
    expect(
      queryClient.getQueryState(["part-detail", "part-1", accessScope]),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(["part-detail", "job-1", accessScope]),
    ).toEqual(createPartDetail());
  });

  it("uses the global client shell without project-tree prefetch", async () => {
    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(true);

    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByTestId("client-shell")).toBeInTheDocument();
    });

    expect(prefetchProjectPage).not.toHaveBeenCalled();
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

  it("keeps membership refetches ordered while request details are saved", async () => {
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

    const { queryClient } = await renderClientPartOnTab("Request");

    fireEvent.click(screen.getByRole("button", { name: "Save Request" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(api.fetchProjectJobMembershipsByJobIds).toHaveBeenCalledWith(["job-1", "job-2"]);
    });

    const pendingMembershipQuery = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["client-project-job-memberships"] })
      .find((query) => {
        const jobIds = query.queryKey.at(-1);
        return Array.isArray(jobIds) && jobIds.includes("job-2");
      });
    expect(pendingMembershipQuery?.state.fetchStatus).toBe("fetching");

    const resolvedMemberships = [
      { job_id: "job-1", project_id: "project-1" },
      { job_id: "job-2", project_id: "project-1" },
    ];
    deferredMemberships.resolve(resolvedMemberships);

    await waitFor(() => {
      expect(queryClient.getQueryData(pendingMembershipQuery!.queryKey)).toEqual(resolvedMemberships);
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
      expect(api.requestQuote).toHaveBeenCalledWith("job-1", ["xometry"]);
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
    fireEvent.click(await screen.findByRole("button", { name: "Review what will be shared" }));
    const sendButton = await screen.findByRole("button", { name: "Send to 1 vendor" });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(api.requestQuote).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(sendButton).toBeDisabled();
    });

    deferred.reject(new Error("Request failed"));

    await waitFor(() => {
      expect(sendButton).toBeEnabled();
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

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });

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

    await screen.findByRole("heading", { name: "BRKT-001 rev A" });
    expect(screen.queryByRole("button", { name: /favorite part/i })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f" });

    await waitFor(() => {
      expect(api.pinJob).toHaveBeenCalledWith("job-1");
    });
  });

  it("keeps favorite state in the overflow menu instead of duplicating it in the header", async () => {
    api.fetchSidebarPins.mockResolvedValueOnce({ projectIds: [], jobIds: ["job-1"] });

    renderWithClient("/parts/job-1");

    expect(await screen.findByRole("menuitem", { name: /unfavorite f/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unfavorite part/i })).not.toBeInTheDocument();
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

  it("keeps the active parent project available in the part workspace", async () => {
    api.fetchAccessibleProjects.mockResolvedValueOnce([
      {
        project: {
          id: "project-1",
          name: "QB00001",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValueOnce([
      {
        job_id: "job-1",
        project_id: "project-1",
        project: {
          id: "project-1",
          name: "QB00001",
          partCount: 1,
        },
      },
    ]);
    api.fetchPartDetailByJobId.mockResolvedValueOnce(
      createPartDetail({
        projectIds: ["project-1"],
      }),
    );

    renderWithClient("/parts/job-1");

    const projectLink = await screen.findByRole("link", { name: "QB00001" });

    expect(projectLink).toHaveAttribute("href", "/projects/project-1");
    expect(screen.queryByRole("button", { name: "QB00001" })).not.toBeInTheDocument();
    expect(lastShellProps?.title).toBe("BRKT-001 rev A");
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
      expect(screen.getByRole("button", { name: /more part actions/i })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /more part actions/i }));
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

    await renderClientPartOnTab();
    expect(await screen.findByTitle("bracket.pdf PDF preview")).toHaveAttribute("src", "blob:part-drawing-pdf");
    expect(storedFile.loadStoredPdfObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        original_name: "bracket.pdf",
        mime_type: "text/plain",
      }),
    );
    expect(screen.queryByText("PDF-1.4")).not.toBeInTheDocument();
  });

  it("keeps the PDF preview usable when optional extracted page images fail", async () => {
    storedFile.loadStoredDrawingPreviewPages.mockRejectedValueOnce(new Error("preview asset unavailable"));
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

    await renderClientPartOnTab();

    expect(await screen.findByTitle("bracket.pdf PDF preview")).toHaveAttribute(
      "src",
      "blob:part-drawing-pdf",
    );
    await waitFor(() => {
      expect(storedFile.loadStoredDrawingPreviewPages).toHaveBeenCalled();
    });
    expect(toastMock.error).not.toHaveBeenCalled();
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

    await renderClientPartOnTab();
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

  it("preserves unsaved request edits until a process patch refresh is acknowledged", async () => {
    const updateRequest = createDeferredPromise<void>();
    const baseDetail = createPartDetail();
    let persistedDescription = "Bracket";
    let persistedProcess: string | null = null;
    const cadFile = {
      id: "cad-file-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad" as const,
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "org-1/job-1/bracket.step",
      normalized_name: "bracket.step",
      original_name: "bracket.step",
      mime_type: "application/step",
      size_bytes: 1024,
      content_sha256: "hash",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-01T00:00:00Z",
    };
    const buildPersistedDetail = () =>
      createPartDetail({
        files: [cadFile],
        part: {
          ...baseDetail.part,
          cadFile,
          clientRequirement: {
            description: persistedDescription,
            partNumber: "BRKT-001",
            revision: "A",
            material: "6061-T6 aluminum",
            finish: null,
            tightestToleranceInch: null,
            process: persistedProcess,
            notes: null,
            quantity: 10,
            quoteQuantities: [10],
            requestedByDate: "2026-04-15",
          },
        },
      });
    api.fetchPartDetailByJobId.mockImplementation(async () => buildPersistedDetail());
    api.updateClientPartRequest.mockImplementationOnce(async (input) => {
      await updateRequest.promise;
      persistedProcess = input.process;
    });

    const { queryClient } = renderWithClient("/parts/job-1");

    fireEvent.change(await screen.findByLabelText("Description"), {
      target: { value: "Pending unsaved description" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "CNC milling" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-1",
          process: "CNC milling",
          description: "Bracket",
        }),
      );
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Newer unsaved description" },
    });

    const fetchCountBeforeUnrelatedRefresh = api.fetchPartDetailByJobId.mock.calls.length;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["part-detail"] });
    });

    expect(api.fetchPartDetailByJobId.mock.calls.length).toBeGreaterThan(
      fetchCountBeforeUnrelatedRefresh,
    );
    expect(screen.getByLabelText("Description")).toHaveValue("Newer unsaved description");

    await act(async () => updateRequest.resolve());

    await waitFor(() => {
      expect(screen.getByLabelText("Description")).toHaveValue("Newer unsaved description");
    });

    persistedDescription = "Server description after acknowledgement";
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["part-detail"] });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Description")).toHaveValue(
        "Server description after acknowledgement",
      );
    });
  });

  it("serializes a field reset after a pending partial save", async () => {
    const baseDetail = createPartDetail();
    let persistedDescription: string | null = "Bracket";
    let resolvePatchRequest: (() => void) | null = null;
    const buildPersistedDetail = () =>
      createPartDetail({
        part: {
          ...baseDetail.part,
          clientRequirement: {
            description: persistedDescription,
            partNumber: "BRKT-001",
            revision: "A",
            material: "6061-T6 aluminum",
            finish: null,
            tightestToleranceInch: null,
            process: "CNC milling",
            notes: null,
            quantity: 10,
            quoteQuantities: [10],
            requestedByDate: "2026-04-15",
          },
        },
      });
    api.fetchPartDetailByJobId.mockImplementation(async () => buildPersistedDetail());
    api.updateClientPartRequest.mockImplementationOnce(
      (input) =>
        new Promise<void>((resolve) => {
          resolvePatchRequest = () => {
            persistedDescription = input.description;
            resolve();
          };
        }),
    );
    api.resetClientPartPropertyOverrides.mockImplementationOnce(async () => {
      persistedDescription = "Extracted bracket description";
    });

    renderWithClient("/parts/job-1");

    fireEvent.change(await screen.findByLabelText("Description"), {
      target: { value: "Pending stale description" },
    });
    fireEvent.change(screen.getByLabelText("Need by date"), {
      target: { value: "2026-04-22" },
    });
    await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Keep this unsaved sourcing note" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset description" }));
    expect(api.resetClientPartPropertyOverrides).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatchRequest?.();
    });

    await waitFor(() => {
      expect(api.resetClientPartPropertyOverrides).toHaveBeenCalledWith({
        jobId: "job-1",
        fields: ["description"],
      });
      expect(screen.getByLabelText("Description")).toHaveValue("Extracted bracket description");
      expect(screen.getByLabelText("Notes")).toHaveValue("Keep this unsaved sourcing note");
    });
    expect(persistedDescription).toBe("Extracted bracket description");
  });

  it("restores unrelated draft edits when a single-field reset fails", async () => {
    const baseDetail = createPartDetail();
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        part: {
          ...baseDetail.part,
          clientRequirement: {
            description: "Bracket",
            partNumber: "BRKT-001",
            revision: "A",
            material: "6061-T6 aluminum",
            finish: null,
            tightestToleranceInch: null,
            process: "CNC milling",
            notes: null,
            quantity: 10,
            quoteQuantities: [10],
            requestedByDate: "2026-04-15",
          },
        },
      }),
    );
    api.resetClientPartPropertyOverrides.mockRejectedValueOnce(new Error("Reset failed"));

    renderWithClient("/parts/job-1");

    fireEvent.change(await screen.findByLabelText("Notes"), {
      target: { value: "Keep this unsaved sourcing note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset description" }));

    await waitFor(() => {
      expect(api.resetClientPartPropertyOverrides).toHaveBeenCalledWith({
        jobId: "job-1",
        fields: ["description"],
      });
      expect(screen.getByLabelText("Description")).toHaveValue("Bracket");
      expect(screen.getByLabelText("Notes")).toHaveValue("Keep this unsaved sourcing note");
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

  it("preserves iOS app mode after account sign-out completes", async () => {
    renderWithClient("/parts/job-1?app=ios");

    await screen.findByText("Account Menu");
    expect(lastAccountMenuProps?.onSignedOut).toEqual(expect.any(Function));

    act(() => {
      (lastAccountMenuProps?.onSignedOut as () => void)();
    });

    expect(screen.getByTestId("location-path")).toHaveTextContent("/");
    expect(screen.getByTestId("location-search")).toHaveTextContent("?app=ios");
  });
});
