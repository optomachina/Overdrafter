import type { QueryClient, QueryFunction, QueryKey } from "@tanstack/react-query";
import type { JobRecord } from "@/features/quotes/types";
import {
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchPartDetail,
  fetchProject,
} from "@/features/quotes/api";

export const WORKSPACE_SHARED_STALE_TIME_MS = 30_000;
export const WORKSPACE_DETAIL_STALE_TIME_MS = 45_000;
export const WORKSPACE_GC_TIME_MS = 10 * 60 * 1000;

export function stableJobIds(jobIds: string[]): string[] {
  return [...new Set(jobIds)].sort((left, right) => left.localeCompare(right));
}

export function isVirtualProjectId(projectId: string): boolean {
  return projectId.startsWith("seed-");
}

export const workspaceQueryKeys = {
  clientProjects: () => ["client-projects"] as const,
  clientJobs: () => ["client-jobs"] as const,
  clientPartSummaries: (jobIds: string[]) => ["client-part-summaries", stableJobIds(jobIds)] as const,
  clientProjectJobMemberships: (jobIds: string[]) =>
    ["client-project-job-memberships", stableJobIds(jobIds)] as const,
  sidebarPins: (userId?: string) => ["sidebar-pins", userId] as const,
  archivedProjects: () => ["archived-projects"] as const,
  archivedJobs: () => ["archived-jobs"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  projectJobs: (projectId: string) => ["project-jobs", projectId] as const,
  clientQuoteWorkspace: (jobIds: string[]) => ["client-quote-workspace", stableJobIds(jobIds)] as const,
  partDetail: (jobId: string) => ["part-detail", jobId] as const,
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
  options: { enabled?: boolean } = {},
): Promise<void> {
  if (options.enabled === false || isVirtualProjectId(projectId)) {
    return;
  }

  const projectKey = workspaceQueryKeys.project(projectId);
  const projectJobsKey = workspaceQueryKeys.projectJobs(projectId);

  const [, prefetchedJobs] = await Promise.all([
    maybePrefetchQuery(queryClient, {
      queryKey: projectKey,
      queryFn: () => fetchProject(projectId),
      staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
    }),
    maybePrefetchQuery<JobRecord[]>(queryClient, {
      queryKey: projectJobsKey,
      queryFn: () => fetchJobsByProject(projectId),
      staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
    }),
  ]);

  const jobs = prefetchedJobs ?? queryClient.getQueryData<JobRecord[]>(projectJobsKey) ?? [];
  const projectJobIds = stableJobIds(jobs.map((job) => job.id));

  if (projectJobIds.length === 0) {
    return;
  }

  await maybePrefetchQuery(queryClient, {
    queryKey: workspaceQueryKeys.clientQuoteWorkspace(projectJobIds),
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(projectJobIds),
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  });
}

export async function prefetchPartPage(queryClient: QueryClient, jobId: string): Promise<void> {
  await maybePrefetchQuery(queryClient, {
    queryKey: workspaceQueryKeys.partDetail(jobId),
    queryFn: () => fetchPartDetail(jobId),
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  });
}
