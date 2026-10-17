/**
 * OVD-875: runs the RLS-on-new-tables lint over this repository inside
 * test:portable-node. Report mode (--report): violations print as diagnostics
 * and never fail the run; only an input error (exit 2) does. Switching LINT_MODE
 * to --enforce is a card item. Offline: reads the checkout, never a database.
 *
 * In GitHub Actions (or when RLS_NEW_TABLES_BASE_REF is set) it also lints the
 * diff against HEAD^1 so escape hatches and baseline growth in the PR are
 * reported as gate_loosening. Fixture coverage lives in lint-rls-new-tables.test.mjs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "./lint-rls-new-tables.mjs";

const LINT_MODE = "--report";
const root = fileURLToPath(new URL("..", import.meta.url));

function run(t, argv) {
  const out = [];
  const code = main([...argv, LINT_MODE, "--root", root], { stdout: (line) => out.push(line), stderr: (line) => out.push(line), env: {} });
  for (const line of out) t.diagnostic(line);
  return code;
}

test("new tables enable RLS in the same migration (report mode)", (t) => {
  assert.equal(run(t, ["--all"]), 0);
});

function resolveBaseRef() {
  const ref = process.env.RLS_NEW_TABLES_BASE_REF ?? (process.env.GITHUB_ACTIONS === "true" ? "HEAD^1" : null);
  if (!ref) return null;
  try {
    execFileSync("/usr/bin/git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, stdio: "ignore" });
    return ref;
  } catch {
    return null;
  }
}

test("changed migrations and gate loosening against the base (report mode)", (t) => {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    t.skip("no base ref (set RLS_NEW_TABLES_BASE_REF; CI uses HEAD^1)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "rls-new-tables-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const changed = join(dir, "changed-files.txt");
  // --no-renames keeps a rename source as a deletion plus an addition.
  writeFileSync(
    changed,
    execFileSync("/usr/bin/git", ["diff", "--name-status", "--no-renames", baseRef, "HEAD"], { cwd: root, encoding: "utf8" }),
  );
  assert.equal(run(t, ["--changed-files-from", changed, "--base-ref", baseRef]), 0);
});
