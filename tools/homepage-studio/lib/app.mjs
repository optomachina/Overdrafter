// Composition root shared by the local server and the Vercel function.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, localToolStatus } from "./config.mjs";
import { createStorage } from "./storage/index.mjs";
import { createEngines } from "./engines/index.mjs";
import { JobManager } from "./jobs.mjs";
import { createAuth } from "./auth.mjs";
import { createApi } from "./api.mjs";

export const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function detectMode(env = process.env) {
  return env.STUDIO_HOSTED === "1" ? "hosted" : "local";
}

export function createApp({ env = process.env, mode = detectMode(env), storage, fetchImpl, probe, extraEngines = [], dataDir = path.join(studioRoot, "data"), now, idGen, jobTimeoutMs } = {}) {
  const config = loadConfig(path.join(studioRoot, "studio.config.json"));
  let seed = null;
  try {
    seed = JSON.parse(fs.readFileSync(path.join(studioRoot, "data", "seed.json"), "utf8"));
  } catch {
    seed = null;
  }
  const store = storage || createStorage({ env, mode, dataDir, fetchImpl, workflowFile: config.workflowFile });
  const engines = createEngines({ mode, storage: store, probe, extra: extraEngines });
  const jobs = new JobManager({
    storage: store, engines, config, awaitInline: mode === "hosted", timeoutMs: jobTimeoutMs,
    localToolStatus: (t) => localToolStatus(t), ...(now ? { now } : {}), ...(idGen ? { idGen } : {}),
  });
  const auth = createAuth({ mode, password: env.STUDIO_PASSWORD || "", secret: env.STUDIO_SESSION_SECRET || "" });
  const repoRoot = mode === "local" && fs.existsSync(path.resolve(studioRoot, "../../public")) ? path.resolve(studioRoot, "../..") : null;
  const api = createApi({ storage: store, jobs, config, engines, auth, mode, seed, repoRoot, studioRoot, ...(now ? { now } : {}), ...(idGen ? { idGen } : {}) });
  return { api, storage: store, jobs, engines, auth, config, mode, seed };
}
