// @vitest-environment node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GATE_CODE_FILES, GATE_LOOSENING_REQUIRES, MATCHER_PATH, SENSITIVE_CLASSES, SENSITIVE_PATHS_FILE, createMatcher, loadSensitivePaths } from "./lib/sensitive-paths.mjs";
import {
  CATEGORY_MATCH_FIELDS,
  CONFIG_PATH,
  CONFIG_REPO_PATH,
  DETECTOR_HELPER_REPO_PATH,
  DETECTOR_REPO_PATH,
  GATE_LOOSENING_LINE,
  MAX_FILES,
  MAX_SQL_TOKENS,
  OUTPUT_CLASSES,
  OUTPUT_VERSION,
  SQL_CONTENT_CLASSES,
  UNCLASSIFIED,
  WORKFLOW_REPO_PATH,
  classifyPath,
  classifySql,
  compileConfig,
  detect,
  detectGateLoosening,
  fetchPullRequest,
  formatSummary,
  gateLooseningForPull,
  githubClient,
  isValidPath,
  loadConfig,
  main,
  pathWords,
} from "./sensitive-class-detect.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// js-yaml is a transitive dev install, as picomatch is for the matcher's tests.
const yaml = createRequire(import.meta.url)("js-yaml");
const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const sensitivePathsText = readFileSync(path.join(repoRoot, SENSITIVE_PATHS_FILE), "utf8");
const { config } = loadConfig();
const requires = [...GATE_LOOSENING_REQUIRES];

const modified = (filename) => ({ filename, status: "modified" });
const noSql = async () => "";
const kinds = (result) => result.reasons.map((reason) => reason.kind);
const tempDirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("compiles the checked-in config: SQL content rules and safe categories, no path classes", () => {
    expect(loadConfig().errors).toEqual([]);
    expect(Object.keys(rawConfig)).not.toContain("classes");
    expect(Object.keys(rawConfig.safe_categories)).toEqual(["docs", "tests", "frontend_ui", "styles_assets", "repo_scripts", "agent_skills"]);
    expect([...new Set(rawConfig.sql_content.rules.map((rule) => rule.class))]).toEqual(["rls", "definer"]);
    expect(OUTPUT_CLASSES).toEqual([...SENSITIVE_CLASSES, ...SQL_CONTENT_CLASSES, UNCLASSIFIED]);
    expect(UNCLASSIFIED).toBe("unclassified");
  });

  it("rejects a classes section, unknown rule keys, bad versions and SQL rules for other classes", () => {
    expect(compileConfig({ ...structuredClone(rawConfig), classes: { auth: { paths: ["src/auth/**"] } } }).errors).toContain('config: unknown key "classes"');
    const withKey = structuredClone(rawConfig);
    withKey.safe_categories.docs.path_keyword = ["readme"];
    expect(compileConfig(withKey).errors).toContain('safe_categories.docs: unknown rule key "path_keyword"');
    expect(compileConfig({ ...structuredClone(rawConfig), version: 2 }).config).toBeNull();
    // Only rls and definer come from SQL content; path classes come from the shared list.
    for (const name of ["nope", "auth", "migrations"]) {
      const badRule = structuredClone(rawConfig);
      badRule.sql_content.rules.push({ class: name, tokens: ["x"] });
      expect(compileConfig(badRule).errors).toContain(`sql_content.rules[${badRule.sql_content.rules.length - 1}]: unknown class "${name}"`);
    }
    const collides = structuredClone(rawConfig);
    collides.safe_categories.infra_ci = { paths: ["x/**"] };
    expect(compileConfig(collides).errors).toContain("safe_categories.infra_ci: name collides with a class");
  });

  it("compiles category and SQL globs with the shared matcher's syntax", () => {
    const bad = structuredClone(rawConfig);
    bad.safe_categories.docs.paths.push("docs/[ab].md");
    bad.sql_content.paths.push("!**/*.sql");
    const errors = compileConfig(bad).errors.join("\n");
    expect(errors).toMatch(/safe_categories\.docs\.paths: unsupported character/);
    expect(errors).toMatch(/sql_content\.paths: unsupported character/);
    expect(pathWords("worker/src/providerAdmission/RLSPolicy.ts")).toEqual(["worker", "src", "provider", "admission", "rls", "policy", "ts"]);
  });

  it("fails closed when the base checkout has no shared list", () => {
    const root = tempDir("sensitive-class-root-");
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(CONFIG_PATH, path.join(root, CONFIG_REPO_PATH));
    const loaded = loadConfig({ root });
    expect(loaded.config).toBeNull();
    expect(loaded.errors).toEqual([expect.stringMatching(/^docs\/sensitive-paths\.json could not be loaded: docs\/sensitive-paths\.json not found/)]);
  });
});

// The shared fixture never names the migrations directory; map it here.
const MIGRATIONS_DIR = ["supabase", "migrations"].join("/");
const sharedFixture = JSON.parse(readFileSync(path.join(repoRoot, "scripts/fixtures/sensitive-paths/paths.json"), "utf8")).paths.map(
  (entry) => ({ ...entry, path: entry.path.replace("{migrations}", MIGRATIONS_DIR) }),
);

