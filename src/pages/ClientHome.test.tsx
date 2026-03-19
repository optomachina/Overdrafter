import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import ClientHome from "./ClientHome";

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
    children,
    sidebarContent,
    sidebarFooter,
  }: {
    children: ReactNode;
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
  WorkspaceAccountMenu: () => <div>Account menu</div>,
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/chat/PromptComposer", () => ({
  PromptComposer: React.forwardRef(function PromptComposerMock() {
    return <div>Prompt composer</div>;
  }),
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

vi.mock("@/features/notifications/use-workspace-notifications", () => ({
  useWorkspaceNotifications: () => null,
}));

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: () => ({
    activeMembership: null,
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
      { id: "project-1", name: "Q1 Brackets", partCount: 2 },
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
    accessibleJobsQuery: {
      data: [
        {
          id: "job-1",
          organization_id: "org-1",
          project_id: "project-1",
          created_by: "user-1",
          title: "Bracket",
          description: "Main bracket",
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
          updated_at: "2026-03-02T00:00:00Z",
          selected_vendor_quote_offer_id: null,
        },
      ],
      isLoading: false,
    },
  }),
}));

describe("ClientHome", () => {
  it("renders the signed-in workspace launcher with recent project and part sections", () => {
    render(<ClientHome />);

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Recent projects")).toBeInTheDocument();
    expect(screen.getByText("Recent parts")).toBeInTheDocument();
    expect(screen.getByText("Q1 Brackets")).toBeInTheDocument();
    expect(screen.getByText("BRKT-001 rev A")).toBeInTheDocument();
  });
});
