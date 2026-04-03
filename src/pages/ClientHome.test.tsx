import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientHome from "./ClientHome";

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
    children,
    showSidebar = true,
    sidebarContent,
    sidebarFooter,
  }: {
    children: ReactNode;
    showSidebar?: boolean;
    sidebarContent?: ReactNode;
    sidebarFooter?: ReactNode;
  }) => (
    <div>
      {showSidebar ? <div>{sidebarContent}</div> : null}
      <div>{children}</div>
      {showSidebar ? <div>{sidebarFooter}</div> : null}
    </div>
  ),
}));

vi.mock("@/components/chat/WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div>Sidebar</div>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => <div>Account menu</div>,
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

vi.mock("@/features/notifications/use-workspace-notifications", () => ({
  useWorkspaceNotifications: () => null,
}));

const useClientHomeControllerMock = vi.fn();

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: () => useClientHomeControllerMock(),
}));

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: "project-1",
    created_by: "user-1",
    title: "Q1 Bracket",
    description: "Primary bracket",
    status: "published",
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
    updated_at: "2026-03-02T00:00:00Z",
    ...overrides,
  };
}

function createControllerState(overrides: Record<string, unknown> = {}) {
  const jobs = (overrides.accessibleJobs as ReturnType<typeof makeJob>[] | undefined) ?? [makeJob()];

  return {
    activeMembership: { role: "client", organizationId: "org-1", organizationName: "Client Org" },
    archivedJobsQuery: { data: [], isLoading: false },
    archivedProjectsQuery: { data: [], isLoading: false },
    authDialogMode: "sign-in",
    composerRef: { current: null },
    handleAssignPartToProject: vi.fn(),
    handleArchivePart: vi.fn(),
    handleArchiveProject: vi.fn(),
    handleComposerSubmit: vi.fn(),
    handleCreateProjectFromSelection: vi.fn(),
    handleDeleteArchivedParts: vi.fn(),
    handleDissolveProject: vi.fn(),
    handlePinPart: vi.fn(),
    handlePinProject: vi.fn(),
    handleRemovePartFromProject: vi.fn(),
    handleRenameProject: vi.fn(),
    handleUnarchivePart: vi.fn(),
    handleUnpinPart: vi.fn(),
    handleUnpinProject: vi.fn(),
    isAuthDialogOpen: false,
    isAuthInitializing: false,
    isSearchOpen: false,
    navigate: vi.fn(),
    newJobFilePicker: {
      accept: "",
      handleFileInputChange: vi.fn(),
      inputRef: { current: null },
      openFilePicker: vi.fn(),
    },
    openAuth: vi.fn(),
    prefetchPart: vi.fn(),
    prefetchProject: vi.fn(),
    projectCollaborationUnavailable: false,
    resolveSidebarProjectIdsForJob: vi.fn(() => []),
    setIsAuthDialogOpen: vi.fn(),
    setIsSearchOpen: vi.fn(),
    sidebarPinsQuery: { data: { projectIds: [], jobIds: [] } },
    sidebarProjects: [
      {
        id: "project-1",
        name: "Q1 Brackets",
        partCount: 2,
        createdAt: "2026-03-01T00:00:00Z",
        updatedAt: "2026-03-03T00:00:00Z",
      },
    ],
    signOut: vi.fn(),
    summariesByJobId: new Map([
      [
        "job-1",
        {
          jobId: "job-1",
          partNumber: "BRKT-001",
          revision: "A",
          description: "Main bracket",
          requestedServiceKinds: ["manufacturing_quote"],
          primaryServiceKind: "manufacturing_quote",
          serviceNotes: null,
          quantity: 10,
          requestedQuoteQuantities: [10],
          requestedByDate: "2026-04-15",
          importedBatch: null,
          selectedSupplier: null,
          selectedPriceUsd: null,
          selectedLeadTimeBusinessDays: null,
        },
      ],
    ]),
    user: { id: "user-1", email: "client@example.com" },
    accessibleJobs: jobs,
    accessibleJobsQuery: {
      data: jobs,
      isLoading: false,
    },
    ...overrides,
  };
}

describe("ClientHome", () => {
  beforeEach(() => {
    useClientHomeControllerMock.mockReturnValue(createControllerState());
  });

  it("renders returning-user action cards with direct project navigation", () => {
    render(<ClientHome />);

    expect(screen.getByText("Keep projects moving with the next highest-impact action.")).toBeInTheDocument();
    expect(screen.getByText("Parts awaiting your decision (1)")).toBeInTheDocument();
    expect(screen.getByText("Recently active projects")).toBeInTheDocument();
    expect(screen.getAllByText("Q1 Brackets").length).toBeGreaterThan(0);
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    expect(screen.queryByText("Upload your first part package to get started.")).not.toBeInTheDocument();
  });

  it("shows onboarding-first guidance when no projects exist", () => {
    useClientHomeControllerMock.mockReturnValue(
      createControllerState({
        sidebarProjects: [],
        accessibleJobs: [makeJob()],
      }),
    );

    render(<ClientHome />);

    expect(screen.getByText("Upload your first part package to get started.")).toBeInTheDocument();
    expect(screen.queryByText(/Parts awaiting your decision/)).not.toBeInTheDocument();
  });

  it("counts only published jobs without a selected offer as awaiting decision", () => {
    useClientHomeControllerMock.mockReturnValue(
      createControllerState({
        accessibleJobs: [
          makeJob({ id: "job-awaiting-1", title: "Awaiting 1", selected_vendor_quote_offer_id: null, status: "published" }),
          makeJob({ id: "job-awaiting-2", title: "Awaiting 2", selected_vendor_quote_offer_id: null, status: "published" }),
          makeJob({ id: "job-selected", title: "Selected", selected_vendor_quote_offer_id: "offer-1", status: "published" }),
          makeJob({ id: "job-quoting", title: "Quoting", selected_vendor_quote_offer_id: null, status: "quoting" }),
          makeJob({ id: "job-client-selected", title: "Client Selected", selected_vendor_quote_offer_id: "offer-2", status: "client_selected" }),
        ],
      }),
    );

    render(<ClientHome />);

    expect(screen.getByText("Parts awaiting your decision (2)")).toBeInTheDocument();
  });
});
