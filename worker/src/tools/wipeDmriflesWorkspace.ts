import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../config.js";
import { createServiceClient } from "../queue.js";

const DEFAULT_TARGET_EMAIL = "dmrifles@gmail.com";
const SAMPLE_LIMIT = 5;
const CHUNK_SIZE = 100;

type AuthUserRecord = {
  id: string;
  email?: string | null;
};

type OrganizationMembershipRow = {
  id: string;
  organization_id: string;
  role: string;
};

type IdRow = {
  id: string;
};

type ProjectScopedRow = IdRow & {
  project_id: string;
};

type JobScopedRow = IdRow & {
  job_id: string;
};

type PartScopedRow = IdRow & {
  part_id: string;
};

type StorageRow = IdRow & {
  storage_bucket: string;
  storage_path: string;
};

type UserPinnedProjectRow = IdRow & {
  project_id: string;
  user_id: string;
};

type UserPinnedJobRow = IdRow & {
  job_id: string;
  user_id: string;
};

type QueryResponse<T> = {
  data: T | null;
  error: unknown;
};

type QueryFilter = {
  eq: (column: string, value: string) => Promise<QueryResponse<unknown[]>>;
  in: (column: string, values: string[]) => Promise<QueryResponse<unknown[]>>;
};

type QueryDelete = {
  eq: (column: string, value: string) => Promise<QueryResponse<null>>;
  in: (column: string, values: string[]) => Promise<QueryResponse<null>>;
};

type ServiceRoleClient = Pick<SupabaseClient, "storage"> & {
  auth: {
    admin: {
      listUsers: () => Promise<QueryResponse<{ users: AuthUserRecord[] }>>;
      deleteUser: (userId: string) => Promise<QueryResponse<unknown>>;
    };
  };
  from: (table: string) => {
    select: (columns: string) => QueryFilter;
    delete: () => QueryDelete;
  };
};

export type WipeArgs = {
  apply: boolean;
  email: string;
};

export type WorkspaceTarget = {
  email: string;
  userId: string;
  membershipId: string;
  organizationId: string;
};

export type StorageTarget = {
  id: string;
  bucket: string;
  path: string;
};

export type WorkspaceSnapshot = {
  jobs: IdRow[];
  jobFiles: StorageTarget[];
  organizationFileBlobs: StorageTarget[];
  parts: IdRow[];
  drawingPreviewAssets: StorageTarget[];
  drawingExtractions: PartScopedRow[];
  approvedPartRequirements: PartScopedRow[];
  quoteRuns: JobScopedRow[];
  vendorQuoteResults: PartScopedRow[];
  vendorQuoteOffers: IdRow[];
  vendorQuoteArtifacts: StorageTarget[];
  publishedQuotePackages: JobScopedRow[];
  publishedQuoteOptions: IdRow[];
  clientSelections: IdRow[];
  workQueue: IdRow[];
  auditEvents: IdRow[];
  pricingPolicies: IdRow[];
  projects: IdRow[];
  projectJobs: ProjectScopedRow[];
  projectMemberships: ProjectScopedRow[];
  projectInvites: ProjectScopedRow[];
  userPinnedProjects: UserPinnedProjectRow[];
  userPinnedJobs: UserPinnedJobRow[];
};

export type DryRunReport = {
  mode: "dry_run" | "apply";
  target: WorkspaceTarget;
  counts: Record<string, number>;
  samples: Record<string, string[]>;
  storageBuckets: Record<string, number>;
};

function expectQuerySuccess<T>(result: QueryResponse<T>, context: string): T {
  if (result.error) {
    throw result.error;
  }

  return (result.data ?? null) as T;
}

function chunkValues<T>(values: T[], chunkSize = CHUNK_SIZE) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function sampleIds(rows: Array<{ id: string }>) {
  return rows.slice(0, SAMPLE_LIMIT).map((row) => row.id);
}

function countByBucket(targets: StorageTarget[]) {
  return targets.reduce<Record<string, number>>((counts, target) => {
    counts[target.bucket] = (counts[target.bucket] ?? 0) + 1;
    return counts;
  }, {});
}

async function selectByOrganization<T>(
  supabase: ServiceRoleClient,
  table: string,
  columns: string,
  organizationId: string,
) {
  const result = await supabase.from(table).select(columns).eq("organization_id", organizationId);
  return expectQuerySuccess<T[]>(result as QueryResponse<T[]>, `select ${table} by organization`);
}

