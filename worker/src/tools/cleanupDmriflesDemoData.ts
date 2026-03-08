import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../config.js";
import { createServiceClient } from "../queue.js";

const DMRIFLES_EMAIL = "dmrifles@gmail.com";
const TARGET_PART_NUMBER = "1093-05589";
const TARGET_BATCH = "QB00002";

type JobRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  source: string;
  created_at: string;
};

type PartRequirementRow = {
  jobId: string;
  partNumber: string | null;
  revision: string | null;
  description: string | null;
  importedBatch: string | null;
};

type JobRelationCounts = {
  parts: number;
  quoteRuns: number;
  packages: number;
  files: number;
};

type JobFileRow = {
  id: string;
  job_id: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  normalized_name: string;
  file_kind: string;
};

export type CleanupRenameCandidate = {
  jobId: string;
  currentTitle: string;
  nextTitle: string;
  currentDescription: string | null;
  nextDescription: string | null;
  currentSource: string;
  nextSource: string;
};

export type CleanupSummary = {
  totalJobs: number;
  totalPackages: number;
  batchCounts: Record<string, number>;
};

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "none")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

export function buildSpreadsheetImportSource(
  batch: string,
  partNumber: string,
  revision: string | null,
): string {
  return `spreadsheet_import:${normalizeToken(batch)}:${normalizeToken(partNumber)}:${normalizeToken(revision)}`;
}

export function isGenericDemoDescription(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();

  return (
    !normalized ||
    normalized === "test" ||
    normalized === "spreadsheet import" ||
    normalized === "imported spreadsheet quote" ||
    normalized === "no description provided."
  );
}

export function getImportedBatchFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }

  const importedBatch = (snapshot as Record<string, unknown>).importedBatch;
  return typeof importedBatch === "string" && importedBatch.trim().length > 0
    ? importedBatch.trim().toUpperCase()
    : null;
}

export function summarizeBatchCounts(
  jobs: JobRow[],
  requirements: PartRequirementRow[],
): Record<string, number> {
  const requirementByJobId = new Map(requirements.map((requirement) => [requirement.jobId, requirement]));

  return jobs.reduce<Record<string, number>>((counts, job) => {
    const batch =
      requirementByJobId.get(job.id)?.importedBatch ??
      (() => {
        const match = job.source.match(/^spreadsheet_import:(qb\d{5}):/i);
        return match?.[1] ? match[1].toUpperCase() : null;
      })();

    if (!batch) {
      return counts;
    }

    counts[batch] = (counts[batch] ?? 0) + 1;
    return counts;
  }, {});
}

export function findRenameCandidates(
  jobs: JobRow[],
  requirements: PartRequirementRow[],
): CleanupRenameCandidate[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  return requirements
    .filter(
      (requirement) =>
        requirement.partNumber === TARGET_PART_NUMBER && requirement.importedBatch === TARGET_BATCH,
    )
    .flatMap((requirement) => {
      const job = jobsById.get(requirement.jobId);

      if (!job || !requirement.partNumber || !requirement.importedBatch) {
        return [];
      }

      return [
        {
          jobId: job.id,
          currentTitle: job.title,
          nextTitle: `${requirement.partNumber} rev ${requirement.revision}`,
          currentDescription: job.description,
          nextDescription: isGenericDemoDescription(job.description)
            ? requirement.description
            : job.description,
          currentSource: job.source,
          nextSource: buildSpreadsheetImportSource(
            requirement.importedBatch,
            requirement.partNumber,
            requirement.revision,
          ),
        } satisfies CleanupRenameCandidate,
      ];
    });
}

export function findOrphanDeleteCandidates(
  jobs: JobRow[],
  relationCountsByJobId: Map<string, JobRelationCounts>,
  filesByJobId: Map<string, JobFileRow[]> = new Map(),
  retainedJobId?: string,
): JobRow[] {
  const retainedFileSignature = retainedJobId
    ? buildFileSignature(filesByJobId.get(retainedJobId) ?? [])
    : "";

  return jobs.filter((job) => {
    const relationCounts = relationCountsByJobId.get(job.id) ?? {
      parts: 0,
      quoteRuns: 0,
      packages: 0,
      files: 0,
    };
    const files = filesByJobId.get(job.id) ?? [];
    const hasDeletableFiles =
      files.length === 0 ||
      (retainedFileSignature.length > 0 && buildFileSignature(files) === retainedFileSignature);

    return (
      job.title.trim().toLowerCase() === "test" &&
      relationCounts.parts === 0 &&
      relationCounts.quoteRuns === 0 &&
      relationCounts.packages === 0 &&
      hasDeletableFiles
    );
  });
}

