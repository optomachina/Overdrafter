import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMembership } from "@/features/quotes/types";
import InternalJobDetail from "./InternalJobDetail";

const useAppSessionMock = vi.fn();
const useInternalJobDetailQueryMock = vi.fn();
const useInternalJobDetailViewModelMock = vi.fn();
const useInternalJobDetailMutationsMock = vi.fn();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => useAppSessionMock(),
}));

vi.mock("./internal-job-detail/use-internal-job-detail-query", () => ({
  useInternalJobDetailQuery: (...args: unknown[]) => useInternalJobDetailQueryMock(...args),
}));

vi.mock("./internal-job-detail/internal-job-detail-view-model", () => ({
  useInternalJobDetailViewModel: (...args: unknown[]) => useInternalJobDetailViewModelMock(...args),
}));

vi.mock("./internal-job-detail/use-internal-job-detail-mutations", () => ({
  useInternalJobDetailMutations: (...args: unknown[]) => useInternalJobDetailMutationsMock(...args),
}));

vi.mock("./internal-job-detail/InternalJobOverviewSection", () => ({
  InternalJobOverviewSection: () => <div>Overview</div>,
}));

vi.mock("./internal-job-detail/InternalJobVendorCompareSection", () => ({
  InternalJobVendorCompareSection: () => <div>Vendor compare</div>,
}));

vi.mock("./internal-job-detail/InternalJobWorkerQueueCard", () => ({
  InternalJobWorkerQueueCard: () => <div>Worker queue</div>,
}));

vi.mock("./internal-job-detail/InternalJobDebugSection", () => ({
  InternalJobDebugSection: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="debug-section" data-disabled={disabled ? "true" : "false"} />
  ),
}));

vi.mock("./internal-job-detail/InternalJobRequirementsSection", () => ({
  InternalJobRequirementsSection: ({ writeActionsDisabled }: { writeActionsDisabled: boolean }) => (
    <div data-testid="requirements-section" data-disabled={writeActionsDisabled ? "true" : "false"} />
  ),
}));

vi.mock("./internal-job-detail/InternalJobHeaderActions", () => ({
  InternalJobHeaderActions: ({
    onRequestExtraction,
    onSaveRequirements,
    onStartQuoteRun,
    requestExtractionPending,
    saveRequirementsPending,
    startQuoteRunPending,
    writeActionsDisabled,
  }: {
    onRequestExtraction: () => void;
    onSaveRequirements: () => void;
    onStartQuoteRun: () => void;
    requestExtractionPending: boolean;
    saveRequirementsPending: boolean;
    startQuoteRunPending: boolean;
    writeActionsDisabled: boolean;
  }) => (
    <>
      <button disabled={writeActionsDisabled || requestExtractionPending} onClick={onRequestExtraction}>
        Queue extraction
      </button>
      <button disabled={writeActionsDisabled || saveRequirementsPending} onClick={onSaveRequirements}>
        Save approved requirements
      </button>
      <button disabled={writeActionsDisabled || startQuoteRunPending} onClick={onStartQuoteRun}>
        Start quote run
      </button>
    </>
  ),
}));

vi.mock("./internal-job-detail/InternalJobPublicationCard", () => ({
  InternalJobPublicationCard: ({
    onPublish,
    publishPending,
    writeActionsDisabled,
  }: {
    onPublish: () => void;
    publishPending: boolean;
    writeActionsDisabled: boolean;
  }) => (
    <button disabled={writeActionsDisabled || publishPending} onClick={onPublish}>
      Publish client package
    </button>
  ),
}));

function makeMembership(role: AppMembership["role"], organizationId = "org-1"): AppMembership {
  return {
    id: `membership-${role}`,
    role,
    organizationId,
    organizationName: "Wilson Works",
    organizationSlug: "wilson-works",
  };
}

function renderInternalJobDetail() {
  return render(
    <MemoryRouter initialEntries={["/internal/jobs/job-1"]}>
      <Routes>
        <Route path="/internal/jobs/:jobId" element={<InternalJobDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InternalJobDetail", () => {
  beforeEach(() => {
    useAppSessionMock.mockReturnValue({
      user: { id: "user-1", email: "blaine@example.com" },
      activeMembership: makeMembership("internal_admin"),
      isPlatformAdmin: true,
      isVerifiedAuth: true,
      isAuthInitializing: false,
      signOut: vi.fn(),
    });
    useInternalJobDetailQueryMock.mockReturnValue({
      jobQuery: { isLoading: false, error: null },
      job: {
        job: {
          id: "job-1",
          title: "Widget Block",
          description: null,
          organization_id: "org-2",
        },
        parts: [],
        workQueue: [],
      },
      latestQuoteRun: { id: "quote-run-1" },
      readinessQuery: { data: undefined },
      showDebugTools: false,
    });
    useInternalJobDetailViewModelMock.mockReturnValue({
      cadPreviewSources: new Map(),
      clientSummary: "",
      compareQuantities: [],
      drafts: {},
      getDraftForPart: vi.fn(),
      getQuoteQuantityInput: vi.fn(() => ""),
      latestPackage: null,
      optionKindsByOfferId: {},
      quoteRows: [],
      setActiveCompareRequestedQuantity: vi.fn(),
      setClientSummary: vi.fn(),
      setDraftQuantity: vi.fn(),
      setQuoteQuantityInputs: vi.fn(),
      updateDraft: vi.fn(),
      activeCompareRequestedQuantity: null,
      visibleQuoteRows: [],
      commitQuoteQuantityInput: vi.fn(),
    });
    useInternalJobDetailMutationsMock.mockReturnValue({
      requestExtractionMutation: { isPending: false, mutate: vi.fn() },
      saveRequirementsMutation: { isPending: false, mutate: vi.fn() },
      startQuoteRunMutation: { isPending: false, mutate: vi.fn() },
      publishMutation: { isPending: false, mutate: vi.fn() },
      isRefreshingVerification: false,
      isResendingVerification: false,
      handleRefreshVerification: vi.fn(),
      handleResendVerification: vi.fn(),
      handleChangeEmail: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the read-only God Mode banner and disables write actions for cross-org jobs", () => {
    renderInternalJobDetail();

    expect(screen.getByText("Read-only God Mode")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue extraction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save approved requirements" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start quote run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish client package" })).toBeDisabled();
    expect(screen.getByTestId("requirements-section")).toHaveAttribute("data-disabled", "true");
    expect(screen.getByTestId("debug-section")).toHaveAttribute("data-disabled", "true");
  });

  it("keeps write actions enabled for same-org platform admin inspection", () => {
    useInternalJobDetailQueryMock.mockReturnValue({
      jobQuery: { isLoading: false, error: null },
      job: {
        job: {
          id: "job-1",
          title: "Widget Block",
          description: null,
          organization_id: "org-1",
        },
        parts: [],
        workQueue: [],
      },
      latestQuoteRun: { id: "quote-run-1" },
      readinessQuery: { data: { ready: true, reasons: [] } },
      showDebugTools: false,
    });

    renderInternalJobDetail();

    expect(screen.queryByText("Read-only God Mode")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue extraction" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save approved requirements" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start quote run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish client package" })).toBeEnabled();
    expect(screen.getByTestId("requirements-section")).toHaveAttribute("data-disabled", "false");
    expect(screen.getByTestId("debug-section")).toHaveAttribute("data-disabled", "false");
  });
});