async function selectByIds<T>(
  supabase: ServiceRoleClient,
  table: string,
  columns: string,
  idColumn: string,
  ids: string[],
) {
  if (ids.length === 0) {
    return [] as T[];
  }

  const results = await Promise.all(
    chunkValues(ids).map(async (chunk) => {
      const result = await supabase.from(table).select(columns).in(idColumn, chunk);
      return expectQuerySuccess<T[]>(result as QueryResponse<T[]>, `select ${table} by ids`);
    }),
  );

  return results.flat();
}

async function deleteByOrganization(
  supabase: ServiceRoleClient,
  table: string,
  organizationId: string,
) {
  const result = await supabase.from(table).delete().eq("organization_id", organizationId);
  expectQuerySuccess(result, `delete ${table} by organization`);
}

async function deleteByIds(
  supabase: ServiceRoleClient,
  table: string,
  idColumn: string,
  ids: string[],
) {
  if (ids.length === 0) {
    return;
  }

  for (const chunk of chunkValues(ids)) {
    const result = await supabase.from(table).delete().in(idColumn, chunk);
    expectQuerySuccess(result, `delete ${table} by ids`);
  }
}

async function deleteSingleById(
  supabase: ServiceRoleClient,
  table: string,
  id: string,
) {
  const result = await supabase.from(table).delete().eq("id", id);
  expectQuerySuccess(result, `delete ${table} by id`);
}

function buildStorageTargets(rows: StorageRow[]) {
  return rows.map((row) => ({
    id: row.id,
    bucket: row.storage_bucket,
    path: row.storage_path,
  }));
}

export function parseArgs(argv: string[] = process.argv.slice(2)): WipeArgs {
  const emailArgIndex = argv.findIndex((value) => value === "--email");
  const emailValue =
    emailArgIndex >= 0 && argv[emailArgIndex + 1] ? argv[emailArgIndex + 1]!.trim().toLowerCase() : DEFAULT_TARGET_EMAIL;

  return {
    apply: argv.includes("--apply"),
    email: emailValue || DEFAULT_TARGET_EMAIL,
  };
}

export function groupStoragePaths(targets: StorageTarget[]) {
  const grouped = new Map<string, Set<string>>();

  targets.forEach((target) => {
    if (!grouped.has(target.bucket)) {
      grouped.set(target.bucket, new Set());
    }

    grouped.get(target.bucket)!.add(target.path);
  });

  return new Map(
    [...grouped.entries()].map(([bucket, paths]) => [bucket, [...paths].sort()]),
  );
}

export async function resolveWorkspaceTarget(
  supabase: ServiceRoleClient,
  email: string,
): Promise<WorkspaceTarget> {
  const usersResult = await supabase.auth.admin.listUsers();
  const users = expectQuerySuccess(usersResult, "list auth users").users ?? [];
  const normalizedEmail = email.trim().toLowerCase();
  const matchingUsers = users.filter((user) => user.email?.trim().toLowerCase() === normalizedEmail);

  if (matchingUsers.length !== 1) {
    throw new Error(`Expected exactly one auth user for ${normalizedEmail}, found ${matchingUsers.length}.`);
  }

  const user = matchingUsers[0]!;
  const membershipsResult = await supabase
    .from("organization_memberships")
    .select("id, organization_id, role")
    .eq("user_id", user.id);
  const memberships = expectQuerySuccess<OrganizationMembershipRow[]>(
    membershipsResult as QueryResponse<OrganizationMembershipRow[]>,
    "load organization memberships",
  );
  const clientMemberships = memberships.filter((membership) => membership.role === "client");

  if (clientMemberships.length !== 1) {
    throw new Error(`Expected exactly one client membership for ${normalizedEmail}, found ${clientMemberships.length}.`);
  }

  if (memberships.length !== 1) {
    throw new Error(`Expected ${normalizedEmail} to have exactly one total membership, found ${memberships.length}.`);
  }

  return {
    email: normalizedEmail,
    userId: user.id,
    membershipId: clientMemberships[0]!.id,
    organizationId: clientMemberships[0]!.organization_id,
  };
}

