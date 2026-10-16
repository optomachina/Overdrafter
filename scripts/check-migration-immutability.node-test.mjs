/**
 * OVD-871: runs the migration immutability check inside `npm run
 * test:portable-node`, which CI already runs, until the drafted ci.yml job
 * lands (docs/migration-immutability.md).
 *
 * Report mode: compares HEAD^1 with HEAD, prints the report and never fails on
 * findings. On a pull_request merge commit HEAD^1 is the base; locally it is
 * the parent commit. Like the drafted job, it runs the base copy of the checker
 * when HEAD^1 has one, so a PR cannot edit the checker to skip itself. Skips
 * when HEAD^1 is not available (shallow clone, single-commit repo).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const CHECKER = "scripts/check-migration-immutability.mjs";
const BASE_REF = "HEAD^1";

function gitOk(args) {
  return spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;
}

test("migration immutability report (HEAD^1..HEAD, report mode)", (t) => {
  if (!gitOk(["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`])) {
    t.skip(`${BASE_REF} is not available (shallow clone or root commit)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "migration-immutability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fromBase = gitOk(["cat-file", "-e", `${BASE_REF}:${CHECKER}`]);
  const checker = fromBase ? join(dir, "check-migration-immutability.mjs") : join(root, CHECKER);
  if (fromBase) writeFileSync(checker, execFileSync("git", ["show", `${BASE_REF}:${CHECKER}`], { cwd: root }));

  const result = spawnSync(process.execPath, [checker, "--root", root, "--base-ref", BASE_REF, "--head-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  t.diagnostic(`checker taken from: ${fromBase ? "base" : "head"}`);
  for (const line of `${result.stdout}${result.stderr}`.trimEnd().split("\n")) t.diagnostic(line);

  // Findings never fail this test; only a checker that cannot run does.
  assert.equal(result.status, 0, `checker exited ${result.status}:\n${result.stderr}`);
  assert.match(result.stdout, /^Migration immutability: /);
});
