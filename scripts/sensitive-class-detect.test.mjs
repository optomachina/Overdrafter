// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_PATH,
  MAX_FILES,
  MAX_SQL_TOKENS,
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

  it.each([
    ["src/pages/Unauthorized.tsx"],
    ["src/components/Reauthenticate.tsx"],
    ["src/features/account/OAuthButton.tsx"],
    ["src/pages/Login.tsx"],
    ["src/pages/DevLogin.tsx"],
    ["src/pages/PasswordReset.tsx"],
    ["src/components/signIn.tsx"],
    ["src/components/SignInDialog.tsx"],
    ["src/pages/signup/Form.tsx"],
    ["src/components/Logout.tsx"],
    ["src/components/Subsessions.tsx"],
    ["scripts/accesstoken-cache.mjs"],
  ])("exclusion keyword inside a word: %s is not safe", (file) => {
    expect(classifyPath(file, config).category).toBeNull();
  });

  it("matches class keywords only at a word start", () => {
    expect(classifyPath("src/pages/Unauthorized.tsx", config).classes).toEqual([]);
    expect(classifyPath("src/lib/authorize.ts", config).classes).toEqual(["auth"]);
  });

  it.each([
    ["scripts/sensitive-class-detect.mjs"],
    ["scripts/sensitive-classes.json"],
    ["scripts/proof-check.mjs"],
    ["scripts/validate-pr-body.mjs"],
  ])("the gate's own files are ci, not repo_scripts: %s", (file) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: ["ci"], category: null });
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
    // Review findings: bodies that are not right after DO or AS.
    ["DO LANGUAGE plpgsql $$ begin create policy p on t using (true); end $$;", ["rls"]],
    ["do $$ begin execute $q$create policy p on t using (true)$q$; end $$;", ["rls"]],
    ["do $$ begin execute 'alter table t enable row level security'; end $$;", ["rls"]],
    ["create function f() returns void language sql as 'drop policy p on t';", ["rls"]],
    ["create function f() returns int as 'select 1' language sql security definer;", ["definer"]],
    ["do $$ begin execute 'create policy p on t using (x = ''a'')'; end $$;", ["rls"]],
    ["do $$ begin execute E'alter table t enable row level security\\n'; end $$;", ["rls"]],
    ["do $a$ begin execute $b$ execute $c$ create policy p on t $c$ $b$; end $a$;", ["rls"]],
  ])("%s -> %j", (text, expected) => {
    expect(sql(text)).toEqual(expected);
  });

  it("still sees tokens below the recursion limit", () => {
    const nested = Array.from({ length: 12 }, (_, level) => `$t${level}$`);
    const text = `do ${nested.join(" ")} create policy p on t ${nested.toReversed().join(" ")};`;
    expect(sql(text)).toEqual(["rls"]);
  });

  it.each([
    ["select $$ security definer $$;", ["definer"]],
    ["select $tag$ create policy $tag$;", ["rls"]],
    ["select 'create policy x';", ["rls"]],
    ["select E'it\\'s security definer';", ["definer"]],
  ])("fails closed on a string literal: %s -> %j", (text, expected) => {
    expect(sql(text)).toEqual(expected);
  });

  it.each([
    ["-- security definer\nselect 1;"],
    ["/* outer /* nested security definer */ create policy */ select 1;"],
    ['select "security definer" from t;'],
    ["create function f() returns text as $$ select 1 -- create policy\n $$ language sql;"],
    ["select 'a /* create policy */ b';"],
    ["select 'security' || 'x' || 'definer';"],
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

  it.each([
    ["scripts/fixture.sql", "unchanged"],
    ["scripts/fixture.pgsql", "modified"],
    ["e2e/setup.psql", "added"],
    ["scripts/fixture.sql", "some-future-status"],
  ])("reads %s (%s) at the head as SQL", async (filename, status) => {
    const read = [];
    const result = await detect({
      files: [{ filename, status }],
      readHeadFile: async (file) => (read.push(file), "do $$ begin execute 'create policy p on t'; end $$;"),
      config,
    });
    expect(read).toEqual([filename]);
    expect(result.files[0]).toMatchObject({ classes: ["rls"], category: null });
  });

  it("fails closed when a head .sql file cannot be read", async () => {
    const result = await detect({ files: [modified("supabase/fixtures/missing.sql")], readHeadFile, config });
    expect(result.status).toBe("error");
    expect(result.errors[0]).toMatch(/could not read supabase\/fixtures\/missing\.sql/);
  });

  describe("oversized SQL bodies", () => {
    const file = "supabase/fixtures/big.sql";
    const run = (words) => detect({ files: [modified(file)], readHeadFile: async () => Array(words).fill("select").join(" "), config });

    it("scans a body just under the limit normally", async () => {
      const result = await run(MAX_SQL_TOKENS);
      expect(result).toMatchObject({ status: "ok", errors: [], sensitive_count: 0, unclassified: [file] });
      expect(result.manual_review).toBeUndefined();
    });

    it("fails closed with a size message when the body is over the limit", async () => {
      const result = await run(MAX_SQL_TOKENS + 1);
      expect(result.status).toBe("ok");
      expect(result.errors).toEqual([]);
      expect(result.sensitive_count).toBe(1);
      expect(result.files[0].classes).toEqual(config.classes.map((entry) => entry.name).filter((name) => config.sqlContent.rules.some((rule) => rule.class === name)));
      expect(result.manual_review).toEqual([
        `SQL body ${file} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`,
      ]);
    });

    it.each([
      ["a quoted string", `select '${";".repeat(500_000)}'`],
      ["a dollar-quoted body", `do $$${";".repeat(500_000)}$$`],
    ])("fails closed on a dense space-free body in %s", async (_name, body) => {
      const result = await detect({ files: [modified(file)], readHeadFile: async () => body, config });
      expect(result.status).toBe("ok");
      expect(result.errors).toEqual([]);
      expect(result.sensitive_count).toBe(1);
      expect(result.manual_review).toEqual([
        `SQL body ${file} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`,
      ]);
    });

    it("is deterministic across runs", async () => {
      const first = await run(MAX_SQL_TOKENS + 1);
      expect(await run(MAX_SQL_TOKENS + 1)).toEqual(first);
    });
  });
});

