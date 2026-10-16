/**
 * OVD-873: sensitive-paths report, run inside `npm run test:portable-node` so CI
 * reports without a workflow of its own (the dedicated workflow is a card draft,
 * see PLANNED_WORKFLOW_PATH in scripts/lib/sensitive-paths.mjs).
 *
 * Report mode: classifies `git diff --name-status --no-renames HEAD^1 HEAD`
 * with the HEAD^1 copy of docs/sensitive-paths.json, prints the report and
 * never fails because of findings or report errors. On a pull_request run
 * HEAD is the merge commit, so HEAD^1 is the base; without a HEAD^1 (shallow
 * or root commit) it skips. Unlike the planned workflow, this runs the head
 * copy of the matcher, so a PR could edit what reports on it; any such edit is
 * itself reported as gate_loosening (matcher_changed).
 *
 * Also runnable on its own: `npm run sensitive-paths:report`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "./lib/sensitive-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function git(args) {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function hasParent() {
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD^1^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

test("sensitive-paths report against HEAD^1 (report mode, never fails on findings)", (t) => {
  if (!hasParent()) {
    t.skip("HEAD^1 not available (shallow or root commit); sensitive-paths report skipped");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "sensitive-paths-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changed = join(dir, "changed-files.txt");
  try {
    // --no-renames keeps a rename source as a deletion plus an addition.
    writeFileSync(changed, git(["diff", "--name-status", "--no-renames", "HEAD^1", "HEAD"]));
  } catch (error) {
    console.log(`sensitive-paths: git diff HEAD^1 HEAD failed (${error.message}); report skipped`);
    return;
  }
  const lines = [];
  const exit = main(["report", "--root", root, "--changed-files-from", changed, "--base-ref", "HEAD^1"], {
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  console.log(["## Sensitive paths (report mode)", ...lines, ...(exit === 0 ? [] : [`sensitive-paths: report exited ${exit} (report mode, not failing)`])].join("\n"));
});