function parseArgs() {
  return {
    apply: process.argv.slice(2).includes("--apply"),
  };
}

function buildSummary(jobs: JobRow[], requirements: PartRequirementRow[], packageCount: number): CleanupSummary {
  return {
    totalJobs: jobs.length,
    totalPackages: packageCount,
    batchCounts: summarizeBatchCounts(jobs, requirements),
  };
}

function buildFileSignature(files: JobFileRow[]): string {
  return files
    .map((file) => `${file.file_kind}:${file.normalized_name}`)
    .sort()
    .join("|");
}

async function resolveDmriflesOrganizationId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.auth.admin.listUsers();

  if (error || !data?.users) {
    throw error ?? new Error("Unable to list auth users.");
  }

  const user = data.users.find((candidate) => candidate.email?.toLowerCase() === DMRIFLES_EMAIL);

  if (!user) {
    throw new Error(`Auth user ${DMRIFLES_EMAIL} was not found.`);
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id)
    .eq("role", "client");

  if (membershipError) {
    throw membershipError;
  }

  if (!memberships || memberships.length !== 1) {
    throw new Error(`Expected exactly one client membership for ${DMRIFLES_EMAIL}.`);
  }

  return memberships[0].organization_id;
}

async function loadWorkspaceState(supabase: SupabaseClient, organizationId: string) {
  const [jobsResult, packagesResult, quoteRunsResult, filesResult, partsResult] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, title, description, status, source, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("published_quote_packages")
      .select("id, job_id")
      .eq("organization_id", organizationId),
    supabase.from("quote_runs").select("id, job_id").eq("organization_id", organizationId),
    supabase
      .from("job_files")
      .select("id, job_id, storage_bucket, storage_path, original_name, normalized_name, file_kind")
      .eq("organization_id", organizationId),
    supabase
      .from("parts")
      .select("job_id, approved_part_requirements(part_number, revision, description, spec_snapshot)")
      .eq("organization_id", organizationId),
  ]);

  if (jobsResult.error) {
    throw jobsResult.error;
  }

  if (packagesResult.error) {
    throw packagesResult.error;
  }

  if (quoteRunsResult.error) {
    throw quoteRunsResult.error;
  }

  if (filesResult.error) {
    throw filesResult.error;
  }

  if (partsResult.error) {
    throw partsResult.error;
  }

  const jobs = (jobsResult.data ?? []) as JobRow[];
  const packages = (packagesResult.data ?? []) as { id: string; job_id: string }[];
  const quoteRuns = (quoteRunsResult.data ?? []) as { id: string; job_id: string }[];
  const files = (filesResult.data ?? []) as JobFileRow[];
  const requirements = ((partsResult.data ?? []) as unknown as {
    job_id: string;
    approved_part_requirements:
      | {
          part_number: string | null;
          revision: string | null;
          description: string | null;
          spec_snapshot: unknown;
        }
      | {
          part_number: string | null;
          revision: string | null;
          description: string | null;
          spec_snapshot: unknown;
        }[]
      | null;
  }[]).map((row) => {
    const approvedRequirement = Array.isArray(row.approved_part_requirements)
      ? row.approved_part_requirements[0] ?? null
      : row.approved_part_requirements;

    return {
      jobId: row.job_id,
      partNumber: approvedRequirement?.part_number ?? null,
      revision: approvedRequirement?.revision ?? null,
      description: approvedRequirement?.description ?? null,
      importedBatch: getImportedBatchFromSnapshot(approvedRequirement?.spec_snapshot),
    };
  });

  const relationCountsByJobId = new Map<string, JobRelationCounts>();
  const filesByJobId = new Map<string, JobFileRow[]>();

  const incrementRelation = (jobId: string, key: keyof JobRelationCounts) => {
    const current = relationCountsByJobId.get(jobId) ?? {
      parts: 0,
      quoteRuns: 0,
      packages: 0,
      files: 0,
    };
    current[key] += 1;
    relationCountsByJobId.set(jobId, current);
  };

  requirements.forEach((requirement) => incrementRelation(requirement.jobId, "parts"));
  quoteRuns.forEach((quoteRun) => incrementRelation(quoteRun.job_id, "quoteRuns"));
  packages.forEach((pkg) => incrementRelation(pkg.job_id, "packages"));
  files.forEach((file) => {
    incrementRelation(file.job_id, "files");
    filesByJobId.set(file.job_id, [...(filesByJobId.get(file.job_id) ?? []), file]);
  });

  return {
    jobs,
    packages,
    requirements,
    relationCountsByJobId,
    filesByJobId,
  };
}