describe("drift: scripts CI runs are in the ci class", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const relative = (file) => path.relative(repoRoot, file).split(path.sep).join("/");
  const scripts = walk(path.join(repoRoot, "scripts")).map(relative);

  // Every scripts/ reference in .github/** (a path, a prefix or a '*' glob),
  // then every scripts/ reference and relative import inside those files.
  const ciScripts = new Set();
  const queue = [];
  const addReferences = (text, fromFile) => {
    for (const [ref] of text.matchAll(/scripts\/[\w*-][\w.*/-]*/g)) {
      const pattern = new RegExp(`^${ref.replace(/\.$/, "").replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}`);
      for (const file of scripts.filter((candidate) => pattern.test(candidate))) queue.push(file);
    }
    if (!fromFile || !/\.(?:mjs|js|ts)$/.test(fromFile)) return;
    for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = relative(path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier));
      if (scripts.includes(target)) queue.push(target);
    }
  };
  for (const file of walk(path.join(repoRoot, ".github"))) addReferences(readFileSync(file, "utf8"));
  while (queue.length) {
    const file = queue.pop();
    if (ciScripts.has(file)) continue;
    ciScripts.add(file);
    if (/\.(?:mjs|js|ts|sh)$/.test(file)) addReferences(readFileSync(path.join(repoRoot, file), "utf8"), file);
  }

  it("finds the scripts CI runs", () => {
    expect(ciScripts).toContain("scripts/sensitive-class-detect.mjs");
    expect(ciScripts).toContain("scripts/sensitive-classes.json");
    expect(ciScripts).toContain("scripts/proof-check.mjs");
  });

  it("classifies every one as ci", () => {
    const missing = [...ciScripts].filter((file) => !classifyPath(file, config).classes.includes("ci"));
    expect(missing).toEqual([]);
  });
});

describe("workflow", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/sensitive-class.yml"), "utf8");

  it("reruns when the PR is retargeted (edited)", () => {
    const types = workflow.split(/^\s*pull_request:/m)[1].split(/^\s*merge_group:/m)[0];
    expect(types).toMatch(/^\s*- edited$/m);
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
