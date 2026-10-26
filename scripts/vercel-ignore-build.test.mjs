// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";

const SCRIPT = resolve(fileURLToPath(new URL("./vercel-ignore-build.sh", import.meta.url)));
const temps = [];
// Synchronous Git/subprocess fixtures must yield so Vitest can report progress.
afterEach(async () => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  await setImmediate();
});

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

const pullRequest = (overrides = {}) => ({
  state: "open", draft: false,
  head: { ref: "feature", repo: { full_name: "optomachina/Overdrafter" } },
  ...overrides,
});

function runScript(cwd, env, { response = JSON.stringify([pullRequest()]), curlStatus = 0 } = {}) {
  // Drop inherited Vercel/git context so only the case's env is in play.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VERCEL_|GIT_|GITHUB_|GH_|VIB_)/i.test(key)),
  );
  const bin = join(cwd, "mock-bin");
  const request = join(cwd, "mock-request.json");
  mkdirSync(bin, { recursive: true });
  // Every test uses a fake curl, so no test can call GitHub or read real tokens.
  writeFileSync(join(bin, "curl"), `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.VIB_REQUEST, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.VIB_RESPONSE);
if (process.env.VIB_CURL_STATUS !== "0") process.stderr.write("synthetic-sensitive-error");
process.exit(Number(process.env.VIB_CURL_STATUS));
`, { mode: 0o755 });
  const result = spawnSync("/bin/bash", [SCRIPT], {
    cwd,
    env: {
      ...baseEnv, VERCEL_GIT_REPO_OWNER: "optomachina", VERCEL_GIT_REPO_SLUG: "Overdrafter",
      ...env, PATH: `${bin}:${env.PATH ?? baseEnv.PATH}`,
      VIB_REQUEST: request, VIB_RESPONSE: response, VIB_CURL_STATUS: String(curlStatus),
    },
    encoding: "utf8",
  });
  return { ...result, request: existsSync(request) ? JSON.parse(readFileSync(request, "utf8")) : null };
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
  it("is wired to Vercel's ignored build step", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.ignoreCommand).toBe("bash scripts/vercel-ignore-build.sh");
  });

  it.each([
    { name: "no open PR", prs: [] },
    { name: "draft PR", prs: [pullRequest({ draft: true })] },
    { name: "multiple draft PRs", prs: [pullRequest({ draft: true }), pullRequest({ draft: true })] },
  ])("skips app changes with $name", ({ prs }) => {
    const { dir } = fixtureRepo(["src/app.ts"]);
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" }, { response: JSON.stringify(prs) });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/SKIP - (no open|draft)/);
  });

  it.each([
    { name: "ready PR", prs: [pullRequest()] },
    { name: "mixed ready and draft PRs", prs: [pullRequest({ draft: true }), pullRequest()] },
  ])("builds app changes with $name", ({ prs }) => {
    const { dir, base } = fixtureRepo(["src/app.ts"]);
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PREVIOUS_SHA: base }, { response: JSON.stringify(prs) });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - app-affecting/);
  });

  it.each([
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "feature" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: "feature" },
    { VERCEL_GIT_COMMIT_REF: "feature" },
    { VERCEL_ENV: "preview" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_REPO_OWNER: "" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_REPO_SLUG: "" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PROVIDER: "gitlab" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_REPO_OWNER: "evil/owner" },
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", PATH: "/nonexistent" },
  ])("builds without a lookup for protected or incomplete context %#", (env) => {
    const { dir } = fixtureRepo(["docs/guide.txt"]);
    const result = runScript(dir, env, { response: "[]" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.request).toBeNull();
  });

  it.each([
    { name: "network timeout", curlStatus: 28 },
    { name: "HTTP error (authentication, rate limit, or server failure)", curlStatus: 22 },
    { name: "empty body", response: "" },
    { name: "malformed JSON", response: "not json" },
    { name: "API error object", response: '{"message":"Bad credentials"}' },
    { name: "null response", response: "null" },
    { name: "null row", response: "[null]" },
    { name: "missing draft flag", response: JSON.stringify([pullRequest({ draft: undefined })]) },
    { name: "string draft flag", response: JSON.stringify([pullRequest({ draft: "true" })]) },
    { name: "closed PR", response: JSON.stringify([pullRequest({ state: "closed" })]) },
    { name: "different branch", response: JSON.stringify([pullRequest({ head: { ref: "other", repo: { full_name: "optomachina/Overdrafter" } } })]) },
    { name: "fork with same branch", response: JSON.stringify([pullRequest({ head: { ref: "feature", repo: { full_name: "someone/Overdrafter" } } })]) },
    { name: "deleted head repo", response: JSON.stringify([pullRequest({ head: { ref: "feature", repo: null } })]) },
    { name: "possibly paginated response", response: JSON.stringify(Array.from({ length: 100 }, () => pullRequest({ draft: true }))) },
  ])("fails open even for docs-only changes: $name", ({ name: _name, ...options }) => {
    const { dir, base } = fixtureRepo(["docs/guide.txt"]);
    const result = runScript(dir, { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature", VERCEL_GIT_PREVIOUS_SHA: base }, options);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - GitHub/);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("synthetic-sensitive-error");
  });

  it.each(["GITHUB_TOKEN", "GH_TOKEN", null])("requests only open PRs for the encoded branch (auth: %s)", (tokenName) => {
    const { dir } = fixtureRepo(["src/app.ts"]);
    const branch = "feature/quote&draft=true";
    const result = runScript(dir, {
      VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: branch,
      ...(tokenName ? { [tokenName]: "synthetic-test-token" } : {}),
    }, { response: "[]" });
    expect(result.status).toBe(0);
    expect(result.request).toContain("https://api.github.com/repos/optomachina/Overdrafter/pulls");
    expect(result.request).toContain("state=open");
    expect(result.request).toContain(`head=optomachina:${branch}`);
    expect(result.request).toContain("--data-urlencode");
    expect(result.request).toContain("--fail");
    expect(result.request).toContain("--max-time");
    expect(result.request.includes("Authorization: Bearer synthetic-test-token")).toBe(Boolean(tokenName));
    expect(result.stdout + result.stderr).not.toContain("synthetic-test-token");
    expect(result.stdout + result.stderr).not.toContain(branch);
  });

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
    ["missing", "0123456789abcdef0123456789abcdef01234567", /BUILD - VERCEL_GIT_PREVIOUS_SHA does not resolve/],
    ["garbage", "not-a-sha; rm -rf /", /BUILD - VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA/],
    ["a ref name", "main", /BUILD - VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA/],
    ["uppercase hex", "0123456789ABCDEF0123456789ABCDEF01234567", /BUILD - VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA/],
  ])("builds when VERCEL_GIT_PREVIOUS_SHA is %s even if main exists", (_label, previous, message) => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const result = runScript(dir, {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_PREVIOUS_SHA: previous,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(message);
  });

  it("never passes an option-shaped VERCEL_GIT_PREVIOUS_SHA to git, even in a shallow clone", () => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const shallow = mkdtempSync(join(tmpdir(), "vib-shallow-"));
    temps.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${dir}`, shallow]);
    const marker = join(tmpdir(), `vib-pwn-${process.pid}-${Date.now()}`);
    const result = runScript(shallow, {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_PREVIOUS_SHA: `--upload-pack=touch ${marker};`,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/BUILD - VERCEL_GIT_PREVIOUS_SHA is not a 40-character hex SHA/);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a multi-line VERCEL_GIT_PREVIOUS_SHA whose first line is valid hex", () => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const result = runScript(dir, {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_PREVIOUS_SHA: `${"a".repeat(40)}\n--upload-pack=touch /tmp/never`,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/not a 40-character hex SHA/);
  });

  it("builds in a shallow clone when a well-formed previous SHA cannot be fetched", () => {
    const { dir } = fixtureRepo(["docs/guide.txt"], { withMain: true });
    const shallow = mkdtempSync(join(tmpdir(), "vib-shallow-"));
    temps.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${dir}`, shallow]);
    const result = runScript(shallow, {
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_PREVIOUS_SHA: "0123456789abcdef0123456789abcdef01234567",
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
