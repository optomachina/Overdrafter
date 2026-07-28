import type { QueryClient, QueryFunction, QueryKey } from "@tanstack/react-query";
import type { JobRecord } from "@/features/quotes/types";
import {
  fetchClientQuoteWorkspaceByJobIds,
  fetchPartDetailByJobId,
  fetchJobsByProject,
  fetchProject,
  isProjectNotFoundError,
  resolveClientPartDetailRoute,
} from "@/features/quotes/api/workspace-access";

export const WORKSPACE_SHARED_STALE_TIME_MS = 30_000;
export const WORKSPACE_DETAIL_STALE_TIME_MS = 45_000;
export const WORKSPACE_GC_TIME_MS = 10 * 60 * 1000;

export type WorkspaceAccessScope = string;

export function createWorkspaceAccessScope({
  userId,
  organizationId,
  role,
}: {
  userId?: string | null;
  organizationId?: string | null;
  role?: string | null;
}): WorkspaceAccessScope {
  return JSON.stringify([
    userId?.trim() || null,
    organizationId?.trim() || null,
    role?.trim() || null,
  ]);
}

export function stableJobIds(jobIds: string[]): string[] {
  return [...new Set(jobIds)].sort((left, right) => left.localeCompare(right));
}

export function isVirtualProjectId(projectId: string): boolean {
  return projectId.startsWith("seed-");
}

export const workspaceQueryKeys = {
  clientProjects: (accessScope: WorkspaceAccessScope) =>
    ["client-projects", accessScope] as const,
  clientJobs: (accessScope: WorkspaceAccessScope) =>
    ["client-jobs", accessScope] as const,
  clientPartSummaries: (jobIds: string[], accessScope: WorkspaceAccessScope) =>
    [
      "client-part-summaries",
      accessScope,
      stableJobIds(jobIds),
    ] as const,
  clientProjectJobMemberships: (
    jobIds: string[],
    accessScope: WorkspaceAccessScope,
  ) =>
    [
      "client-project-job-memberships",
      accessScope,
      stableJobIds(jobIds),
    ] as const,
  sidebarPins: (accessScope: WorkspaceAccessScope) =>
    ["sidebar-pins", accessScope] as const,
  archivedProjects: (accessScope: WorkspaceAccessScope) =>
    ["archived-projects", accessScope] as const,
  archivedJobs: (accessScope: WorkspaceAccessScope) =>
    ["archived-jobs", accessScope] as const,
  project: (projectId: string, accessScope: WorkspaceAccessScope) =>
    ["project", projectId, accessScope] as const,
  projectJobs: (projectId: string, accessScope: WorkspaceAccessScope) =>
    ["project-jobs", projectId, accessScope] as const,
  projectAssignees: (projectId: string, accessScope: WorkspaceAccessScope) =>
    [
      "project-assignees",
      projectId,
      accessScope,
    ] as const,
  clientQuoteWorkspace: (
    jobIds: string[],
    accessScope: WorkspaceAccessScope,
  ) =>
    [
      "client-quote-workspace",
      accessScope,
      stableJobIds(jobIds),
    ] as const,
  clientActivity: (jobIds: string[], accessScope: WorkspaceAccessScope) =>
    [
      "client-activity",
      accessScope,
      stableJobIds(jobIds),
    ] as const,
  partDetailRoute: (routeId: string, accessScope: WorkspaceAccessScope) =>
    [
      "part-detail-route",
      routeId,
      accessScope,
    ] as const,
  partDetail: (jobId: string, accessScope: WorkspaceAccessScope) =>
    ["part-detail", jobId, accessScope] as const,
};

function shouldPrefetchQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  staleTime: number,
): boolean {
  const state = queryClient.getQueryState(queryKey);

  if (!state) {
    return true;
  }

  if (state.fetchStatus === "fetching") {
    return false;
  }

  if (typeof state.data === "undefined") {
    return true;
  }

  return Date.now() - state.dataUpdatedAt > staleTime;
}

async function maybePrefetchQuery<T>(
  queryClient: QueryClient,
  options: {
    queryKey: QueryKey;
    queryFn: QueryFunction<T>;
    staleTime: number;
  },
): Promise<T | undefined> {
  if (!shouldPrefetchQuery(queryClient, options.queryKey, options.staleTime)) {
    return queryClient.getQueryData<T>(options.queryKey);
  }

  await queryClient.prefetchQuery({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    staleTime: options.staleTime,
    gcTime: WORKSPACE_GC_TIME_MS,
  });

  return queryClient.getQueryData<T>(options.queryKey);
}

export async function prefetchProjectPage(
  queryClient: QueryClient,
  projectId: string,
  options: {
    enabled?: boolean;
    accessScope: WorkspaceAccessScope;
  },
): Promise<void> {
  if (options.enabled === false || isVirtualProjectId(projectId)) {
    return;
  }

  const projectKey = workspaceQueryKeys.project(projectId, options.accessScope);
  const projectJobsKey = workspaceQueryKeys.projectJobs(projectId, options.accessScope);

  if (shouldPrefetchQuery(queryClient, projectKey, WORKSPACE_DETAIL_STALE_TIME_MS)) {
    try {
      const project = await fetchProject(projectId);
      queryClient.setQueryData(projectKey, project);
    } catch (error) {
      if (!isProjectNotFoundError(error)) {
        throw error;
      }

      queryClient.removeQueries({ queryKey: projectKey, exact: true });
      queryClient.removeQueries({ queryKey: projectJobsKey, exact: true });
      return;
    }
  }

  let prefetchedJobs: JobRecord[] | undefined;

  try {
    prefetchedJobs = await maybePrefetchQuery<JobRecord[]>(queryClient, {
        queryKey: projectJobsKey,
        queryFn: () => fetchJobsByProject(projectId),
        staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
      });
  } catch (error) {
    if (!isProjectNotFoundError(error)) {
      throw error;
    }

    queryClient.removeQueries({ queryKey: projectKey, exact: true });
    queryClient.removeQueries({ queryKey: projectJobsKey, exact: true });
    return;
  }

  const jobs = prefetchedJobs ?? queryClient.getQueryData<JobRecord[]>(projectJobsKey) ?? [];
  const projectJobIds = stableJobIds(jobs.map((job) => job.id));

  if (projectJobIds.length === 0) {
    return;
  }

  await maybePrefetchQuery(queryClient, {
    queryKey: workspaceQueryKeys.clientQuoteWorkspace(
      projectJobIds,
      options.accessScope,
    ),
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(projectJobIds),
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  });
}

export async function prefetchPartPage(
  queryClient: QueryClient,
  routeId: string,
  options: { accessScope: WorkspaceAccessScope },
): Promise<void> {
  const resolvedRoute = await maybePrefetchQuery(queryClient, {
    queryKey: workspaceQueryKeys.partDetailRoute(routeId, options.accessScope),
    queryFn: () => resolveClientPartDetailRoute(routeId),
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  });

  if (!resolvedRoute) {
    queryClient.removeQueries({
      queryKey: workspaceQueryKeys.partDetail(routeId, options.accessScope),
      exact: true,
    });
    return;
  }

  if (resolvedRoute.jobId !== routeId) {
    queryClient.removeQueries({
      queryKey: workspaceQueryKeys.partDetail(routeId, options.accessScope),
      exact: true,
    });
  }

  await maybePrefetchQuery(queryClient, {
    queryKey: workspaceQueryKeys.partDetail(
      resolvedRoute.jobId,
      options.accessScope,
    ),
    queryFn: () => fetchPartDetailByJobId(resolvedRoute.jobId),
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  });
}
