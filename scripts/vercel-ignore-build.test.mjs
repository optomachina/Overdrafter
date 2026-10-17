// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(new URL("./vercel-ignore-build.sh", import.meta.url)));
const temps = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

function commitFiles(dir, files, message) {
  for (const path of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${message}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Repo on `trunk` with one base commit, then a `feature` branch carrying
 * `changed`. With withMain, the base branch is named `main` instead.
 */
function fixtureRepo(changed, { withMain = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vercel-ignore-build-"));
  temps.push(dir);
  git(dir, "init", "-q", "-b", withMain ? "main" : "trunk");
  const base = commitFiles(dir, ["src/app.ts", "README.md"], "base");
  git(dir, "checkout", "-q", "-b", "feature");
  commitFiles(dir, changed, "change");
  return { dir, base };
}

function runScript(cwd, env) {
  // Drop inherited Vercel/git context so only the case's env is in play.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VERCEL_|GIT_)/i.test(key)),
  );
  return spawnSync("bash", [SCRIPT], { cwd, env: { ...baseEnv, ...env }, encoding: "utf8" });
}

const CASES = [
  { name: "docs-only skips", changed: ["docs/guide.txt"], expected: 0 },
  { name: "markdown-only (any directory) skips", changed: ["src/notes/CHANGES.md", "README.md"], expected: 0 },
  {
    name: "scripts/.github/supabase/tests only skips",
    changed: ["scripts/tool.mjs", ".github/workflows/ci.yml", "supabase/tests/rls.test.sql"],
    expected: 0,
  },
  { name: "docs and non-build scripts still skip", changed: ["docs/guide.txt", "scripts/jarvis-demo/jarvis-demo.mjs"], expected: 0 },
  { name: "build-input script builds", changed: ["scripts/verify-public-assets.mjs"], expected: 1 },
  { name: "vite plugin builds", changed: ["scripts/vite-sample-plate-plugin.ts"], expected: 1 },
  { name: "public markdown builds", changed: ["public/llms.md"], expected: 1 },
  { name: "src change builds", changed: ["src/app.ts"], expected: 1 },
  { name: "mixed docs and src builds", changed: ["docs/guide.txt", "src/app.ts"], expected: 1 },
  { name: "supabase migration builds", changed: ["supabase/migrations/0001_x.sql"], expected: 1 },
  { name: "main ref builds even for docs-only", changed: ["docs/guide.txt"], env: { VERCEL_GIT_COMMIT_REF: "main" }, expected: 1 },
  { name: "production builds even for docs-only", changed: ["docs/guide.txt"], env: { VERCEL_ENV: "production" }, expected: 1 },
];

describe("vercel-ignore-build.sh", () => {
  it.each(CASES)("$name (vs VERCEL_GIT_PREVIOUS_SHA)", ({ changed, env = {}, expected }) => {
    const { dir, base } = fixtureRepo(changed);
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PREVIOUS_SHA: base, ...env });
    expect(result.status, result.stdout + result.stderr).toBe(expected);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toMatch(expected === 0 ? /SKIP/ : /BUILD/);
  });

  it.each([
    { name: "missing previous SHA", previous: undefined },
    { name: "bogus previous SHA", previous: "0123456789abcdef0123456789abcdef01234567" },
  ])("$name with no main builds", ({ previous }) => {
    const { dir } = fixtureRepo(["docs/guide.txt"]);
    const env = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" };
    if (previous) env.VERCEL_GIT_PREVIOUS_SHA = previous;
    const result = runScript(dir, env);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - (no comparable base commit|VERCEL_GIT_PREVIOUS_SHA does not resolve)/);
  });

  it("falls back to merge-base with main on a first deployment and skips docs-only changes", () => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/SKIP .*merge-base with main/);
  });

  it.each([
    ["missing", "0123456789abcdef0123456789abcdef01234567"],
    ["garbage", "not-a-sha; rm -rf /"],
  ])("builds when VERCEL_GIT_PREVIOUS_SHA is %s even if main exists", (_label, previous) => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const result = runScript(dir, {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_PREVIOUS_SHA: previous,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - VERCEL_GIT_PREVIOUS_SHA does not resolve/);
  });

  it("falls back to merge-base with main and builds src changes", () => {
    const { dir } = fixtureRepo(["src/app.ts"], { withMain: true });
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
  });

  it("builds on an empty diff", () => {
    const { dir } = fixtureRepo(["docs/guide.txt"]);
    const head = git(dir, "rev-parse", "HEAD");
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PREVIOUS_SHA: head });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - empty diff/);
  });

  it("builds outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "vercel-ignore-build-nogit-"));
    temps.push(dir);
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PREVIOUS_SHA: "abc123" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
  });
});
