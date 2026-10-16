// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  MAX_FILES,
  classifyPath,
  classifySql,
  compileConfig,
  detect,
  fetchPullRequest,
  githubClient,
  globToRegExp,
  loadConfig,
  main,
  pathWords,
} from "./sensitive-class-detect.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const { config } = loadConfig();

const modified = (filename) => ({ filename, status: "modified" });
const noSql = async () => "";

describe("config", () => {
  it("compiles the checked-in config with the issue's class and category sets", () => {
    expect(loadConfig().errors).toEqual([]);
    expect(Object.keys(rawConfig.classes)).toEqual(["migration", "rls", "definer", "auth", "billing", "provider", "secrets", "ci", "infra", "deps"]);
    expect(Object.keys(rawConfig.safe_categories)).toEqual(["docs", "tests", "frontend_ui", "styles_assets", "repo_scripts", "agent_skills"]);
  });

  it("rejects unknown rule keys, bad versions and rules for unknown classes", () => {
    const withKey = structuredClone(rawConfig);
    withKey.classes.auth.path_keyword = ["auth"];
    expect(compileConfig(withKey).errors).toContain('classes.auth: unknown rule key "path_keyword"');

    const badVersion = { ...structuredClone(rawConfig), version: 2 };
    expect(compileConfig(badVersion).config).toBeNull();

    const badRule = structuredClone(rawConfig);
    badRule.sql_content.rules.push({ class: "nope", tokens: ["x"] });
    expect(compileConfig(badRule).errors).toContain('sql_content.rules[5]: unknown class "nope"');
  });

  it("supports the documented glob and keyword syntax", () => {
    expect(globToRegExp("**/token{,s}.{json,ts}").test("a/b/tokens.ts")).toBe(true);
    expect(globToRegExp("**/token{,s}.{json,ts}").test("token.json")).toBe(true);
    expect(globToRegExp("scripts/deploy*").test("scripts/sub/deploy.sh")).toBe(false);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(pathWords("worker/src/providerAdmission/RLSPolicy.ts")).toEqual(["worker", "src", "provider", "admission", "rls", "policy", "ts"]);
  });
});

