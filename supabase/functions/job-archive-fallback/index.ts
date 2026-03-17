import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.7";
import {
  ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE,
  ArchivedDeleteFlowError,
  executeArchivedDelete,
  type ArchivedDeletePlan,
  type StorageCandidate,
} from "./delete-flow.ts";

type JobArchiveAction = "archive" | "unarchive" | "delete";

type JobArchivePayload = {
  action?: JobArchiveAction;
  jobId?: string;
};

const JOB_ARCHIVING_UNAVAILABLE_MESSAGE =
  "Part archiving is unavailable in this environment until the archive schema is applied.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const supabaseDbUrl = Deno.env.get("SUPABASE_DB_URL");
const supabaseServiceRoleKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseAnonKey || !supabaseDbUrl) {
  throw new Error("Missing Supabase function environment configuration.");
}

const sql = postgres(supabaseDbUrl, {
  prepare: false,
  max: 1,
});

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Transaction = postgres.TransactionSql<object>;

type JobRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  archived_at: string | null;
};

async function hasRelation(
  transaction: Transaction,
  relationName: string,
): Promise<boolean> {
  const rows = await transaction<{ oid: string | null }[]>`
    select to_regclass(${relationName})::text as oid
  `;

  return rows[0]?.oid !== null;
}

async function hasColumn(
  transaction: Transaction,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await transaction<{ present: boolean }[]>`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = ${tableName}
        and column_name = ${columnName}
    ) as present
  `;

  return Boolean(rows[0]?.present);
}

async function hasFunction(
  transaction: Transaction,
  regprocedure: string,
): Promise<boolean> {
  const rows = await transaction<{ present: boolean }[]>`
    select to_regprocedure(${regprocedure}) is not null as present
  `;

  return Boolean(rows[0]?.present);
}

