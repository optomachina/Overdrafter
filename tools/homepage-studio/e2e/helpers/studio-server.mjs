// Starts the REAL studio (server.mjs createServer + lib/app.mjs createApp) in this process on a loopback
// ephemeral port, with its own temp data directory. Nothing under tools/homepage-studio/data is touched.
// Test seams used (all already public parameters of createApp, no production code is changed):
//   - dataDir        : temp directory per server
//   - env            : explicit env object (the process env is never read)
//   - probe          : stands in for `claude auth status`
//   - fetchImpl      : hosted mode GitHub calls; rewritten to the loopback GitHub stub, anything else throws
//   - extraEngines   : a gate in front of the real demo engine, and the existing fake engine for forced failures
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../lib/app.mjs";
import { createServer, listen } from "../../server.mjs";
import { createTemplateDemoEngine } from "../../lib/engines/template-demo.mjs";
import { createFakeEngine } from "../../lib/engines/fake.mjs";
import { startFakeGithub } from "./fake-github.mjs";
import { publicDir } from "./paths.mjs";

export const HOSTED_PASSWORD = "e2e-test-password";
export const HOSTED_SECRET = "e2e-session-secret-0123456789abcdef";
export const GITHUB_REPO = "e2e/data";

/** A promise gate in front of the demo engine so a test can observe "running" deterministically. */
export function createGate() {
  const g = {
    held: false, entered: 0, _promise: null, _release: null,
    hold() {
      if (g.held) return;
      g.held = true;
      g._promise = new Promise((resolve) => (g._release = resolve));
    },
    release() {
      g.held = false;
      g._release?.();
    },
    async wait() {
      g.entered++;
      if (g.held) await g._promise;
    },
  };
  return g;
}

const PROBES = {
  "not-logged-in": async () => ({ installed: true, loggedIn: false }),
  "logged-in": async () => ({ installed: true, loggedIn: true }),
  "not-installed": async () => ({ installed: false, loggedIn: false }),
};

function buildApp({ mode, env, dataDir, probe, gate, fakeEngine, fetchImpl }) {
  const demo = createTemplateDemoEngine();
  const extraEngines = [{ ...demo, run: async (ctx) => { await gate.wait(); return demo.run(ctx); } }];
  if (fakeEngine) extraEngines.push(createFakeEngine(fakeEngine));
  // Tool skill folders resolve against the home directory when the app is built. Point HOME at an empty
  // temp directory for that synchronous call so the result never depends on skills installed on this Mac.
  const realHome = process.env.HOME;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "hs-e2e-home-"));
  process.env.HOME = emptyHome;
  try {
    return createApp({ env, mode, dataDir, probe: PROBES[probe], extraEngines, fetchImpl });
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
}

async function listenOnEphemeral(app) {
  const server = createServer(app);
  const addr = await listen(server, 0);
  return { server, port: addr.port };
}

/** Local mode studio: fs storage in a temp dir, demo engine, probe forced to "not logged in" by default. */
export async function startLocalStudio({ probe = "not-logged-in", fakeEngine = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-e2e-data-"));
  const gate = createGate();
  const app = buildApp({ mode: "local", env: {}, dataDir, probe, gate, fakeEngine });
  const { server, port } = await listenOnEphemeral(app);
  return {
    mode: "local", url: `http://127.0.0.1:${port}`, port, dataDir, app, gate,
    async close() {
      gate.release();
      await app.jobs.idle().catch(() => {});
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function baselineFiles() {
  const out = {};
  for (const v of ["v6", "v7", "v8", "v9"]) out[`baselines/${v}/index.html`] = fs.readFileSync(path.join(publicDir, v, "index.html"));
  return out;
}

/**
 * Hosted mode studio against the loopback GitHub stub. The data repo starts with only the baseline page
 * snapshots (the studio seeds project.json itself on first request, as it would on a fresh data repo).
 * env overrides: pass password:"" to prove the fail-closed behaviour.
 */
export async function startHostedStudio({ password = HOSTED_PASSWORD, secret = HOSTED_SECRET, probe = "not-logged-in", withProject = false } = {}) {
  const files = baselineFiles();
  const gh = await startFakeGithub({ repo: GITHUB_REPO, files });
  const gate = createGate();
  const env = {
    STUDIO_HOSTED: "1", STUDIO_PASSWORD: password, STUDIO_SESSION_SECRET: secret,
    STUDIO_DATA_REPO: GITHUB_REPO, GITHUB_TOKEN: "e2e-fake-token", STUDIO_DATA_BRANCH: "main",
  };
  const fetchImpl = (url, init) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") throw new Error(`e2e: refusing a request to ${u.hostname}`);
    return fetch(`${gh.url}${u.pathname}${u.search}`, init);
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-e2e-hosted-"));
  const app = buildApp({ mode: "hosted", env, dataDir, probe, gate, fetchImpl });
  const { server, port } = await listenOnEphemeral(app);
  const studio = {
    mode: "hosted", url: `http://127.0.0.1:${port}`, port, dataDir, app, gate, gh, fetchImpl, env,
    async close() {
      gate.release();
      await app.jobs.idle().catch(() => {});
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await gh.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  if (withProject) await studio.app.api.ensureProject();
  return studio;
}
