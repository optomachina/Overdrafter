import { createDeployDiagnosticsHandler } from "../server/operations/deploy-diagnostics";

/** Public deploy diagnostics: environment and Supabase project ref only, never keys. */
export default { fetch: (request: Request) => createDeployDiagnosticsHandler(process.env)(request) };
