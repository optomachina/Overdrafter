import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.7";

type CreateProjectPayload = {
  name?: string;
  description?: string | null;
};

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

  let payload: CreateProjectPayload;

  try {
    payload = (await request.json()) as CreateProjectPayload;
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const name = payload.name?.trim() ?? "";

  if (!name) {
    return json(400, { error: "Project name is required." });
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

  const description = typeof payload.description === "string" ? payload.description.trim() : null;

  try {
    const projectId = await sql.begin(async (transaction) => {
      const memberships = await transaction<{ organization_id: string }[]>`
        select organization_id
        from public.organization_memberships
        where user_id = ${user.id}::uuid
        order by created_at asc
        limit 1
      `;

      const organizationId = memberships[0]?.organization_id;

      if (!organizationId) {
        throw new HttpError(400, "A home workspace is still being prepared for this account.");
      }

      const projects = await transaction<{ id: string }[]>`
        insert into public.projects (
          organization_id,
          owner_user_id,
          name,
          description
        )
        values (
          ${organizationId}::uuid,
          ${user.id}::uuid,
          ${name},
          ${description}
        )
        returning id
      `;

      const projectId = projects[0]?.id;

      if (!projectId) {
        throw new HttpError(500, "Failed to create project.");
      }

      await transaction`
        insert into public.project_memberships (
          project_id,
          user_id,
          role
        )
        values (
          ${projectId}::uuid,
          ${user.id}::uuid,
          'owner'::public.project_role
        )
        on conflict (project_id, user_id) do update
          set role = 'owner'::public.project_role
      `;

      return projectId;
    });

    return json(200, { projectId });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message });
    }

    console.error("create-project-fallback failed", error);
    return json(500, {
      error: error instanceof Error ? error.message : "Failed to create project.",
    });
  }
});
