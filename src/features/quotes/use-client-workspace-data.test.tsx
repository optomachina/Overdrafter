import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateClientWorkspaceQueries,
  useClientWorkspaceData,
  useWarmClientWorkspaceNavigation,
} from "@/features/quotes/use-client-workspace-data";

const {
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
  prefetchPartPage,
  prefetchProjectPage,
} = vi.hoisted(() => ({
  fetchAccessibleJobs: vi.fn(),
  fetchAccessibleProjects: vi.fn(),
  fetchArchivedJobs: vi.fn(),
  fetchArchivedProjects: vi.fn(),
  fetchJobPartSummariesByJobIds: vi.fn(),
  fetchProjectJobMembershipsByJobIds: vi.fn(),
  fetchSidebarPins: vi.fn(),
  prefetchPartPage: vi.fn(),
  prefetchProjectPage: vi.fn(),
}));

vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
}));

vi.mock("@/features/quotes/workspace-navigation", async () => {
  const actual = await vi.importActual<typeof import("@/features/quotes/workspace-navigation")>(
    "@/features/quotes/workspace-navigation",
  );

  return {
    ...actual,
    prefetchPartPage,
    prefetchProjectPage,
  };
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function QueryProvider({ children, queryClient = createQueryClient() }: PropsWithChildren<{ queryClient?: QueryClient }>) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function WarmNavigationProbe() {
  useWarmClientWorkspaceNavigation({
    enabled: true,
    canPrefetchProjects: false,
    projects: [{ id: "project-1" }, { id: "seed-qb00001" }],
    jobs: [
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
        selected_vendor_quote_offer_id: null,
        created_by: "user-1",
        title: "Standalone part",
        description: null,
        status: "uploaded",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [1],
        requested_by_date: null,
        archived_at: null,
        created_at: "2026-03-05T12:00:00.000Z",
        updated_at: "2026-03-05T12:30:00.000Z",
      },
    ],
  });

  return null;
}

function WarmNavigationWithStalePinsProbe() {
  useWarmClientWorkspaceNavigation({
    enabled: true,
    canPrefetchProjects: true,
    projects: [{ id: "project-1" }],
    pinnedProjectIds: ["project-1", "project-missing"],
    jobs: [],
  });

  return null;
}

describe("useWarmClientWorkspaceNavigation", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("skips project warming when remote project prefetch is disabled", () => {
    vi.useFakeTimers();

    render(<WarmNavigationProbe />, { wrapper: QueryProvider });
    vi.advanceTimersByTime(200);

    expect(prefetchProjectPage).not.toHaveBeenCalled();
    expect(prefetchPartPage).toHaveBeenCalledWith(expect.anything(), "job-1");
  });

  it("ignores pinned project ids that are not in the accessible project list", () => {
    vi.useFakeTimers();

    render(<WarmNavigationWithStalePinsProbe />, { wrapper: QueryProvider });
    vi.advanceTimersByTime(200);

    expect(prefetchProjectPage).toHaveBeenCalledTimes(1);
    expect(prefetchProjectPage).toHaveBeenCalledWith(expect.anything(), "project-1");
  });
});

describe("useClientWorkspaceData", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps prior project memberships available while the membership query refetches for a new job set", async () => {
    const queryClient = createQueryClient();
    let jobsResponse = [
      {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
        selected_vendor_quote_offer_id: null,
        created_by: "user-1",
        title: "Bracket",
        description: null,
        status: "uploaded",
        source: "client",
        active_pricing_policy_id: null,
        tags: [],
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [1],
        requested_by_date: null,
        archived_at: null,
        created_at: "2026-03-05T12:00:00.000Z",
        updated_at: "2026-03-05T12:30:00.000Z",
      },
    ];
    let resolveMemberships: ((value: Array<{ job_id: string; project_id: string }>) => void) | null = null;

    fetchAccessibleProjects.mockResolvedValue([]);
    fetchArchivedJobs.mockResolvedValue([]);
    fetchArchivedProjects.mockResolvedValue([]);
    fetchJobPartSummariesByJobIds.mockResolvedValue([]);
    fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    fetchAccessibleJobs.mockImplementation(async () => jobsResponse);
    fetchProjectJobMembershipsByJobIds.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMemberships = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useClientWorkspaceData({
          enabled: true,
          userId: "user-1",
          projectCollaborationUnavailable: false,
        }),
      {
        wrapper: ({ children }) => <QueryProvider queryClient={queryClient}>{children}</QueryProvider>,
      },
    );

    await waitFor(() => {
      expect(fetchProjectJobMembershipsByJobIds).toHaveBeenCalledWith(["job-1"]);
    });

    await act(async () => {
      resolveMemberships?.([{ job_id: "job-1", project_id: "project-1" }]);
    });

    await waitFor(() => {
      expect(result.current.projectJobMemberships).toEqual([{ job_id: "job-1", project_id: "project-1" }]);
    });

    jobsResponse = [
      ...jobsResponse,
      {
        ...jobsResponse[0],
        id: "job-2",
        title: "Plate",
      },
    ];

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["client-jobs"] });
    });

    await waitFor(() => {
      expect(fetchProjectJobMembershipsByJobIds).toHaveBeenCalledWith(["job-1", "job-2"]);
    });

    expect(result.current.projectJobMemberships).toEqual([{ job_id: "job-1", project_id: "project-1" }]);
  });
});

describe("invalidateClientWorkspaceQueries", () => {
  it("includes project membership and invite keys when requested", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined as never);

    await invalidateClientWorkspaceQueries(queryClient, {
      projectId: "project-1",
      jobId: "job-2",
      clientQuoteWorkspaceJobIds: ["job-2", "job-1"],
      includeProjectMemberships: true,
      includeProjectInvites: true,
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project-memberships", "project-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project-invites", "project-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["part-detail", "job-2"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["client-quote-workspace", ["job-1", "job-2"]],
    });
  });
});
