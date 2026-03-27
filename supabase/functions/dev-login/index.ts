import { createClient } from "npm:@supabase/supabase-js@2";

const DEV_LOGIN_EMAIL = "dmrifles@gmail.com";
const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

function json(status: number, body: Record<string, unknown>, origin?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Content-Type": "application/json",
    },
  });
}

function isLoopbackHost(hostname: string | null): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function sanitizeRedirectPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function parseOrigin(value: string | null): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function findUserByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<{ id: string; email?: string | null } | null> {
  let page = 1;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });

    if (error) {
      throw error;
    }

    const match = data.users.find((candidate) => candidate.email?.toLowerCase() === email);

    if (match) {
      return match;
    }

    if (data.users.length < 200) {
      return null;
    }

    page += 1;
  }
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase function environment configuration.");
}

const supabaseHostname = new URL(supabaseUrl).hostname;

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  const parsedOrigin = parseOrigin(origin);

  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...corsHeaders,
        ...(parsedOrigin ? { "Access-Control-Allow-Origin": parsedOrigin.origin } : {}),
      },
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." }, parsedOrigin?.origin);
  }

  // Security boundary:
  // - this shortcut is only available when the function is running against a
  //   local Supabase stack
  // - requests must originate from a localhost browser session
  // - the returned redirect stays inside the local app
  if (!isLoopbackHost(supabaseHostname) || !parsedOrigin || !isLoopbackHost(parsedOrigin.hostname)) {
    return json(404, { error: "Not available outside local development." }, parsedOrigin?.origin);
  }

  let payload: { redirectPath?: unknown; appOrigin?: unknown };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json(400, { error: "Invalid request body." }, parsedOrigin.origin);
  }

  const appOrigin =
    typeof payload.appOrigin === "string" && parseOrigin(payload.appOrigin)?.origin === parsedOrigin.origin
      ? parsedOrigin.origin
      : null;

  if (!appOrigin) {
    return json(400, { error: "Invalid app origin." }, parsedOrigin.origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  let user: { id: string; email?: string | null } | null = null;

  try {
    user = await findUserByEmail(admin, DEV_LOGIN_EMAIL);
  } catch (usersError) {
    console.error("dev-login listUsers failed", usersError);
    return json(500, { error: "Failed to load the dev login user." }, parsedOrigin.origin);
  }

  if (!user) {
    return json(404, { error: `User ${DEV_LOGIN_EMAIL} was not found.` }, parsedOrigin.origin);
  }

  const redirectPath = sanitizeRedirectPath(payload.redirectPath);
  const redirectTo = `${appOrigin}/auth/callback?redirect=${encodeURIComponent(redirectPath)}`;
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: DEV_LOGIN_EMAIL,
    options: {
      redirectTo,
    },
  });

  if (linkError) {
    console.error("dev-login generateLink failed", linkError);
    return json(500, { error: "Failed to create the dev login link." }, parsedOrigin.origin);
  }

  const actionLink = linkData.properties.action_link;

  if (!actionLink) {
    return json(500, { error: "Supabase did not return a login link." }, parsedOrigin.origin);
  }

  return json(
    200,
    {
      actionLink,
      userId: user.id,
      redirectPath,
    },
    parsedOrigin.origin,
  );
});
