import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobRecord } from "@/features/quotes/types";
import {
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
} from "@/features/quotes/api";
import {
  prefetchPartPage,
  prefetchProjectPage,
  stableJobIds,
  workspaceQueryKeys,
  WORKSPACE_DETAIL_STALE_TIME_MS,
  WORKSPACE_GC_TIME_MS,
  WORKSPACE_SHARED_STALE_TIME_MS,
} from "@/features/quotes/workspace-navigation";

type UseClientWorkspaceDataOptions = {
  enabled: boolean;
  userId?: string;
  projectCollaborationUnavailable: boolean;
};

type UseWarmWorkspaceNavigationOptions = {
  enabled: boolean;
  projects: Array<{ id: string }>;
  jobs: JobRecord[];
  pinnedProjectIds?: string[];
  pinnedJobIds?: string[];
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

export function useClientWorkspaceData({
  enabled,
  userId,
  projectCollaborationUnavailable,
}: UseClientWorkspaceDataOptions) {
  const accessibleProjectsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientProjects(),
    queryFn: fetchAccessibleProjects,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const accessibleJobsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientJobs(),
    queryFn: fetchAccessibleJobs,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const accessibleJobIds = useMemo(
    () => stableJobIds((accessibleJobsQuery.data ?? []).map((job) => job.id)),
    [accessibleJobsQuery.data],
  );
  const partSummariesQuery = useQuery({
    queryKey: workspaceQueryKeys.clientPartSummaries(accessibleJobIds),
    queryFn: () => fetchJobPartSummariesByJobIds(accessibleJobIds),
    enabled: enabled && accessibleJobIds.length > 0,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const projectJobMembershipsQuery = useQuery({
    queryKey: workspaceQueryKeys.clientProjectJobMemberships(accessibleJobIds),
    queryFn: () => fetchProjectJobMembershipsByJobIds(accessibleJobIds),
    enabled: enabled && accessibleJobIds.length > 0 && !projectCollaborationUnavailable,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const sidebarPinsQuery = useQuery({
    queryKey: workspaceQueryKeys.sidebarPins(userId),
    queryFn: fetchSidebarPins,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const archivedProjectsQuery = useQuery({
    queryKey: workspaceQueryKeys.archivedProjects(),
    queryFn: fetchArchivedProjects,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const archivedJobsQuery = useQuery({
    queryKey: workspaceQueryKeys.archivedJobs(),
    queryFn: fetchArchivedJobs,
    enabled,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });

  const summariesByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );
  const accessibleJobsById = useMemo(
    () => new Map((accessibleJobsQuery.data ?? []).map((job) => [job.id, job])),
    [accessibleJobsQuery.data],
  );

  return {
    accessibleProjectsQuery,
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
  projects,
  jobs,
  pinnedProjectIds = [],
  pinnedJobIds = [],
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

    pinnedProjectIds.forEach((projectId) => pushUnique(projectIdsToWarm, projectId, MAX_WARM_PROJECTS));
    projects.forEach((project) => pushUnique(projectIdsToWarm, project.id, MAX_WARM_PROJECTS));

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
          .map((projectId) => prefetchProjectPage(queryClient, projectId)),
        ...jobIdsToWarm
          .filter((jobId) => jobId !== activeJobId)
          .map((jobId) => prefetchPartPage(queryClient, jobId)),
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
