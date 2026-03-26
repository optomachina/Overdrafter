import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSidebarProject } from "@/components/chat/WorkspaceSidebar";
import {
  buildSidebarProjectIdsByJobId,
  buildSidebarProjects,
  resolveWorkspaceProjectIdsForJob,
} from "@/features/quotes/client-workspace";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { stableJobIds } from "@/features/quotes/workspace-navigation";

type AccessibleSidebarProject = {
  project: {
    id: string;
    organization_id: string;
    name: string;
    created_at: string;
    updated_at: string;
  };
  partCount: number;
  inviteCount: number;
  currentUserRole: string;
};

type SidebarProjectMembership = {
  job_id: string;
  project_id: string;
};

export type WorkspaceNavigationCoherenceState =
  | "coherent"
  | "jobs_pending"
  | "projects_pending"
  | "memberships_pending"
  | "missing_project_reference";

export type WorkspaceNavigationCandidate = {
  isCoherent: boolean;
  coherenceState: WorkspaceNavigationCoherenceState;
  coherentJobIds: string[];
  sidebarProjects: WorkspaceSidebarProject[];
  parts: JobRecord[];
  partToProjectIds: Map<string, string[]>;
  jobsByProjectId: Map<string, JobRecord[]>;
  uiFlags: {
    showProjectsEmpty: boolean;
    showPartsEmpty: boolean;
  };
};

export type WorkspaceNavigationModel = WorkspaceNavigationCandidate & {
  version: number;
};

type UseWorkspaceNavigationModelInput = {
  accessibleJobs?: JobRecord[];
  accessibleProjects?: AccessibleSidebarProject[];
  projectJobMemberships?: SidebarProjectMembership[];
  summariesByJobId: Map<string, JobPartSummary>;
  accessibleJobsQuery?: { isFetching: boolean; isSuccess: boolean };
  accessibleProjectsQuery?: { isFetching: boolean; isSuccess: boolean };
  projectJobMembershipsQuery?: { isFetching: boolean; isSuccess: boolean };
  projectCollaborationUnavailable: boolean;
};

const EMPTY_MODEL: WorkspaceNavigationModel = {
  version: 0,
  isCoherent: false,
  coherenceState: "jobs_pending",
  coherentJobIds: [],
  sidebarProjects: [],
  parts: [],
  partToProjectIds: new Map(),
  jobsByProjectId: new Map(),
  uiFlags: {
    showProjectsEmpty: false,
    showPartsEmpty: false,
  },
};

export function deriveWorkspaceNavigationCandidate(input: {
  accessibleJobs: JobRecord[];
  accessibleProjects: AccessibleSidebarProject[];
  projectJobMemberships: SidebarProjectMembership[];
  jobsFetching: boolean;
  jobsSuccess: boolean;
  projectsFetching: boolean;
  projectsSuccess: boolean;
  membershipsFetching: boolean;
  membershipsSuccess: boolean;
  projectCollaborationUnavailable: boolean;
}): WorkspaceNavigationCandidate {
  const { sidebarProjects } = buildSidebarProjects({
    accessibleProjects: input.accessibleProjects,
  });
  const sidebarProjectIdsByJobId = buildSidebarProjectIdsByJobId(input.projectJobMemberships);
  const jobsById = new Map(input.accessibleJobs.map((job) => [job.id, job]));
  const projectsById = new Map(sidebarProjects.map((project) => [project.id, project]));
  const partToProjectIds = new Map<string, string[]>();
  const jobsByProjectId = new Map<string, JobRecord[]>();

  let coherenceState: WorkspaceNavigationCoherenceState = "coherent";
  let isCoherent = true;

  if (!input.jobsSuccess && (input.jobsFetching || input.accessibleJobs.length === 0)) {
    coherenceState = "jobs_pending";
    isCoherent = false;
  } else if (!input.projectsSuccess && (input.projectsFetching || input.accessibleProjects.length === 0)) {
    coherenceState = "projects_pending";
    isCoherent = false;
  } else if (
    !input.projectCollaborationUnavailable &&
    input.accessibleJobs.length > 0 &&
    !input.membershipsSuccess &&
    input.membershipsFetching
  ) {
    coherenceState = "memberships_pending";
    isCoherent = false;
  }

  if (isCoherent) {
    input.accessibleJobs.forEach((job) => {
      const projectIds = resolveWorkspaceProjectIdsForJob({
        job,
        sidebarProjectIdsByJobId,
      }).filter((projectId) => projectsById.has(projectId));
      partToProjectIds.set(job.id, projectIds);

      projectIds.forEach((projectId) => {
        const projectJobs = jobsByProjectId.get(projectId) ?? [];
        projectJobs.push(job);
        jobsByProjectId.set(projectId, projectJobs);
      });
    });

    const danglingMembership = input.projectJobMemberships.find(
      (membership) => !jobsById.has(membership.job_id) || !projectsById.has(membership.project_id),
    );

    if (danglingMembership) {
      coherenceState = "missing_project_reference";
      isCoherent = false;
    }
  }

  const coherentJobIds = isCoherent ? stableJobIds(input.accessibleJobs.map((job) => job.id)) : [];

  return {
    isCoherent,
    coherenceState,
    coherentJobIds,
    sidebarProjects,
    parts: input.accessibleJobs,
    partToProjectIds,
    jobsByProjectId,
    uiFlags: {
      showProjectsEmpty: isCoherent && sidebarProjects.length === 0,
      showPartsEmpty: isCoherent && input.accessibleJobs.length === 0,
    },
  };
}

