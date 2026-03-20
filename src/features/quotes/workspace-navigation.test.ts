import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prefetchPartPage,
  prefetchProjectPage,
  workspaceQueryKeys,
} from "@/features/quotes/workspace-navigation";

const {
  fetchPartDetailByJobId,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProject,
  isProjectNotFoundError,
  resolveClientPartDetailRoute,
} = vi.hoisted(() => ({
  fetchPartDetailByJobId: vi.fn(),
  fetchClientQuoteWorkspaceByJobIds: vi.fn(),
  fetchJobsByProject: vi.fn(),
  fetchProject: vi.fn(),
  isProjectNotFoundError: vi.fn(),
  resolveClientPartDetailRoute: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => ({
  fetchPartDetailByJobId,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProject,
  isProjectNotFoundError,
  resolveClientPartDetailRoute,
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchPartDetailByJobId,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProject,
  isProjectNotFoundError,
  resolveClientPartDetailRoute,
}));

describe("workspace navigation prefetch", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("prefetches project detail, project jobs, and quote workspace with matching keys", async () => {
    const project = { id: "project-1", name: "Project One" };
    const jobs = [{ id: "job-2", title: "Job Two" }];
    const workspaceItems = [{ job: { id: "job-2" } }];

    fetchProject.mockResolvedValue(project);
    fetchJobsByProject.mockResolvedValue(jobs);
    fetchClientQuoteWorkspaceByJobIds.mockResolvedValue(workspaceItems);

    await prefetchProjectPage(queryClient, "project-1");

    expect(queryClient.getQueryData(workspaceQueryKeys.project("project-1"))).toEqual(project);
    expect(queryClient.getQueryData(workspaceQueryKeys.projectJobs("project-1"))).toEqual(jobs);
    expect(
      queryClient.getQueryData(workspaceQueryKeys.clientQuoteWorkspace(["job-2"])),
    ).toEqual(workspaceItems);
    expect(fetchClientQuoteWorkspaceByJobIds).toHaveBeenCalledWith(["job-2"]);
  });

  it("prefetches part detail with the route query key", async () => {
    const detail = { job: { id: "job-1" } };
    resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "job-1",
      jobId: "job-1",
      source: "job",
    });
    fetchPartDetailByJobId.mockResolvedValue(detail);

    await prefetchPartPage(queryClient, "job-1");

    expect(queryClient.getQueryData(workspaceQueryKeys.partDetail("job-1"))).toEqual(detail);
  });

  it("skips duplicate part prefetches while cached data is still fresh", async () => {
    resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "job-1",
      jobId: "job-1",
      source: "job",
    });
    fetchPartDetailByJobId.mockResolvedValue({ job: { id: "job-1" } });

    await prefetchPartPage(queryClient, "job-1");
    await prefetchPartPage(queryClient, "job-1");

    expect(fetchPartDetailByJobId).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes legacy part-id prefetches onto the owning job key", async () => {
    const detail = { job: { id: "job-1" } };
    resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "part-1",
      jobId: "job-1",
      source: "part",
    });
    fetchPartDetailByJobId.mockResolvedValue(detail);

    await prefetchPartPage(queryClient, "part-1");

    expect(queryClient.getQueryData(workspaceQueryKeys.partDetail("job-1"))).toEqual(detail);
    expect(queryClient.getQueryState(workspaceQueryKeys.partDetail("part-1"))).toBeUndefined();
  });

  it("skips remote prefetch for virtual seeded projects", async () => {
    await prefetchProjectPage(queryClient, "seed-qb00001");

    expect(fetchProject).not.toHaveBeenCalled();
    expect(fetchJobsByProject).not.toHaveBeenCalled();
    expect(fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });

  it("evicts stale project queries when the prefetched project no longer exists", async () => {
    const notFound = new Error("Project not found.");
    fetchProject.mockRejectedValue(notFound);
    fetchJobsByProject.mockResolvedValue([{ id: "job-2", title: "Job Two" }]);
    isProjectNotFoundError.mockReturnValue(true);

    await prefetchProjectPage(queryClient, "project-missing");

    await waitFor(() => {
      expect(queryClient.getQueryState(workspaceQueryKeys.project("project-missing"))).toBeUndefined();
      expect(queryClient.getQueryState(workspaceQueryKeys.projectJobs("project-missing"))).toBeUndefined();
    });
    expect(fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });
});
