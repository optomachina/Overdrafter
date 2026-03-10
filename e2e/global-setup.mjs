import { ensureAuthStates } from "./auth.mjs";

export default async function globalSetup() {
  await ensureAuthStates();
}
