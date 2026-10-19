#!/usr/bin/env node
// Entry point run by studio-generate.yml inside the data repo checkout.
//   node studio/worker.mjs            (cwd = data repo root; env JOB_ID, GITHUB_TOKEN, model secret)
// Layout in the data repo: studio/lib/**, studio/hosted/**, studio/studio.config.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = fs.existsSync(path.join(here, "lib")) ? here : path.resolve(here, "..");
const { runWorkerJob } = await import(path.join(studioRoot, "lib/worker-core.mjs"));
const { loadConfig } = await import(path.join(studioRoot, "lib/config.mjs"));
const { fetchSkill } = await import(path.join(here, "fetch-skill.mjs"));

const dataDir = process.cwd();
const token = process.env.GITHUB_TOKEN || "";
const branch = process.env.GITHUB_REF_NAME || "main";
const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
// The token is passed per command through git's environment config: it is never written to .git/config.
const gitEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
const git = (...args) => execFileSync("git", args, { cwd: dataDir, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

git("config", "user.name", "homepage-studio-worker");
git("config", "user.email", "homepage-studio-worker@users.noreply.github.com");

const gitOps = {
  async commitPush(message) {
    git("add", "-A", "--", "project.json", "jobs", "versions");
    if (git("status", "--porcelain").trim() === "") return { ok: true };
    git("commit", "-q", "-m", message);
    try {
      git("push", "origin", `HEAD:${branch}`); // plain push: never forced
      return { ok: true };
    } catch {
      return { ok: false, rejected: true };
    }
  },
  async resetToRemote() {
    git("fetch", "-q", "origin", branch);
    git("reset", "-q", "--hard", `origin/${branch}`);
    git("clean", "-fdq", "--", "versions", "jobs");
  },
};

const config = loadConfig(path.join(studioRoot, "studio.config.json"));
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "studio-skill-"));
const result = await runWorkerJob({
  dataDir, jobId: process.env.JOB_ID, env: process.env, config, git: gitOps,
  fetchSkill: async (tool) => fetchSkill(tool, workRoot),
});
console.log(JSON.stringify({ state: result.state, message: result.message, skipped: result.skipped || false }));
