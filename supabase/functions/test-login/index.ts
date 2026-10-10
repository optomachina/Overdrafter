import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Test-only authentication bypass for E2E testing.
 * 
 * SECURITY BOUNDARY:
 * - Only available when VERCEL_ENV !== "production" and NODE_ENV !== "production"
 * - Only accepts requests from localhost origins
 * - Only works against local Supabase instances (not production URLs)
 * - Requires explicit environment variable flag to enable
 * 
 * This allows E2E tests to authenticate as seeded test users without
 * going through the full OAuth flow, while being impossible to enable
 * in production deployments.
 */

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

function isProductionEnvironment(): boolean {
  const nodeEnv = Deno.env.get("NODE_ENV")?.toLowerCase();
  const vercelEnv = Deno.env.get("VERCEL_ENV")?.toLowerCase();
  const appEnv = Deno.env.get("APP_ENV")?.toLowerCase();

  return (
    nodeEnv === "production" ||
    nodeEnv === "prod" ||
    vercelEnv === "production" ||
    vercelEnv === "prod" ||
    appEnv === "production" ||
    appEnv === "prod"
  );
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

    const match = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());

    if (match) {
      return match;
    }

    if (data.users.length < 200) {
      return null;
    }

    page += 1;
  }
}

export async function handleTestLoginRequest(request: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase function environment configuration.");
  }

  const supabaseHostname = new URL(supabaseUrl).hostname;
  const testLoginEnabled = Deno.env.get("ENABLE_TEST_LOGIN") === "1";

  const rejectTestLogin = (reason: string, publicError: string): Response => {
    console.warn(`test-login rejected: ${reason}`);
    return json(404, { error: publicError }, parseOrigin(request.headers.get("Origin"))?.origin);
  };
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

  // Security boundary 1: Fail closed in production
  if (isProductionEnvironment()) {
    return rejectTestLogin("production environment detected", "Not found.");
  }

  // Security boundary 2: Must be explicitly enabled
  if (!testLoginEnabled) {
    return rejectTestLogin("ENABLE_TEST_LOGIN not set", "Not found.");
  }

  // Security boundary 3: Only localhost Supabase
  if (!isLoopbackHost(supabaseHostname)) {
    return rejectTestLogin("non-localhost Supabase URL", "Not available outside local development.");
  }

  // Security boundary 4: Only localhost browser
  if (!parsedOrigin || !isLoopbackHost(parsedOrigin.hostname)) {
    return rejectTestLogin("non-localhost origin", "Not available outside local development.");
  }

  let payload: { email?: unknown; redirectPath?: unknown; appOrigin?: unknown };

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

  const email = typeof payload.email === "string" ? payload.email : null;

  if (!email) {
    return json(400, { error: "Email is required." }, parsedOrigin.origin);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  let user: { id: string; email?: string | null } | null = null;

  try {
    user = await findUserByEmail(admin, email);
  } catch (usersError) {
    console.error("test-login listUsers failed", usersError);
    return json(500, { error: "Failed to load the test user." }, parsedOrigin.origin);
  }

  if (!user) {
    return json(404, { error: `User ${email} was not found.` }, parsedOrigin.origin);
  }

  const redirectPath = sanitizeRedirectPath(payload.redirectPath);
  const redirectTo = `${appOrigin}/auth/callback?redirect=${encodeURIComponent(redirectPath)}`;
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: {
      redirectTo,
    },
  });

  if (linkError) {
    console.error("test-login generateLink failed", linkError);
    return json(500, { error: "Failed to create the test login link." }, parsedOrigin.origin);
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
}

Deno.serve(handleTestLoginRequest);
