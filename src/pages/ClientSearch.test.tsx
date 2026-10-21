import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientSearch from "./ClientSearch";
import ClientParts from "./ClientParts";
import ClientQuotes from "./ClientQuotes";
import type { WorkspaceNotificationsController } from "@/features/notifications/use-workspace-notifications";

const useClientHomeControllerMock = vi.fn();
const accountMenuMock = vi.fn();
const fetchActivityMock = vi.fn().mockResolvedValue([]);

vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchClientActivityEventsByJobIds: (...args: unknown[]) => fetchActivityMock(...args),
  fetchPlatformAdminNotifications: vi.fn().mockResolvedValue([]),
}));

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
  filterPartCollection: () => [],
  filterQuoteCollection: () => [],
  parseEngineeringQuery: () => ({ chips: [] }),
}));

vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({ children, accountSlot }: { children: ReactNode; accountSlot: ReactNode }) => <>{accountSlot}{children}</>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: (props: { notificationCenter?: WorkspaceNotificationsController }) => {
    accountMenuMock(props);
    return null;
  },
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

function QueryWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
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
    { wrapper: QueryWrapper },
  );
}

describe("ClientSearch", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("Notification", { permission: "default" });
    useClientHomeControllerMock.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      isAuthInitializing: false,
      accessibleJobs: [{ id: "job-1" }],
      isPlatformAdmin: false,
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

  it.each([
    ["ClientParts", ClientParts],
    ["ClientQuotes", ClientQuotes],
    ["ClientSearch", ClientSearch],
  ])("%s supplies browser permission and client preferences to the account menu", async (_name, Page) => {
    render(<MemoryRouter><Page /></MemoryRouter>, { wrapper: QueryWrapper });

    expect(accountMenuMock).toHaveBeenLastCalledWith(expect.objectContaining({
      notificationCenter: expect.objectContaining({
        browserPermission: "default",
        supportedTypes: ["client.quote_package_ready"],
      }),
    }));
    await waitFor(() => expect(fetchActivityMock).toHaveBeenCalledWith(["job-1"], 12));
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