async function main() {
  await import("dotenv/config");

  const args = parseArgs();
  const config = loadConfig();
  const supabase = createServiceClient(config);
  const organizationId = await resolveDmriflesOrganizationId(supabase);
  const before = await loadWorkspaceState(supabase, organizationId);
  const renameCandidates = findRenameCandidates(before.jobs, before.requirements);
  const deleteCandidates = findOrphanDeleteCandidates(
    before.jobs,
    before.relationCountsByJobId,
    before.filesByJobId,
    renameCandidates[0]?.jobId,
  );

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "apply" : "dry_run",
        organizationId,
        before: buildSummary(before.jobs, before.requirements, before.packages.length),
        renameCandidates,
        deleteCandidates: deleteCandidates.map((job) => ({
          jobId: job.id,
          title: job.title,
          source: job.source,
          files:
            before.filesByJobId.get(job.id)?.map((file) => ({
              path: file.storage_path,
              kind: file.file_kind,
            })) ?? [],
        })),
      },
      null,
      2,
    ),
  );

  if (renameCandidates.length !== 1) {
    throw new Error(`Expected exactly one rename candidate, found ${renameCandidates.length}.`);
  }

  if (deleteCandidates.length > 1) {
    throw new Error(`Expected at most one orphan delete candidate, found ${deleteCandidates.length}.`);
  }

  if (!args.apply) {
    return;
  }

  const renameCandidate = renameCandidates[0];
  const renameUpdates: Record<string, string> = {};

  if (renameCandidate.currentTitle !== renameCandidate.nextTitle) {
    renameUpdates.title = renameCandidate.nextTitle;
  }

  if (
    renameCandidate.nextDescription &&
    renameCandidate.currentDescription !== renameCandidate.nextDescription
  ) {
    renameUpdates.description = renameCandidate.nextDescription;
  }

  if (renameCandidate.currentSource === "client" && renameCandidate.currentSource !== renameCandidate.nextSource) {
    renameUpdates.source = renameCandidate.nextSource;
  }

  if (Object.keys(renameUpdates).length > 0) {
    const { error } = await supabase.from("jobs").update(renameUpdates).eq("id", renameCandidate.jobId);

    if (error) {
      throw error;
    }
  }

  if (deleteCandidates.length === 1) {
    const duplicateFiles = before.filesByJobId.get(deleteCandidates[0].id) ?? [];

    if (duplicateFiles.length > 0) {
      const filesByBucket = new Map<string, string[]>();

      duplicateFiles.forEach((file) => {
        filesByBucket.set(file.storage_bucket, [...(filesByBucket.get(file.storage_bucket) ?? []), file.storage_path]);
      });

      for (const [bucket, paths] of filesByBucket.entries()) {
        const { error: storageError } = await supabase.storage.from(bucket).remove(paths);

        if (storageError) {
          throw storageError;
        }
      }

      const { error: fileDeleteError } = await supabase.from("job_files").delete().eq("job_id", deleteCandidates[0].id);

      if (fileDeleteError) {
        throw fileDeleteError;
      }
    }

    const { error } = await supabase.from("jobs").delete().eq("id", deleteCandidates[0].id);

    if (error) {
      throw error;
    }
  }

  const after = await loadWorkspaceState(supabase, organizationId);

  console.log(
    JSON.stringify(
      {
        after: buildSummary(after.jobs, after.requirements, after.packages.length),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
