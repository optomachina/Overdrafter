import { createDeployDiagnosticsHandler } from "../server/operations/deploy-diagnostics";

/** Public deploy diagnostics: environment and Supabase project ref only, never keys. */
export default { fetch: (request: Request) => createDeployDiagnosticsHandler({
  VERCEL_ENV: process.env.VERCEL_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
})(request) };