export function useWorkspaceNavigationModel(input: UseWorkspaceNavigationModelInput): WorkspaceNavigationModel {
  const accessibleJobs = useMemo(() => input.accessibleJobs ?? [], [input.accessibleJobs]);
  const accessibleProjects = useMemo(() => input.accessibleProjects ?? [], [input.accessibleProjects]);
  const projectJobMemberships = useMemo(
    () => input.projectJobMemberships ?? [],
    [input.projectJobMemberships],
  );
  const accessibleJobsQuery = input.accessibleJobsQuery ?? { isFetching: false, isSuccess: true };
  const accessibleProjectsQuery = input.accessibleProjectsQuery ?? { isFetching: false, isSuccess: true };
  const projectJobMembershipsQuery = input.projectJobMembershipsQuery ?? {
    isFetching: false,
    isSuccess: true,
  };
  const candidate = useMemo(
    () =>
      deriveWorkspaceNavigationCandidate({
        accessibleJobs,
        accessibleProjects,
        projectJobMemberships,
        jobsFetching: accessibleJobsQuery.isFetching,
        jobsSuccess: accessibleJobsQuery.isSuccess,
        projectsFetching: accessibleProjectsQuery.isFetching,
        projectsSuccess: accessibleProjectsQuery.isSuccess,
        membershipsFetching: projectJobMembershipsQuery.isFetching,
        membershipsSuccess: projectJobMembershipsQuery.isSuccess,
        projectCollaborationUnavailable: input.projectCollaborationUnavailable,
      }),
    [
      accessibleJobs,
      accessibleJobsQuery.isFetching,
      accessibleJobsQuery.isSuccess,
      accessibleProjects,
      accessibleProjectsQuery.isFetching,
      accessibleProjectsQuery.isSuccess,
      input.projectCollaborationUnavailable,
      projectJobMemberships,
      projectJobMembershipsQuery.isFetching,
      projectJobMembershipsQuery.isSuccess,
    ],
  );

  const stableModelRef = useRef<WorkspaceNavigationModel>(EMPTY_MODEL);
  const lastRejectedStateRef = useRef<string | null>(null);
  const lastCommittedSignatureRef = useRef<string | null>(null);
  const [version, setVersion] = useState(0);

  const accessibleJobCount = accessibleJobs.length;
  const accessibleProjectCount = accessibleProjects.length;

  useEffect(() => {
    if (!candidate.isCoherent) {
      if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
        const rejectedSignature = `${candidate.coherenceState}:${candidate.coherentJobIds.join(",")}`;

        if (lastRejectedStateRef.current !== rejectedSignature) {
          // Temporary signal while the new monotonic model settles in production usage.
          console.debug("[workspace-nav] rejected incoherent candidate", {
            coherenceState: candidate.coherenceState,
            jobCount: accessibleJobCount,
            projectCount: accessibleProjectCount,
          });
          lastRejectedStateRef.current = rejectedSignature;
        }
      }
      return;
    }

    const candidateSignature = JSON.stringify({
      coherentJobIds: candidate.coherentJobIds,
      projectIds: candidate.sidebarProjects.map((project) => project.id),
      membershipShape: candidate.sidebarProjects.map((project) => ({
        projectId: project.id,
        jobIds: (candidate.jobsByProjectId.get(project.id) ?? []).map((job) => job.id),
      })),
    });

    if (lastCommittedSignatureRef.current === candidateSignature) {
      return;
    }

    const nextVersion = stableModelRef.current.version + 1;
    stableModelRef.current = {
      ...candidate,
      version: nextVersion,
    };
    setVersion(nextVersion);
    lastRejectedStateRef.current = null;
    lastCommittedSignatureRef.current = candidateSignature;
  }, [accessibleJobCount, accessibleProjectCount, candidate]);

  // keep version in state to trigger renders after coherent commits
  void version;

  if (stableModelRef.current.version === 0) {
    return {
      ...candidate,
      version: 0,
    };
  }

  if (!candidate.isCoherent) {
    return stableModelRef.current;
  }

  return {
    ...candidate,
    version: stableModelRef.current.version,
  };
}
