import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { JobRecord } from "@/features/quotes/types";
import {
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
} from "@/features/quotes/api/workspace-access";
import {
  isVirtualProjectId,
  prefetchPartPage,
  prefetchProjectPage,
  stableJobIds,
  type WorkspaceAccessScope,
  workspaceQueryKeys,
  WORKSPACE_DETAIL_STALE_TIME_MS,
  WORKSPACE_GC_TIME_MS,
  WORKSPACE_SHARED_STALE_TIME_MS,
} from "@/features/quotes/workspace-navigation";

type UseClientWorkspaceDataOptions = {
  enabled: boolean;
  accessScope: WorkspaceAccessScope;
  projectCollaborationUnavailable: boolean;
};

type UseWarmWorkspaceNavigationOptions = {
  enabled: boolean;
  accessScope: WorkspaceAccessScope;
  projects: Array<{ id: string }>;
  jobs: JobRecord[];
  pinnedProjectIds?: string[];
  pinnedJobIds?: string[];
  canPrefetchProjects?: boolean;
  resolveProjectIdsForJob?: (job: JobRecord) => string[];
  activeProjectId?: string | null;
  activeJobId?: string | null;
};

const MAX_WARM_PROJECTS = 3;
const MAX_WARM_PARTS = 4;

function pushUnique(target: string[], value: string | null | undefined, limit: number) {
  if (!value || target.includes(value) || target.length >= limit) {
    return;
  }

  target.push(value);
}

function useStableWorkspaceList<T>({
  data,
  isFetching,
  scopeKey,
}: {
  data: T[] | undefined;
  isFetching: boolean;
  scopeKey: WorkspaceAccessScope;
}): T[] {
  const stableRef = useRef<{
    scopeKey: WorkspaceAccessScope;
    items: T[];
  }>({
    scopeKey,
    items: data ?? [],
  });

  const scopeChanged = stableRef.current.scopeKey !== scopeKey;

  if (scopeChanged) {
    stableRef.current = {
      scopeKey,
      items: [],
    };
  }

  useEffect(() => {
    const nextItems = data ?? [];

    if (nextItems.length > 0 || !isFetching) {
      stableRef.current = {
        scopeKey,
        items: nextItems,
      };
    }
  }, [data, isFetching, scopeKey]);

  if (scopeChanged) {
    return [];
  }

  if (isFetching && (data?.length ?? 0) === 0) {
    return stableRef.current.items;
  }

  return data ?? [];
}