describe("drift: AGENTS.md sensitive paths table", () => {
  const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  const section = agents.split(/^## Sensitive paths/m)[1]?.split(/^## /m)[0] ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line) && !/^\|\s*Area\s*\|/.test(line))
    .map((line) => {
      const [area, signals] = line.split("|").slice(1, 3).map((cell) => cell.trim());
      return { area, signals: [...signals.matchAll(/`([^`]+)`/g)].map((match) => match[1]) };
    });

  it("finds the table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it.each(rows.map((row) => [row.area, row]))("row %s maps to classes covering every signal", (_area, row) => {
    const claiming = Object.values(rawConfig.classes).filter((entry) => entry.areas?.includes(row.area));
    expect(claiming.length).toBeGreaterThan(0);
    const covered = new Set(claiming.flatMap((entry) => entry.signals ?? []));
    expect(row.signals.filter((signal) => !covered.has(signal))).toEqual([]);
  });
});

// One example path per AGENTS.md table signal.
const SIGNAL_ROWS = [
  ["supabase/migrations/", "supabase/migrations/20261001000000_x.sql", "migration"],
  ["auth", "src/lib/auth/session-store.ts", "auth"],
  ["rls", "supabase/tests/rls_quotes.test.sql", "rls"],
  ["permission(s)", "server/permissions.ts", "auth"],
  ["session", "worker/src/sessionManager.ts", "auth"],
  ["payment", "server/payments/handler.ts", "billing"],
  ["billing", "api/billing.ts", "billing"],
  ["stripe", "server/stripeWebhook.ts", "billing"],
  ["pricing", "shared/pricing.ts", "billing"],
  ["invoice", "server/invoices.ts", "billing"],
  ["checkout", "src/pages/checkout/Summary.tsx", "billing"],
  ["dispatch", "worker/src/dispatchQueue.ts", "provider"],
  ["worker/src/adapters/", "worker/src/adapters/xometry.ts", "provider"],
  ["provider-admission", "server/provider-admission.ts", "provider"],
  ["provider-upload", "worker/src/providerUpload.ts", "provider"],
  ["secret", "server/secretStore.ts", "secrets"],
  ["credential", "worker/src/credentials.ts", "secrets"],
  ["*.pem", "certs/server.pem", "secrets"],
  ["*.key", "certs/server.key", "secrets"],
  ["keys/", "config/keys/public.json", "secrets"],
  ["token(s).{json,yaml,ts,js}", "config/tokens.yaml", "secrets"],
  ["vault", "server/vaultClient.ts", "secrets"],
  [".env*", ".env.production", "secrets"],
  ["env.{ts,js,json}", "src/env.ts", "secrets"],
  [".envrc", ".envrc", "secrets"],
  [".github/workflows/", ".github/workflows/ci.yml", "ci"],
  [".github/actions/", ".github/actions/setup/action.yml", "ci"],
  ["infra/", "infra/main.yaml", "infra"],
  ["terraform/", "terraform/vpc.hcl", "infra"],
  ["deploy/", "deploy/run.sh", "infra"],
  ["k8s/", "k8s/worker.yaml", "infra"],
  ["helm/", "helm/values.yaml", "infra"],
  ["ops/", "ops/runbook.yaml", "infra"],
  ["*.tf", "main.tf", "infra"],
  ["Dockerfile", "worker/Dockerfile", "infra"],
  ["docker-compose", "docker-compose.yml", "infra"],
  ["vercel.json", "vercel.json", "infra"],
  ["netlify.toml", "netlify.toml", "infra"],
  ["fly.toml", "fly.toml", "infra"],
  ["scripts/deploy*", "scripts/deploy-x.sh", "infra"],
  ["scripts/release*", "scripts/release-notes.mjs", "infra"],
  ["package.json", "package.json", "deps"],
  ["lockfiles", "package-lock.json", "deps"],
  ["requirements*.txt", "jev/requirements-dev.txt", "deps"],
  ["pyproject.toml", "pyproject.toml", "deps"],
  ["uv.lock", "uv.lock", "deps"],
  ["Cargo.toml", "native/Cargo.toml", "deps"],
  ["go.mod", "worker/go.mod", "deps"],
];

describe("classifyPath: AGENTS.md table entries", () => {
  it("has an example for every configured signal", () => {
    const configured = Object.values(rawConfig.classes).flatMap((entry) => entry.signals ?? []);
    expect(new Set(SIGNAL_ROWS.map(([signal]) => signal))).toEqual(new Set(configured));
  });

  it.each(SIGNAL_ROWS)("%s: %s -> %s", (_signal, file, expected) => {
    const result = classifyPath(file, config);
    expect(result.classes).toContain(expected);
    expect(result.category).toBeNull();
  });
});

describe("classifyPath: safe categories", () => {
  it.each([
    ["README.md", "docs"],
    ["docs/agent-graph-metrics.md", "docs"],
    ["src/lib/quote.test.ts", "tests"],
    ["scripts/catalog-parity-diff.node-test.mjs", "tests"],
    ["e2e/journeys/quote.spec.ts", "tests"],
    ["src/components/QuoteTable.tsx", "frontend_ui"],
    ["src/index.css", "styles_assets"],
    ["public/favicon.svg", "styles_assets"],
    ["scripts/inventory-worktrees.mjs", "repo_scripts"],
    [".codex/skills/commit/SKILL.md", "agent_skills"],
    [".claude/agents/implementer.md", "agent_skills"],
  ])("%s -> %s", (file, category) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: [], category });
  });

  it.each([
    ["docs/migration-drafts/x.sql", ["migration"], null],
    ["docs/release/forward.sql", ["migration"], null],
    ["e2e/fixtures/a.sql", [], null],
    ["scripts/deploy-x.sh", ["infra"], null],
    ["src/pages/checkout/Pay.tsx", ["billing"], null],
    ["src/features/auth/x.tsx", ["auth"], null],
    ["scripts/rotate-token-cache.mjs", [], null],
    ["AGENTS.md", [], null],
  ])("exclusion: %s -> classes %j, category %s", (file, classes, category) => {
    expect(classifyPath(file, config)).toMatchObject({ classes, category });
  });

  it("matches more than one class on one path", () => {
    expect(classifyPath(".github/workflows/deploy-stripe.yml", config).classes).toEqual(["billing", "ci"]);
  });
});

describe("classifySql", () => {
  const sql = (text) => classifySql(text, config).classes;

  it.each([
    ["create policy p on t for select using (true);", ["rls"]],
    ["ALTER POLICY p ON t USING (false);", ["rls"]],
    ["drop policy if exists p on t;", ["rls"]],
    ["alter table t enable row level security;", ["rls"]],
    ["create function f() returns int language sql security definer as $$ select 1 $$;", ["definer"]],
    ["do $$ begin create policy p on t using (true); end $$;", ["rls"]],
    ["create function f() returns void as $body$ begin alter table t force row level security; end $body$ language plpgsql;", ["rls"]],
  ])("%s -> %j", (text, expected) => {
    expect(sql(text)).toEqual(expected);
  });

  it.each([
    ["-- security definer\nselect 1;"],
    ["/* outer /* nested security definer */ create policy */ select 1;"],
    ["select $$ security definer $$;"],
    ["select $tag$ create policy $tag$;"],
    ["select 'create policy x';"],
    ["select E'it\\'s security definer';"],
    ['select "security definer" from t;'],
    ["create function f() returns text as $$ select 'security definer' -- create policy\n $$ language sql;"],
  ])("no false positive: %s", (text) => {
    expect(sql(text)).toEqual([]);
  });
});

describe("detect", () => {
  const sqlFiles = {
    "supabase/migrations/20261001_policy.sql": "create policy p on t using (true);",
    "supabase/tests/definer.test.sql": "create function f() returns int language sql security definer as $$ select 1 $$;",
    "supabase/fixtures/comment.sql": "-- security definer\nselect 1;",
  };
  const readHeadFile = async (file) => {
    if (!(file in sqlFiles)) throw new Error("not found");
    return sqlFiles[file];
  };

  it("adds SQL content classes and keys the result to the head", async () => {
    const result = await detect({ files: Object.keys(sqlFiles).map(modified), readHeadFile, config, sha: "h", baseSha: "b" });
    expect(result).toMatchObject({ version: 1, sha: "h", base_sha: "b", status: "ok", classes: ["migration", "rls", "definer"], multi_class: true });
    expect(result.files.map((file) => file.classes)).toEqual([["migration", "rls"], ["definer"], []]);
    expect(result.unclassified).toEqual(["supabase/fixtures/comment.sql"]);
  });

  it("counts a sensitive old path of a rename", async () => {
    const result = await detect({
      files: [{ filename: "docs/old-notes.md", previous_filename: "supabase/migrations/2026_x.sql", status: "renamed" }],
      readHeadFile: noSql,
      config,
    });
    expect(result.files[0]).toMatchObject({ classes: ["migration"], category: null, previous_path: "supabase/migrations/2026_x.sql" });
    expect(result.files[0].reasons).toContain("previous:migration:path:supabase/migrations/**");
  });

  it("classifies a deletion by path without reading the head", async () => {
    const result = await detect({ files: [{ filename: "src/lib/auth.ts", status: "removed" }, { filename: "supabase/migrations/x.sql", status: "removed" }], config });
    expect(result.status).toBe("ok");
    expect(result.files.map((file) => file.classes)).toEqual([["auth"], ["migration"]]);
  });

  it("reports an unmatched file as unclassified", async () => {
    const result = await detect({ files: [modified("worker/foo.go"), modified("README.md")], config });
    expect(result).toMatchObject({ status: "ok", classes: [], sensitive_count: 0, unclassified: ["worker/foo.go"], multi_class: false });
  });

  it("fails closed when a head .sql file cannot be read", async () => {
    const result = await detect({ files: [modified("supabase/fixtures/missing.sql")], readHeadFile, config });
    expect(result.status).toBe("error");
    expect(result.errors[0]).toMatch(/could not read supabase\/fixtures\/missing\.sql/);
  });
});

function fakeFetch(routes) {
  return async (url) => {
    const key = url.replace("https://api.github.com", "");
    const value = routes(key);
    if (value === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => value, text: async () => value };
  };
}

const PULL = { head: { sha: "headsha" }, base: { sha: "basesha" }, changed_files: 2 };
const FILES = [
  { filename: "src/features/auth/x.tsx", status: "modified" },
  { filename: "supabase/migrations/1_x.sql", status: "added" },
];

describe("fetchPullRequest", () => {
  it("reads the PR, its files and head content", async () => {
    const client = githubClient({
      fetchImpl: fakeFetch((key) => {
        if (key === "/repos/o/r/pulls/7") return PULL;
        if (key.startsWith("/repos/o/r/pulls/7/files")) return key.endsWith("page=1") ? FILES : [];
        if (key === "/repos/o/r/contents/supabase/migrations/1_x.sql?ref=headsha") return "select 1;";
        return undefined;
      }),
    });
    const pull = await fetchPullRequest(client, "o/r", 7, { expectedHeadSha: "headsha" });
    expect(pull).toMatchObject({ sha: "headsha", baseSha: "basesha", errors: [] });
    const result = await detect({ ...pull, config });
    expect(result).toMatchObject({ status: "ok", classes: ["migration", "auth"], sha: "headsha" });
  });

  it("errors on a truncated or incomplete list and a moved head", async () => {
    const client = githubClient({
      fetchImpl: fakeFetch((key) => (key === "/repos/o/r/pulls/7" ? { ...PULL, changed_files: MAX_FILES + 1 } : FILES)),
    });
    const pull = await fetchPullRequest(client, "o/r", 7, { expectedHeadSha: "other" });
    expect(pull.errors).toEqual([
      "PR head moved: expected other, API has headsha",
      `PR changes ${MAX_FILES + 1} files; the API lists at most ${MAX_FILES}, so the list is truncated`,
      `file list is incomplete: API listed 2 of ${MAX_FILES + 1} changed files`,
    ]);
    expect((await detect({ ...pull, config })).status).toBe("error");
  });
});

describe("main", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const run = async (args, routes) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sensitive-class-"));
    const out = path.join(dir, "out.json");
    const code = await main(["--repo", "o/r", "--pr", "7", "--json", out, ...args], { GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") }, { fetchImpl: fakeFetch(routes), stdout: { write() {} } });
    return { code, result: JSON.parse(readFileSync(out, "utf8")), summary: readFileSync(path.join(dir, "summary.md"), "utf8") };
  };

  it("writes the JSON and a job summary", async () => {
    const { code, result, summary } = await run([], (key) => (key === "/repos/o/r/pulls/7" ? PULL : key.includes("/contents/") ? "" : FILES));
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: "ok", sha: "headsha", base_sha: "basesha", classes: ["migration", "auth"] });
    expect(summary).toContain("### Sensitive classes: OK");
    expect(summary).toContain('"sha": "headsha"');
  });

  it("reports status error on an API failure and still exits 0", async () => {
    const { code, result } = await run(["--head-sha", "headsha"], () => undefined);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: "error", sha: "headsha", files: [] });
    expect(result.errors[0]).toMatch(/GitHub API error: GET \/repos\/o\/r\/pulls\/7 returned 404/);
  });

  it("reports status error on a bad config", async () => {
    const bad = path.join(mkdtempSync(path.join(os.tmpdir(), "sensitive-class-config-")), "bad.json");
    writeFileSync(bad, "{ not json");
    try {
      const { result } = await run(["--config", bad], () => PULL);
      expect(result.status).toBe("error");
      expect(result.errors[0]).toMatch(/config could not be read/);
    } finally {
      rmSync(path.dirname(bad), { recursive: true, force: true });
    }
  });

  it("returns 2 on bad arguments", async () => {
    expect(await main(["--pr", "x"], {})).toBe(2);
  });
});