export async function loadWorkspaceSnapshot(
  supabase: ServiceRoleClient,
  target: WorkspaceTarget,
): Promise<WorkspaceSnapshot> {
  const [
    jobs,
    jobFiles,
    organizationFileBlobs,
    parts,
    drawingPreviewAssets,
    drawingExtractions,
    approvedPartRequirements,
    quoteRuns,
    vendorQuoteResults,
    vendorQuoteOffers,
    vendorQuoteArtifacts,
    publishedQuotePackages,
    publishedQuoteOptions,
    clientSelections,
    workQueue,
    auditEvents,
    pricingPolicies,
    projects,
  ] = await Promise.all([
    selectByOrganization<IdRow>(supabase, "jobs", "id", target.organizationId),
    selectByOrganization<StorageRow>(
      supabase,
      "job_files",
      "id, storage_bucket, storage_path",
      target.organizationId,
    ),
    selectByOrganization<StorageRow>(
      supabase,
      "organization_file_blobs",
      "id, storage_bucket, storage_path",
      target.organizationId,
    ),
    selectByOrganization<IdRow>(supabase, "parts", "id", target.organizationId),
    selectByOrganization<StorageRow>(
      supabase,
      "drawing_preview_assets",
      "id, storage_bucket, storage_path",
      target.organizationId,
    ),
    selectByOrganization<PartScopedRow>(supabase, "drawing_extractions", "id, part_id", target.organizationId),
    selectByOrganization<PartScopedRow>(
      supabase,
      "approved_part_requirements",
      "id, part_id",
      target.organizationId,
    ),
    selectByOrganization<JobScopedRow>(supabase, "quote_runs", "id, job_id", target.organizationId),
    selectByOrganization<PartScopedRow>(
      supabase,
      "vendor_quote_results",
      "id, part_id",
      target.organizationId,
    ),
    selectByOrganization<IdRow>(supabase, "vendor_quote_offers", "id", target.organizationId),
    selectByOrganization<StorageRow>(
      supabase,
      "vendor_quote_artifacts",
      "id, storage_bucket, storage_path",
      target.organizationId,
    ),
    selectByOrganization<JobScopedRow>(
      supabase,
      "published_quote_packages",
      "id, job_id",
      target.organizationId,
    ),
    selectByOrganization<IdRow>(supabase, "published_quote_options", "id", target.organizationId),
    selectByOrganization<IdRow>(supabase, "client_selections", "id", target.organizationId),
    selectByOrganization<IdRow>(supabase, "work_queue", "id", target.organizationId),
    selectByOrganization<IdRow>(supabase, "audit_events", "id", target.organizationId),
    selectByOrganization<IdRow>(supabase, "pricing_policies", "id", target.organizationId),
    selectByOrganization<IdRow>(supabase, "projects", "id", target.organizationId),
  ]);

  const projectIds = projects.map((project) => project.id);
  const jobIds = jobs.map((job) => job.id);

  const [projectJobs, projectMemberships, projectInvites, userPinnedProjects, userPinnedJobs] = await Promise.all([
    selectByIds<ProjectScopedRow>(supabase, "project_jobs", "id, project_id", "project_id", projectIds),
    selectByIds<ProjectScopedRow>(supabase, "project_memberships", "id, project_id", "project_id", projectIds),
    selectByIds<ProjectScopedRow>(supabase, "project_invites", "id, project_id", "project_id", projectIds),
    selectByIds<UserPinnedProjectRow>(
      supabase,
      "user_pinned_projects",
      "id, project_id, user_id",
      "project_id",
      projectIds,
    ),
    selectByIds<UserPinnedJobRow>(supabase, "user_pinned_jobs", "id, job_id, user_id", "job_id", jobIds),
  ]);

  return {
    jobs,
    jobFiles: buildStorageTargets(jobFiles),
    organizationFileBlobs: buildStorageTargets(organizationFileBlobs),
    parts,
    drawingPreviewAssets: buildStorageTargets(drawingPreviewAssets),
    drawingExtractions,
    approvedPartRequirements,
    quoteRuns,
    vendorQuoteResults,
    vendorQuoteOffers,
    vendorQuoteArtifacts: buildStorageTargets(vendorQuoteArtifacts),
    publishedQuotePackages,
    publishedQuoteOptions,
    clientSelections,
    workQueue,
    auditEvents,
    pricingPolicies,
    projects,
    projectJobs,
    projectMemberships,
    projectInvites,
    userPinnedProjects,
    userPinnedJobs,
  };
}

