import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAccessScope } from "@/features/quotes/workspace-navigation";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import { deriveFanoutApprovalReference } from "@/features/quotes/provider-fanout-dispatch";
import ClientPart from "./ClientPart";

const {
  api,
  mockQuoteCollectionMode,
  mockQuantityScope,
  mockUseAppSession,
  mockUsePartDeadline,
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
    getFoundingBetaAccess: vi.fn(),
    acceptFoundingBetaNotice: vi.fn(),
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
    getXometryBetaDispatchScope: vi.fn(),
    getProviderDispatchScope: vi.fn(),
    getProviderFanoutGuards: vi.fn(),
    fetchJobVendorPreferenceContext: vi.fn(),
    requestQuote: vi.fn(),
    requestXometryBetaDispatch: vi.fn(),
    requestProviderDispatch: vi.fn(),
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
    // Mirrors useQuoteAccess: "unknown" while loading, refetching or errored.
    state: "eligible" as "eligible" | "blocked" | "unknown",
    hasAutomaticEntitlement: true,
    isLoading: false,
    plan: "pro",
    setAutomaticEnabled: vi.fn(),
    refresh: vi.fn(),
  },
  mockQuantityScope: {
    status: "single_only" as "loading" | "single_only" | "multiple_allowed" | "unavailable",
  },
  mockUseAppSession: vi.fn(),
  mockUsePartDeadline: vi.fn(),
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
  getXometryBetaDispatchScope: api.getXometryBetaDispatchScope,
  getProviderDispatchScope: api.getProviderDispatchScope,
  getProviderFanoutGuards: api.getProviderFanoutGuards,
  requestManualQuote: api.requestQuote,
  requestQuote: api.requestQuote,
  requestXometryBetaDispatch: api.requestXometryBetaDispatch,
  requestProviderDispatch: api.requestProviderDispatch,
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
vi.mock("@/features/quotes/quote-access", () => ({
  useQuoteAccess: () => mockQuoteCollectionMode,
}));
// The server read behind the single Quantity field (OVD-997) is controlled per test.
vi.mock("@/features/quotes/quantity-scope", () => ({
  useQuantityScope: () => mockQuantityScope,
}));
// Enrollment is explicit fixture data; it must never make a real RPC from this
// page suite. Success, non-enrollment, and unavailable cases are covered below.
vi.mock("@/features/quotes/api/founding-beta-api", () => ({
  getFoundingBetaAccess: api.getFoundingBetaAccess,
  acceptFoundingBetaNotice: api.acceptFoundingBetaNotice,
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

vi.mock("@/features/quotes/use-part-deadline", () => ({
  usePartDeadline: (...args: unknown[]) => mockUsePartDeadline(...args),
}));

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
    activePreset,
    deadline,
    requestedByDate,
    controls,
    headerActions,
    onSelect,
  }: {
    requestedByDate?: string | null;
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
    activePreset?: string | null;
    deadline?: { date: string | null; state: string } | null;
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
      activePreset,
      deadline,
      requestedByDate,
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
    scope,
    requestedByDate,
    disabled,
    dueDateHelpText,
    onScopeChange,
    onModeChange,
    onRequestedByDateChange,
  }: {
    scope?: "domestic" | "global";
    requestedByDate?: string | null;
    disabled?: boolean;
    dueDateHelpText?: string;
    onScopeChange?: (next: "domestic" | "global") => void;
    onModeChange?: (next: "balanced" | "cheapest" | "fastest") => void;
    onRequestedByDateChange?: (next: string | null) => void;
  }) => (
    <div data-testid="quote-selection-function-bar">
      <label htmlFor="mock-due-by">Need by date</label>
      <input
        id="mock-due-by"
        aria-label="Need by date"
        value={requestedByDate ?? ""}
        disabled={disabled}
        onChange={(event) => onRequestedByDateChange?.(event.target.value || null)}
      />
      <span data-testid="need-by-help-text">{dueDateHelpText}</span>
      <button type="button" disabled={disabled} onClick={() => onRequestedByDateChange?.(null)}>
        Clear
      </button>
      <button
        type="button"
        onClick={() => onScopeChange?.(scope === "domestic" ? "global" : "domestic")}
      >
        {scope === "domestic" ? "US-only sourcing" : "All sourcing"}
      </button>
      {onModeChange ? (
        <>
          <button type="button" onClick={() => onModeChange("fastest")}>Fast</button>
          <button type="button" onClick={() => onModeChange("cheapest")}>Cheap</button>
        </>
      ) : null}
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
  fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
  for (const checkbox of await screen.findAllByRole("checkbox")) {
    fireEvent.click(checkbox);
  }
  fireEvent.click(await screen.findByRole("button", { name: "Confirm & queue Xometry quote" }));
}

function createXometryDispatchScope() {
  return {
    organizationId: "org-1",
    jobId: "job-1",
    partId: "part-1",
    provider: "xometry" as const,
    requestedQuantity: 1,
    scopeVersion: 1,
    scopeFingerprint: "a".repeat(64),
    declaredModelUnits: "inch" as const,
    policyRevision: "founding-beta-2026-08-15",
    envelopeRevision: "xometry-controlled-beta-envelope.v1",
    scope: {
      schema: "quote-lane-scope.v1" as const,
      vendor: "xometry" as const,
      quantity: 1,
      destination: { confirmationRevision: "1", street: "123 Test Ave", city: "Tucson", region: "AZ", postalCode: "85701", country: "US", state: "confirmed" as const },
      part: {
        id: "part-1",
        cad: {
          fileId: "cad-1",
          sha256: "b".repeat(64),
          name: "BRKT-001.step",
          mimeType: "model/step",
          sizeBytes: 1024,
        },
        drawing: null,
      },
      requirements: {
        id: "requirements-1",
        capturedAt: "2026-08-15T00:00:00Z",
        description: "Bracket",
        partNumber: "BRKT-001",
        revision: "A",
        material: "6061-T6 aluminum",
        finish: "As machined",
        tightestToleranceInch: 0.005,
        requestedDeliveryDate: null,
        specification: { process: "CNC milling" },
      },
    },
  };
}

function renderPartControllerHook() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = renderHook(({ jobId }) => useClientPartController(jobId, { warmNavigation: false }), {
    initialProps: { jobId: "job-1" },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
    ),
  });
  return { ...rendered, queryClient };
}

/** A part detail with one live Xometry offer (`offer-1`), selected by the given stored offer id. */
function createLiveOfferPartDetail(liveTimestamp: string, selectedOfferId: string | null = "offer-1") {
  const base = createPartDetail();
  return createPartDetail({
    job: { ...base.job, selected_vendor_quote_offer_id: selectedOfferId },
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
  });
}

/**
 * A saved request that carries the kinds of field a full save could rewrite
 * (Notes, quantity, Quote quantities, Need by date), optionally with Threads
 * already saved and/or thread callouts read from the drawing.
 */
function createNeedByRequestDetail(options: { savedThreads?: string; drawingThreads?: string[] } = {}) {
  const detail = createLiveOfferPartDetail(new Date().toISOString());
  return {
    ...detail,
    part: {
      ...detail.part,
      extraction: options.drawingThreads
        ? ({ id: "extraction-1", extraction: { threads: options.drawingThreads }, warnings: [] } as never)
        : null,
      approvedRequirement: {
        ...detail.part.approvedRequirement,
        spec_snapshot: {
          process: "CNC milling",
          notes: "Deburr all edges",
          ...(options.savedThreads ? { threads: options.savedThreads } : {}),
        },
      },
    },
  };
}

const THREADED_DRAWING = ["1/4-20 UNC-2B", "M6x1.0-6H"];