describe("classifyPath: classes come from docs/sensitive-paths.json", () => {
  it("gives the shared matcher's classes for every shared fixture path", () => {
    const matcher = createMatcher(loadSensitivePaths({ root: repoRoot }));
    for (const { path: file, classes } of sharedFixture) {
      expect(classifyPath(file, config).classes, file).toEqual(classes);
      expect(matcher.classify(file), file).toEqual(classes);
    }
  });

  // One path per class this detector used before the shared list (old -> new).
  it.each([
    ["supabase/migrations/20261001000000_x.sql", ["schema", "migrations"]], // migration
    ["docs/migration-drafts/ovd707/notes.md", ["schema"]], // migration
    ["docs/release/window-2/forward.sql", ["schema"]], // migration
    ["supabase/tests/rls_quotes.test.sql", ["schema", "auth"]], // rls path
    ["src/lib/auth/session-store.ts", ["auth"]], // auth
    ["server/payments/handler.ts", ["payments"]], // billing
    ["src/pages/checkout/Summary.tsx", ["payments"]], // billing
    ["worker/src/adapters/xometry.ts", ["provider_dispatch"]], // provider
    ["worker/src/dispatchQueue.ts", ["provider_dispatch"]], // provider
    [".env.production", ["secrets"]], // secrets
    [".github/workflows/ci.yml", ["infra_ci"]], // ci
    ["infra/main.yaml", ["infra_ci"]], // infra
    ["scripts/deploy-x.sh", ["infra_ci"]], // infra
    ["package-lock.json", ["deps"]], // deps
  ])("%s -> %j", (file, classes) => {
    expect(classifyPath(file, config)).toMatchObject({ classes, category: null });
  });

  // Coverage this detector had that the shared list gained in this PR (additions only).
  it.each([
    ["scripts/build.Dockerfile", ["infra_ci"]],
    ["staging.tfvars", ["infra_ci"]],
    ["config/.env.d/local.json", ["secrets"]],
    ["scripts/bun.lock", ["deps"]],
    ["tools/Pipfile.lock", ["deps"]],
    ["Gemfile", ["deps"]],
  ])("kept coverage: %s -> %j", (file, classes) => {
    expect(classifyPath(file, config)).toMatchObject({ classes, category: null });
  });

  it.each([
    [DETECTOR_REPO_PATH],
    [CONFIG_REPO_PATH],
    ["scripts/sensitive-class-detect.test.mjs"],
    [DETECTOR_HELPER_REPO_PATH],
    [WORKFLOW_REPO_PATH],
    ["scripts/validate-pr-body.mjs"],
    [MATCHER_PATH],
    [SENSITIVE_PATHS_FILE],
  ])("the gate's own files are infra_ci, never a safe category: %s", (file) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: ["infra_ci"], category: null });
  });

  it("matches more than one class on one path, with one reason per matching glob", () => {
    expect(classifyPath(".github/workflows/deploy-stripe.yml", config)).toEqual({
      classes: ["payments", "infra_ci"],
      category: null,
      reasons: ["payments:path:**/*stripe*{,/**}", "infra_ci:path:.github/workflows/**"],
    });
  });

  it("matches a class word anywhere in a name, as the shared list does (fails closed)", () => {
    expect(classifyPath("src/pages/Unauthorized.tsx", config).classes).toEqual(["auth"]);
    expect(classifyPath("src/lib/authorize.ts", config).classes).toEqual(["auth"]);
  });

  // Agent instruction files in any directory (review @ f786b942): Codex reads
  // one per directory and prefers AGENTS.override.md, so each can replace the
  // contract for its tree. They were safe (docs, frontend_ui, repo_scripts,
  // agent_skills) or unclassified before.
  it.each([
    ["AGENTS.md"],
    ["AGENTS.override.md"],
    ["CLAUDE.md"],
    ["CLAUDE.local.md"],
    ["src/features/quotes/AGENTS.override.md"],
    ["docs/AGENTS.md"],
    ["docs/CLAUDE.md"],
    ["scripts/AGENTS.override.md"],
    [".codex/skills/AGENTS.override.md"],
    [".claude/agents/CLAUDE.md"],
    ["worker/src/CLAUDE.local.md"],
  ])("agent instruction file %s is infra_ci, never a safe category", (file) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: ["infra_ci"], category: null });
  });

  it("covers the tracked AGENTS.override.md", () => {
    expect(existsSync(path.join(repoRoot, "src/features/quotes/AGENTS.override.md"))).toBe(true);
  });

  // Names 0163daf7's path keywords matched and the shared list now matches too
  // (reviews @ f786b942 and 6e96e47c): rls after a dot or a comma, provider
  // admission or upload split by a directory, by any characters next to it, by
  // a one-character directory, or by any other character, and checkout with
  // the Kelvin sign (0163daf7 lower-cased it to k). scripts/sensitive-class-sweep.test.mjs
  // checks every character in every position.
  it.each([
    ["src/features/q/x.rls.ts", ["auth"]],
    ["scripts/x.rls.ts", ["auth"]],
    ["src/features/q/x,rls.ts", ["auth"]],
    ["src/features/provider/upload/Form.tsx", ["provider_dispatch"]],
    ["src/features/provider/admission/Form.tsx", ["provider_dispatch"]],
    ["src/features/provider.upload.tsx", ["provider_dispatch"]],
    ["scripts/provider/admission.mjs", ["provider_dispatch"]],
    ["docs/provider admission.md", ["provider_dispatch"]],
    ["src/components/provider+uploads.tsx", ["provider_dispatch"]],
    ["src/features/provider/_upload/Form.tsx", ["provider_dispatch"]],
    ["src/features/provider/_upload.tsx", ["provider_dispatch"]],
    ["src/pages/provider/(admission)/index.tsx", ["provider_dispatch"]],
    ["src/features/provider/[upload]/Form.tsx", ["provider_dispatch"]],
    ["src/features/provider/@upload/Form.tsx", ["provider_dispatch"]],
    ["src/features/x-provider_/upload.tsx", ["provider_dispatch"]],
    ["src/provider_/upload/x.ts", ["provider_dispatch"]],
    ["scripts/provider/_admission.mjs", ["provider_dispatch"]],
    ["worker/src/provider/_admission.ts", ["provider_dispatch"]],
    ["docs/provider/ upload.md", ["provider_dispatch"]],
    ["src/features/provider/_/upload.tsx", ["provider_dispatch"]],
    ["src/features/chec\u212Aout.tsx", ["payments"]],
    ["docs/a.pgsql", ["schema"]],
    ["src/assets/b.psql", ["schema"]],
  ])("restored coverage: %j -> %j", (file, classes) => {
    expect(classifyPath(file, config)).toMatchObject({ classes, category: null });
  });

  // The agent contract and agent configuration (review @ 6e96e47c): WORKFLOW.md
  // sets Codex's approval policy, sandbox and network access and runs the
  // Symphony hooks; the others configure Codex or Claude, start MCP servers or
  // run as git hooks. At 6e96e47c (and 0163daf7) WORKFLOW.md and both GEMINI.md
  // rows were docs; symphony-ensure-branch.sh, the vite plugins and
  // scripts/hooks/pre-commit were repo_scripts; symphony-agent.sh was already
  // infra_ci (repo_scripts at 0163daf7); the rest were unclassified.
  it.each([
    ["WORKFLOW.md"],
    ["GEMINI.md"],
    ["docs/GEMINI.md"],
    ["scripts/symphony-ensure-branch.sh"],
    ["scripts/symphony-agent.sh"],
    ["scripts/vite-sample-plate-plugin.ts"],
    ["scripts/vite-private-fixture-plugin.ts"],
    [".codex/config.toml"],
    [".codex/hooks.json"],
    [".claude/settings.json"],
    [".claude/settings.local.json"],
    [".claude/hooks/pre-tool.sh"],
    [".claude/rules/style.md"],
    [".claude/launch.json"],
    [".mcp.json"],
    [".husky/pre-commit"],
    [".githooks/pre-push"],
    ["scripts/hooks/pre-commit"],
    ["lefthook.yml"],
    [".pre-commit-config.yaml"],
  ])("agent contract or configuration file %s is infra_ci, never a safe category", (file) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: ["infra_ci"], category: null });
  });

  it("classifies every file validate-agent-contract reads as infra_ci", () => {
    const source = readFileSync(path.join(repoRoot, "scripts/validate-agent-contract.mjs"), "utf8");
    const read = [...source.matchAll(/\bread\("([^"]+)"\)/g)].map(([, file]) => file);
    expect(read).toEqual(["AGENTS.md", "CLAUDE.md", "WORKFLOW.md"]);
    expect(source).toContain("read(SENSITIVE_PATHS_FILE)");
    for (const file of [...read, SENSITIVE_PATHS_FILE]) expect(classifyPath(file, config).classes, file).toContain("infra_ci");
  });

  it("leaves React hooks alone and makes every provider page provider_dispatch (Release, final round)", () => {
    expect(classifyPath("src/hooks/use-toast.ts", config)).toMatchObject({ classes: [], category: null });
    expect(classifyPath("src/features/providers/ProviderCard.tsx", config)).toMatchObject({ classes: ["provider_dispatch"], category: null });
  });

  // Release, final round: any provider, adapter or dispatch path is sensitive.
  it.each([
    "src/features/provider/_upload/Form.tsx",
    "src/pages/provider/(admission)/index.tsx",
    "src/features/provider/[upload]/Form.tsx",
    "scripts/provider/_admission.mjs",
    "worker/src/provider_/upload/x.ts",
    "src/lib/quoteAdapter.ts",
    "src/features/dispatch/Panel.tsx",
    "src/components/ProviderBadge.tsx",
    "docs/adapters/README.md",
  ])("provider path %s is provider_dispatch, never a safe category", async (file) => {
    expect(classifyPath(file, config)).toMatchObject({ category: null });
    expect(classifyPath(file, config).classes).toContain("provider_dispatch");
    const result = await detect({ files: [modified(file)], config });
    expect(result).toMatchObject({ status: "ok", sensitive_count: 1, unclassified: [] });
    expect(result.files[0].classes).toContain("provider_dispatch");
  });

  it.each(["WORKFLOW.md", "scripts/symphony-ensure-branch.sh", "scripts/symphony-agent.sh", "scripts/symphony-preflight.sh"])(
    "agent-contract file %s is infra_ci, never a safe category (Release, final round)",
    (file) => {
      expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
      expect(classifyPath(file, config)).toMatchObject({ classes: ["infra_ci"], category: null });
    },
  );

  // Release, final round 3: every Symphony script name shape is infra_ci, not
  // only scripts/symphony-*; a Symphony directory is covered too.
  it.each(["scripts/symphony.sh", "scripts/symphony/run.sh", "scripts/symphony_agent.sh", "scripts/symphonyHook.mjs"])(
    "Symphony script %s is infra_ci, never a safe category (Release, final round 3)",
    async (file) => {
      expect(classifyPath(file, config)).toMatchObject({ classes: ["infra_ci"], category: null });
      const result = await detect({ files: [modified(file)], config });
      expect(result).toMatchObject({ status: "ok", sensitive_count: 1, unclassified: [] });
      expect(result.files[0].classes).toEqual(["infra_ci"]);
    },
  );

  // Known residual (documented in the PR): 0163daf7 split camelCase words, so
  // quoteRls was rls. The shared list is case-insensitive and its fixture keeps
  // src/lib/urls.ts out, so a camelCase rls cannot be matched without urls.
  it("does not match a camelCase rls, which would also match urls", () => {
    expect(classifyPath("src/features/quotes/quoteRls.ts", config)).toMatchObject({ classes: [], category: "frontend_ui" });
    expect(classifyPath("src/lib/urls.ts", config)).toMatchObject({ classes: [], category: null });
  });
});

