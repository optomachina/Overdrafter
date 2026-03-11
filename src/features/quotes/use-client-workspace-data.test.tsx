import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateClientWorkspaceQueries,
  useWarmClientWorkspaceNavigation,
} from "@/features/quotes/use-client-workspace-data";

const { prefetchPartPage, prefetchProjectPage } = vi.hoisted(() => ({
  prefetchPartPage: vi.fn(),
  prefetchProjectPage: vi.fn(),
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

function QueryProvider({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

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
        created_by: "user-1",
        title: "Standalone part",
        description: null,
        status: "uploaded",
        source: "client_home",
        active_pricing_policy_id: null,
        tags: [],
        created_at: "2026-03-05T12:00:00.000Z",
        updated_at: "2026-03-05T12:30:00.000Z",
      },
    ],
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
