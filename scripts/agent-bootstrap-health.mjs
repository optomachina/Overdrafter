import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function collectBootstrapHealth(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const status = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trimEnd();
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: os.hostname(),
    repoRoot: root,
    head: git(["rev-parse", "HEAD"], root),
    branch: git(["branch", "--show-current"], root) || null,
    dirty: status.length > 0,
    changedPaths: status ? status.split("\n").map((line) => line.slice(3)) : [],
    instructionBytes: {
      agents: fs.statSync(path.join(root, "AGENTS.md")).size,
      claude: fs.statSync(path.join(root, "CLAUDE.md")).size,
      workflow: fs.statSync(path.join(root, "WORKFLOW.md")).size,
    },
  };
}

if (process.argv[1]?.endsWith("agent-bootstrap-health.mjs")) {
  console.log(JSON.stringify(collectBootstrapHealth(), null, 2));
}
