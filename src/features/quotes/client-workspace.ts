import type { WorkspaceSidebarProject } from "@/components/chat/WorkspaceSidebar";
import { assignJobToProject, createProject } from "@/features/quotes/api";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

export const DMRIFLES_EMAIL = "dmrifles@gmail.com";
export const DMRIFLES_PROJECT_NAMES = ["QB00001", "QB00002", "QB00003"] as const;
export const PROJECT_STORAGE_PREFIX = "overdrafter-job-projects-v3";

export type ClientJobProject = {
  id: string;
  name: string;
  jobIds: string[];
  createdAt: string;
  systemManaged?: boolean;
};

type NamedProject = {
  id: string;
  name: string;
};

type SidebarProjectMembership = {
  job_id: string;
  project_id: string;
};

type AccessibleSidebarProject = {
  project: {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
  };
  partCount: number;
  inviteCount: number;
  currentUserRole: string;
};

export function buildSeedProjectId(name: string): string {
  return `seed-${name.toLowerCase()}`;
}

export function resolveImportedBatchFromSource(source: string | null | undefined): string | null {
  if (!source) {
    return null;
  }

  const match = source.match(/^spreadsheet_import:(qb\d{5}):/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function resolveImportedBatch(
  job: Pick<JobRecord, "source">,
  partSummary?: Pick<JobPartSummary, "importedBatch"> | null,
): string | null {
  const importedBatch = partSummary?.importedBatch?.trim().toUpperCase();

  if (importedBatch) {
    return importedBatch;
  }

  return resolveImportedBatchFromSource(job.source);
}

export function buildDmriflesProjects(
  jobs: JobRecord[],
  partSummariesByJobId: Map<string, JobPartSummary>,
): ClientJobProject[] {
  const timestamp = new Date().toISOString();
  const seedProjects = new Map(
    DMRIFLES_PROJECT_NAMES.map((name) => [
      name,
      {
        id: buildSeedProjectId(name),
        name,
        jobIds: [] as string[],
        createdAt: timestamp,
        systemManaged: true,
      },
    ]),
  );

  const sortedJobs = [...jobs].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    }

    return left.title.localeCompare(right.title);
  });

  sortedJobs.forEach((job) => {
    const importedBatch = resolveImportedBatch(job, partSummariesByJobId.get(job.id));

    if (importedBatch && seedProjects.has(importedBatch)) {
      seedProjects.get(importedBatch)?.jobIds.push(job.id);
    }
  });

  return DMRIFLES_PROJECT_NAMES.map((name) => seedProjects.get(name)!);
}

export function findImportedBatchProjectId(
  importedBatch: string | null | undefined,
  projects: NamedProject[],
): string | null {
  if (!importedBatch) {
    return null;
  }

  const normalizedBatch = importedBatch.trim().toUpperCase();
  const match = projects.find((project) => project.name.trim().toUpperCase() === normalizedBatch);
  return match?.id ?? null;
}

export function buildSidebarProjectIdsByJobId(
  memberships: SidebarProjectMembership[],
): Map<string, string[]> {
  const next = new Map<string, string[]>();

  memberships.forEach((membership) => {
    const projectIds = next.get(membership.job_id) ?? [];

    if (!projectIds.includes(membership.project_id)) {
      projectIds.push(membership.project_id);
    }

    next.set(membership.job_id, projectIds);
  });

  return next;
}

export function buildRemoteSidebarProjects(
  accessibleProjects: AccessibleSidebarProject[],
): WorkspaceSidebarProject[] {
  return accessibleProjects.map((project) => ({
    id: project.project.id,
    name: project.project.name,
    partCount: project.partCount,
    inviteCount: project.inviteCount,
    roleLabel: project.currentUserRole,
    canRename: project.currentUserRole === "owner" || project.currentUserRole === "editor",
    canDelete: project.currentUserRole === "owner",
    createdAt: project.project.created_at,
    updatedAt: project.project.updated_at,
  }));
}

