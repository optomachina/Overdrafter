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
        id: `seed-${name.toLowerCase()}`,
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

export function matchesDefaultDmriflesSeed(projects: ClientJobProject[]): boolean {
  if (projects.length !== DMRIFLES_PROJECT_NAMES.length) {
    return false;
  }

  return DMRIFLES_PROJECT_NAMES.every((name) =>
    projects.some(
      (project) =>
        project.id === `seed-${name.toLowerCase()}` &&
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
