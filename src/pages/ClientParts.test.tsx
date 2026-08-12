import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientParts from "./ClientParts";

const mockUseClientHomeController = vi.hoisted(() => vi.fn());
const mockUseQuoteIntelligenceWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: () => mockUseClientHomeController(),
}));

vi.mock("@/features/quotes/use-quote-intelligence-workspace", () => ({
  useQuoteIntelligenceWorkspace: () => mockUseQuoteIntelligenceWorkspace(),
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => <div>Account menu</div>,
}));

function RootLocationProbe() {
  const location = useLocation();

  return (
    <div>
      <span>Canonical public landing</span>
      <span data-testid="root-search">{location.search}</span>
      <span data-testid="root-hash">{location.hash}</span>
    </div>
  );
}

describe("ClientParts anonymous routing", () => {
  beforeEach(() => {
    mockUseClientHomeController.mockReturnValue({
      accessibleJobs: [],
      isAuthInitializing: false,
      navigationModel: { partToProjectIds: new Map() },
      sidebarProjects: [],
      summariesByJobId: new Map(),
      user: null,
      workspaceAccessScope: { kind: "anonymous" },
    });
    mockUseQuoteIntelligenceWorkspace.mockReturnValue({
      metadataByJobId: new Map(),
      workspaceQuery: { data: [] },
    });
  });

  it("redirects to the canonical public landing and preserves location state", async () => {
    render(
      <MemoryRouter initialEntries={["/parts?auth=signin#quote-example"]}>
        <Routes>
          <Route path="/" element={<RootLocationProbe />} />
          <Route path="/parts" element={<ClientParts />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Canonical public landing")).toBeInTheDocument();
    expect(screen.getByTestId("root-search")).toHaveTextContent("?auth=signin");
    expect(screen.getByTestId("root-hash")).toHaveTextContent("#quote-example");
  });

  it("describes the initial collection fetch as loading the workspace", () => {
    mockUseClientHomeController.mockReturnValue({
      accessibleJobs: [],
      accessibleJobsQuery: {
        isError: false,
        isLoading: true,
        refetch: vi.fn(),
      },
      activeMembership: null,
      isAuthInitializing: false,
      navigationModel: { partToProjectIds: new Map() },
      newJobFilePicker: {
        accept: "",
        handleFileInputChange: vi.fn(),
        inputRef: { current: null },
        openFilePicker: vi.fn(),
      },
      sidebarProjects: [],
      signOut: vi.fn(),
      summariesByJobId: new Map(),
      user: { id: "user-1", email: "client@example.com" },
      workspaceAccessScope: { kind: "organization", organizationId: "org-1" },
    });

    render(
      <MemoryRouter initialEntries={["/parts"]}>
        <ClientParts />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading workspace…");
  });
});
