import { createClient } from "npm:@supabase/supabase-js@2";

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
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error("Missing Supabase function environment configuration.");
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

  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: memberships, error: membershipError } = await serviceClient
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);

  if (membershipError) {
    return json(500, { error: membershipError.message });
  }

  const organizationId = memberships?.[0]?.organization_id;

  if (!organizationId) {
    return json(400, { error: "A home workspace is still being prepared for this account." });
  }

  const description = typeof payload.description === "string" ? payload.description.trim() : "";

  const { data: project, error: projectError } = await serviceClient
    .from("projects")
    .insert({
      organization_id: organizationId,
      owner_user_id: user.id,
      name,
      description: description || null,
    })
    .select("id")
    .single();

  if (projectError || !project?.id) {
    return json(500, { error: projectError?.message ?? "Failed to create project." });
  }

  const { error: projectMembershipError } = await serviceClient
    .from("project_memberships")
    .upsert(
      {
        project_id: project.id,
        user_id: user.id,
        role: "owner",
      },
      {
        onConflict: "project_id,user_id",
      },
    );

  if (projectMembershipError) {
    await serviceClient.from("projects").delete().eq("id", project.id);
    return json(500, { error: projectMembershipError.message });
  }

  return json(200, { projectId: project.id });
});
