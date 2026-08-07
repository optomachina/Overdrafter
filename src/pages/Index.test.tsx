import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "@/features/quotes/types";
import Index from "./Index";

const guestLandingHeading = /files in\.\s*parts out\./i;
const guestLandingBody =
  /upload CAD files and drawings to collect vendor quotes, compare price and lead time, and choose the best source for your budget and deadline/i;

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: () => <div data-testid="anonymous-quote-chart" />,
}));

const mockUseAppSession = vi.fn();
const mockFetchCommercialAdminAccess = vi.hoisted(() => vi.fn());
const mockFetchAccessibleProjects = vi.fn();
const mockFetchAccessibleJobs = vi.fn();
const mockFetchArchivedJobs = vi.fn();
const mockFetchArchivedProjects = vi.fn();
const mockFetchUngroupedParts = vi.fn();
const mockFetchJobPartSummariesByJobIds = vi.fn();
const mockFetchProjectJobMembershipsByJobIds = vi.fn();
const mockFetchSidebarPins = vi.fn();
const mockIsProjectNotFoundError = vi.fn<(error: unknown) => boolean>(() => false);

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/features/quotes/api/commercial-admin-access-api", () => ({
  fetchCommercialAdminAccess: mockFetchCommercialAdminAccess,
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/features/quotes/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/quotes/api")>();

  return {
    ...actual,
    createSelfServiceOrganization: vi.fn(),
    fetchAccessibleProjects: (...args: unknown[]) => mockFetchAccessibleProjects(...args),
    fetchAccessibleJobs: (...args: unknown[]) => mockFetchAccessibleJobs(...args),
    fetchUngroupedParts: (...args: unknown[]) => mockFetchUngroupedParts(...args),
    fetchJobPartSummariesByJobIds: (...args: unknown[]) => mockFetchJobPartSummariesByJobIds(...args),
    fetchProjectJobMembershipsByJobIds: (...args: unknown[]) => mockFetchProjectJobMembershipsByJobIds(...args),
  };
});
vi.mock("@/features/quotes/api/session-access", () => ({
  createSelfServiceOrganization: vi.fn(),
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleProjects: (...args: unknown[]) => mockFetchAccessibleProjects(...args),
  fetchAccessibleJobs: (...args: unknown[]) => mockFetchAccessibleJobs(...args),
  fetchArchivedJobs: (...args: unknown[]) => mockFetchArchivedJobs(...args),
  fetchArchivedProjects: (...args: unknown[]) => mockFetchArchivedProjects(...args),
  fetchJobPartSummariesByJobIds: (...args: unknown[]) => mockFetchJobPartSummariesByJobIds(...args),
  fetchProjectJobMembershipsByJobIds: (...args: unknown[]) => mockFetchProjectJobMembershipsByJobIds(...args),
  fetchSidebarPins: (...args: unknown[]) => mockFetchSidebarPins(...args),
  isProjectNotFoundError: (error: unknown) => mockIsProjectNotFoundError(error),
}));
vi.mock("@/features/quotes/api/jobs-api", () => ({
  fetchUngroupedParts: (...args: unknown[]) => mockFetchUngroupedParts(...args),
}));

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-dmrifles",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Sample job",
    description: null,
    status: "uploaded",
    source: "client_home",
    tags: [],
    active_pricing_policy_id: null,
    requested_quote_quantities: [1],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-03T19:00:00Z",
    updated_at: "2026-03-03T19:00:00Z",
    ...overrides,
  } as JobRecord;
}

function ClientPartsLocationProbe() {
  const location = useLocation();

  return (
    <>
      <div>Parts Collection</div>
      <div data-testid="parts-location-search">{location.search}</div>
      <div data-testid="parts-location-hash">{location.hash}</div>
    </>
  );
}

