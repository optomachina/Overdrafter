import { ensureAuthStates } from "./auth.mjs";

export default async function globalSetup() {
  if (process.env.PLAYWRIGHT_SKIP_AUTH_SETUP === "1") {
    return;
  }

  await ensureAuthStates();
}
