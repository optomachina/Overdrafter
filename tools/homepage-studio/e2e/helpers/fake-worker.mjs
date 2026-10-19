// Plays the role of the hosted GitHub Actions worker against the loopback GitHub stub. It uses the studio's own
// storage adapter and finalizeJob (exactly what hosted/worker.mjs does), so the records it writes are real.
import { createGithubStorage } from "../../lib/storage/github.mjs";
import { finalizeJob } from "../../lib/finalize.mjs";
import { demoAssetHtml } from "../../lib/engines/template-demo.mjs";
import { GITHUB_REPO } from "./studio-server.mjs";

export const NO_CREDENTIAL = "No model credential configured in the data repo: add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN";

export function workerStorage(studio) {
  return createGithubStorage({ repo: GITHUB_REPO, branch: "main", token: "e2e-worker-token", fetchImpl: studio.fetchImpl });
}

/** The queued job file the studio committed for this job id. */
export async function readQueuedJob(studio, jobId) {
  const job = await workerStorage(studio).readJob(jobId);
  if (!job) throw new Error(`job ${jobId} is not in the data repo`);
  return job;
}

export function setRun(studio, jobId, { status, conclusion = null }) {
  studio.gh.runs = [{ id: 4242, status, conclusion, display_title: `studio generate ${jobId}`, name: "studio-generate", html_url: `${studio.gh.url}/runs/4242` }];
}

export async function workerSucceeds(studio, jobId, { label = "Hero", prompt = "worker figure" } = {}) {
  const job = await readQueuedJob(studio, jobId);
  const assetHtml = demoAssetHtml({ section: { label }, prompt, tool: job.tool });
  const final = await finalizeJob(workerStorage(studio), job, { state: "succeeded", model: "e2e-simulated-worker", usage: null, demo: false, assetHtml, log: "" });
  setRun(studio, jobId, { status: "completed", conclusion: "success" });
  return final;
}

export async function workerBlocks(studio, jobId, message = NO_CREDENTIAL) {
  const job = await readQueuedJob(studio, jobId);
  const final = await finalizeJob(workerStorage(studio), job, { state: "blocked", message, log: message });
  setRun(studio, jobId, { status: "completed", conclusion: "success" });
  return final;
}