function renderIndex(initialEntry = "/") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/parts" element={<ClientPartsLocationProbe />} />
          <Route
            path="/internal/commercial"
            element={<div>Commercial Accounts</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Index client home", () => {
  beforeEach(() => {
    mockFetchCommercialAdminAccess.mockResolvedValue({
      hasCapability: false,
      hasAal2: false,
    });
    mockFetchAccessibleProjects.mockResolvedValue([]);
    mockFetchAccessibleJobs.mockResolvedValue([]);
    mockFetchArchivedJobs.mockResolvedValue([]);
    mockFetchArchivedProjects.mockResolvedValue([]);
    mockFetchUngroupedParts.mockResolvedValue([]);
    mockFetchJobPartSummariesByJobIds.mockResolvedValue([]);
    mockFetchProjectJobMembershipsByJobIds.mockResolvedValue([]);
    mockFetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the public manufacturing workflow landing", async () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      isLoading: false,
      isVerifiedAuth: false,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign up for free/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /get started free/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: guestLandingHeading })).toBeInTheDocument();
    expect(screen.getByText(guestLandingBody)).toBeInTheDocument();
    expect(screen.getByText(/launch scope · machined aluminum · STEP \+ PDF/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /multiple quotes\. one obvious tradeoff/i })).toBeInTheDocument();
    expect(await screen.findByTestId("anonymous-quote-chart")).toBeInTheDocument();
    expect(screen.getByText(/how it works/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /drop your part package/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /compare and choose the best fit/i })).toBeInTheDocument();
  });

  it("routes an established client workspace to the parts collection", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: {
        id: "membership-1",
        role: "client",
        organizationId: "org-1",
        organizationName: "Client Org",
        organizationSlug: "client-org",
      },
      isLoading: false,
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });
    mockFetchAccessibleProjects.mockResolvedValue([
      {
        project: {
          id: "project-1",
          name: "Bracket Project",
          organization_id: "org-1",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
        partCount: 1,
        inviteCount: 0,
        currentUserRole: "owner",
      },
    ]);
    mockFetchAccessibleJobs.mockResolvedValue([
      makeJob({
        id: "job-1",
        project_id: "project-1",
        title: "Bracket",
      }),
    ]);
    mockFetchUngroupedParts.mockResolvedValue([]);
    mockFetchJobPartSummariesByJobIds.mockResolvedValue([]);

    renderIndex();

    await waitFor(() => {
      expect(screen.getByText("Parts Collection")).toBeInTheDocument();
    });
  });

  it("preserves the query and hash when redirecting a client to parts", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: {
        id: "membership-1",
        role: "client",
        organizationId: "org-1",
        organizationName: "Client Org",
        organizationSlug: "client-org",
      },
      isLoading: false,
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });

    renderIndex("/?app=ios&source=native#quote");

    await waitFor(() => {
      expect(screen.getByText("Parts Collection")).toBeInTheDocument();
    });
    expect(screen.getByTestId("parts-location-search")).toHaveTextContent("?app=ios&source=native");
    expect(screen.getByTestId("parts-location-hash")).toHaveTextContent("#quote");
  });

  it("holds the shell in auth restoration while auth is still unknown", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      isLoading: true,
      isVerifiedAuth: false,
      isAuthInitializing: true,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.getByText("Restoring your workspace.")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });
  it("renders the client home while membership recovery continues for an authenticated user", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: null,
      isLoading: true,
      isVerifiedAuth: true,
      isAuthInitializing: true,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.queryByText("Restoring your workspace.")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Keep projects moving with the next highest-impact action.")).toBeInTheDocument();
    });
  });

  it("routes a capability-only administrator into commercial operations", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isLoading: false,
      isVerifiedAuth: true,
      isAuthInitializing: false,
      signOut: vi.fn(),
    });
    mockFetchCommercialAdminAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: false,
    });

    renderIndex();

    expect(
      await screen.findByText("Commercial Accounts"),
    ).toBeInTheDocument();
  });

  it("fails closed with a retry when commercial access cannot be checked", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isLoading: false,
      isVerifiedAuth: true,
      isAuthInitializing: false,
      signOut: vi.fn(),
    });
    mockFetchCommercialAdminAccess
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue({
        hasCapability: true,
        hasAal2: false,
      });

    renderIndex();

    expect(
      await screen.findByText("Commercial access could not be checked"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Keep projects moving with the next highest-impact action."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText("Commercial Accounts"),
    ).toBeInTheDocument();
  });

  it("holds the route on auth restoration while a restorable session is still initializing", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      isLoading: true,
      isVerifiedAuth: false,
      isAuthInitializing: true,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.getByText("Restoring your workspace.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: guestLandingHeading })).not.toBeInTheDocument();
  });
});
