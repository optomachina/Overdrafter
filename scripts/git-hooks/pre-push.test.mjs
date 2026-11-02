// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// Each case pushes from a fixture clone to a local bare remote with the real
// hook installed, so git feeds it the same stdin a developer's push would.
const root = resolve(".");
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-hook-"));
  dirs.push(dir);
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);
  mkdirSync(join(work, "scripts/git-hooks"), { recursive: true });
  copyFileSync(join(root, "scripts/git-hooks/pre-push"), join(work, "scripts/git-hooks/pre-push"));
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"));
  writeFileSync(join(work, ".gitignore"), "node_modules\n");
  writeFileSync(join(work, "eslint.config.js"), 'export default [{ files: ["**/*.mjs"], rules: { "no-debugger": "error" } }];\n');
  // A lint error that is already on main: a push that does not touch it must not fail on it.
  writeFileSync(join(work, "old.mjs"), "debugger;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("push", "-q", "origin", "main");
  git("config", "core.hooksPath", "scripts/git-hooks");
  const commit = (file, content) => {
    writeFileSync(join(work, file), content);
    git("add", "-A");
    git("commit", "-q", "-m", `edit ${file}`);
  };
  const push = (...args) => {
    const result = spawnSync("git", ["push", "origin", ...args], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { git, commit, push };
}

test("passes a clean push and checks only the changed files", () => {
  const { commit, push } = fixture();
  commit("notes.md", "clean line\n");
  commit("new.mjs", "export const value = 1;\n");
  const result = push("main");
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("pre-push: format PASS");
  expect(result.output).toContain("pre-push: lint PASS");
  expect(result.output).toContain("pre-push: typecheck SKIPPED");
}, 60_000);

test("fails a push that adds trailing whitespace or a lint error, and blocks it", () => {
  const { git, commit, push } = fixture();
  commit("notes.md", "trailing space \n");
  commit("new.mjs", "debugger;\n");
  const result = push("main");
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("pre-push: format FAIL");
  expect(result.output).toContain("pre-push: lint FAIL");
  expect(result.output).toContain("new.mjs");
  expect(result.output).not.toContain("old.mjs");
  expect(git("ls-remote", "origin", "main").split(/\s/)[0]).not.toBe(git("rev-parse", "HEAD"));
}, 60_000);

test("diffs a new branch against its origin/main merge base and skips branch deletions", () => {
  const { git, commit, push } = fixture();
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-b", "feature");
  commit("feature.md", "fine\n");
  const created = push("feature");
  expect(created.status, created.output).toBe(0);
  expect(created.output).toContain("pre-push: format PASS");
  expect(created.output).toContain("pre-push: lint SKIPPED");
  const deleted = push("--delete", "feature");
  expect(deleted.status, deleted.output).toBe(0);
  expect(deleted.output).not.toContain("pre-push: format");
}, 60_000);
