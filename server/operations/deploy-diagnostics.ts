/**
 * OVD-838 deployment diagnostics. Reports which Supabase project a deployment
 * targets as a bare project ref derived from the configured URLs; it never
 * reads or echoes keys. See docs/staging-env-wiring.md.
 */
export const PRODUCTION_SUPABASE_REF = "ozuatdcakezjtevztjlr";
// Must match STAGING_SUPABASE_REF in worker/scripts/deploy-cloud-run.sh (contract-tested).
export const STAGING_SUPABASE_REF = "ldmambwtksfvqdufhaam";

type Environment = Readonly<Record<string, string | undefined>>;

export type DeployEnvironment = "production" | "preview" | "development" | "local";

export type DeployDiagnostics = {
  service: "overdrafter-web";
  deployEnvironment: DeployEnvironment;
  /** Ref behind SUPABASE_URL, used by server functions. */
  serverSupabaseRef: string | null;
  /**
   * Ref behind the runtime VITE_SUPABASE_URL. The browser bundle inlines this at
   * build time, so the two only agree when the deployment was rebuilt after the
   * value last changed.
   */
  browserSupabaseRef: string | null;
  expectedSupabaseRef: string | null;
  /** False when a ref is missing or differs from the one this environment requires. */
  supabaseRefMatchesEnvironment: boolean | null;
};

/**
 * Hosted Supabase refs are 20 lowercase alphanumerics; anything else is not reported.
 * Mirrored by supabaseProjectRef in worker/src/httpServer.ts; keep them in sync.
 */
export function supabaseProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(new URL(url).hostname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function deployEnvironment(environment: Environment): DeployEnvironment {
  const value = environment.VERCEL_ENV;
  return value === "production" || value === "preview" || value === "development" ? value : "local";
}

// `development` and `local` have no required ref, so they always answer 200.
const EXPECTED_REFS: Partial<Record<DeployEnvironment, string>> = {
  production: PRODUCTION_SUPABASE_REF,
  preview: STAGING_SUPABASE_REF,
};

export function readDeployDiagnostics(environment: Environment): DeployDiagnostics {
  const env = deployEnvironment(environment);
  const serverSupabaseRef = supabaseProjectRef(environment.SUPABASE_URL);
  const browserSupabaseRef = supabaseProjectRef(environment.VITE_SUPABASE_URL);
  const expectedSupabaseRef = EXPECTED_REFS[env] ?? null;
  return {
    service: "overdrafter-web",
    deployEnvironment: env,
    serverSupabaseRef,
    browserSupabaseRef,
    expectedSupabaseRef,
    supabaseRefMatchesEnvironment: expectedSupabaseRef === null
      ? null
      : serverSupabaseRef === expectedSupabaseRef && browserSupabaseRef === expectedSupabaseRef,
  };
}

/** 503 on a known mismatch so a smoke check can fail a mis-wired Preview or Production. */
export function createDeployDiagnosticsHandler(environment: Environment) {
  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
    }
    const diagnostics = readDeployDiagnostics(environment);
    return new Response(request.method === "HEAD" ? null : JSON.stringify(diagnostics), {
      status: diagnostics.supabaseRefMatchesEnvironment === false ? 503 : 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}