export function useClientWorkspaceData({
  enabled,
  accessScope,
  projectCollaborationUnavailable,
}: UseClientWorkspaceDataOptions) {
  const accessibleProjectsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientProjects(accessScope),
    queryFn: fetchAccessibleProjects,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const accessibleJobsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientJobs(accessScope),
    queryFn: fetchAccessibleJobs,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const rawAccessibleJobs = useStableWorkspaceList({
    data: accessibleJobsQuery.data,
    isFetching: accessibleJobsQuery.isFetching,
    scopeKey: accessScope,
  });
  const accessibleJobIds = useMemo(
    () => stableJobIds(rawAccessibleJobs.map((job) => job.id)),
    [rawAccessibleJobs],
  );
  const partSummariesQuery = useQuery({
    queryKey: workspaceQueryKeys.clientPartSummaries(
      accessibleJobIds,
      accessScope,
    ),
    queryFn: () => fetchJobPartSummariesByJobIds(accessibleJobIds),
    enabled: enabled && accessibleJobIds.length > 0,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const projectJobMembershipsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientProjectJobMemberships(
      accessibleJobIds,
      accessScope,
    ),
    queryFn: () => fetchProjectJobMembershipsByJobIds(accessibleJobIds),
    enabled: enabled && accessibleJobIds.length > 0 && !projectCollaborationUnavailable,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const sidebarPinsQuery = useQuery({
    queryKey: workspaceQueryKeys.sidebarPins(accessScope),
    queryFn: fetchSidebarPins,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const archivedProjectsQuery = useQuery({
    queryKey: workspaceQueryKeys.archivedProjects(accessScope),
    queryFn: fetchArchivedProjects,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const archivedJobsQuery = useQuery({
    queryKey: workspaceQueryKeys.archivedJobs(accessScope),
    queryFn: fetchArchivedJobs,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });

  const accessibleProjects = useStableWorkspaceList({
    data: accessibleProjectsQuery.data,
    isFetching: accessibleProjectsQuery.isFetching,
    scopeKey: accessScope,
  });
  const projectJobMemberships = useStableWorkspaceList({
    data: projectJobMembershipsQuery.data,
    isFetching: projectJobMembershipsQuery.isFetching,
    scopeKey: accessScope,
  });
  const accessibleJobs = rawAccessibleJobs;
  const summariesByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );
  const accessibleJobsById = useMemo(
    () => new Map(accessibleJobs.map((job) => [job.id, job])),
    [accessibleJobs],
  );

  return {
    accessibleProjects,
    accessibleJobs,
    accessibleProjectsQuery,
    projectJobMemberships,
    accessibleJobsQuery,
    accessibleJobIds,
    accessibleJobsById,
    partSummariesQuery,
    projectJobMembershipsQuery,
    sidebarPinsQuery,
    archivedProjectsQuery,
    archivedJobsQuery,
    summariesByJobId,
  };
}

export function useWarmClientWorkspaceNavigation({
  enabled,
  accessScope,
  projects,
  jobs,
  pinnedProjectIds = [],
  pinnedJobIds = [],
  canPrefetchProjects = true,
  resolveProjectIdsForJob,
  activeProjectId = null,
  activeJobId = null,
}: UseWarmWorkspaceNavigationOptions) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const projectIdsToWarm: string[] = [];
    const jobIdsToWarm: string[] = [];
    const availableProjectIdSet = new Set(
      projects.filter((project) => !isVirtualProjectId(project.id)).map((project) => project.id),
    );

    if (canPrefetchProjects) {
      pinnedProjectIds
        .filter((projectId) => availableProjectIdSet.has(projectId))
        .forEach((projectId) => pushUnique(projectIdsToWarm, projectId, MAX_WARM_PROJECTS));
      projects
        .filter((project) => !isVirtualProjectId(project.id))
        .forEach((project) => pushUnique(projectIdsToWarm, project.id, MAX_WARM_PROJECTS));
    }

    pinnedJobIds.forEach((jobId) => pushUnique(jobIdsToWarm, jobId, MAX_WARM_PARTS));
    jobs.forEach((job) => {
      const projectIds =
        resolveProjectIdsForJob?.(job) ?? (job.project_id ? [job.project_id] : []);

      if (projectIds.length > 0) {
        return;
      }

      pushUnique(jobIdsToWarm, job.id, MAX_WARM_PARTS);
    });

    const warmTargets = async () => {
      await Promise.all([
        ...projectIdsToWarm
          .filter((projectId) => projectId !== activeProjectId)
          .map((projectId) =>
            prefetchProjectPage(queryClient, projectId, { accessScope }),
          ),
        ...jobIdsToWarm
          .filter((jobId) => jobId !== activeJobId)
          .map((jobId) =>
            prefetchPartPage(queryClient, jobId, { accessScope }),
          ),
      ]);
    };

    const timeoutId = window.setTimeout(() => {
      void warmTargets();
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeJobId,
    activeProjectId,
    accessScope,
    canPrefetchProjects,
    enabled,
    jobs,
    pinnedJobIds,
    pinnedProjectIds,
    projects,
    queryClient,
    resolveProjectIdsForJob,
  ]);
}

export const workspaceDetailQueryOptions = {
  staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
  gcTime: WORKSPACE_GC_TIME_MS,
};

type InvalidateWorkspaceQueriesInput = {
  projectId?: string | null;
  jobId?: string | null;
  clientQuoteWorkspaceJobIds?: string[];
  includeProjectMemberships?: boolean;
  includeProjectInvites?: boolean;
};

export async function invalidateClientWorkspaceQueries(
  queryClient: QueryClient,
  input: InvalidateWorkspaceQueriesInput = {},
): Promise<void> {
  const jobIds = input.clientQuoteWorkspaceJobIds ? stableJobIds(input.clientQuoteWorkspaceJobIds) : [];

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
    queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
    queryClient.invalidateQueries({ queryKey: ["client-activity"] }),
    queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
    queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] }),
    queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["project"] }),
    queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
    ...(input.projectId
      ? [
          queryClient.invalidateQueries({
            queryKey: ["project", input.projectId],
          }),
          queryClient.invalidateQueries({
            queryKey: ["project-jobs", input.projectId],
          }),
          queryClient.invalidateQueries({
            queryKey: ["project-assignees", input.projectId],
          }),
          ...(input.includeProjectMemberships
            ? [queryClient.invalidateQueries({ queryKey: ["project-memberships", input.projectId] })]
            : []),
          ...(input.includeProjectInvites
            ? [queryClient.invalidateQueries({ queryKey: ["project-invites", input.projectId] })]
            : []),
        ]
      : []),
    ...(input.jobId
      ? [
          queryClient.invalidateQueries({
            queryKey: ["part-detail", input.jobId],
          }),
        ]
      : []),
    ...(jobIds.length > 0
      ? [
          queryClient.invalidateQueries({
            queryKey: ["client-quote-workspace"],
          }),
          queryClient.invalidateQueries({
            queryKey: ["client-activity"],
          }),
        ]
      : []),
  ]);
}