describe("classifyPath: safe categories", () => {
  it.each([
    ["README.md", "docs"],
    ["docs/agent-graph-metrics.md", "docs"],
    ["src/lib/quote.test.ts", "tests"],
    ["scripts/check-compiled-worker-scope.node-test.mjs", "tests"],
    ["e2e/journeys/quote.spec.ts", "tests"],
    ["src/components/QuoteTable.tsx", "frontend_ui"],
    ["src/index.css", "styles_assets"],
    ["public/favicon.svg", "styles_assets"],
    ["scripts/generate-favicons.mjs", "repo_scripts"],
    [".codex/skills/commit/SKILL.md", "agent_skills"],
    [".claude/agents/implementer.md", "agent_skills"],
  ])("%s -> %s", (file, category) => {
    expect(classifyPath(file, config)).toMatchObject({ classes: [], category });
  });

  it.each([
    ["docs/migration-drafts/x.sql", ["schema"], null],
    ["docs/release/forward.sql", ["schema"], null],
    ["e2e/fixtures/a.sql", ["schema"], null],
    ["scripts/deploy-x.sh", ["infra_ci"], null],
    ["src/pages/checkout/Pay.tsx", ["payments"], null],
    ["src/features/auth/x.tsx", ["auth"], null],
    ["scripts/rotate-token-cache.mjs", [], null],
    ["AGENTS.md", ["infra_ci"], null],
    ["CLAUDE.md", ["infra_ci"], null],
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
    // Postgres ends a line comment at CR too (review @ f786b942).
    ["-- x\rCREATE POLICY p ON t USING (true);", ["rls"]],
    ["select 1; -- note\r\nalter table t enable row level security;", ["rls"]],
  ])("%s -> %j", (text, expected) => {
    expect(sql(text)).toEqual(expected);
  });

  it("still sees tokens below the recursion limit", () => {
    const nested = Array.from({ length: 12 }, (_, level) => `$t${level}$`);
    const text = `do ${nested.join(" ")} create policy p on t ${nested.toReversed().join(" ")};`;
    expect(sql(text)).toEqual(["rls"]);
  });

  // Deliberate deviation from the OVD-844 test plan row "security definer
  // inside $$ is no false positive": every string is scanned as SQL so DO and
  // EXECUTE bodies are caught, which fails closed on a mere mention.
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

  it("adds SQL content classes after the shared list's and keys the result to the head", async () => {
    const result = await detect({ files: Object.keys(sqlFiles).map(modified), readHeadFile, config, sha: "h", baseSha: "b" });
    expect(result).toMatchObject({ version: OUTPUT_VERSION, sha: "h", base_sha: "b", status: "ok", classes: ["schema", "migrations", "rls", "definer"], multi_class: true });
    expect(result.files.map((file) => file.classes)).toEqual([["schema", "migrations", "rls"], ["schema", "definer"], ["schema"]]);
    expect(result.files[0].reasons).toEqual(["schema:path:**/*.sql", "migrations:path:supabase/migrations/**", "rls:sql:create policy"]);
    expect(result.unclassified).toEqual([]);
  });

  it("counts a sensitive old path of a rename", async () => {
    const result = await detect({
      files: [{ filename: "docs/old-notes.md", previous_filename: "supabase/migrations/2026_x.sql", status: "renamed" }],
      readHeadFile: noSql,
      config,
    });
    expect(result.files[0]).toMatchObject({ classes: ["schema", "migrations"], category: null, previous_path: "supabase/migrations/2026_x.sql" });
    expect(result.files[0].reasons).toContain("previous:migrations:path:supabase/migrations/**");
  });

  it("classifies a deletion by path without reading the head", async () => {
    const result = await detect({ files: [{ filename: "src/lib/auth.ts", status: "removed" }, { filename: "supabase/migrations/x.sql", status: "removed" }], config });
    expect(result.status).toBe("ok");
    expect(result.files.map((file) => file.classes)).toEqual([["auth"], ["schema", "migrations"]]);
  });

  // Release, final round: fail closed. Only a safe category makes a file with no class non-sensitive.
  it.each(["vite.config.ts", "some/new/dir/file.xyz", "worker/foo.go", "src/lib/urls.ts"])(
    "an unmatched path %s is sensitive with classes [unclassified]",
    async (file) => {
      expect(classifyPath(file, config)).toMatchObject({ classes: [], category: null });
      const result = await detect({ files: [modified(file)], config });
      expect(result).toMatchObject({ status: "ok", classes: [UNCLASSIFIED], sensitive_count: 1, unclassified: [file], multi_class: false });
      expect(result.files[0]).toMatchObject({ classes: [UNCLASSIFIED], category: null, reasons: ["unclassified:no-safe-category"] });
    },
  );

  it.each(["docs/guide.md", "src/components/Button.tsx", "README.md"])("a safe-only path %s is the non-sensitive case", async (file) => {
    const result = await detect({ files: [modified(file)], config });
    expect(result).toMatchObject({ status: "ok", classes: [], sensitive_count: 0, unclassified: [] });
    expect(result.files[0].classes).toEqual([]);
    expect(result.files[0].category).not.toBeNull();
  });

  it("counts unclassified with the other classes and lists it last", async () => {
    const result = await detect({ files: [modified("worker/foo.go"), modified("src/lib/auth.ts"), modified("README.md")], config });
    expect(result).toMatchObject({ classes: ["auth", UNCLASSIFIED], sensitive_count: 2, multi_class: true, unclassified: ["worker/foo.go"] });
  });

  it("gives unclassified to a rename whose names land in different safe categories", async () => {
    const result = await detect({ files: [{ filename: "src/components/Guide.tsx", previous_filename: "docs/guide.md", status: "renamed" }], config });
    expect(result.files[0]).toMatchObject({ classes: [UNCLASSIFIED], category: null });
    expect(result.sensitive_count).toBe(1);
  });

  it("renders unclassified files as sensitive in the summary", async () => {
    const summary = formatSummary(await detect({ files: [modified("worker/foo.go")], config }));
    expect(summary).toContain("Unclassified (sensitive, no safe category): `worker/foo.go`");
    expect(summary).toContain("| `worker/foo.go` | modified | **unclassified** | - |");
  });

  it.each([
    ["scripts/fixture.sql", "unchanged", ["schema", "rls"]],
    ["scripts/fixture.pgsql", "modified", ["schema", "rls"]],
    ["e2e/setup.psql", "added", ["schema", "rls"]],
    ["scripts/fixture.sql", "some-future-status", ["schema", "rls"]],
  ])("reads %s (%s) at the head as SQL", async (filename, status, classes) => {
    const read = [];
    const result = await detect({
      files: [{ filename, status }],
      readHeadFile: async (file) => (read.push(file), "do $$ begin execute 'create policy p on t'; end $$;"),
      config,
    });
    expect(read).toEqual([filename]);
    expect(result.files[0]).toMatchObject({ classes, category: null });
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
      expect(result).toMatchObject({ version: OUTPUT_VERSION, status: "ok", errors: [], sensitive_count: 1, unclassified: [], classes: ["schema"] });
      expect(result.manual_review).toBeUndefined();
    });

    it("fails closed with a size message when the body is over the limit", async () => {
      const result = await run(MAX_SQL_TOKENS + 1);
      expect(result.status).toBe("ok");
      expect(result.errors).toEqual([]);
      expect(result.sensitive_count).toBe(1);
      expect(result.version).toBe(OUTPUT_VERSION);
      expect(result.files[0].classes).toEqual(["schema", ...SQL_CONTENT_CLASSES]);
      expect(result.files[0].reasons).toContain(`sql:oversized:>${MAX_SQL_TOKENS}`);
      expect(formatSummary(result)).toContain("manual review: `SQL body " + file + " rejected for size");
      expect(result.manual_review).toEqual([
        `SQL body ${file} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`,
      ]);
    });

    it.each([
      ["a quoted string", `select '${";".repeat(500_000)}'`],
      ["a dollar-quoted body", `do $$${";".repeat(500_000)}$$`],
      ["a comment exceeding the character cap", `--${"x".repeat(MAX_SQL_TOKENS * 256)}`],
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

// The shared matcher reads a non-string as its string form and an empty list
// as not sensitive; the detector must turn those into status error instead.
describe("detect: strict file list", () => {
  const spied = () => {
    const seen = [];
    return { seen, config: { ...config, matcher: { ...config.matcher, match: (file) => (seen.push(file), config.matcher.match(file)) } } };
  };

  it.each([
    ["a missing filename", { status: "modified" }],
    ["a null filename", { filename: null, status: "modified" }],
    ["an object filename", { filename: { path: "supabase/migrations/x.sql" }, status: "modified" }],
    ["an empty filename", { filename: "", status: "modified" }],
    ["a blank filename", { filename: "   ", status: "modified" }],
    ["a filename that is only ./", { filename: "./", status: "modified" }],
    ["a missing status", { filename: "supabase/migrations/x.sql" }],
    ["a rename without previous_filename", { filename: "docs/x.md", status: "renamed" }],
    ["a non-string previous_filename", { filename: "docs/x.md", previous_filename: 7, status: "renamed" }],
    ["a null entry", null],
  ])("%s is status error and never reaches the matcher", async (_label, entry) => {
    const { seen, config: spy } = spied();
    const result = await detect({ files: [entry, modified("README.md")], readHeadFile: noSql, config: spy });
    expect(result.status).toBe("error");
    expect(result.errors).toEqual([expect.stringMatching(/^changed file 1: /)]);
    expect(seen).toEqual(["README.md"]);
    expect(result.files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("errors on an empty or missing list unless the PR reports zero changed files", async () => {
    const { seen, config: spy } = spied();
    expect(await detect({ files: [], config: spy })).toMatchObject({ status: "error", errors: [expect.stringMatching(/list is empty/)] });
    expect(await detect({ files: [], config: spy, allowEmpty: true })).toMatchObject({ status: "ok", classes: [], files: [], errors: [] });
    expect(await detect({ files: undefined, config: spy, allowEmpty: true })).toMatchObject({ status: "error", errors: [expect.stringMatching(/not an array/)] });
    expect(seen).toEqual([]);
  });

  it("classifyPath refuses a non-path instead of reading it as not sensitive", () => {
    for (const value of [undefined, null, "", "  ", "./", { path: "supabase/migrations/x.sql" }, 5]) {
      expect(() => classifyPath(value, config), String(value)).toThrow(/invalid path/);
    }
    expect(isValidPath("supabase/migrations/x.sql")).toBe(true);
  });
});

// The scripts CI runs, found by walking from .github/**, from WORKFLOW.md (the
// Symphony hooks and agent command run on agent hosts) and from the root tool
// configs CI's commands load (*.config.{ts,js,...}: vite build, vitest, eslint,
// playwright):
// - every scripts/ reference in a .github/** file or WORKFLOW.md (a path, a
//   prefix or a glob), and every relative import in a root tool config;
// - every `npm run <name>` (also `npm test`, `npm start`, `npm --prefix <dir>`,
//   pre and post scripts, and the install lifecycle scripts of `npm ci` or
//   `npm install` without --ignore-scripts) in a .github/** file, in
//   WORKFLOW.md, in a package.json script reached that way, and in a shell
//   script reached;
// - the scripts/ files those package.json scripts name;
// - in each script reached: every scripts/ reference (except a ** glob, which
//   is prose) and every relative import, require or new URL.
// JavaScript files are not read for npm runs; a test checks that none starts
// npm. Python files are not read for imports; CI names their directory.
// Vitest's own discovery (`vitest run` with no file) is not followed, nor are
// string paths in a tool config (vite.config.ts's opt-in setup file, which CI
// does not enable, and its test include globs).
const DYNAMIC_NPM_RUNS = { "scripts/preflight.sh": ["lint", "typecheck", "test"] };
const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];

function ciRunScripts(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const scripts = walk(path.join(root, "scripts")).map(relative);
  const found = new Map();
  const npmRuns = new Map();
  const problems = [];
  const queue = [];

  const addScriptRefs = (text, from, { dir = "", prose = false } = {}) => {
    for (const [, lead, ref] of text.matchAll(/((?:\.{1,2}\/)*)(scripts\/[\w*-][\w.*/-]*)/g)) {
      if (prose && ref.includes("**")) continue;
      const resolved = dir ? path.posix.normalize(path.posix.join(dir, lead, ref)) : ref;
      if (!resolved.startsWith("scripts/")) continue;
      const pattern = new RegExp(`^${resolved.replace(/\.$/, "").replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}`);
      for (const file of scripts.filter((candidate) => pattern.test(candidate))) queue.push([file, from]);
    }
  };
  const packageScripts = (dir) => JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")).scripts ?? {};
  const followNpm = (dir, names, from, { optional = false } = {}) => {
    const defined = packageScripts(dir);
    for (const name of names) {
      if (!Object.hasOwn(defined, name)) {
        if (!optional) problems.push(`${from}: npm run ${name} has no script in ${dir || "."}/package.json`);
        continue;
      }
      for (const step of [`pre${name}`, name, `post${name}`]) {
        const key = `${dir || "."}/package.json#${step}`;
        if (!Object.hasOwn(defined, step) || npmRuns.has(key)) continue;
        npmRuns.set(key, from);
        addScriptRefs(defined[step], key, { dir });
        addNpmRuns(defined[step], key, dir);
      }
    }
  };
  const addNpmRuns = (text, from, dir = "") => {
    const invocation = /\bnpm((?:\s+(?:--prefix[= ]\s*\S+|-C\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(run-script|run|test|start|t|ci|install|i)\b((?:\s+--?[\w-]+)*)(?:\s+(["']?)([^\s"'`;&|)]+)\4)?([^\n;&|]*)/g;
    for (const [, options, verb, , , rawName, rest] of text.matchAll(invocation)) {
      const prefix = /(?:--prefix[= ]\s*|-C\s+)(\S+)/.exec(options)?.[1];
      const target = prefix ? path.posix.normalize(path.posix.join(dir || ".", prefix)).replace(/^\.$/, "") : dir;
      if (["ci", "install", "i"].includes(verb)) {
        if (!/--ignore-scripts\b/.test(`${options} ${rawName ?? ""} ${rest}`)) followNpm(target, INSTALL_LIFECYCLE, from, { optional: true });
        continue;
      }
      if (verb !== "run" && verb !== "run-script") {
        followNpm(target, [verb === "t" ? "test" : verb], from);
        continue;
      }
      if (!rawName) continue;
      const name = rawName.replace(/[.,:]+$/, "");
      if (name.includes("$")) {
        if (DYNAMIC_NPM_RUNS[from]) followNpm(target, DYNAMIC_NPM_RUNS[from], from);
        else problems.push(`${from}: npm run ${rawName} takes its name from a variable; list its names in DYNAMIC_NPM_RUNS`);
        continue;
      }
      followNpm(target, [name], from);
    }
  };
  const addImports = (text, from) => {
    for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport|\brequire|\bnew URL)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = relative(path.resolve(path.dirname(path.join(root, from)), specifier));
      const hits = scripts.filter((file) => [target, `${target}.mjs`, `${target}.js`, `${target}.ts`].includes(file) || file.startsWith(`${target}/`));
      for (const file of hits) queue.push([file, from]);
    }
  };

  for (const file of walk(path.join(root, ".github"))) {
    const text = readFileSync(file, "utf8");
    addScriptRefs(text, relative(file));
    addNpmRuns(text, relative(file));
  }
  if (existsSync(path.join(root, "WORKFLOW.md"))) {
    const text = readFileSync(path.join(root, "WORKFLOW.md"), "utf8");
    addScriptRefs(text, "WORKFLOW.md");
    addNpmRuns(text, "WORKFLOW.md");
  }
  for (const entry of readdirSync(root)) {
    if (/^[^/]+\.config\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry)) addImports(readFileSync(path.join(root, entry), "utf8"), entry);
  }
  while (queue.length) {
    const [file, from] = queue.pop();
    if (found.has(file)) continue;
    found.set(file, from);
    if (!/\.(?:mjs|cjs|js|ts|sh)$/.test(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    addScriptRefs(text, file, { prose: true });
    if (file.endsWith(".sh")) addNpmRuns(text, file);
    else addImports(text, file);
  }
  return { scripts: found, npmRuns, problems };
}

describe("drift: scripts CI runs are infra_ci on the shared list", () => {
  const { scripts: ciScripts, npmRuns, problems } = ciRunScripts(repoRoot);

  it("finds the scripts CI runs, including through npm run and package.json", () => {
    for (const file of [DETECTOR_REPO_PATH, CONFIG_REPO_PATH, DETECTOR_HELPER_REPO_PATH, MATCHER_PATH, "scripts/preflight.sh"]) expect(ciScripts.has(file), file).toBe(true);
    // Reached only through npm run (the f786b942 reviews' examples).
    for (const file of [
      "scripts/verify-migration-lineage.mjs", // ci.yml: npm run verify:migration-lineage
      "scripts/provider-check.mjs", // npm run provider:check
      "scripts/provider-sync.mjs", // imported by provider-check.mjs
      "scripts/provider-registry.mjs",
      "scripts/default-deny-execution.mjs",
      "scripts/reviewed-envelope-check.mjs",
      "scripts/seed-dev.mjs", // npm run seed:dev
      "scripts/verify-public-assets.mjs", // npm run build
      "scripts/inventory-worktrees.mjs", // npm run test:agent-control-plane
      "scripts/agent-control/launch.py",
      "scripts/agent-control/run_store.py",
      "scripts/check-migration-immutability.mjs", // npm run test:portable-node
      // Review @ 6e96e47c: reached from WORKFLOW.md and from vite.config.ts.
      "scripts/symphony-ensure-branch.sh", // WORKFLOW.md before_run
      "scripts/symphony-agent.sh", // WORKFLOW.md codex.command
      "scripts/symphony-preflight.sh", // WORKFLOW.md after_create
      "scripts/vite-private-fixture-plugin.ts", // vite.config.ts import (npm run build, vitest)
      "scripts/vite-sample-plate-plugin.ts",
    ]) {
      expect(ciScripts.has(file), file).toBe(true);
    }
    // preflight.sh runs npm run "$stage"; the stages are followed too.
    for (const step of ["./package.json#lint", "./package.json#typecheck", "./package.json#test", "worker/package.json#verify"]) expect(npmRuns.has(step), step).toBe(true);
  });

  it("resolves every npm run name, and lists the names a variable can take", () => {
    expect(problems).toEqual([]);
    // DYNAMIC_NPM_RUNS must follow preflight.sh's own stage list.
    expect(readFileSync(path.join(repoRoot, "scripts/preflight.sh"), "utf8")).toMatch(/^\s*lint \| typecheck \| test\) ;;$/m);
    const probe = tempDir("sensitive-class-npm-");
    mkdirSync(path.join(probe, ".github", "workflows"), { recursive: true });
    mkdirSync(path.join(probe, "scripts"));
    writeFileSync(path.join(probe, "package.json"), JSON.stringify({ scripts: { prechecks: "node scripts/a.mjs", checks: "npm run inner", inner: "bash scripts/b.sh" } }));
    writeFileSync(path.join(probe, "scripts", "a.mjs"), "");
    writeFileSync(path.join(probe, "scripts", "b.sh"), 'npm run "$x"\nnpm run missing\n');
    writeFileSync(path.join(probe, ".github", "workflows", "ci.yml"), "steps:\n  - run: npm run checks -- --flag\n");
    const walked = ciRunScripts(probe);
    expect([...walked.scripts.keys()].sort()).toEqual(["scripts/a.mjs", "scripts/b.sh"]);
    expect(walked.problems).toEqual([
      "scripts/b.sh: npm run $x takes its name from a variable; list its names in DYNAMIC_NPM_RUNS",
      "scripts/b.sh: npm run missing has no script in ./package.json",
    ]);
  });

  it("no CI-run JavaScript file starts npm itself (the walk reads only shell scripts for npm runs)", () => {
    const starts = [...ciScripts.keys()].filter((file) => /\.(?:mjs|cjs|js|ts)$/.test(file)).filter((file) =>
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*["'`]npm(?:["'`]|\s)/.test(readFileSync(path.join(repoRoot, file), "utf8")));
    expect(starts).toEqual([]);
  });

  it("classifies every one as infra_ci in docs/sensitive-paths.json", () => {
    const matcher = createMatcher(loadSensitivePaths({ root: repoRoot }));
    const missing = [...ciScripts].filter(([file]) => !matcher.classify(file).includes("infra_ci")).map(([file, from]) => `${file} (from ${from})`);
    expect(missing).toEqual([]);
  });
});

describe("workflow", () => {
  const workflow = yaml.load(readFileSync(path.join(repoRoot, WORKFLOW_REPO_PATH), "utf8"));
  const job = workflow.jobs["sensitive-class"];
  const step = job.steps.find((entry) => entry.name === "Detect sensitive classes");

  it("reruns when the PR is retargeted (edited)", () => {
    expect(workflow.on.pull_request.types).toContain("edited");
  });

  it("runs the detect step with GitHub's default shell (bash -e) and no inline expressions", () => {
    expect(step).toBeDefined();
    expect(step.shell).toBeUndefined();
    expect(job.defaults).toBeUndefined();
    expect(workflow.defaults).toBeUndefined();
    expect(step.run).not.toContain("${{");
  });

  // GitHub runs a run: block with no shell as `bash -e {0}`, and with
  // `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`.
  // The third form passes the block itself with -c, as Release's checklist asks.
  const shells = [["bash", "-e"], ["bash", "--noprofile", "--norc", "-eo", "pipefail"], ["bash", "-e", "-c"]];
  const writeArgs = 'import { appendFileSync, writeFileSync } from "node:fs";\nwriteFileSync(`${process.env.RUNNER_TEMP}/argv.json`, JSON.stringify(process.argv.slice(2)));\n';
  const writeResult = (status) => `${writeArgs}writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify({ status: "${status}" }));\nappendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Sensitive classes: ${status === "ok" ? "OK" : "ERROR"}\\n");\n`;
  const runStep = (shell, stub) => {
    const dir = tempDir("sensitive-class-step-");
    const work = path.join(dir, "work");
    mkdirSync(path.join(work, "scripts"), { recursive: true });
    if (stub !== null) writeFileSync(path.join(work, DETECTOR_REPO_PATH), stub);
    const script = path.join(dir, "step.sh");
    writeFileSync(script, step.run);
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    const args = shell.includes("-c") ? [...shell.slice(1), step.run] : [...shell.slice(1), script];
    const child = spawnSync(shell[0], args, {
      cwd: work,
      encoding: "utf8",
      env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, PR_NUMBER: "7", HEAD_SHA: "headsha", REPOSITORY: "o/r", GITHUB_TOKEN: "test-token" },
    });
    const argvFile = path.join(dir, "argv.json");
    return {
      status: child.status,
      stdout: child.stdout,
      summary: readFileSync(summary, "utf8"),
      argv: existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, "utf8")) : null,
      out: path.join(dir, "sensitive-class.json"),
      outExists: existsSync(path.join(dir, "sensitive-class.json")),
    };
  };

  it("uses a harness where bash -e ends a script at the first failing command", () => {
    const child = spawnSync("bash", ["-e", "-c", "false\necho after"], { encoding: "utf8" });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
  });

  it.each(shells)("a detector that exits non-zero gives a warning and an ERROR summary, and the step exits 0 (%s %s)", (...shell) => {
    for (const [stub, code] of [[`${writeArgs}process.exit(3);\n`, 3], [`${writeResult("ok")}throw new Error("crash after writing");\n`, 1]]) {
      const run = runStep(shell, stub);
      expect(run.status, run.stdout).toBe(0);
      expect(run.stdout).toContain(`::warning title=Sensitive class::sensitive-class-detect exited ${code} (report mode, not failing the job)`);
      expect(run.summary).toContain("### Sensitive classes: ERROR");
      expect(run.summary).toContain(`sensitive-class-detect exited ${code}, so there is no result.`);
      // A result written before the failure is removed, so no artifact is uploaded.
      expect(run.outExists).toBe(false);
      expect(run.argv).toEqual(["--repo", "o/r", "--pr", "7", "--head-sha", "headsha", "--json", run.out]);
    }
  });

  it.each(shells)("a detector that exits 0 with status ok gives no warning and keeps its summary (%s %s)", (...shell) => {
    const run = runStep(shell, writeResult("ok"));
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("::warning");
    expect(run.summary).toBe("### Sensitive classes: OK\n");
    expect(run.outExists).toBe(true);
  });

  it.each(shells)("a detector that exits 0 with status error gives a warning (%s %s)", (...shell) => {
    const run = runStep(shell, writeResult("error"));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("::warning title=Sensitive class::status is not ok");
    expect(run.summary).toBe("### Sensitive classes: ERROR\n");
  });

  it.each(shells)("a detector that exits 0 without a result gives a warning and an ERROR summary (%s %s)", (...shell) => {
    const run = runStep(shell, `${writeArgs}\n`);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("::warning title=Sensitive class::no readable result");
    expect(run.summary).toContain("### Sensitive classes: ERROR");
    expect(run.outExists).toBe(false);
  });

  // Review @ 6e96e47c: an unreadable result written before an exit 0 stayed and was uploaded.
  it.each(shells)("a detector that exits 0 with unreadable JSON gives an ERROR summary and leaves no result to upload (%s %s)", (...shell) => {
    for (const body of ['{"status": "ok", "files": [', "", "null"]) {
      const stub = `${writeArgs}writeFileSync(process.argv[process.argv.indexOf("--json") + 1], ${JSON.stringify(body)});\n`;
      const run = runStep(shell, stub);
      expect(run.status, body).toBe(0);
      expect(run.stdout, body).toContain("::warning title=Sensitive class::no readable result (report mode, not failing the job)");
      expect(run.summary, body).toContain("sensitive-class-detect exited 0 but wrote no readable result.");
      expect(run.outExists, body).toBe(false);
    }
  });

  it.each(shells)("a base without the detector skips with a summary (%s %s)", (...shell) => {
    const run = runStep(shell, null);
    expect(run.status).toBe(0);
    expect(run.summary).toContain("### Sensitive classes: SKIPPED");
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
    expect(pull).toMatchObject({ sha: "headsha", baseSha: "basesha", changedFiles: 2, errors: [] });
    const result = await detect({ ...pull, config });
    expect(result).toMatchObject({ status: "ok", classes: ["schema", "migrations", "auth"], sha: "headsha" });
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

  it("returns the PR's own count, so only a PR with zero changed files may have an empty list", async () => {
    const empty = await fetchPullRequest(githubClient({ fetchImpl: fakeFetch((key) => (key === "/repos/o/r/pulls/7" ? { ...PULL, changed_files: 0 } : [])) }), "o/r", 7);
    expect(empty).toMatchObject({ changedFiles: 0, files: [], errors: [] });
    expect(await detect({ ...empty, config, allowEmpty: empty.changedFiles === 0 })).toMatchObject({ status: "ok", files: [] });
    const lost = await fetchPullRequest(githubClient({ fetchImpl: fakeFetch((key) => (key === "/repos/o/r/pulls/7" ? { ...PULL, changed_files: undefined } : [])) }), "o/r", 7);
    expect(lost.changedFiles).toBeNull();
    expect((await detect({ ...lost, config, allowEmpty: lost.changedFiles === 0 })).status).toBe("error");
  });
});

describe("main", () => {
  const run = async (args, routes, options = {}) => {
    const dir = tempDir("sensitive-class-");
    const out = path.join(dir, "out.json");
    const code = await main(["--repo", "o/r", "--pr", "7", "--json", out, ...args], { GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") }, { fetchImpl: fakeFetch(routes), stdout: { write() {} }, ...options });
    return { code, result: JSON.parse(readFileSync(out, "utf8")), summary: readFileSync(path.join(dir, "summary.md"), "utf8") };
  };
  const filesRoute = (files, extra = () => undefined) => (key) => {
    if (key === "/repos/o/r/pulls/7") return { ...PULL, changed_files: files.length };
    if (key.startsWith("/repos/o/r/pulls/7/files")) return key.endsWith("page=1") ? files : [];
    return extra(key);
  };

  it("writes the JSON and a job summary", async () => {
    const { code, result, summary } = await run([], filesRoute(FILES, (key) => (key.includes("/contents/") ? "" : undefined)));
    expect(code).toBe(0);
    expect(result).toMatchObject({ version: OUTPUT_VERSION, status: "ok", sha: "headsha", base_sha: "basesha", classes: ["schema", "migrations", "auth"] });
    expect(summary).toContain("### Sensitive classes: OK");
    expect(summary).toContain('"sha": "headsha"');
    expect(result.gate_loosening).toEqual({ detected: false, reasons: [], requires });
    expect(summary).toContain("Gate loosening: none");
  });

  it("reports status error on an API failure and still exits 0", async () => {
    const { code, result } = await run(["--head-sha", "headsha"], () => undefined);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: "error", sha: "headsha", files: [] });
    expect(result.errors[0]).toMatch(/GitHub API error: GET \/repos\/o\/r\/pulls\/7 returned 404/);
    expect(result.gate_loosening).toMatchObject({ detected: true, reasons: [{ kind: "not_checked" }] });
  });

  it("reports status error on a bad config", async () => {
    const bad = path.join(tempDir("sensitive-class-config-"), "bad.json");
    writeFileSync(bad, "{ not json");
    const { result } = await run(["--config", bad], () => PULL);
    expect(result.status).toBe("error");
    expect(result.errors[0]).toMatch(/config could not be read/);
  });

  it("reports status error when the checkout has no shared list", async () => {
    const root = tempDir("sensitive-class-root-");
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(CONFIG_PATH, path.join(root, CONFIG_REPO_PATH));
    const { code, result } = await run([], filesRoute(FILES), { root });
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: "error", files: [] });
    expect(result.errors[0]).toMatch(/docs\/sensitive-paths\.json could not be loaded/);
  });

  it("reports status error when a touched config cannot be read at head (API error)", async () => {
    for (const file of [CONFIG_REPO_PATH, SENSITIVE_PATHS_FILE]) {
      const { result } = await run([], filesRoute([modified(file)]));
      expect(result.status, file).toBe("error");
      expect(result.errors, file).toEqual([`could not read ${file} at head: GET /repos/o/r/contents/${file}?ref=headsha returned 404`]);
      expect(result.gate_loosening.reasons, file).toEqual([expect.objectContaining({ kind: "config_unreadable", ref: "head", path: file })]);
    }
  });

  it("reports malformed API file entries as status error, end to end", async () => {
    const { code, result } = await run([], filesRoute([null, { status: "modified" }, modified("README.md")]));
    expect(code).toBe(0);
    expect(result.status).toBe("error");
    expect(result.errors).toEqual([expect.stringMatching(/^changed file 1: is not an object/), expect.stringMatching(/^changed file 2: filename undefined/)]);
    expect(result.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(result.gate_loosening).toEqual({ detected: false, reasons: [], requires });
  });

  it("accepts a PR with zero changed files", async () => {
    const { result } = await run([], filesRoute([]));
    expect(result).toMatchObject({ status: "ok", files: [], classes: [] });
  });

  it("returns 2 on bad arguments", async () => {
    expect(await main(["--pr", "x"], {})).toBe(2);
  });
});

describe("gate_loosening: detector config diff against base", () => {
  const configChanged = [{ path: CONFIG_REPO_PATH, status: "modified" }];
  const judge = (edit) => {
    const head = structuredClone(rawConfig);
    edit(head);
    return detectGateLoosening({ baseRaw: rawConfig, headRaw: head, gateFiles: configChanged });
  };

  it("does not flag an unchanged config or a PR that leaves the config alone", () => {
    expect(judge(() => {})).toEqual({ detected: false, reasons: [], requires });
    expect(detectGateLoosening({ baseRaw: rawConfig, headRaw: null, gateFiles: [] }).detected).toBe(false);
  });

  it("flags a removed sql_content rule and a narrowed sql_content path", () => {
    expect(kinds(judge((head) => head.sql_content.rules.pop()))).toEqual(["sql_rule_removed"]);
    expect(judge((head) => (head.sql_content.rules[0].tokens = ["create", "policy", "now"]))).toMatchObject({
      detected: true,
      reasons: [{ kind: "sql_rule_removed", value: "rls:create policy" }],
    });
    expect(kinds(judge((head) => (head.sql_content.paths = ["**/*.sql"])))).toEqual(["rule_narrowed"]);
  });

  // A rename probe: docs/a.test.ts -> src/a.test.ts is unclassified on base
  // (the old path lands in docs, the new one in tests). An edit that sends the
  // old path to tests makes the rename safe.
  const renameCategory = async (edit) => {
    const rename = [{ filename: "src/a.test.ts", previous_filename: "docs/a.test.ts", status: "renamed" }];
    const head = structuredClone(rawConfig);
    edit(head);
    const compiled = compileConfig(head);
    expect(compiled.errors).toEqual([]);
    return (await detect({ files: rename, readHeadFile: noSql, config: { ...compiled.config, matcher: config.matcher } })).files[0].category;
  };

  it("the rename probe is unclassified on base", async () => {
    expect(await renameCategory(() => {})).toBeNull();
  });

  it("flags reordered safe categories, which change the first-match category", async () => {
    const reorder = (head) => {
      const { tests, ...rest } = head.safe_categories;
      head.safe_categories = { tests, ...rest };
    };
    const result = judge(reorder);
    expect(result.reasons).toEqual([expect.objectContaining({ kind: "category_order_changed", entry: "safe_categories" })]);
    expect(await renameCategory(reorder)).toBe("tests");

    // Appending a category keeps the shared order; its paths are exemptions.
    expect(kinds(judge((head) => (head.safe_categories.misc = { description: "Misc.", paths: ["misc/**"] })))).toEqual(["exemption_added"]);
  });

  // Narrowing an earlier category lets the old path fall through to tests.
  it.each([
    ["deleting safe category docs", (head) => delete head.safe_categories.docs, { entry: "safe_categories.docs" }],
    ["dropping docs/** from docs.paths", (head) => (head.safe_categories.docs.paths = head.safe_categories.docs.paths.filter((glob) => glob !== "docs/**")), { entry: "safe_categories.docs", field: "paths", value: "docs/**" }],
    ["adding docs.exclude **/*.test.ts", (head) => head.safe_categories.docs.exclude.push("**/*.test.ts"), { entry: "safe_categories.docs", field: "exclude", value: "**/*.test.ts" }],
    ["adding docs.exclude_keywords test", (head) => (head.safe_categories.docs.exclude_keywords = ["test"]), { entry: "safe_categories.docs", field: "exclude_keywords", value: "test" }],
  ])("flags %s, which makes the rename probe safe", async (_label, edit, reason) => {
    expect(await renameCategory(edit)).toBe("tests");
    expect(judge(edit)).toMatchObject({ detected: true, reasons: [{ kind: "category_narrowed", ...reason }] });
    expect(judge(edit).reasons).toHaveLength(1);
  });

  it("flags dropping a path_keywords item from a safe category", () => {
    const base = structuredClone(rawConfig);
    base.safe_categories.docs.path_keywords = ["readme"];
    const result = detectGateLoosening({ baseRaw: base, headRaw: rawConfig, gateFiles: configChanged });
    expect(result.reasons).toEqual([expect.objectContaining({ kind: "category_narrowed", entry: "safe_categories.docs", field: "path_keywords", value: "readme" })]);
  });

  it("covers every safe category field the validator accepts", () => {
    // The category schema is closed: any other key is invalid, so fails closed.
    expect(CATEGORY_MATCH_FIELDS).toEqual(["paths", "path_keywords", "exclude", "exclude_keywords"]);
    expect(kinds(judge((head) => (head.safe_categories.docs.priority = 1)))).toEqual(["config_invalid"]);
    // Adding or removing one item of any matching field, on any category, is flagged.
    for (const name of Object.keys(rawConfig.safe_categories)) {
      for (const field of CATEGORY_MATCH_FIELDS) {
        const probe = field.endsWith("keywords") ? "zzprobe" : "zzprobe/**";
        const widened = structuredClone(rawConfig);
        widened.safe_categories[name][field] = [...(widened.safe_categories[name][field] ?? []), probe];
        const added = detectGateLoosening({ baseRaw: rawConfig, headRaw: widened, gateFiles: configChanged });
        const removed = detectGateLoosening({ baseRaw: widened, headRaw: rawConfig, gateFiles: configChanged });
        for (const result of [added, removed]) {
          expect(result.reasons).toEqual([expect.objectContaining({ entry: `safe_categories.${name}`, field, value: probe })]);
        }
      }
    }
  });

  it("does not flag a description-only edit to safe categories", async () => {
    const reword = (head) => {
      for (const entry of Object.values(head.safe_categories)) entry.description = "Reworded.";
    };
    expect(judge(reword)).toMatchObject({ detected: false, reasons: [] });
    expect(await renameCategory(reword)).toBeNull();
    // Reordering or repeating items inside a list cannot change a category either.
    expect(judge((head) => head.safe_categories.docs.paths.reverse()).detected).toBe(false);
    expect(judge((head) => head.safe_categories.docs.exclude.push("AGENTS.md")).detected).toBe(false);
  });

  it("does not flag reordered sql_content rules", () => {
    expect(judge((head) => head.sql_content.rules.reverse())).toMatchObject({ detected: false, reasons: [] });
  });

  it("flags a new exemption: safe category path, keyword or category", () => {
    expect(judge((head) => head.safe_categories.tests.paths.push("supabase/tests/**")).reasons).toEqual([
      expect.objectContaining({ kind: "exemption_added", entry: "safe_categories.tests", value: "supabase/tests/**" }),
    ]);
    expect(kinds(judge((head) => (head.safe_categories.docs.path_keywords = ["readme"])))).toEqual(["exemption_added"]);
    expect(kinds(judge((head) => (head.safe_categories.misc = { description: "Misc.", paths: ["misc/**"] })))).toEqual(["exemption_added"]);
  });

  it("flags a safe category exclusion that is removed", () => {
    expect(judge((head) => (head.safe_categories.docs.exclude = head.safe_categories.docs.exclude.filter((glob) => glob !== "AGENTS.md"))).reasons).toEqual([
      expect.objectContaining({ kind: "exemption_widened", entry: "safe_categories.docs", value: "AGENTS.md" }),
    ]);
  });

  it("fails closed on an unparseable, invalid, removed or re-classed head config", async () => {
    const files = [modified(CONFIG_REPO_PATH)];
    const unparseable = await gateLooseningForPull({ files, readHeadFile: async () => "{ not json", baseRaw: rawConfig, sensitivePathsText });
    expect(unparseable).toMatchObject({ errors: [], gateLoosening: { detected: true, reasons: [{ kind: "config_unreadable", ref: "head" }] } });
    const invalid = await gateLooseningForPull({ files, readHeadFile: async () => JSON.stringify({ ...rawConfig, version: 2 }), baseRaw: rawConfig, sensitivePathsText });
    expect(invalid.gateLoosening).toMatchObject({ detected: true, reasons: [{ kind: "config_invalid", ref: "head" }] });
    expect(invalid.gateLoosening.reasons[0].message).toMatch(/version must be 1/);
    expect(kinds(judge((head) => (head.safe_categories.docs.fail_open = true)))).toEqual(["config_invalid"]);
    // Path classes belong to docs/sensitive-paths.json; a classes section here is invalid.
    expect(kinds(judge((head) => (head.classes = { auth: { paths: ["src/auth/**"] } })))).toEqual(["config_invalid"]);
    const removed = await gateLooseningForPull({ files: [{ filename: CONFIG_REPO_PATH, status: "removed" }], baseRaw: rawConfig, sensitivePathsText });
    expect(removed.gateLoosening).toMatchObject({ detected: true, reasons: [{ kind: "config_unreadable", ref: "head" }] });
    const renamed = await gateLooseningForPull({ files: [{ filename: "scripts/other.json", previous_filename: CONFIG_REPO_PATH, status: "renamed" }], baseRaw: rawConfig, sensitivePathsText });
    expect(kinds(renamed.gateLoosening)).toEqual(["config_unreadable"]);
    const noBase = detectGateLoosening({ baseError: "missing", headRaw: rawConfig, gateFiles: configChanged });
    expect(noBase).toMatchObject({ detected: true, reasons: [{ kind: "config_unreadable", ref: "base" }] });
  });

  it("does not flag an added sql_content rule or path", () => {
    const result = judge((head) => {
      head.sql_content.rules.push({ class: "definer", tokens: ["set", "role"] });
      head.sql_content.paths.push("**/*.ddl");
    });
    expect(result).toMatchObject({ detected: false, reasons: [] });
  });

  it("does not flag description or syntax text edits", () => {
    const result = judge((head) => {
      head.description = "Reworded.";
      head.syntax.paths = "Reworded.";
      head.safe_categories.docs.description = "Reworded.";
    });
    expect(result).toMatchObject({ detected: false, reasons: [] });
  });

  it("flags an edited or removed detector, helper or workflow, and an incomplete file list", async () => {
    const edited = await gateLooseningForPull({ files: [modified(DETECTOR_REPO_PATH)], baseRaw: rawConfig, sensitivePathsText });
    expect(kinds(edited.gateLoosening)).toEqual(["gate_changed"]);
    const removed = await gateLooseningForPull({ files: [{ filename: DETECTOR_REPO_PATH, status: "removed" }], baseRaw: rawConfig, sensitivePathsText });
    expect(kinds(removed.gateLoosening)).toEqual(["gate_removed"]);
    const helper = await gateLooseningForPull({ files: [modified(DETECTOR_HELPER_REPO_PATH)], baseRaw: rawConfig, sensitivePathsText });
    expect(helper.gateLoosening.reasons).toEqual([expect.objectContaining({ kind: "gate_changed", path: "scripts/proof-check.mjs" })]);
    const workflowEdit = await gateLooseningForPull({ files: [modified(WORKFLOW_REPO_PATH)], baseRaw: rawConfig, sensitivePathsText });
    expect(kinds(workflowEdit.gateLoosening)).toEqual(["gate_changed"]);
    const incomplete = await gateLooseningForPull({ files: [], baseRaw: rawConfig, sensitivePathsText, incomplete: "the changed-file list is incomplete or stale" });
    expect(kinds(incomplete.gateLoosening)).toEqual(["not_checked"]);
  });

  it("is in the JSON and the job summary", () => {
    const result = { ...detectGateLoosening({}), detected: false };
    const base = { sha: "h", base_sha: "b", status: "ok", classes: [], sensitive_count: 0, multi_class: false, files: [], unclassified: [], errors: [] };
    expect(formatSummary({ ...base, gate_loosening: result })).toContain("Gate loosening: none");
    const flagged = formatSummary({ ...base, gate_loosening: judge((head) => delete head.safe_categories.docs) });
    expect(flagged).toContain(GATE_LOOSENING_LINE);
    expect(flagged).toContain(`- \`${CONFIG_REPO_PATH} removes safe category "docs"; a path it matched can fall through to a later category.\``);
    expect(flagged).toContain('"kind": "category_narrowed"');
  });
});

describe("gate_loosening: the shared list's findGateLoosening", () => {
  const withGlobs = (mutate) => {
    const copy = JSON.parse(sensitivePathsText);
    mutate(copy.globs);
    return JSON.stringify(copy);
  };
  const judgeList = (files, headList) =>
    gateLooseningForPull({
      files,
      readHeadFile: async (file) => {
        if (file === SENSITIVE_PATHS_FILE && headList !== undefined) return headList;
        throw new Error(`GET ${file} returned 404`);
      },
      baseRaw: rawConfig,
      sensitivePathsText,
    });

  it("does not flag a PR that leaves the list alone or only adds globs", async () => {
    expect(await judgeList([modified("README.md")])).toEqual({ gateLoosening: { detected: false, reasons: [], requires }, errors: [] });
    const added = withGlobs((globs) => globs.push({ glob: "zzprobe/**", class: "infra_ci" }));
    expect(await judgeList([modified(SENSITIVE_PATHS_FILE)], added)).toEqual({ gateLoosening: { detected: false, reasons: [], requires }, errors: [] });
  });

  it("flags a removed or reclassified glob with the shared list's codes and fields", async () => {
    const removed = withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "supabase/migrations/**"), 1));
    const { gateLoosening } = await judgeList([modified(SENSITIVE_PATHS_FILE)], removed);
    expect(gateLoosening).toMatchObject({ detected: true, requires });
    expect(gateLoosening.reasons).toEqual([
      expect.objectContaining({ kind: "glob_removed", code: "glob_removed", path: SENSITIVE_PATHS_FILE, file: SENSITIVE_PATHS_FILE, source: "sensitive-paths", glob: "supabase/migrations/**", class: "migrations" }),
    ]);
    const reclassified = withGlobs((globs) => (globs.find((entry) => entry.glob === "**/*.pem").class = "deps"));
    expect(kinds((await judgeList([modified(SENSITIVE_PATHS_FILE)], reclassified)).gateLoosening)).toEqual(["glob_reclassified"]);
  });

  it("flags a deleted, renamed-away or invalid list", async () => {
    expect(kinds((await judgeList([{ filename: SENSITIVE_PATHS_FILE, status: "removed" }])).gateLoosening)).toEqual(["config_removed"]);
    expect(kinds((await judgeList([{ filename: "docs/other.json", previous_filename: SENSITIVE_PATHS_FILE, status: "renamed" }])).gateLoosening)).toEqual(["config_removed"]);
    expect(kinds((await judgeList([modified(SENSITIVE_PATHS_FILE)], "{ not json")).gateLoosening)).toEqual(["config_invalid"]);
  });

  it("flags an edit to the matcher or other code that applies the list, but not its introduction", async () => {
    for (const file of GATE_CODE_FILES) {
      expect(kinds((await judgeList([modified(file)])).gateLoosening), file).toEqual(["matcher_changed"]);
      expect(kinds((await judgeList([{ filename: file, status: "removed" }])).gateLoosening), file).toEqual(["matcher_changed"]);
      expect((await judgeList([{ filename: file, status: "added" }])).gateLoosening.detected, file).toBe(false);
    }
    // Renaming the matcher away deletes it.
    expect(kinds((await judgeList([{ filename: "scripts/lib/other.mjs", previous_filename: MATCHER_PATH, status: "renamed" }])).gateLoosening)).toEqual(["matcher_changed"]);
  });

  it("an unreadable head list is an error and config_unreadable, and matcher edits are still reported", async () => {
    const result = await gateLooseningForPull({
      files: [modified(SENSITIVE_PATHS_FILE), modified(MATCHER_PATH)],
      readHeadFile: async () => {
        throw new Error("GET returned 500");
      },
      baseRaw: rawConfig,
      sensitivePathsText,
    });
    expect(result.errors).toEqual([`could not read ${SENSITIVE_PATHS_FILE} at head: GET returned 500`]);
    expect(kinds(result.gateLoosening)).toEqual(["config_unreadable", "matcher_changed"]);
  });

  it("flags a glob moved from the list into a safe category on both sides", async () => {
    const headList = withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "docs/migration-drafts/**"), 1));
    const headConfig = structuredClone(rawConfig);
    headConfig.safe_categories.docs.paths.push("docs/migration-drafts/**");
    const { gateLoosening } = await gateLooseningForPull({
      files: [modified(SENSITIVE_PATHS_FILE), modified(CONFIG_REPO_PATH)],
      readHeadFile: async (file) => (file === SENSITIVE_PATHS_FILE ? headList : JSON.stringify(headConfig)),
      baseRaw: rawConfig,
      sensitivePathsText,
    });
    expect(kinds(gateLoosening).sort()).toEqual(["exemption_added", "glob_removed"]);
  });
});

describe("gate_loosening: the base copy judges", () => {
  it("a PR that edits the differ, the matcher, the config and the list is still judged by the base copies", async () => {
    const dir = tempDir("sensitive-class-base-");
    const base = path.join(dir, "base");
    for (const file of [DETECTOR_REPO_PATH, CONFIG_REPO_PATH, DETECTOR_HELPER_REPO_PATH, MATCHER_PATH, SENSITIVE_PATHS_FILE]) {
      mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
      copyFileSync(path.join(repoRoot, file), path.join(base, file));
    }
    const headConfig = structuredClone(rawConfig);
    delete headConfig.safe_categories.docs;
    const headList = JSON.parse(sensitivePathsText);
    headList.globs = headList.globs.filter((entry) => entry.glob !== "supabase/migrations/**");
    const headDetector = readFileSync(path.join(repoRoot, DETECTOR_REPO_PATH), "utf8")
      .replace("export function detectGateLoosening(", "export function detectGateLoosening() { return { detected: false, reasons: [] }; }\nfunction unusedGateLoosening(");
    const headMatcher = readFileSync(path.join(repoRoot, MATCHER_PATH), "utf8")
      .replace("export function findGateLoosening(", "export function findGateLoosening() { return { detected: false, reasons: [], requires: [] }; }\nfunction unusedFindGateLoosening(");
    expect(headDetector).toContain("unusedGateLoosening");
    expect(headMatcher).toContain("unusedFindGateLoosening");

    const changed = [modified(CONFIG_REPO_PATH), modified(DETECTOR_REPO_PATH), modified(MATCHER_PATH), modified(SENSITIVE_PATHS_FILE)];
    const heads = {
      [CONFIG_REPO_PATH]: JSON.stringify(headConfig),
      [DETECTOR_REPO_PATH]: headDetector,
      [MATCHER_PATH]: headMatcher,
      [SENSITIVE_PATHS_FILE]: JSON.stringify(headList),
    };
    const routes = (key) => {
      if (key === "/repos/o/r/pulls/7") return { ...PULL, changed_files: changed.length };
      if (key.startsWith("/repos/o/r/pulls/7/files")) return key.endsWith("page=1") ? changed : [];
      const file = Object.keys(heads).find((name) => key === `/repos/o/r/contents/${name}?ref=headsha`);
      return file ? heads[file] : undefined;
    };
    const baseModule = await import(pathToFileURL(path.join(base, DETECTOR_REPO_PATH)).href);
    const out = path.join(dir, "out.json");
    await baseModule.main(["--repo", "o/r", "--pr", "7", "--json", out], {}, { fetchImpl: fakeFetch(routes), stdout: { write() {} } });
    const result = JSON.parse(readFileSync(out, "utf8"));
    expect(result).toMatchObject({ status: "ok", classes: ["infra_ci"] });
    expect(result.gate_loosening.detected).toBe(true);
    expect(kinds(result.gate_loosening).sort()).toEqual(["category_narrowed", "gate_changed", "glob_removed", "matcher_changed"]);
  });
});
