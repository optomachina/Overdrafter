import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientSearch from "./ClientSearch";

const useClientHomeControllerMock = vi.fn();

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: () => useClientHomeControllerMock(),
}));

vi.mock("@/features/quotes/use-quote-intelligence-workspace", () => ({
  useQuoteIntelligenceWorkspace: () => ({
    factsByJobId: new Map(),
    metadataByJobId: new Map(),
    workspaceQuery: { isLoading: false },
  }),
}));

vi.mock("@/components/quote-intelligence/useQuoteReferences", () => ({
  useQuoteReferences: () => new Map(),
}));

vi.mock("@/features/quotes/quote-intelligence-view-model", () => ({
  buildGlobalSearchResults: () => [],
  buildPartCollection: () => [],
  buildQuoteCollection: () => [],
  parseEngineeringQuery: () => ({ chips: [] }),
}));

vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => null,
}));

vi.mock("@/components/quote-intelligence/QuoteIntelligenceLanding", () => ({
  QuoteIntelligenceLanding: () => null,
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

function SearchHistoryControls() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <div data-testid="location-search">{location.search}</div>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function renderSearch() {
  return render(
    <MemoryRouter
      initialEntries={["/search?q=first&app=ios", "/search?q=history&app=ios"]}
      initialIndex={1}
    >
      <SearchHistoryControls />
      <Routes>
        <Route path="/search" element={<ClientSearch />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ClientSearch", () => {
  beforeEach(() => {
    useClientHomeControllerMock.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      isAuthInitializing: false,
      accessibleJobs: [],
      accessibleJobsQuery: {
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      },
      sidebarProjects: [],
      summariesByJobId: new Map(),
      navigationModel: { partToProjectIds: new Map() },
      workspaceAccessScope: "user-1:org-1:client",
      newJobFilePicker: {
        accept: "",
        handleFileInputChange: vi.fn(),
        inputRef: { current: null },
        openFilePicker: vi.fn(),
      },
      signOut: vi.fn(),
    });
  });

  it("writes a trimmed query while letting browser history restore the input", async () => {
    renderSearch();

    const input = screen.getByRole("searchbox");
    expect(input).toHaveValue("history");

    fireEvent.change(input, { target: { value: "  local query  " } });

    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent("?q=local+query&app=ios");
    });
    expect(input).toHaveValue("  local query  ");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(input).toHaveValue("first");
      expect(screen.getByTestId("location-search")).toHaveTextContent("?q=first&app=ios");
    });
  });
});
