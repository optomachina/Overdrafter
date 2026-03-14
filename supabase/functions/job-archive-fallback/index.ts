import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.7";

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

async function hasRelation(
  transaction: postgres.TransactionSql<object>,
  relationName: string,
): Promise<boolean> {
  const rows = await transaction<{ oid: string | null }[]>`
    select to_regclass(${relationName})::text as oid
  `;

  return rows[0]?.oid !== null;
}

async function hasColumn(
  transaction: postgres.TransactionSql<object>,
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
  transaction: postgres.TransactionSql<object>,
  regprocedure: string,
): Promise<boolean> {
  const rows = await transaction<{ present: boolean }[]>`
    select to_regprocedure(${regprocedure}) is not null as present
  `;

  return Boolean(rows[0]?.present);
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
    const jobId = await sql.begin(async (transaction) => {
      const hasArchivedAt = await hasColumn(transaction, "jobs", "archived_at");

      if (!hasArchivedAt) {
        throw new HttpError(500, JOB_ARCHIVING_UNAVAILABLE_MESSAGE);
      }

      const jobs = await transaction<{
        id: string;
        organization_id: string;
        created_by: string | null;
        archived_at: string | null;
      }[]>`
        select id, organization_id, created_by, archived_at
        from public.jobs
        where id = ${payload.jobId}::uuid
        limit 1
      `;

      const job = jobs[0];

      if (!job) {
        throw new HttpError(404, `Job ${payload.jobId} not found.`);
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
          : job.created_by === user.id ||
            Boolean(
              (
                await transaction<{ allowed: boolean }[]>`
                  select exists (
                    select 1
                    from public.organization_memberships
                    where user_id = ${user.id}::uuid
                      and organization_id = ${job.organization_id}::uuid
                  ) as allowed
                `
              )[0]?.allowed,
            );

      if (!allowed) {
        throw new HttpError(403, `You do not have permission to ${payload.action} this part.`);
      }

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

      if (!job.archived_at) {
        throw new HttpError(400, "Only archived parts can be deleted.");
      }

      await transaction`
        delete from public.jobs
        where id = ${job.id}::uuid
      `;

      return job.id;
    });

    return json(200, { jobId });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message });
    }

    console.error("job-archive-fallback failed", error);
    return json(500, {
      error: error instanceof Error ? error.message : "Failed to update part archive state.",
    });
  }
});