/** The scope check denial a PostgREST RPC returns: a plain record, not an Error. */
function scopeDenial(message: string) {
  return { code: "P0001", details: null, hint: null, message };
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

/** A manufacturing-quote part with trusted CAD and approved requirements, ready for confirmation. */
function createDispatchReadyPartDetail(applicableVendors: string[]) {
  return createPartDetail({
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
        applicable_vendors: applicableVendors,
        spec_snapshot: {},
        approved_at: "2026-03-01T00:00:00Z",
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T00:00:00Z",
      },
    },
    revisionSiblings: [],
  });
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
    mockQuoteCollectionMode.state = "eligible";
    mockQuoteCollectionMode.isLoading = false;
    mockQuoteCollectionMode.hasAutomaticEntitlement = true;
    mockQuoteCollectionMode.plan = "pro";
    mockQuantityScope.status = "single_only";
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
      isVerifiedAuth: true,
      activeMembership: { organizationId: "org-1", role: "client" },
      signOut: vi.fn(),
    });

    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(false);
    api.getFoundingBetaAccess.mockRejectedValue(new Error("Synthetic beta-access lookup unavailable"));
    api.acceptFoundingBetaNotice.mockRejectedValue(new Error("Unexpected notice acceptance in ClientPart fixture"));
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
    api.getXometryBetaDispatchScope.mockResolvedValue(createXometryDispatchScope());
    api.requestXometryBetaDispatch.mockResolvedValue({
      accepted: true,
      created: true,
      deduplicated: false,
      permitId: "permit-1",
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
      scopeFingerprint: "a".repeat(64),
      status: "queued",
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

  it.each(["eligible", "not_enrolled", "unavailable"] as const)(
    "uses explicit upload enrollment fixture state: %s", async (state) => {
      if (state !== "unavailable") {
        api.getFoundingBetaAccess.mockResolvedValue({ state, policyRevision: "founding-beta-2026-08-15",
          termsPath: "/legal/beta-terms", privacyPath: "/legal/privacy" });
      }
      renderWithClient("/parts/job-1");
      const upload = await screen.findByRole("button", { name: "Upload part files" });
      await waitFor(() => expect(api.getFoundingBetaAccess).toHaveBeenCalledWith("org-1"));
      const input = screen.getByLabelText("Attach files to part");
      const click = vi.spyOn(input, "click").mockImplementation(() => {});
      fireEvent.click(upload);
      if (state === "eligible") {
        await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
        expect(toastMock.error).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
        expect(click).not.toHaveBeenCalled();
      }
      expect(api.uploadFilesToJob).not.toHaveBeenCalled();
      expect(api.acceptFoundingBetaNotice).not.toHaveBeenCalled();
    },
  );

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
    expect(screen.getByRole("button", { name: "Quote" })).toBeDisabled();
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
      createLiveOfferPartDetail(liveTimestamp),
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

  describe("Need by display filter inside the controlled envelope (OVD-981)", () => {
    it("re-ranks the options by the view date without writing the request", async () => {
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString()));
      const { result, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      // The saved 2026-04-15 date is met by the fixture's offer (ships 2026-03-10).
      expect(result.current.quoteViewRequestedByDate).toBe("2026-04-15");
      expect(result.current.rankedQuoteOptions.every((option) => option.dueDateEligible)).toBe(true);

      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      expect(result.current.quoteViewRequestedByDate).toBe("2000-01-01");
      expect(result.current.requestSummaryRequestedByDate).toBe("2026-04-15");
      expect(result.current.rankedQuoteOptions.some((option) => option.dueDateEligible)).toBe(false);

      act(() => result.current.handleNeedByFilterChange(null));
      expect(result.current.quoteViewRequestedByDate).toBeNull();
      expect(result.current.rankedQuoteOptions.every((option) => option.dueDateEligible)).toBe(true);
      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      queryClient.clear();
    });

    it("drops the view date when the part changes", async () => {
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString()));
      const { result, rerender, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      expect(result.current.quoteViewRequestedByDate).toBe("2000-01-01");

      rerender({ jobId: "job-2" });
      await waitFor(() => expect(result.current.quoteViewRequestedByDate).toBe("2026-04-15"));
      queryClient.clear();
    });

    it("ranks published quote options by the view date, not the saved one (OVD-991)", async () => {
      const detail = createLiveOfferPartDetail(new Date().toISOString());
      api.fetchPartDetailByJobId.mockResolvedValue({
        ...detail,
        publishedQuoteOptions: [
          {
            id: "published-option-1",
            package_id: "published-package-1",
            organization_id: "org-1",
            option_kind: "lowest_cost",
            label: "Lowest Cost",
            requested_quantity: 10,
            published_price_usd: 125,
            lead_time_business_days: 8,
            comparison_summary: "Best published price.",
            source_vendor_quote_id: "quote-1",
            source_vendor_quote_offer_id: "offer-1",
            markup_policy_version: "v1_markup_20",
            created_at: "2026-03-02T00:00:00Z",
          },
        ],
      });
      const { result, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      // Published pricing replaces the live offers, and the saved 2026-04-15 date is met.
      expect(result.current.rankedQuoteOptions.map((option) => option.key)).toEqual(["published:published-option-1"]);
      expect(result.current.rankedQuoteOptions.every((option) => option.dueDateEligible)).toBe(true);

      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      expect(result.current.rankedQuoteOptions.map((option) => option.key)).toEqual(["published:published-option-1"]);
      expect(result.current.rankedQuoteOptions.some((option) => option.dueDateEligible)).toBe(false);

      act(() => result.current.handleNeedByFilterChange(null));
      expect(result.current.rankedQuoteOptions.every((option) => option.dueDateEligible)).toBe(true);
      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      queryClient.clear();
    });

    it.each([
      ["while access is loading or refetching", { state: "unknown", isLoading: true }],
      ["when access could not be verified", { state: "unknown", isLoading: false }],
      ["when access is blocked but still refetching", { state: "blocked", isLoading: true }],
      ["when access is eligible", { state: "eligible", isLoading: false }],
    ] as const)("stays view only %s (OVD-991)", async (_label, access) => {
      mockQuoteCollectionMode.automaticEnabled = access.state === "eligible" && !access.isLoading;
      mockQuoteCollectionMode.state = access.state;
      mockQuoteCollectionMode.isLoading = access.isLoading;
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString()));
      const { result, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      expect(result.current.needByFilterIsViewOnly).toBe(true);
      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      expect(result.current.quoteViewRequestedByDate).toBe("2000-01-01");
      expect(result.current.requestSummaryRequestedByDate).toBe("2026-04-15");
      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      queryClient.clear();
    });

    it("persists the filter only when access is blocked and settled (OVD-991)", async () => {
      mockQuoteCollectionMode.automaticEnabled = false;
      mockQuoteCollectionMode.state = "blocked";
      mockQuoteCollectionMode.isLoading = false;
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString()));
      const { result, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      expect(result.current.needByFilterIsViewOnly).toBe(false);
      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      await waitFor(() =>
        expect(api.updateClientPartRequest).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: "job-1", requestedByDate: "2000-01-01" }),
        ),
      );
      queryClient.clear();
    });

    it("turns view only again when blocked access is refetched after a dispatch (OVD-991)", async () => {
      mockQuoteCollectionMode.automaticEnabled = false;
      mockQuoteCollectionMode.state = "blocked";
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString()));
      const { result, rerender, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));
      expect(result.current.needByFilterIsViewOnly).toBe(false);

      // The access check restarts: the hook reports "unknown" and loading until it settles.
      mockQuoteCollectionMode.state = "unknown";
      mockQuoteCollectionMode.isLoading = true;
      rerender({ jobId: "job-1" });
      expect(result.current.needByFilterIsViewOnly).toBe(true);
      act(() => result.current.handleNeedByFilterChange("2000-01-01"));
      expect(result.current.quoteViewRequestedByDate).toBe("2000-01-01");
      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      queryClient.clear();
    });
  });

  describe("single Quantity field (OVD-997)", () => {
    /** A saved request at the given quantities; a saved [1] is the case where a changed Qty used to be discarded. */
    function createSavedQuantitiesDetail(quantities: number[]) {
      const detail = createPartDetail();
      const [quantity] = quantities;
      return {
        ...detail,
        job: { ...detail.job, requested_quote_quantities: quantities },
        summary: { ...detail.summary, quantity, requestedQuoteQuantities: quantities },
        part: {
          ...detail.part,
          quantity,
          approvedRequirement: { ...detail.part.approvedRequirement, quantity, quote_quantities: quantities },
        },
      };
    }
    const createSavedQuantityOneDetail = () => createSavedQuantitiesDetail([1]);

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("is off by default: the controller offers no single Quantity state and saves the typed list as before", async () => {
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      expect(result.current.singleQuantity).toBeUndefined();

      act(() => {
        result.current.setQuoteQuantityInput("10/25");
      });
      act(() => {
        result.current.handleSaveRequest();
      });

      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        quantity: 10,
        requestedQuoteQuantities: [10, 25],
      });
    });

    it.each([
      ["1,000/2,000", [1000, 2000]], ["0,500/10", [500, 10]], ["10,25,50", [10, 25, 50]],
    ])("saves valid Quote quantities %j without truncation", async (text, quantities) => {
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      act(() => result.current.setQuoteQuantityInput(text as string));
      act(() => result.current.handleSaveRequest());
      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        requestedQuoteQuantities: quantities,
      });
    });

    it.each([
      "12.5", "250,500", "100,250,500", "1,000", "1,250 2,500", "1,250, 2,500",
      "2,500 7,500", "100,250 500", "1,500,25/50", "1,500, 2,500 / 5,000",
      "1,500,25", "25,1,500", "10,25,1,500", "2,500,10", "12,500,5", "10,25,500",
      "1000,250", "1234,567", "1,500,250", "1,500", "1,500, 25", "1,500 ,25",
      "10 1,250,", "10,25,500/50", "1234,567/50", "10/12.5", "12.5/25", "1,0", "x 40",
    ])("rejects Quote quantities %j without a save or success toast", async (text) => {
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      act(() => result.current.setQuoteQuantityInput(text));
      await act(async () => result.current.handleSaveRequest());
      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      expect(toastMock.error).toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it("saves [5] when only Quantity changed from a saved [1], for a participant the server scoped", async () => {
      vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
      mockQuantityScope.status = "multiple_allowed";
      api.fetchPartDetailByJobId.mockResolvedValue(createSavedQuantityOneDetail());
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.requestedQuoteQuantities).toEqual([1]));
      expect(result.current.singleQuantity).toEqual({ allowAboveOne: true, loading: false, unavailable: false });

      act(() => {
        result.current.handleDraftChange({ quantity: 5 });
      });
      act(() => {
        result.current.handleSaveRequest();
      });

      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        jobId: "job-1",
        quantity: 5,
        requestedQuoteQuantities: [5],
      });
    });

    it("saves exactly one quantity even when several were saved, ignoring the hidden Quote quantities text", async () => {
      vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
      mockQuantityScope.status = "multiple_allowed";
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      act(() => {
        result.current.setQuoteQuantityInput("10/25/50");
      });

      act(() => {
        result.current.handleSaveRequest();
      });

      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        quantity: 10,
        requestedQuoteQuantities: [10],
      });
    });

    it("fixes the saved quantity at 1 when the server did not scope a larger quantity", async () => {
      vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
      mockQuantityScope.status = "single_only";
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      expect(result.current.singleQuantity).toEqual({ allowAboveOne: false, loading: false, unavailable: false });

      act(() => {
        result.current.handleSaveRequest();
      });

      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        quantity: 1,
        requestedQuoteQuantities: [1],
      });
    });

    it("keeps the saved quantities when the scope read is unavailable, instead of writing 1", async () => {
      vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
      mockQuantityScope.status = "unavailable";
      api.fetchPartDetailByJobId.mockResolvedValue(createSavedQuantitiesDetail([25, 50]));
      const { result } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.requestedQuoteQuantities).toEqual([25, 50]));
      expect(result.current.singleQuantity).toEqual({ allowAboveOne: false, loading: false, unavailable: true });

      act(() => {
        result.current.handleSaveRequest();
      });

      await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
      expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
        jobId: "job-1",
        quantity: 25,
        requestedQuoteQuantities: [25, 50],
      });
    });

    it("does not save while the server answer is pending, and never saves an unusable quantity", async () => {
      vi.stubEnv("VITE_CONTROLLED_BETA_SINGLE_QUANTITY", "1");
      mockQuantityScope.status = "loading";
      const { result, rerender } = renderPartControllerHook();
      await waitFor(() => expect(result.current.effectiveRequestDraft?.quantity).toBe(10));
      expect(result.current.singleQuantity).toEqual({ allowAboveOne: false, loading: true, unavailable: false });
      act(() => {
        result.current.handleSaveRequest();
      });

      mockQuantityScope.status = "multiple_allowed";
      rerender({ jobId: "job-1" });
      act(() => {
        result.current.handleDraftChange({ quantity: 0 });
      });
      act(() => {
        result.current.handleSaveRequest();
      });

      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
    });
  });

  describe("when the stored quote selection is gone", () => {
    const missingSelectionDetail = () => createLiveOfferPartDetail(new Date().toISOString(), "offer-gone");

    it("selects no substitute at the controller level while options still exist", async () => {
      api.fetchPartDetailByJobId.mockResolvedValue(missingSelectionDetail());
      const { result, queryClient } = renderPartControllerHook();

      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));
      expect(result.current.rankedQuoteOptions.some((option) => option.eligible)).toBe(true);
      expect(result.current.selectedQuoteOption).toBeNull();
      expect(result.current.previousQuoteSelectionUnavailable).toBe(true);
      queryClient.clear();
    });

    it("never persists a selection when a preset or the sourcing toggle is applied", async () => {
      api.fetchPartDetailByJobId.mockResolvedValue(missingSelectionDetail());
      const { result, queryClient } = renderPartControllerHook();
      await waitFor(() => expect(result.current.rankedQuoteOptions.length).toBeGreaterThan(0));

      act(() => result.current.handlePresetSelection("cheapest_global"));
      act(() => result.current.handlePresetSelection("balanced_domestic"));

      expect(result.current.activePreset).toBe("balanced_domestic");
      expect(result.current.selectedQuoteOption).toBeNull();
      // TanStack Query runs mutationFn asynchronously, so let it flush before asserting nothing was persisted.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(result.current.activePreset).toBe("balanced_domestic"));
      expect(api.persistClientQuoteSelection).not.toHaveBeenCalled();
      expect(api.setJobSelectedVendorQuoteOffer).not.toHaveBeenCalled();
      queryClient.clear();
    });

    async function findReviewOrderButton(selectedOfferId: string) {
      api.fetchPartDetailByJobId.mockResolvedValue(createLiveOfferPartDetail(new Date().toISOString(), selectedOfferId));
      renderWithClient("/parts/job-1");
      await screen.findByText("Xometry · Standard");
      return screen.getByRole("button", { name: "Review order" });
    }

    it("keeps the Review order button disabled with an accessible reason until a quote is chosen", async () => {
      const button = await findReviewOrderButton("offer-gone");
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Choose a quote to continue");
    });

    it("passes an expired confirmed deadline to the panel as expired with its recorded date", async () => {
      mockUsePartDeadline.mockReturnValue({
        partId: "part-1",
        revision: null,
        recordedDate: "2026-01-15",
        activeDate: null,
        state: "expired",
      });
      await findReviewOrderButton("offer-1");
      expect(lastQuoteDecisionPanelProps?.deadline).toEqual({ date: "2026-01-15", state: "expired" });
    });

    it("rolls the selection back and keeps the error state when persisting a selection fails", async () => {
      const button = await findReviewOrderButton("offer-1");
      expect(button).toBeEnabled();
      const persistedKey = (lastQuoteDecisionPanelProps?.selectedOption as { key: string }).key;
      api.setJobSelectedVendorQuoteOffer.mockRejectedValue(new Error("boom"));
      api.persistClientQuoteSelection.mockRejectedValue(new Error("boom"));

      await act(async () => {
        (lastQuoteDecisionPanelProps?.onSelect as (option: unknown) => void)(null);
      });

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("boom"));
      await waitFor(() => {
        expect((lastQuoteDecisionPanelProps?.selectedOption as { key: string } | null)?.key).toBe(persistedKey);
      });
      expect(screen.getByRole("button", { name: "Review order" })).toBeEnabled();
    });

    it("rolls back an optimistic selection to the persisted one when the persist mutation rejects", async () => {
      const button = await findReviewOrderButton("offer-gone");
      expect(button).toBeDisabled();
      api.persistClientQuoteSelection.mockRejectedValue(new Error("persist failed"));

      await act(async () => {
        const onSelect = lastQuoteDecisionPanelProps?.onSelect as (option: unknown) => void;
        onSelect(lastQuoteDecisionPanelProps?.firstOption);
      });

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("persist failed"));
      await waitFor(() => expect(screen.getByRole("button", { name: "Review order" })).toBeDisabled());
      expect(lastQuoteDecisionPanelProps?.selectedOption).toBeNull();
    });

    it("enables the Review order button when the stored selection is still current", async () => {
      const button = await findReviewOrderButton("offer-1");
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("aria-describedby");
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
                  geographic_origin: "domestic",
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
    fireEvent.click(screen.getByRole("button", { name: "US-only sourcing" }));
    await waitFor(() => {
      expect(lastQuoteDecisionPanelProps?.activePreset).toBe("balanced_global");
    });
    // The sourcing toggle only filters and reorders; it must not persist a hidden winner.
    expect(api.persistClientQuoteSelection).not.toHaveBeenCalled();
    expect(api.setJobSelectedVendorQuoteOffer).not.toHaveBeenCalled();
    api.persistClientQuoteSelection.mockClear();
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
    expect(lastQuoteDecisionPanelProps?.activePreset).toBe("balanced_global");
    expect(api.setJobSelectedVendorQuoteOffer).not.toHaveBeenCalledWith(
      "job-1",
      "offer-imported-1",
    );

    // OVD-571: table order is Cheapest/Fastest on the comparison table; no preset button auto-selects a winner.
    expect(screen.queryByRole("button", { name: "Cheap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Balanced" })).not.toBeInTheDocument();
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

  it("confirms through the generic Fictiv RPCs when the deployment targets Fictiv (OVD-673)", async () => {
    vi.stubEnv("VITE_LIVE_DISPATCH_PROVIDER", "fictiv");
    try {
      const xometryScope = createXometryDispatchScope();
      api.getProviderDispatchScope.mockResolvedValue({
        ...xometryScope,
        provider: "fictiv",
        envelopeRevision: "fictiv-quote-envelope.v1",
        scope: { ...xometryScope.scope, vendor: "fictiv" },
      });
      api.requestProviderDispatch.mockResolvedValue({
        accepted: true,
        created: true,
        deduplicated: false,
        permitId: "permit-1",
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        scopeFingerprint: "a".repeat(64),
        status: "queued",
      });
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["fictiv"]));

      renderWithClient("/parts/job-1");

      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
      const confirm = await screen.findByRole("button", { name: "Confirm & queue Fictiv quote" });
      for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
      fireEvent.click(confirm);

      await waitFor(() => {
        expect(api.requestProviderDispatch).toHaveBeenCalledWith({
          jobId: "job-1",
          provider: "fictiv",
          declaredModelUnits: "inch",
          expectedScopeFingerprint: "a".repeat(64),
          noticeRevision: "founding-beta-2026-08-15",
          expectedEnvelopeRevision: "fictiv-quote-envelope.v1",
          approvalReference: expect.any(String),
        });
      });
      expect(api.getProviderDispatchScope).toHaveBeenCalledWith("job-1", "fictiv", "inch");
      expect(api.getXometryBetaDispatchScope).not.toHaveBeenCalled();
      expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * The server's Xometry provider set rule (OVD-762 draft): without a fan out
   * marker Xometry must be the only enabled provider; with one, the marker
   * must name Xometry and another provider, all of them enabled. The blanket
   * successful scope mock used to hide this rule from the fan out tests.
   */
  function xometryProviderSetRefusal(enabledVendors: string[], marker: readonly string[] | null | undefined) {
    if (!marker) {
      return enabledVendors.length === 1 && enabledVendors[0] === "xometry"
        ? null
        : "xometry_beta_exact_provider_set_required";
    }
    if (!marker.includes("xometry") || marker.length < 2 || new Set(marker).size !== marker.length) {
      return "xometry_beta_fanout_marker_invalid";
    }
    return marker.every((vendor) => enabledVendors.includes(vendor)) ? null : "xometry_beta_exact_provider_set_required";
  }

  function mockFanoutVendors(vendors: string[]) {
    api.fetchJobVendorPreferenceContext.mockResolvedValue({
      availableVendors: vendors,
      projectVendorPreferences: { includedVendors: [], excludedVendors: [] },
      jobVendorPreferences: { includedVendors: vendors, excludedVendors: [] },
    });
    api.getXometryBetaDispatchScope.mockImplementation(
      async (_jobId: string, _units: string, marker?: readonly string[] | null) => {
        const refusal = xometryProviderSetRefusal(vendors, marker);
        if (refusal) throw { message: refusal, code: "P0001" };
        return createXometryDispatchScope();
      },
    );
  }

  /** Accepts a Xometry request only when it passes the same server rule. */
  function mockXometryRequestServerRule(vendors: string[]) {
    api.requestXometryBetaDispatch.mockImplementation(
      async (input: { fanout?: { vendors: readonly string[] } | null }) => {
        const refusal = xometryProviderSetRefusal(vendors, input.fanout?.vendors);
        if (refusal) throw { message: refusal, code: "P0001" };
        return {
          accepted: true,
          created: true,
          deduplicated: false,
          permitId: "permit-xometry",
          quoteRequestId: "request-xometry",
          quoteRunId: "run-xometry",
          scopeFingerprint: "a".repeat(64),
          status: "queued",
        };
      },
    );
  }

  async function confirmXometryDialog() {
    fireEvent.click(await findRequestQuoteButton());
    fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
    const confirm = await screen.findByRole("button", { name: "Confirm & queue Xometry quote" });
    for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
    fireEvent.click(confirm);
  }

  it("keeps the single provider flow when the fan out flag is off", async () => {
    mockFanoutVendors(["xometry"]);
    mockXometryRequestServerRule(["xometry"]);
    api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry"]));

    renderWithClient("/parts/job-1");
    await confirmXometryDialog();

    await waitFor(() => expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1));
    expect(api.getXometryBetaDispatchScope).toHaveBeenCalledWith("job-1", "inch", null);
    expect(api.requestXometryBetaDispatch.mock.calls[0][0].fanout).toBeNull();
    expect(screen.queryByText("Providers for this request")).not.toBeInTheDocument();
    expect(api.getProviderFanoutGuards).not.toHaveBeenCalled();
    expect(api.getProviderDispatchScope).not.toHaveBeenCalled();
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
  });

  it("with the flag off asks for the exact Xometry scope, which the server refuses beside other providers", async () => {
    mockFanoutVendors(["xometry", "fictiv", "sendcutsend"]);
    api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv", "sendcutsend"]));

    renderWithClient("/parts/job-1");
    fireEvent.click(await findRequestQuoteButton());
    fireEvent.click(await screen.findByRole("button", { name: "Inches" }));

    await waitFor(() => expect(api.getXometryBetaDispatchScope).toHaveBeenCalledWith("job-1", "inch", null));
    await expect(api.getXometryBetaDispatchScope.mock.results[0].value).rejects.toMatchObject({
      message: "xometry_beta_exact_provider_set_required",
    });
    expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
    expect(api.getProviderFanoutGuards).not.toHaveBeenCalled();
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
  });

  it("fans one confirmation out to every applicable provider when the flag is on", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    try {
      mockFanoutVendors(["xometry", "fictiv", "protolabs", "sendcutsend", "rapiddirect", "geomiq"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: ["protolabs"],
        exportDeclaration: "not_clean",
        providersAtDailyCap: [],
        quoteRequestBudget: null,
      });
      const xometryScope = createXometryDispatchScope();
      api.getProviderDispatchScope.mockResolvedValue({
        ...xometryScope,
        provider: "fictiv",
        envelopeRevision: "fictiv-quote-envelope.v1",
        scope: { ...xometryScope.scope, vendor: "fictiv" },
      });
      api.requestXometryBetaDispatch.mockRejectedValue({ message: "xometry_beta_rollout_disabled", code: "P0001" });
      api.requestProviderDispatch.mockResolvedValue({
        accepted: true,
        created: true,
        deduplicated: false,
        permitId: "permit-2",
        quoteRequestId: "request-2",
        quoteRunId: "run-2",
        scopeFingerprint: "a".repeat(64),
        status: "queued",
      });
      api.fetchPartDetailByJobId.mockResolvedValue(
        createDispatchReadyPartDetail(["xometry", "fictiv", "protolabs", "sendcutsend", "rapiddirect", "geomiq"]),
      );

      renderWithClient("/parts/job-1");
      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));

      const sent = await screen.findByRole("list", { name: "Providers sent" });
      expect(within(sent).getByText("Xometry")).toBeInTheDocument();
      expect(within(sent).getByText("Fictiv")).toBeInTheDocument();
      const skipped = screen.getByRole("list", { name: "Providers skipped" });
      expect(within(skipped).getByText("Protolabs").parentElement).toHaveTextContent("Switched off");
      expect(within(skipped).getByText("SendCutSend").parentElement).toHaveTextContent("process");
      expect(within(skipped).getByText("RapidDirect").parentElement).toHaveTextContent("export declaration");
      expect(within(skipped).getByText("Geomiq").parentElement).toHaveTextContent("Not offered");
      expect(
        screen.getByRole("checkbox", {
          name: "I am authorized to share these files and requirements with Xometry and Fictiv to request a quote.",
        }),
      ).toBeInTheDocument();

      for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

      // Xometry is denied for a reason other than a changed package, so Fictiv
      // is still sent with its own scope and a reference derived from the
      // customer's confirmation.
      await waitFor(() => {
        expect(api.requestProviderDispatch).toHaveBeenCalledWith({
          jobId: "job-1",
          provider: "fictiv",
          declaredModelUnits: "inch",
          expectedScopeFingerprint: "a".repeat(64),
          noticeRevision: "founding-beta-2026-08-15",
          expectedEnvelopeRevision: "fictiv-quote-envelope.v1",
          approvalReference: expect.any(String),
        });
      });
      const confirmationReference = api.requestXometryBetaDispatch.mock.calls[0][0].approvalReference;
      expect(api.requestProviderDispatch.mock.calls[0][0].approvalReference).toBe(
        await deriveFanoutApprovalReference(confirmationReference, "fictiv"),
      );
      // The Xometry primary reads and requests its scope with the fan out
      // marker; the request names exactly the providers this confirmation reaches.
      expect(api.getXometryBetaDispatchScope).toHaveBeenCalledWith("job-1", "inch", [
        "fictiv",
        "geomiq",
        "protolabs",
        "rapiddirect",
        "sendcutsend",
        "xometry",
      ]);
      expect(api.requestXometryBetaDispatch.mock.calls[0][0].fanout).toEqual({
        confirmationReference,
        vendors: ["fictiv", "xometry"],
      });
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      expect(api.getProviderDispatchScope).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(sent.querySelector('[data-provider="fictiv"]')).toHaveAttribute("data-status", "queued");
      });
      expect(sent.querySelector('[data-provider="xometry"]')).toHaveAttribute("data-status", "denied");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets Xometry join as an extra when Fictiv is the primary", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    vi.stubEnv("VITE_LIVE_DISPATCH_PROVIDER", "fictiv");
    try {
      mockFanoutVendors(["xometry", "fictiv"]);
      mockXometryRequestServerRule(["xometry", "fictiv"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: [],
        exportDeclaration: "clean",
        providersAtDailyCap: [],
        quoteRequestBudget: null,
      });
      const xometryScope = createXometryDispatchScope();
      api.getProviderDispatchScope.mockResolvedValue({
        ...xometryScope,
        provider: "fictiv",
        envelopeRevision: "fictiv-quote-envelope.v1",
        scope: { ...xometryScope.scope, vendor: "fictiv" },
      });
      api.requestProviderDispatch.mockResolvedValue({
        accepted: true,
        created: true,
        deduplicated: false,
        permitId: "permit-fictiv",
        quoteRequestId: "request-fictiv",
        quoteRunId: "run-fictiv",
        scopeFingerprint: "a".repeat(64),
        status: "queued",
      });
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv"]));

      renderWithClient("/parts/job-1");
      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
      const sent = await screen.findByRole("list", { name: "Providers sent" });
      for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Fictiv quote" }));

      await waitFor(() => expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1));
      const confirmationReference = api.requestProviderDispatch.mock.calls[0][0].approvalReference;
      expect(api.getXometryBetaDispatchScope).toHaveBeenCalledWith("job-1", "inch", ["fictiv", "xometry"]);
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledWith({
        jobId: "job-1",
        declaredModelUnits: "inch",
        expectedScopeFingerprint: "a".repeat(64),
        policyRevision: "founding-beta-2026-08-15",
        approvalReference: await deriveFanoutApprovalReference(confirmationReference, "xometry"),
        fanout: { confirmationReference, vendors: ["fictiv", "xometry"] },
      });
      await waitFor(() => {
        expect(sent.querySelector('[data-provider="xometry"]')).toHaveAttribute("data-status", "queued");
      });
      expect(sent.querySelector('[data-provider="fictiv"]')).toHaveAttribute("data-status", "queued");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses locally when the plan leaves Xometry alone beside another enabled provider", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    try {
      mockFanoutVendors(["xometry", "fictiv"]);
      mockXometryRequestServerRule(["xometry", "fictiv"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: ["fictiv"],
        exportDeclaration: "clean",
        providersAtDailyCap: [],
        quoteRequestBudget: null,
      });
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv"]));

      renderWithClient("/parts/job-1");
      await confirmXometryDialog();

      await waitFor(() => {
        expect(toastMock.error).toHaveBeenCalledWith(
          "Xometry can take this request only together with another provider right now.",
        );
      });
      expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
      expect(api.requestProviderDispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("replays an uncertain Xometry fan out request with its original marker after fan out turns off", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    try {
      mockFanoutVendors(["xometry", "fictiv"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: [],
        exportDeclaration: "clean",
        providersAtDailyCap: [],
        quoteRequestBudget: null,
      });
      const xometryScope = createXometryDispatchScope();
      api.getProviderDispatchScope.mockResolvedValue({
        ...xometryScope,
        provider: "fictiv",
        envelopeRevision: "fictiv-quote-envelope.v1",
        scope: { ...xometryScope.scope, vendor: "fictiv" },
      });
      api.requestXometryBetaDispatch.mockRejectedValueOnce(new Error("Request failed"));
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv"]));

      const { queryClient } = renderWithClient("/parts/job-1");
      await confirmXometryDialog();

      expect(await screen.findByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
      const attemptedInput = { ...api.requestXometryBetaDispatch.mock.calls[0][0] };
      expect(attemptedInput.fanout).toEqual({
        confirmationReference: attemptedInput.approvalReference,
        vendors: ["fictiv", "xometry"],
      });

      // Automatic collection turns off, which also turns fan out off.
      mockQuoteCollectionMode.automaticEnabled = false;
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["job-vendor-preferences"] }); });
      fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
      fireEvent.click(await screen.findByRole("button", { name: "Check previous quote request" }));
      mockXometryRequestServerRule(["xometry", "fictiv"]);
      await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

      await waitFor(() => expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(2));
      expect(api.requestXometryBetaDispatch.mock.calls[1][0]).toEqual(attemptedInput);
      expect(await screen.findByText("Xometry quote request queued")).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends no extra provider when the primary is refused because the package changed", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    try {
      mockFanoutVendors(["xometry", "fictiv"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: [],
        exportDeclaration: "clean",
        providersAtDailyCap: [],
        quoteRequestBudget: null,
      });
      // A second tab edited the requirement after this dialog loaded it.
      api.requestXometryBetaDispatch.mockRejectedValue({ message: "xometry_beta_scope_changed", code: "P0001" });
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv"]));

      renderWithClient("/parts/job-1");
      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
      const sent = await screen.findByRole("list", { name: "Providers sent" });
      for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

      await waitFor(() => {
        expect(sent.querySelector('[data-provider="fictiv"]')).toHaveAttribute("data-status", "denied");
      });
      expect(sent.querySelector('[data-provider="fictiv"]')).toHaveTextContent("changed after you reviewed it");
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      expect(api.getProviderDispatchScope).not.toHaveBeenCalled();
      expect(api.requestProviderDispatch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows which extras the per user quote request limit would refuse", async () => {
    vi.stubEnv("VITE_MULTI_PROVIDER_FANOUT", "true");
    try {
      mockFanoutVendors(["xometry", "fictiv", "protolabs"]);
      api.getProviderFanoutGuards.mockResolvedValue({
        killSwitchedProviders: [],
        exportDeclaration: "clean",
        providersAtDailyCap: [],
        quoteRequestBudget: {
          userWindowMinutes: 60,
          userMaxRequestsPerWindow: 5,
          userRequestsRemaining: 2,
          orgPendingCostCeilingUsd: 500,
          costPerLaneUsd: 75,
          orgPendingCostHeadroomUsd: 500,
        },
      });
      api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry", "fictiv", "protolabs"]));

      renderWithClient("/parts/job-1");
      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));

      const sent = await screen.findByRole("list", { name: "Providers sent" });
      expect(within(sent).getByText("Xometry")).toBeInTheDocument();
      expect(within(sent).getByText("Fictiv")).toBeInTheDocument();
      const skipped = screen.getByRole("list", { name: "Providers skipped" });
      expect(within(skipped).getByText("Protolabs").parentElement).toHaveTextContent(
        "You can send 5 quote requests every 60 minutes",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets an eligible Free customer confirm their own request without changing commercial status", async () => {
    mockQuoteCollectionMode.plan = "free";
    mockQuoteCollectionMode.hasAutomaticEntitlement = false;
    api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry"]));

    renderWithClient("/parts/job-1");

    const requestButton = await findRequestQuoteButton();
    fireEvent.click(requestButton);
    fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
    expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();
    for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    expect(mockQuoteCollectionMode.plan).toBe("free");
    expect(mockQuoteCollectionMode.hasAutomaticEntitlement).toBe(false);

    await waitFor(() => {
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-1",
          declaredModelUnits: "inch",
          expectedScopeFingerprint: "a".repeat(64),
          policyRevision: "founding-beta-2026-08-15",
        }),
      );
      expect(api.requestQuote).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["xometry_beta_scope_changed", "The current package was not queued. Review the refreshed scope and try again."],
    ["free_allowance_unavailable", "The current package was not queued. Review the refreshed scope and try again."],
    ["xometry_beta_job_busy", "This part is being updated in another session. Try again in a moment."],
  ])("fails closed and refreshes scope when dispatch is denied: %s", async (reason, expectedToast) => {
    api.requestXometryBetaDispatch.mockRejectedValue(new Error(reason));
    mockQuoteCollectionMode.refresh.mockImplementation(async () => {
      mockQuoteCollectionMode.automaticEnabled = false;
    });

    api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry"]));

    renderWithClient("/parts/job-1");

    await clickRequestQuoteButton();

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(expectedToast);
    });
    await screen.findByText(/current package was not queued/i);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request (manual )?quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check previous quote request" })).not.toBeInTheDocument();
    expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
    expect(api.requestQuote).not.toHaveBeenCalled();
  });

  it.each(["stable", "blocked_after", "blocked_during", "scope_changed", "actor_changed", "actor_changed_after", "unverified_after"])("preserves only same-actor uncertain replay through close and reopen: %s", async (scenario) => {
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

    api.fetchPartDetailByJobId.mockResolvedValue(createDispatchReadyPartDetail(["xometry"]));
    api.requestXometryBetaDispatch.mockReturnValue(deferred.promise);

    const { queryClient } = renderWithClient("/parts/job-1");

    const button = await findRequestQuoteButton();

    expect(button).toBeEnabled();

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
    for (const checkbox of await screen.findAllByRole("checkbox")) {
      fireEvent.click(checkbox);
    }
    const sendButton = await screen.findByRole("button", { name: "Confirm & queue Xometry quote" });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(sendButton).toBeDisabled();
    });
    expect(screen.queryByText("Check previous quote request")).not.toBeInTheDocument();

    if (scenario === "blocked_during" || scenario === "actor_changed") {
      mockQuoteCollectionMode.automaticEnabled = false;
      if (scenario === "actor_changed") {
        const previous = mockUseAppSession.mock.results[mockUseAppSession.mock.results.length - 1].value;
        mockUseAppSession.mockReturnValue({ ...previous, user: { ...previous.user, id: "user-2" } });
      }
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["job-vendor-preferences"] }); });
    }
    await act(async () => { deferred.reject(new Error("Request failed")); });
    if (scenario === "actor_changed") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled());
      expect(screen.queryByText(/could not confirm whether the request was queued/i)).not.toBeInTheDocument();
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
      expect(screen.queryByRole("button", { name: "Check previous quote request" })).not.toBeInTheDocument();
      return;
    }

    expect(await screen.findByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
    expect(screen.queryByText(/queued for worker processing/i)).not.toBeInTheDocument();
    expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
    const attemptedInput = { ...api.requestXometryBetaDispatch.mock.calls[0][0] };
    const approval = attemptedInput.approvalReference;
    if (scenario === "actor_changed_after" || scenario === "unverified_after") {
      const previous = mockUseAppSession.mock.results[mockUseAppSession.mock.results.length - 1].value;
      mockUseAppSession.mockReturnValue({
        ...previous,
        ...(scenario === "actor_changed_after"
          ? { user: { ...previous.user, id: "user-2" } }
          : { isVerifiedAuth: false }),
      });
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["job-vendor-preferences"] }); });
      fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
      expect(screen.queryByRole("button", { name: "Check previous quote request" })).not.toBeInTheDocument();
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      return;
    }
    if (scenario === "blocked_after" || scenario === "scope_changed") {
      api.getXometryBetaDispatchScope.mockResolvedValue({
        ...createXometryDispatchScope(),
        scopeFingerprint: "d".repeat(64),
        policyRevision: "founding-beta-new-policy",
      });
      mockQuoteCollectionMode.refresh.mockImplementation(async () => {
        if (scenario === "blocked_after") mockQuoteCollectionMode.automaticEnabled = false;
      });
      const previousScopeChecks = api.getXometryBetaDispatchScope.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Refresh current scope" }));
      await waitFor(() => expect(api.getXometryBetaDispatchScope.mock.calls.length).toBeGreaterThan(previousScopeChecks));
    }
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (!mockQuoteCollectionMode.automaticEnabled) {
      expect(screen.queryByRole("button", { name: /request (manual )?quote/i })).not.toBeInTheDocument();
    }
    fireEvent.click(await screen.findByRole("button", { name: "Check previous quote request" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.queryByText("d".repeat(64))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inches" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Millimeters" })).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
    }
    expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
    api.requestXometryBetaDispatch.mockResolvedValue({ accepted: true, created: false, deduplicated: true, status: "queued" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    await waitFor(() => expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(2));
    expect(api.requestXometryBetaDispatch.mock.calls[1][0].approvalReference).toBe(approval);
    expect(api.requestXometryBetaDispatch.mock.calls[1][0]).toEqual(attemptedInput);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled());
    expect(await screen.findByText("Xometry quote request queued")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("button", { name: "Check previous quote request" })).not.toBeInTheDocument();
    expect(api.requestQuote).not.toHaveBeenCalled();
  });

  it("does not offer recovery for a blocked confirmation that was never submitted", async () => {
    const { queryClient } = renderWithClient("/parts/job-1?quote=request");
    await screen.findByTestId("part-info-panel");
    fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
    for (const checkbox of await screen.findAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeEnabled();
    mockQuoteCollectionMode.automaticEnabled = false;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["job-vendor-preferences"] }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("button", { name: "Check previous quote request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request (manual )?quote/i })).not.toBeInTheDocument();
    expect(api.requestXometryBetaDispatch).not.toHaveBeenCalled();
    expect(api.requestQuote).not.toHaveBeenCalled();
  });

  it.each(["approvalReference", "declaredModelUnits", "policyRevision", "scopeFingerprint"] as const)(
    "does not use uncertain recovery to admit a changed %s while access is blocked",
    async (changedField) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result, rerender } = renderHook(
        () => useClientPartController("job-1", { warmNavigation: false }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(result.current.partDetail?.job.id).toBe("job-1"));
      const originalInput = {
        approvalReference: "original-approval",
        declaredModelUnits: "inch" as const,
        policyRevision: "founding-beta-2026-08-15",
        scopeFingerprint: "a".repeat(64),
      };
      api.requestXometryBetaDispatch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await act(async () => {
        expect(await result.current.handleRequestQuote(originalInput)).toMatchObject({ status: "unknown" });
      });
      expect(result.current.canRecoverQuoteRequest).toBe(true);
      mockQuoteCollectionMode.automaticEnabled = false;
      rerender();
      const changedInput = {
        ...originalInput,
        ...{
          approvalReference: { approvalReference: "fresh-approval" },
          declaredModelUnits: { declaredModelUnits: "millimeter" as const },
          policyRevision: { policyRevision: "new-policy" },
          scopeFingerprint: { scopeFingerprint: "d".repeat(64) },
        }[changedField],
      };
      await act(async () => {
        expect(await result.current.handleRequestQuote(changedInput)).toMatchObject({ status: "denied" });
      });
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      expect(api.requestQuote).not.toHaveBeenCalled();
      queryClient.clear();
    },
  );

  it("keeps uncertain recovery when the exact replay is refused as busy, but not for a fresh approval", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useClientPartController("job-1", { warmNavigation: false }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.partDetail?.job.id).toBe("job-1"));
    const originalInput = {
      approvalReference: "original-approval",
      declaredModelUnits: "inch" as const,
      policyRevision: "founding-beta-2026-08-15",
      scopeFingerprint: "a".repeat(64),
    };
    api.requestXometryBetaDispatch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      expect(await result.current.handleRequestQuote(originalInput)).toMatchObject({ status: "unknown" });
    });
    expect(result.current.canRecoverQuoteRequest).toBe(true);

    api.requestXometryBetaDispatch.mockRejectedValueOnce(new Error("xometry_beta_job_busy"));
    await act(async () => {
      expect(await result.current.handleRequestQuote({ ...originalInput })).toMatchObject({
        status: "unknown",
        diagnosticCode: "explicit_server_denial",
      });
    });
    expect(result.current.canRecoverQuoteRequest).toBe(true);
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenLastCalledWith("This part is being updated in another session. Try again in a moment.");
    });
    for (const [message] of toastMock.error.mock.calls) {
      expect(String(message)).not.toMatch(/nothing was queued|not queued/i);
    }

    api.requestXometryBetaDispatch.mockRejectedValueOnce(new Error("xometry_beta_job_busy"));
    await act(async () => {
      expect(
        await result.current.handleRequestQuote({ ...originalInput, approvalReference: "fresh-approval" }),
      ).toMatchObject({ status: "denied" });
    });
    expect(result.current.canRecoverQuoteRequest).toBe(false);
    expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(3);
    expect(api.requestXometryBetaDispatch.mock.calls[1][0]).toMatchObject({ approvalReference: "original-approval" });
    expect(api.requestQuote).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it.each(["organization", "job"] as const)(
    "removes uncertain recovery and denies the old approval after the %s changes",
    async (changedIdentity) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result, rerender } = renderHook(
        ({ jobId }) => useClientPartController(jobId, { warmNavigation: false }),
        {
          initialProps: { jobId: "job-1" },
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(result.current.partDetail?.job.id).toBe("job-1"));
      const originalInput = {
        approvalReference: "original-approval",
        declaredModelUnits: "inch" as const,
        policyRevision: "founding-beta-2026-08-15",
        scopeFingerprint: "a".repeat(64),
      };
      api.requestXometryBetaDispatch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await act(async () => {
        expect(await result.current.handleRequestQuote(originalInput)).toMatchObject({ status: "unknown" });
      });
      expect(result.current.canRecoverQuoteRequest).toBe(true);

      mockQuoteCollectionMode.automaticEnabled = false;
      const jobId = changedIdentity === "job" ? "job-2" : "job-1";
      const organizationId = changedIdentity === "organization" ? "org-2" : "org-1";
      const previous = mockUseAppSession.mock.results[mockUseAppSession.mock.results.length - 1].value;
      mockUseAppSession.mockReturnValue({
        ...previous,
        activeMembership: { ...previous.activeMembership, organizationId },
      });
      api.resolveClientPartDetailRoute.mockResolvedValue({ routeId: jobId, jobId, source: "job" });
      const detail = createPartDetail();
      api.fetchPartDetailByJobId.mockResolvedValue(createPartDetail({
        job: { ...detail.job, id: jobId, organization_id: organizationId },
        part: { ...detail.part, job_id: jobId, organization_id: organizationId },
        summary: { ...detail.summary, jobId },
      }));
      rerender({ jobId });
      await waitFor(() => expect(result.current.quoteConfirmationIdentity).toBe(`user-1:${organizationId}:${jobId}`));
      expect(result.current.canRecoverQuoteRequest).toBe(false);

      await act(async () => {
        expect(await result.current.handleRequestQuote(originalInput)).toMatchObject({ status: "denied" });
      });
      expect(result.current.canRecoverQuoteRequest).toBe(false);
      expect(api.requestXometryBetaDispatch).toHaveBeenCalledTimes(1);
      expect(api.requestXometryBetaDispatch.mock.calls[0][0]).toMatchObject({ jobId: "job-1", approvalReference: "original-approval" });
      expect(api.requestQuote).not.toHaveBeenCalled();
      queryClient.clear();
    },
  );

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

  it("saves a due date from the inline function bar once access is known to be blocked", async () => {
    mockQuoteCollectionMode.automaticEnabled = false;
    mockQuoteCollectionMode.state = "blocked";
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("need-by-help-text")).toHaveTextContent("requested delivery date");
    expect(screen.getByTestId("need-by-help-text")).not.toHaveTextContent("view only");

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", requestedByDate: "2026-04-22" }),
      );
    });
    expect(screen.queryByRole("button", { name: "Remove Need by from request" })).toBeNull();
  });

  it("keeps the Need by display filter out of the request while the controlled envelope applies (OVD-981)", async () => {
    renderWithClient("/parts/job-1");

    await waitFor(() => {
      expect(screen.getByTestId("quote-selection-function-bar")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Need by date")).toHaveValue("2026-04-15");

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });

    await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue("2026-04-22"));
    expect(lastQuoteDecisionPanelProps).toMatchObject({ requestedByDate: "2026-04-22" });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue(""));
    expect(api.updateClientPartRequest).not.toHaveBeenCalled();
  });

  it("explains an already saved Need by date and removes it only on request (OVD-981)", async () => {
    renderWithClient("/parts/job-1");

    expect(await screen.findByText(/does not support a Need by date/i)).toBeInTheDocument();
    expect(api.updateClientPartRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Need by from request" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", requestedByDate: null }),
      );
    });
  });

  it("removes the Need by date with a save that changes nothing else (OVD-991)", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(createNeedByRequestDetail({ savedThreads: "1/4-20 UNC-2B" }));
    renderWithClient("/parts/job-1");

    // An unsaved edit in the request form must not ride along with the removal.
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Unsaved note" } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove Need by from request" }));

    await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
    expect(api.updateClientPartRequest.mock.calls[0]).toStrictEqual([
      {
        jobId: "job-1",
        requestedServiceKinds: ["manufacturing_quote"],
        primaryServiceKind: "manufacturing_quote",
        serviceNotes: null,
        description: "Bracket",
        partNumber: "BRKT-001",
        revision: "A",
        material: "6061-T6 aluminum",
        finish: "Black anodize",
        threads: "1/4-20 UNC-2B",
        tightestToleranceInch: 0.005,
        process: "CNC milling",
        notes: "Deburr all edges",
        quantity: 10,
        requestedQuoteQuantities: [10],
        requestedByDate: null,
        shipping: { requestedByDateOverride: null, packagingNotes: null, shippingNotes: null },
        certifications: {
          requiredCertifications: [],
          materialCertificationRequired: null,
          certificateOfConformanceRequired: null,
          inspectionLevel: null,
          notes: null,
        },
        sourcing: {
          regionPreferenceOverride: null,
          preferredSuppliers: [],
          materialProvisioning: null,
          notes: null,
        },
        release: {
          releaseStatus: null,
          reviewDisposition: null,
          quoteBlockedUntilRelease: null,
          notes: null,
        },
      },
    ]);
  });

  it("keeps the saved Need by notice on the request's date while the filter shows another (OVD-991)", async () => {
    renderWithClient("/parts/job-1");

    const notice = await screen.findByRole("region", { name: "Need by date on the request" });
    expect(notice).toHaveTextContent("Apr 15, 2026");

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });
    await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue("2026-04-22"));
    expect(screen.getByRole("region", { name: "Need by date on the request" })).toHaveTextContent("Apr 15, 2026");
    expect(screen.getByRole("region", { name: "Need by date on the request" })).not.toHaveTextContent("Apr 22, 2026");

    // Clearing the filter shows every option but the saved date still blocks dispatch.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue(""));
    expect(screen.getByRole("region", { name: "Need by date on the request" })).toHaveTextContent("Apr 15, 2026");
    expect(api.updateClientPartRequest).not.toHaveBeenCalled();
  });

  it("says in the filter tooltip that it changes the view only when no Need by date is saved (OVD-991)", async () => {
    const base = createPartDetail();
    api.fetchPartDetailByJobId.mockResolvedValue(
      createPartDetail({
        job: { ...base.job, requested_by_date: null },
        summary: { ...base.summary, requestedByDate: null },
      }),
    );
    renderWithClient("/parts/job-1");

    const helpText = await screen.findByTestId("need-by-help-text");
    expect(helpText).toHaveTextContent("in this view only");
    expect(helpText).toHaveTextContent("not saved to the request");
    expect(helpText).not.toHaveTextContent("requested delivery date");
    expect(screen.queryByRole("button", { name: "Remove Need by from request" })).toBeNull();
  });

  describe.each([
    ["is loading or refetching", { state: "unknown", isLoading: true }],
    ["could not be verified", { state: "unknown", isLoading: false }],
    ["is blocked but still refetching", { state: "blocked", isLoading: true }],
  ] as const)("while quote access %s (OVD-991)", (_label, access) => {
    beforeEach(() => {
      mockQuoteCollectionMode.automaticEnabled = false;
      mockQuoteCollectionMode.state = access.state;
      mockQuoteCollectionMode.isLoading = access.isLoading;
    });

    it("keeps the filter view only and never writes the request", async () => {
      renderWithClient("/parts/job-1");

      await screen.findByTestId("quote-selection-function-bar");
      fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });
      await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue("2026-04-22"));
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(screen.getByLabelText("Need by date")).toHaveValue(""));

      expect(api.updateClientPartRequest).not.toHaveBeenCalled();
      expect(screen.getByTestId("need-by-help-text")).toHaveTextContent("in this view only");
    });

    it("keeps the saved Need by notice visible", async () => {
      renderWithClient("/parts/job-1");

      expect(await screen.findByRole("region", { name: "Need by date on the request" })).toHaveTextContent(
        "Apr 15, 2026",
      );
      expect(screen.getByRole("button", { name: "Remove Need by from request" })).toBeInTheDocument();
    });
  });

  it("disables the Need by controls while a request save is pending (OVD-991)", async () => {
    const pendingSave = createDeferredPromise<void>();
    api.updateClientPartRequest.mockReturnValue(pendingSave.promise);
    renderWithClient("/parts/job-1");

    const remove = await screen.findByRole("button", { name: "Remove Need by from request" });
    expect(remove).toBeEnabled();
    expect(screen.getByLabelText("Need by date")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();

    fireEvent.click(remove);

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Need by from request" })).toBeDisabled());
    expect(screen.getByLabelText("Need by date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();

    await act(async () => {
      pendingSave.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Need by from request" })).toBeEnabled());
    expect(screen.getByLabelText("Need by date")).toBeEnabled();
  });

  it("warns that removing Need by also saves the drawing's thread callouts as Threads (OVD-991)", async () => {
    api.fetchPartDetailByJobId.mockResolvedValue(createNeedByRequestDetail({ drawingThreads: THREADED_DRAWING }));
    renderWithClient("/parts/job-1");

    const notice = await screen.findByRole("region", { name: "Need by date on the request" });
    expect(notice).toHaveTextContent("records the thread callouts read from the drawing as Threads");

    // The warning is true: the save sends the callouts as the request's Threads.
    fireEvent.click(screen.getByRole("button", { name: "Remove Need by from request" }));
    await waitFor(() => expect(api.updateClientPartRequest).toHaveBeenCalledTimes(1));
    expect(api.updateClientPartRequest.mock.calls[0]?.[0]).toMatchObject({
      requestedByDate: null,
      threads: "1/4-20 UNC-2B, M6x1.0-6H",
    });
  });

  it.each([
    ["the drawing has no thread callouts", createNeedByRequestDetail()],
    [
      "Threads are already saved on the request",
      createNeedByRequestDetail({ savedThreads: "1/4-20 UNC-2B", drawingThreads: THREADED_DRAWING }),
    ],
  ])("does not warn about Threads when %s (OVD-991)", async (_label, detail) => {
    api.fetchPartDetailByJobId.mockResolvedValue(detail);
    renderWithClient("/parts/job-1");

    const notice = await screen.findByRole("region", { name: "Need by date on the request" });
    expect(notice).not.toHaveTextContent(/thread callouts/i);
  });

  describe("scope denial copy in the confirmation dialog (OVD-991)", () => {
    async function openDeniedScope(denial: string, drawingThreads: string[] | undefined) {
      const detail = createDispatchReadyPartDetail(["fictiv"]);
      api.fetchPartDetailByJobId.mockResolvedValue({
        ...detail,
        part: {
          ...detail.part,
          extraction: drawingThreads
            ? ({ id: "extraction-1", extraction: { threads: drawingThreads }, warnings: [] } as never)
            : null,
        },
      });
      api.getProviderDispatchScope.mockRejectedValue(scopeDenial(denial));

      renderWithClient("/parts/job-1");
      fireEvent.click(await findRequestQuoteButton());
      fireEvent.click(await screen.findByRole("button", { name: "Inches" }));
      return screen.findByRole("alert");
    }

    it.each([
      ["with thread callouts on the drawing", THREADED_DRAWING, true],
      ["without thread callouts", undefined, false],
    ])("names Fictiv, the denied fields and the way out for a saved Need by date %s", async (_label, drawingThreads, hasNote) => {
      vi.stubEnv("VITE_LIVE_DISPATCH_PROVIDER", "fictiv");
      try {
        const alert = await openDeniedScope("provider_dispatch_special_requirements_not_supported", drawingThreads);

        expect(alert).toHaveTextContent("This package is not ready for controlled Fictiv beta dispatch.");
        expect(alert).toHaveTextContent("The controlled Fictiv beta cannot carry a Need by date, Threads, Notes");
        expect(alert).toHaveTextContent("an inspection level other than Standard");
        expect(alert).toHaveTextContent("If this part needs any of them, it is outside the beta.");
        expect(alert).toHaveTextContent("Remove them only if the part does not need them, then retry.");
        expect(alert).not.toHaveTextContent("Xometry");
        expect(alert.textContent?.includes("Thread callouts read from the drawing are saved as Threads")).toBe(hasNote);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("tells a Fictiv customer to remove extra Quote quantities, not to set Qty to 1", async () => {
      vi.stubEnv("VITE_LIVE_DISPATCH_PROVIDER", "fictiv");
      try {
        const alert = await openDeniedScope("provider_dispatch_exact_scope_required", undefined);

        expect(alert).toHaveTextContent("The controlled Fictiv beta quotes one part at one quantity from its approved files.");
        expect(alert).toHaveTextContent("Remove extra Quote quantities so one quantity remains, then retry.");
        expect(alert).toHaveTextContent("contact support");
        expect(alert).not.toHaveTextContent("Qty");
        expect(alert).not.toHaveTextContent("Xometry");
      } finally {
        vi.unstubAllEnvs();
      }
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

  it("clears the inline due date from the function bar once access is known to be blocked", async () => {
    mockQuoteCollectionMode.automaticEnabled = false;
    mockQuoteCollectionMode.state = "blocked";
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

  it("asks for material on a freshly uploaded STEP-only part instead of rejecting launch scope", async () => {
    const detail = createDispatchReadyPartDetail([]);
    api.fetchPartDetailByJobId.mockResolvedValueOnce(createPartDetail({
      ...detail,
      job: { ...detail.job, status: "uploaded" },
      files: [detail.part.cadFile],
      part: {
        ...detail.part,
        approvedRequirement: null,
        clientRequirement: {
          description: "Bracket", partNumber: null, revision: null,
          material: "Unknown material", finish: null, tightestToleranceInch: null,
          process: null, notes: null, quantity: 1, quoteQuantities: [1], requestedByDate: null,
        },
        clientExtraction: {
          lifecycle: "uploaded", hasCadFile: true, hasDrawingFile: false,
          warningCount: 0, warnings: [], missingFields: ["material"], pageCount: 0,
          lastFailureCode: null, lastFailureMessage: null,
          extractedAt: null, failedAt: null, updatedAt: null,
        },
      },
    }));

    await renderClientPartOnTab();
    expect(await screen.findByRole("heading", { name: "Confirm the material" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", {
      name: "This material is outside the launch scope",
    })).not.toBeInTheDocument();
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

    // The draft already shows the newer edit, so waiting on its value cannot observe the
    // acknowledgement. Wait on the acknowledgement itself, inside one act scope: the save reports
    // success only after its own refresh lands, and its per-call onSuccess marks the patch
    // preservation completed in the microtasks that follow. Leaving act then commits that state
    // and flushes the effect that clears the preservation. Refreshing before that commit lets the
    // acknowledgement and the next server refresh land in one commit, which keeps the draft.
    await act(async () => {
      updateRequest.resolve();
      await vi.waitFor(() => {
        expect(toastMock.success).toHaveBeenCalledWith("Request details updated.");
      });
    });
    expect(screen.getByLabelText("Description")).toHaveValue("Newer unsaved description");

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
    // The Need by filter only persists once access is known to be blocked (OVD-981, OVD-991).
    mockQuoteCollectionMode.automaticEnabled = false;
    mockQuoteCollectionMode.state = "blocked";
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

    // Wait on each stage of the serialized pipeline in order instead of asserting its final state
    // inside one real-time window: the pending save settles after its refresh, the queued reset
    // runs, and the reset settles only after it has refreshed and reconciled the draft.
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Request details updated.");
    });
    await waitFor(() => {
      expect(api.resetClientPartPropertyOverrides).toHaveBeenCalledWith({
        jobId: "job-1",
        fields: ["description"],
      });
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Field reset to extracted value.");
    });
    await waitFor(() => {
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

  it("renders the shell without part data while a persisted session is still being verified", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      signOut: vi.fn(),
      isAuthInitializing: true,
      hasCachedSession: true,
    });

    renderWithClient("/parts/job-1");

    expect(screen.getByTestId("client-shell")).toBeInTheDocument();
    expect(screen.queryByText("Restoring your part workspace.")).not.toBeInTheDocument();
    expect(screen.queryByText("Account Menu")).not.toBeInTheDocument();
    expect(api.fetchPartDetailByJobId).not.toHaveBeenCalled();
    expect(api.resolveClientPartDetailRoute).not.toHaveBeenCalled();
    expect(api.fetchAccessibleJobs).not.toHaveBeenCalled();
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