export function buildDryRunReport(
  target: WorkspaceTarget,
  snapshot: WorkspaceSnapshot,
  apply = false,
): DryRunReport {
  const storageTargets = [
    ...snapshot.jobFiles,
    ...snapshot.organizationFileBlobs,
    ...snapshot.drawingPreviewAssets,
    ...snapshot.vendorQuoteArtifacts,
  ];

  return {
    mode: apply ? "apply" : "dry_run",
    target,
    counts: {
      jobs: snapshot.jobs.length,
      projects: snapshot.projects.length,
      jobFiles: snapshot.jobFiles.length,
      organizationFileBlobs: snapshot.organizationFileBlobs.length,
      parts: snapshot.parts.length,
      drawingPreviewAssets: snapshot.drawingPreviewAssets.length,
      drawingExtractions: snapshot.drawingExtractions.length,
      approvedPartRequirements: snapshot.approvedPartRequirements.length,
      quoteRuns: snapshot.quoteRuns.length,
      vendorQuoteResults: snapshot.vendorQuoteResults.length,
      vendorQuoteOffers: snapshot.vendorQuoteOffers.length,
      vendorQuoteArtifacts: snapshot.vendorQuoteArtifacts.length,
      publishedQuotePackages: snapshot.publishedQuotePackages.length,
      publishedQuoteOptions: snapshot.publishedQuoteOptions.length,
      clientSelections: snapshot.clientSelections.length,
      workQueue: snapshot.workQueue.length,
      auditEvents: snapshot.auditEvents.length,
      pricingPolicies: snapshot.pricingPolicies.length,
      projectJobs: snapshot.projectJobs.length,
      projectMemberships: snapshot.projectMemberships.length,
      projectInvites: snapshot.projectInvites.length,
      userPinnedProjects: snapshot.userPinnedProjects.length,
      userPinnedJobs: snapshot.userPinnedJobs.length,
      storageObjects: storageTargets.length,
    },
    samples: {
      jobs: sampleIds(snapshot.jobs),
      projects: sampleIds(snapshot.projects),
      quoteRuns: sampleIds(snapshot.quoteRuns),
      publishedQuotePackages: sampleIds(snapshot.publishedQuotePackages),
      vendorQuoteResults: sampleIds(snapshot.vendorQuoteResults),
      jobFiles: snapshot.jobFiles.slice(0, SAMPLE_LIMIT).map((row) => row.path),
      vendorQuoteArtifacts: snapshot.vendorQuoteArtifacts.slice(0, SAMPLE_LIMIT).map((row) => row.path),
    },
    storageBuckets: countByBucket(storageTargets),
  };
}

