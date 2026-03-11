import type { WorkspaceSidebarProject } from "@/components/chat/WorkspaceSidebar";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

export const PROJECT_STORAGE_PREFIX = "overdrafter-job-projects-v3";

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
  accessibleProjects: AccessibleSidebarProject[];
}): {
  remoteProjects: WorkspaceSidebarProject[];
  sidebarProjects: WorkspaceSidebarProject[];
} {
  const remoteProjects = buildRemoteSidebarProjects(input.accessibleProjects);

  return {
    remoteProjects,
    sidebarProjects: remoteProjects,
  };
}

export function resolveWorkspaceProjectIdsForJob(input: {
  job: Pick<JobRecord, "id" | "project_id">;
  sidebarProjectIdsByJobId: Map<string, string[]>;
}): string[] {
  return [
    ...new Set([
      ...(input.sidebarProjectIdsByJobId.get(input.job.id) ?? []),
      ...(input.job.project_id ? [input.job.project_id] : []),
    ]),
  ];
}