export function buildSidebarProjects(input: {
  isDmriflesWorkspace: boolean;
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  accessibleProjects: AccessibleSidebarProject[];
}): {
  seededProjects: WorkspaceSidebarProject[];
  remoteProjects: WorkspaceSidebarProject[];
  remoteProjectsByName: Map<string, string>;
  sidebarProjects: WorkspaceSidebarProject[];
} {
  const remoteProjects = buildRemoteSidebarProjects(input.accessibleProjects);
  const remoteProjectsByName = new Map(
    remoteProjects.map((project) => [project.name.trim().toUpperCase(), project.id]),
  );
  const seededProjects = input.isDmriflesWorkspace
    ? buildDmriflesProjects(input.jobs, input.summariesByJobId).map((project) => ({
        id: project.id,
        name: project.name,
        partCount: project.jobIds.length,
        roleLabel: "batch",
        isReadOnly: true,
        canManage: false,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      }))
    : [];

  return {
    seededProjects,
    remoteProjects,
    remoteProjectsByName,
    sidebarProjects: input.isDmriflesWorkspace
      ? [
          ...seededProjects.filter(
            (project) => !remoteProjectsByName.has(project.name.trim().toUpperCase()),
          ),
          ...remoteProjects,
        ]
      : remoteProjects,
  };
}

export function resolveWorkspaceProjectIdsForJob(input: {
  job: Pick<JobRecord, "id" | "project_id" | "source">;
  isDmriflesWorkspace: boolean;
  summariesByJobId: Map<string, JobPartSummary>;
  sidebarProjectIdsByJobId: Map<string, string[]>;
  remoteProjects: Array<Pick<WorkspaceSidebarProject, "id" | "name">>;
}): string[] {
  const projectIds = [
    ...new Set([
      ...(input.sidebarProjectIdsByJobId.get(input.job.id) ?? []),
      ...(input.job.project_id ? [input.job.project_id] : []),
    ]),
  ];

  if (!input.isDmriflesWorkspace) {
    return projectIds;
  }

  const importedBatch = resolveImportedBatch(input.job, input.summariesByJobId.get(input.job.id));
  if (!importedBatch) {
    return projectIds;
  }

  const importedBatchProjectId =
    findImportedBatchProjectId(importedBatch, input.remoteProjects) ?? buildSeedProjectId(importedBatch);

  return [...new Set([...projectIds, importedBatchProjectId])];
}

export function findSeededProjectById(input: {
  projectId: string;
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
}): ClientJobProject | null {
  return (
    buildDmriflesProjects(input.jobs, input.summariesByJobId).find(
      (project) => project.id === input.projectId,
    ) ?? null
  );
}

export async function syncImportedBatchProjects(input: {
  jobs: JobRecord[];
  partSummariesByJobId: Map<string, JobPartSummary>;
  projects: NamedProject[];
  resolveProjectIdsForJob: (jobId: string) => string[];
}): Promise<boolean> {
  const groupedJobsByBatch = new Map<string, string[]>();

  input.jobs.forEach((job) => {
    const importedBatch = resolveImportedBatch(job, input.partSummariesByJobId.get(job.id));
    if (!importedBatch) {
      return;
    }

    const normalizedBatch = importedBatch.trim().toUpperCase();
    const jobIds = groupedJobsByBatch.get(normalizedBatch) ?? [];
    jobIds.push(job.id);
    groupedJobsByBatch.set(normalizedBatch, jobIds);
  });

  if (groupedJobsByBatch.size === 0) {
    return false;
  }

  const projectIdsByName = new Map(
    input.projects.map((project) => [project.name.trim().toUpperCase(), project.id]),
  );

  let mutated = false;

  for (const [batchName, jobIds] of groupedJobsByBatch.entries()) {
    let targetProjectId = projectIdsByName.get(batchName) ?? null;

    if (!targetProjectId) {
      targetProjectId = await createProject({ name: batchName });
      projectIdsByName.set(batchName, targetProjectId);
      mutated = true;
    }

    for (const jobId of jobIds) {
      if (input.resolveProjectIdsForJob(jobId).includes(targetProjectId)) {
        continue;
      }

      await assignJobToProject({ jobId, projectId: targetProjectId });
      mutated = true;
    }
  }

  return mutated;
}

export function matchesDefaultDmriflesSeed(projects: ClientJobProject[]): boolean {
  if (projects.length !== DMRIFLES_PROJECT_NAMES.length) {
    return false;
  }

  return DMRIFLES_PROJECT_NAMES.every((name) =>
    projects.some(
      (project) =>
        project.id === buildSeedProjectId(name) &&
        project.name === name &&
        project.systemManaged === true,
    ),
  );
}

export function isDmriflesSystemProject(
  project: Pick<ClientJobProject, "id" | "name" | "systemManaged"> | null | undefined,
): boolean {
  if (!project) {
    return false;
  }

  return (
    project.systemManaged === true &&
    project.id.startsWith("seed-") &&
    DMRIFLES_PROJECT_NAMES.includes(project.name as (typeof DMRIFLES_PROJECT_NAMES)[number])
  );
}
