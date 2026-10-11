import { ensureAuthStates } from "./auth.mjs";
import { warmFixtureRoutes } from "./fixture-warmup.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";

export default async function globalSetup(config) {
  if (process.env.PLAYWRIGHT_SKIP_AUTH_SETUP === "1") {
    await warmFixtureRoutes(config?.projects?.[0]?.use?.baseURL ?? DEFAULT_BASE_URL);
    return;
  }

  await ensureAuthStates();
}
