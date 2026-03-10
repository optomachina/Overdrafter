import { ensureAuthStates } from "./auth.mjs";

ensureAuthStates().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
