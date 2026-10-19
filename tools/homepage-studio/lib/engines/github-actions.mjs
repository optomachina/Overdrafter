// Hosted engine: does not run a model itself. It queues a job in the data repo
// and triggers the worker workflow (the Claude CLI cannot run on Vercel).
import { EngineError } from "./errors.mjs";

export const NEEDS_GITHUB = "Generation needs the GitHub data repo: set STUDIO_DATA_REPO and GITHUB_TOKEN (see HOSTING.md).";

export function createGithubActionsEngine({ storage }) {
  const configured = storage && storage.kind === "github";
  return {
    id: "github-actions",
    label: "GitHub Actions worker",
    description: "Queues a job in the data repo; a workflow runs Claude headlessly and commits the result.",
    inline: false,
    usesSkills: true,
    async available() {
      return configured ? { ok: true, message: "" } : { ok: false, message: NEEDS_GITHUB };
    },
    async enqueue(job) {
      if (!configured) throw new EngineError("unavailable", NEEDS_GITHUB);
      await storage.dispatch({
        jobId: job.id,
        section: job.sectionId,
        tool: job.tool,
        engine: "claude-cli",
        promptRef: `jobs/${job.id}.json`,
      });
    },
    async status(job) {
      if (!configured) return null;
      return storage.findRun(job.id);
    },
  };
}
