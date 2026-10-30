// Jarvis PWA admission (OVD-803). The client never decides access.
// Slice 1 reuses the OVD-740 platform-admin allowlist (private.platform_admin_emails)
// and the existing current_user_has_aal2() check. No new schema.

export const JARVIS_PWA_FLAG = "JARVIS_PWA_ENABLED";
export const JARVIS_PWA_SESSION_PATH = "/api/jarvis/session";

const NOT_FOUND_BODY = "Not found\n";
const SESSION_BODY = '{"thread":{"state":"empty"}}';
const AAL2_BODY = '{"error":"aal2_required"}';
const MAX_JSON_CHARS = 65_536;
const LOOKUP_TIMEOUT_MS = 8_000;

const NOT_FOUND_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export type JarvisPwaRoute = "session" | "other";

export type JarvisGateCaller = {
  readonly userId: string;
  readonly allowlisted: boolean;
  readonly aal2: boolean;
};

export type JarvisGateDeps = {
  readonly enabled: boolean;
  readonly lookup: (token: string, signal: AbortSignal) => Promise<JarvisGateCaller | null>;
};

export function isJarvisPwaEnabled(value: string | undefined): boolean {
  return value === "1";
}

export function jarvisNotFoundResponse(): Response {
  return new Response(NOT_FOUND_BODY, { status: 404, headers: NOT_FOUND_HEADERS });
}

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function aal2Required(): Response {
  return new Response(AAL2_BODY, {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function admitted(): Response {
  return new Response(SESSION_BODY, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length < 16 || token.length > 8192) return null;
  return token;
}

export async function handleJarvisPwaRequest(
  request: Request,
  deps: JarvisGateDeps,
  route: JarvisPwaRoute,
): Promise<Response> {
  if (!deps.enabled) return jarvisNotFoundResponse();
  const token = bearerToken(request);
  if (!token) return unauthorized();

  let caller: JarvisGateCaller | null;
  try {
    caller = await deps.lookup(token, request.signal);
  } catch {
    console.error("jarvis-pwa: admission check failed");
    return jarvisNotFoundResponse();
  }
  if (!caller) return unauthorized();
  if (!caller.allowlisted) return jarvisNotFoundResponse();
  if (route !== "session" || request.method !== "GET") return jarvisNotFoundResponse();
  if (!caller.aal2) return aal2Required();
  return admitted();
}

export function createJarvisPwaHandler(deps: JarvisGateDeps, route: JarvisPwaRoute) {
  return async (request: Request): Promise<Response> => {
    try {
      return await handleJarvisPwaRequest(request, deps, route);
    } catch {
      console.error("jarvis-pwa: admission check failed");
      return jarvisNotFoundResponse();
    }
  };
}

function httpsOrigin(value: string | undefined): string {
  const url = new URL(value ?? "");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("unavailable");
  }
  return url.origin;
}

function requiredSecret(value: string | undefined): string {
  if (!value || value.trim() !== value) throw new Error("unavailable");
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_JSON_CHARS) throw new Error("unavailable");
  return JSON.parse(text) as unknown;
}

async function rpcFlag(
  send: typeof fetch,
  supabaseUrl: string,
  headers: Record<string, string>,
  name: "api_get_is_platform_admin" | "current_user_has_aal2",
  signal: AbortSignal,
): Promise<boolean> {
  const response = await send(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  return (await readJson(response)) === true;
}

function lookupSignal(parent: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  return AbortSignal.any([parent, timeout]);
}

export function createJarvisPwaDeps(
  environment: Readonly<Record<string, string | undefined>>,
  send: typeof fetch = fetch,
): JarvisGateDeps {
  const enabled = isJarvisPwaEnabled(environment.JARVIS_PWA_ENABLED);
  return {
    enabled,
    async lookup(token, parent) {
      const signal = lookupSignal(parent);
      const supabaseUrl = httpsOrigin(environment.SUPABASE_URL ?? environment.VITE_SUPABASE_URL);
      const apiKey = requiredSecret(
        environment.SUPABASE_ANON_KEY
          ?? environment.SUPABASE_PUBLISHABLE_KEY
          ?? environment.VITE_SUPABASE_PUBLISHABLE_KEY,
      );
      const headers = {
        apikey: apiKey,
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      const userResponse = await send(`${supabaseUrl}/auth/v1/user`, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
      if (userResponse.status === 401 || userResponse.status === 403) {
        await userResponse.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!userResponse.ok) {
        await userResponse.body?.cancel().catch(() => undefined);
        throw new Error("unavailable");
      }
      const user = await readJson(userResponse);
      if (!user || typeof user !== "object" || typeof (user as { id?: unknown }).id !== "string") {
        throw new Error("unavailable");
      }
      const [allowlisted, aal2] = await Promise.all([
        rpcFlag(send, supabaseUrl, headers, "api_get_is_platform_admin", signal),
        rpcFlag(send, supabaseUrl, headers, "current_user_has_aal2", signal),
      ]);
      return { userId: (user as { id: string }).id, allowlisted, aal2 };
    },
  };
}
