// Hosted worker core (runs inside the GitHub Actions runner against a checkout of
// the DATA repo). Pure of git: pass a `git` object so tests can fake it.
import { createFsStorage } from "./storage/fs.mjs";
import { createClaudeCliEngine } from "./engines/claude-cli.mjs";
import { JobManager } from "./jobs.mjs";
import { finalizeJob } from "./finalize.mjs";
import { getTool } from "./config.mjs";
import { remoteToolStatus } from "./config.mjs";
import { assertId } from "./paths.mjs";

export const NO_CREDENTIAL = "No model credential configured in the data repo: add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN";

export function hasCredential(env) {
  return Boolean((env.CLAUDE_CODE_OAUTH_TOKEN || "").trim() || (env.ANTHROPIC_API_KEY || "").trim());
}

// Environment handed to the model subprocess: ONLY what Claude needs. Never the
// GitHub token (a prompt-injected run must not be able to read it).
export function scrubbedEnv(env) {
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  const out = {};
  for (const k of keep) if (env[k]) out[k] = env[k];
  return out;
}

/**
 * git: { commitPush(message) -> Promise<{ok:boolean, rejected?:boolean}>, resetToRemote() -> Promise<void> }
 * fetchSkill(tool) -> Promise<string dir>  (pinned, verified; throws on mismatch)
 */
export async function runWorkerJob({ dataDir, jobId, env, config, git, fetchSkill, engineFactory, now = () => new Date(), maxPushAttempts = 5 }) {
  assertId(jobId, "job id");
  const storage = createFsStorage({ dataDir });
  const job = await storage.readJob(jobId);
  if (!job) throw new Error(`Job file jobs/${jobId}.json not found in the data repo.`);
  if (job.state !== "queued") return { skipped: true, state: job.state };

  const apply = async (outcome, j = job) => {
    for (let attempt = 1; attempt <= maxPushAttempts; attempt++) {
      const final = await finalizeJob(storage, j, outcome, { now });
      const kind = final.state === "succeeded" ? "generated" : final.state === "blocked" ? "blocked" : "failed";
      const res = await git.commitPush(`studio: ${kind} ${final.sectionId} ${final.resultVersionId || final.id}`);
      if (res.ok) return final;
      await git.resetToRemote();
      // reset restored job.state=queued and the latest project.json; loop re-applies.
    }
    throw new Error("Could not push the result after several attempts: the data repo kept changing.");
  };

  const tool = getTool(config, job.tool);
  if (!tool) return apply({ state: "failed", message: `Unknown tool: ${job.tool}`, log: "" });

  if (!hasCredential(env)) return apply({ state: "blocked", message: NO_CREDENTIAL, log: "" });

  const rs = remoteToolStatus(tool);
  if (!rs.ok) return apply({ state: "blocked", message: rs.reason, log: "" });

  let skillDir = null;
  if (tool.source) {
    try {
      skillDir = await fetchSkill(tool);
    } catch (e) {
      return apply({ state: "failed", message: `Skill source check failed (closed): ${e.message}`, log: "" });
    }
  }
  const runTool = { ...tool, resolvedPath: skillDir };
  const cfg = { ...config, tools: config.tools.map((t) => (t.id === tool.id ? runTool : t)) };
  const engine = (engineFactory || ((e) => createClaudeCliEngine({ probe: async () => ({ installed: true, loggedIn: true }), env: scrubbedEnv(e) })))(env);
  const jobs = new JobManager({
    storage, engines: { "claude-cli": engine }, config: cfg, timeoutMs: (config.workerTimeoutMinutes - 3) * 60_000, now,
    finalize: (j, outcome) => apply(outcome, j),
  });
  return jobs.runExisting({ ...job, engine: "claude-cli" });
}
