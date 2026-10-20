import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A second Vite dev server of the same app with build flags set. A `VITE_*` flag is read from
// import.meta.env, so it is fixed when a dev server starts: the default Playwright web server leaves
// every flag unset (flag OFF), and a journey spec that needs a flag ON starts one of these on its own
// port and stops it afterwards. Fixture mode only: no Supabase is reachable.

export const FLAG_ON_SERVER_START_TIMEOUT_MS = 120_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type FlagOnServer = {
  readonly origin: string;
  start: () => Promise<void>;
  stop: () => void;
};

export function createFlagOnServer(port: number, flags: Record<string, string>): FlagOnServer {
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;

  // Polls one step at a time (recursion, not a loop): each step must finish before the next starts.
  async function waitForServer(deadline = Date.now() + FLAG_ON_SERVER_START_TIMEOUT_MS): Promise<void> {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`flag-on dev server exited early with code ${child.exitCode}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`flag-on dev server did not answer at ${origin}`);
    }
    try {
      if ((await fetch(origin)).ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return waitForServer(deadline);
  }

  return {
    origin,
    async start() {
      child = spawn(
        process.execPath,
        ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            VITE_ENABLE_FIXTURE_MODE: "1",
            VITE_ENABLE_ENGINEERING_WORKBENCH: "1",
            VITE_SUPABASE_URL: "http://127.0.0.1:9",
            VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "fixture-unused-publishable-key",
            ...flags,
          },
          stdio: "ignore",
        },
      );
      await waitForServer();
    },
    stop() {
      child?.kill("SIGTERM");
      child = undefined;
    },
  };
}