export async function executeWorkspaceHardDelete(
  supabase: ServiceRoleClient,
  target: WorkspaceTarget,
  snapshot: WorkspaceSnapshot,
  log: (message: string) => void = console.log,
) {
  const storageGroups = groupStoragePaths([
    ...snapshot.jobFiles,
    ...snapshot.organizationFileBlobs,
    ...snapshot.drawingPreviewAssets,
    ...snapshot.vendorQuoteArtifacts,
  ]);

  for (const [bucket, paths] of storageGroups.entries()) {
    if (paths.length === 0) {
      continue;
    }

    log(`Removing storage objects from ${bucket} (${paths.length})`);

    for (const chunk of chunkValues(paths)) {
      const result = await supabase.storage.from(bucket).remove(chunk);
      expectQuerySuccess(result as QueryResponse<unknown>, `remove storage from ${bucket}`);
    }
  }

  const deletePhase = async (label: string, callback: () => Promise<void>) => {
    log(label);
    await callback();
  };

  await deletePhase(`Deleting client selections (${snapshot.clientSelections.length})`, async () => {
    await deleteByOrganization(supabase, "client_selections", target.organizationId);
  });
  await deletePhase(`Deleting published quote options (${snapshot.publishedQuoteOptions.length})`, async () => {
    await deleteByOrganization(supabase, "published_quote_options", target.organizationId);
  });
  await deletePhase(`Deleting vendor quote artifacts (${snapshot.vendorQuoteArtifacts.length})`, async () => {
    await deleteByOrganization(supabase, "vendor_quote_artifacts", target.organizationId);
  });
  await deletePhase(`Deleting vendor quote offers (${snapshot.vendorQuoteOffers.length})`, async () => {
    await deleteByOrganization(supabase, "vendor_quote_offers", target.organizationId);
  });
  await deletePhase(`Deleting vendor quote results (${snapshot.vendorQuoteResults.length})`, async () => {
    await deleteByOrganization(supabase, "vendor_quote_results", target.organizationId);
  });
  await deletePhase(`Deleting drawing preview assets (${snapshot.drawingPreviewAssets.length})`, async () => {
    await deleteByOrganization(supabase, "drawing_preview_assets", target.organizationId);
  });
  await deletePhase(`Deleting drawing extractions (${snapshot.drawingExtractions.length})`, async () => {
    await deleteByOrganization(supabase, "drawing_extractions", target.organizationId);
  });
  await deletePhase(
    `Deleting approved part requirements (${snapshot.approvedPartRequirements.length})`,
    async () => {
      await deleteByOrganization(supabase, "approved_part_requirements", target.organizationId);
    },
  );
  await deletePhase(`Deleting work queue rows (${snapshot.workQueue.length})`, async () => {
    await deleteByOrganization(supabase, "work_queue", target.organizationId);
  });
  await deletePhase(`Deleting audit events (${snapshot.auditEvents.length})`, async () => {
    await deleteByOrganization(supabase, "audit_events", target.organizationId);
  });
  await deletePhase(`Deleting published quote packages (${snapshot.publishedQuotePackages.length})`, async () => {
    await deleteByOrganization(supabase, "published_quote_packages", target.organizationId);
  });
  await deletePhase(`Deleting quote runs (${snapshot.quoteRuns.length})`, async () => {
    await deleteByOrganization(supabase, "quote_runs", target.organizationId);
  });
  await deletePhase(`Deleting parts (${snapshot.parts.length})`, async () => {
    await deleteByOrganization(supabase, "parts", target.organizationId);
  });
  await deletePhase(`Deleting job files (${snapshot.jobFiles.length})`, async () => {
    await deleteByOrganization(supabase, "job_files", target.organizationId);
  });
  await deletePhase(
    `Deleting organization file blobs (${snapshot.organizationFileBlobs.length})`,
    async () => {
      await deleteByOrganization(supabase, "organization_file_blobs", target.organizationId);
    },
  );
  await deletePhase(`Deleting pinned projects (${snapshot.userPinnedProjects.length})`, async () => {
    await deleteByIds(
      supabase,
      "user_pinned_projects",
      "project_id",
      snapshot.userPinnedProjects.map((row) => row.project_id),
    );
  });
  await deletePhase(`Deleting pinned jobs (${snapshot.userPinnedJobs.length})`, async () => {
    await deleteByIds(
      supabase,
      "user_pinned_jobs",
      "job_id",
      snapshot.userPinnedJobs.map((row) => row.job_id),
    );
  });
  await deletePhase(`Deleting project invites (${snapshot.projectInvites.length})`, async () => {
    await deleteByIds(
      supabase,
      "project_invites",
      "project_id",
      snapshot.projectInvites.map((row) => row.project_id),
    );
  });
  await deletePhase(`Deleting project memberships (${snapshot.projectMemberships.length})`, async () => {
    await deleteByIds(
      supabase,
      "project_memberships",
      "project_id",
      snapshot.projectMemberships.map((row) => row.project_id),
    );
  });
  await deletePhase(`Deleting project-job links (${snapshot.projectJobs.length})`, async () => {
    await deleteByIds(
      supabase,
      "project_jobs",
      "project_id",
      snapshot.projectJobs.map((row) => row.project_id),
    );
  });
  await deletePhase(`Deleting projects (${snapshot.projects.length})`, async () => {
    await deleteByOrganization(supabase, "projects", target.organizationId);
  });
  await deletePhase(`Deleting jobs (${snapshot.jobs.length})`, async () => {
    await deleteByOrganization(supabase, "jobs", target.organizationId);
  });
  await deletePhase(`Deleting pricing policies (${snapshot.pricingPolicies.length})`, async () => {
    await deleteByOrganization(supabase, "pricing_policies", target.organizationId);
  });
  await deletePhase(`Deleting organization membership ${target.membershipId}`, async () => {
    await deleteSingleById(supabase, "organization_memberships", target.membershipId);
  });

  log(`Deleting auth user ${target.userId}`);
  const deleteUserResult = await supabase.auth.admin.deleteUser(target.userId);
  expectQuerySuccess(deleteUserResult, "delete auth user");
}

export async function runWorkspaceWipe(
  supabase: ServiceRoleClient,
  args: WipeArgs,
  log: (message: string) => void = console.log,
) {
  const target = await resolveWorkspaceTarget(supabase, args.email);
  const snapshot = await loadWorkspaceSnapshot(supabase, target);
  const report = buildDryRunReport(target, snapshot, args.apply);

  log(JSON.stringify(report, null, 2));

  if (!args.apply) {
    return report;
  }

  await executeWorkspaceHardDelete(supabase, target, snapshot, log);
  return report;
}

async function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const supabase = createServiceClient(config) as unknown as ServiceRoleClient;
  await runWorkspaceWipe(supabase, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