function dedupeStorageCandidates(candidates: StorageCandidate[]): StorageCandidate[] {
  const seen = new Set<string>();
  const deduped: StorageCandidate[] = [];

  for (const candidate of candidates) {
    const bucket = candidate.bucket.trim();
    const path = candidate.path.trim();

    if (!bucket || !path) {
      continue;
    }

    const key = `${bucket}:${path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({ bucket, path });
  }

  return deduped;
}

async function getAuthorizedJob(
  transaction: Transaction,
  jobId: string,
  userId: string,
  action: JobArchiveAction,
): Promise<JobRow> {
  const hasArchivedAt = await hasColumn(transaction, "jobs", "archived_at");

  if (!hasArchivedAt) {
    throw new HttpError(500, JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
  }

  const jobs = await transaction<JobRow[]>`
    select id, organization_id, created_by, archived_at
    from public.jobs
    where id = ${jobId}::uuid
    limit 1
  `;

  const job = jobs[0];

  if (!job) {
    throw new HttpError(404, `Job ${jobId} not found.`);
  }

  const hasUserCanEditJob = await hasFunction(transaction, "public.user_can_edit_job(uuid)");
  const allowed =
    hasUserCanEditJob
      ? Boolean(
          (
            await transaction<{ allowed: boolean }[]>`
              select public.user_can_edit_job(${job.id}::uuid) as allowed
            `
          )[0]?.allowed,
        )
      : job.created_by === userId ||
        Boolean(
          (
            await transaction<{ allowed: boolean }[]>`
              select exists (
                select 1
                from public.organization_memberships
                where user_id = ${userId}::uuid
                  and organization_id = ${job.organization_id}::uuid
              ) as allowed
            `
          )[0]?.allowed,
        );

  if (!allowed) {
    throw new HttpError(403, `You do not have permission to ${action} this part.`);
  }

  return job;
}

async function collectArchivedDeletePlan(
  transaction: Transaction,
  jobId: string,
  userId: string,
): Promise<ArchivedDeletePlan> {
  const job = await getAuthorizedJob(transaction, jobId, userId, "delete");

  if (!job.archived_at) {
    throw new HttpError(400, "Only archived parts can be deleted.");
  }

  const orphanBlobs = await transaction<{ id: string; storage_bucket: string; storage_path: string }[]>`
    select distinct blob.id, blob.storage_bucket, blob.storage_path
    from public.organization_file_blobs blob
    join public.job_files file on file.blob_id = blob.id
    where file.job_id = ${job.id}::uuid
      and not exists (
        select 1
        from public.job_files other
        where other.blob_id = blob.id
          and other.job_id <> ${job.id}::uuid
      )
  `;

  const orphanBlobIds = orphanBlobs.map((blob) => blob.id);
  const orphanBlobIdArray = sql.array(orphanBlobIds, "uuid");

  const drawingPreviewAssets = await transaction<{ storage_bucket: string; storage_path: string }[]>`
    select distinct asset.storage_bucket, asset.storage_path
    from public.drawing_preview_assets asset
    join public.parts part on part.id = asset.part_id
    where part.job_id = ${job.id}::uuid
      and not exists (
        select 1
        from public.drawing_preview_assets other_asset
        join public.parts other_part on other_part.id = other_asset.part_id
        where other_asset.storage_bucket = asset.storage_bucket
          and other_asset.storage_path = asset.storage_path
          and other_part.job_id <> ${job.id}::uuid
      )
  `;

  const vendorQuoteArtifacts = await transaction<{ storage_bucket: string; storage_path: string }[]>`
    select distinct artifact.storage_bucket, artifact.storage_path
    from public.vendor_quote_artifacts artifact
    join public.vendor_quote_results result on result.id = artifact.vendor_quote_result_id
    join public.parts part on part.id = result.part_id
    where part.job_id = ${job.id}::uuid
  `;

  const unownedJobFiles = await transaction<{ storage_bucket: string; storage_path: string }[]>`
    select distinct file.storage_bucket, file.storage_path
    from public.job_files file
    where file.job_id = ${job.id}::uuid
      and file.blob_id is null
      and not exists (
        select 1
        from public.job_files other
        where other.storage_bucket = file.storage_bucket
          and other.storage_path = file.storage_path
          and other.job_id <> ${job.id}::uuid
      )
      and not exists (
        select 1
        from public.organization_file_blobs blob
        where blob.storage_bucket = file.storage_bucket
          and blob.storage_path = file.storage_path
          and not (blob.id = any(${orphanBlobIdArray}))
      )
  `;

  return {
    job,
    orphanBlobIds,
    storageCandidates: dedupeStorageCandidates([
      ...orphanBlobs.map((blob) => ({
        bucket: blob.storage_bucket,
        path: blob.storage_path,
      })),
      ...drawingPreviewAssets.map((asset) => ({
        bucket: asset.storage_bucket,
        path: asset.storage_path,
      })),
      ...vendorQuoteArtifacts.map((artifact) => ({
        bucket: artifact.storage_bucket,
        path: artifact.storage_path,
      })),
      ...unownedJobFiles.map((file) => ({
        bucket: file.storage_bucket,
        path: file.storage_path,
      })),
    ]),
  };
}

async function removeStorageCandidates(jobId: string, storageCandidates: StorageCandidate[]): Promise<boolean> {
  if (storageCandidates.length === 0) {
    return true;
  }

  const serviceRoleKey = supabaseServiceRoleKey;

  if (!serviceRoleKey) {
    return false;
  }

  const serviceRoleClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const candidatesByBucket = new Map<string, string[]>();

  for (const candidate of storageCandidates) {
    const paths = candidatesByBucket.get(candidate.bucket) ?? [];
    paths.push(candidate.path);
    candidatesByBucket.set(candidate.bucket, paths);
  }

  for (const [bucket, paths] of candidatesByBucket.entries()) {
    const { error } = await serviceRoleClient.storage.from(bucket).remove(paths);

    if (error) {
      console.error("job-archive-fallback storage cleanup failed", {
        jobId,
        bucket,
        paths,
        error,
      });
      return false;
    }
  }

  return true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return json(401, { error: "You must be signed in to continue." });
  }

  let payload: JobArchivePayload;

  try {
    payload = (await request.json()) as JobArchivePayload;
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  if (!payload.jobId || !payload.action) {
    return json(400, { error: "jobId and action are required." });
  }

  if (!["archive", "unarchive", "delete"].includes(payload.action)) {
    return json(400, { error: "Unsupported archive action." });
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return json(401, { error: userError?.message ?? "You must be signed in to continue." });
  }

  const provider = typeof user.app_metadata?.provider === "string" ? user.app_metadata.provider : "";

  if (!user.email_confirmed_at && !["google", "azure", "apple"].includes(provider)) {
    return json(403, {
      error: "Verify your email or sign in with Google, Microsoft, or Apple before performing this action.",
    });
  }

  try {
    if (payload.action === "delete") {
      const deletePlan = await sql.begin((transaction) =>
        collectArchivedDeletePlan(transaction, payload.jobId!, user.id),
      );
      const jobId = await executeArchivedDelete({
        deletePlan,
        hasStorageServiceRoleKey: Boolean(supabaseServiceRoleKey),
        missingServiceRoleMessage:
          "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
        storageCleanupFailureMessage: ARCHIVED_DELETE_STORAGE_CLEANUP_FAILED_MESSAGE,
        removeStorageCandidates,
        commitDelete: async (currentDeletePlan) => {
          await sql.begin(async (transaction) => {
            const job = await getAuthorizedJob(transaction, payload.jobId!, user.id, "delete");

            if (!job.archived_at) {
              throw new HttpError(400, "Only archived parts can be deleted.");
            }

            await transaction`
              delete from public.published_quote_options option_row
              using public.published_quote_packages package_row
              where option_row.package_id = package_row.id
                and package_row.job_id = ${job.id}::uuid
            `;

            await transaction`
              select public.log_audit_event(
                ${job.organization_id}::uuid,
                'job.deleted',
                jsonb_build_object(
                  'jobId', ${job.id}::uuid,
                  'archivedAt', ${job.archived_at},
                  'deleteScope', 'single'
                ),
                ${job.id}::uuid,
                null
              )
            `;

            await transaction`
              delete from public.jobs
              where id = ${job.id}::uuid
            `;

            if (currentDeletePlan.orphanBlobIds.length > 0) {
              await transaction`
                delete from public.organization_file_blobs blob
                where blob.id = any(${sql.array(currentDeletePlan.orphanBlobIds, "uuid")})
                  and not exists (
                    select 1
                    from public.job_files file
                    where file.blob_id = blob.id
                  )
              `;
            }
          });
        },
      });

      return json(200, { jobId });
    }

    const jobId = await sql.begin(async (transaction) => {
      const job = await getAuthorizedJob(transaction, payload.jobId!, user.id, payload.action);

      if (payload.action === "archive") {
        const hasProjectId = await hasColumn(transaction, "jobs", "project_id");
        let nextProjectId: string | null = null;

        if (
          hasProjectId &&
          (await hasRelation(transaction, "public.project_jobs")) &&
          (await hasRelation(transaction, "public.projects")) &&
          (await hasColumn(transaction, "projects", "archived_at"))
        ) {
          const rows = await transaction<{ project_id: string | null }[]>`
            select project_job.project_id
            from public.project_jobs project_job
            join public.projects project_row on project_row.id = project_job.project_id
            where project_job.job_id = ${job.id}::uuid
              and project_row.archived_at is null
            order by project_job.created_at asc
            limit 1
          `;
          nextProjectId = rows[0]?.project_id ?? null;
        }

        if (hasProjectId) {
          await transaction`
            update public.jobs
            set
              archived_at = coalesce(archived_at, timezone('utc', now())),
              project_id = ${nextProjectId}::uuid,
              updated_at = timezone('utc', now())
            where id = ${job.id}::uuid
          `;
        } else {
          await transaction`
            update public.jobs
            set
              archived_at = coalesce(archived_at, timezone('utc', now())),
              updated_at = timezone('utc', now())
            where id = ${job.id}::uuid
          `;
        }

        return job.id;
      }

      if (payload.action === "unarchive") {
        await transaction`
          update public.jobs
          set
            archived_at = null,
            updated_at = timezone('utc', now())
          where id = ${job.id}::uuid
        `;

        return job.id;
      }

      throw new HttpError(400, "Unsupported archive action.");
    });

    return json(200, { jobId });
  } catch (error) {
    if (error instanceof HttpError || error instanceof ArchivedDeleteFlowError) {
      return json(error.status, { error: error.message });
    }

    console.error("job-archive-fallback failed", error);
    return json(500, {
      error: error instanceof Error ? error.message : "Failed to update part archive state.",
    });
  }
});
