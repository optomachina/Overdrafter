// @vitest-environment node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  SQL_OVERSIZED_REASON,
  SqlTooLargeError,
  UNCLASSIFIED,
  WORKFLOW_REPO_PATH,
  classifyPath,
  classifySql,
  compileConfig,
  detect,
  doorTier,
  detectGateLoosening,
  fetchPullRequest,
  formatSummary,
  gateLooseningForPull,
  githubClient,
  isValidPath,
  loadConfig,
  main,
  pathWords,
  sqlTokens,
  sqlWords,
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
    expect([...new Set(rawConfig.sql_content.rules.map((rule) => rule.class))]).toEqual(["rls", "definer", "auth"]);
    expect(OUTPUT_CLASSES).toEqual([...SENSITIVE_CLASSES, ...SQL_CONTENT_CLASSES, UNCLASSIFIED]);
    expect(UNCLASSIFIED).toBe("unclassified");
  });

  it("rejects a classes section, unknown rule keys, bad versions and SQL rules for other classes", () => {
    expect(compileConfig({ ...structuredClone(rawConfig), classes: { auth: { paths: ["src/auth/**"] } } }).errors).toContain('config: unknown key "classes"');
    const withKey = structuredClone(rawConfig);
    withKey.safe_categories.docs.path_keyword = ["readme"];
    expect(compileConfig(withKey).errors).toContain('safe_categories.docs: unknown rule key "path_keyword"');
    expect(compileConfig({ ...structuredClone(rawConfig), version: 2 }).config).toBeNull();
    // SQL rules may name rls, definer and shared-list auth.
    for (const name of ["nope", "migrations"]) {
      const badRule = structuredClone(rawConfig);
      badRule.sql_content.rules.push({ id: "invalid_class", class: name, tokens: ["x"], reason: "test" });
      expect(compileConfig(badRule).errors).toContain(`sql_content.rules[${badRule.sql_content.rules.length - 1}]: unknown class "${name}"`);
    }
    const authRule = structuredClone(rawConfig);
    authRule.sql_content.rules.push({ id: "extra_auth", class: "auth", tokens: ["x"], reason: "test" });
    expect(compileConfig(authRule).errors).toEqual([]);
    const collides = structuredClone(rawConfig);
    collides.safe_categories.infra_ci = { paths: ["x/**"] };
    expect(compileConfig(collides).errors).toContain("safe_categories.infra_ci: name collides with a class");
  });

  it("requires every SQL rule to have a unique id and a reason", () => {
    const ids = rawConfig.sql_content.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);

    const bad = structuredClone(rawConfig);
    const next = bad.sql_content.rules.length;
    bad.sql_content.rules.push({ class: "rls", tokens: ["x"] }, { id: ids[0], class: "rls", tokens: ["x"], reason: "dup" });
    expect(compileConfig(bad).errors).toEqual(
      expect.arrayContaining([
        `sql_content.rules[${next}]: invalid id`,
        `sql_content.rules[${next}]: reason must be a non-empty string`,
        `sql_content.rules[${next + 1}]: duplicate id "${ids[0]}"`,
      ]),
    );
  });

  it("rejects a SQL rule token that is an upper-case letter or mixed-case word", () => {
    const bad = structuredClone(rawConfig);
    const next = bad.sql_content.rules.length;
    bad.sql_content.rules.push({ id: "upper_rule", class: "rls", tokens: ["A", "Set"], reason: "x" });
    expect(compileConfig(bad).errors).toEqual(
      expect.arrayContaining([
        `sql_content.rules[${next}].tokens has invalid keyword "A"`,
        `sql_content.rules[${next}].tokens has invalid keyword "Set"`,
      ]),
    );
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

  // A body of more than about 100k words used to overflow the call stack in
  // words.push(...), so detect() reported a read error instead of a class.
  it.each([
    ["a single-quoted string", (filler) => `select '${filler}'; create policy p on t using (true);`],
    ["a dollar-quoted body", (filler) => `do $$ ${filler} $$; create policy p on t using (true);`],
    ["a statement inside the body", (filler) => `do $$ ${filler} create policy p on t using (true); $$;`],
  ])("reads a body of 150k words (%s)", (_name, build) => {
    expect(sql(build("a ".repeat(150_000)))).toEqual(["rls"]);
  });

  it("still sees tokens below the recursion limit", () => {
    const nested = Array.from({ length: 12 }, (_, level) => `$t${level}$`);
    const text = `do ${nested.join(" ")} create policy p on t ${nested.toReversed().join(" ")};`;
    expect(sql(text)).toEqual(["rls", "auth"]);
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

describe("classifySql: BYPASSRLS and row_security (OVD-866)", () => {
  const sql = (text) => classifySql(text, config);

  it.each([
    ["ALTER ROLE x BYPASSRLS;", "rls_bypassrls"],
    ["create role y with nobypassrls;", "rls_nobypassrls"],
    ["SET row_security = off;", "rls_set_row_security"],
    ["set local row_security to off;", "rls_set_local_row_security"],
    ["set session row_security = off;", "rls_set_session_row_security"],
    ["reset row_security;", "rls_reset_row_security"],
    ["select set_config('row_security','off',true);", "rls_set_config_row_security"],
    ["select pg_catalog.set_config( 'row_security' , 'off', false);", "rls_set_config_row_security"],
    ["ALTER DATABASE d SET row_security = off;", "rls_set_row_security"],
    ["alter role app in database d set row_security to off;", "rls_set_row_security"],
    ["create user u password 'x' bypassrls;", "rls_bypassrls"],
    ["update pg_authid set rolbypassrls = true where rolname = 'x';", "rls_rolbypassrls"],
    ["Alter\n  ROLE App_User\n  WITH LOGIN\n  ByPassRLS;", "rls_bypassrls"],
    ["Create Role\n\tReader\n\tNoBypassRls\n\tNOLOGIN;", "rls_nobypassrls"],
    ["DO $$ BEGIN ALTER ROLE x BYPASSRLS; END $$;", "rls_bypassrls"],
    ["do $body$ begin perform set_config('row_security', 'off', true); end $body$;", "rls_set_config_row_security"],
    // Review round 1: quoted names, named arguments and extra parentheses.
    ['SET "row_security" = off;', "rls_set_row_security"],
    ['SET SESSION "row_security" TO off;', "rls_set_session_row_security"],
    ['SET LOCAL "ROW_SECURITY" TO off;', "rls_set_local_row_security"],
    ['RESET "row_security";', "rls_reset_row_security"],
    ["select \"set_config\"('row_security','off',true);", "rls_set_config_row_security"],
    ["select pg_catalog.\"set_config\"('row_security','off',true);", "rls_set_config_row_security"],
    ["select set_config(setting_name => 'row_security', new_value => 'off', is_local => true);", "rls_row_security"],
    ["select set_config(new_value => 'off', is_local => true, setting_name => 'row_security');", "rls_row_security"],
    ["select set_config(('row_security'), 'off', true);", "rls_row_security"],
    ["select set_config('row_security'::text, 'off', true);", "rls_row_security"],
    ["select current_setting('row_security');", "rls_row_security"],
  ])("%s -> rls (%s)", (text, id) => {
    const result = sql(text);
    expect(result.classes).toEqual(["rls"]);
    const rule = rawConfig.sql_content.rules.find((entry) => entry.id === id);
    expect(result.reasons).toContain(`rls:sql:${id}: ${rule.reason}`);
  });

  it.each([
    ["set role authenticated;", "auth_set_role"],
    ["set local role service_role;", "auth_set_local_role"],
    ["SET SESSION AUTHORIZATION admin;", "auth_set_session_authorization"],
    ["select set_config('role', 'service_role', true);", "auth_set_config_role"],
    ["set session role postgres;", "auth_set_session_role"],
    ["set local session authorization admin;", "auth_set_local_session_authorization"],
    ["select set_config('session_authorization', 'admin', false);", "auth_set_config_session_authorization"],
    // Review round 1: quoted names, named arguments, extra parentheses and RESET.
    ["SET \"role\" TO 'service_role';", "auth_set_role"],
    ["set local \"Role\" service_role;", "auth_set_local_role"],
    ['SET SESSION "authorization" admin;', "auth_set_session_authorization"],
    ["select \"set_config\"('role', 'service_role', true);", "auth_set_config_role"],
    ["select pg_catalog.\"set_config\"('role', 'service_role', true);", "auth_set_config_role"],
    ["select set_config(('role'), 'service_role', true);", "auth_set_config_paren_role"],
    ["select set_config(setting_name => 'role', new_value => 'service_role', is_local => true);", "auth_set_config_named_role"],
    ["select set_config(new_value => 'service_role', is_local => true, setting_name => 'role');", "auth_set_config_named_role"],
    ["select set_config(setting_name := 'role', new_value := 'service_role', is_local := true);", "auth_set_config_named_role_legacy"],
    ["select set_config(setting_name => 'session_authorization', new_value => 'admin', is_local => false);", "auth_session_authorization"],
    ["select set_config(('session_authorization'), 'admin', false);", "auth_session_authorization"],
    ["RESET ROLE;", "auth_reset_role"],
    ['reset "role";', "auth_reset_role"],
    ["RESET SESSION AUTHORIZATION;", "auth_reset_session_authorization"],
    ["reset all;", "auth_reset_all"],
    ["do $$ begin execute 'reset role'; end $$;", "auth_reset_role"],
  ])("%s -> auth (%s)", (text, id) => {
    const result = sql(text);
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons.some((reason) => reason.startsWith(`auth:sql:${id}: `))).toBe(true);
  });

  it.each([
    ["-- bypassrls\nselect 1;"],
    ["/* set row_security = off */ select 1;"],
    ["alter table t add column row_security_note text;"],
    ["update t set row_security_note = 'x';"],
    ["select current_setting('row_security_note');"],
    ['select "row_security_note" from t;'],
    ['alter table t add column "row security" text;'],
    ["select set_config('search_path', 'pg_catalog', true);"],
    ["select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated')::text, true);"],
    ["create role reader;"],
  ])("no false positive: %s", (text) => {
    expect(sql(text).classes).toEqual([]);
  });

  it("reads docs for the door scan without adding legacy SQL classes", async () => {
    const read = [];
    const result = await detect({
      files: [modified("docs/database-notes.md")],
      readHeadFile: async (file) => (read.push(file), "ALTER ROLE x BYPASSRLS; SET row_security = off;"),
      readBaseFile: async () => "",
      sha: "a".repeat(40),
      config,
    });
    expect(read).toEqual(["docs/database-notes.md"]);
    expect(result.door).toBe("one-way");
    expect(result.files[0]).toMatchObject({ classes: [], category: "docs" });
  });
});

describe("classifySql: role attributes, role grants and test SET ROLE scope (OVD-878)", () => {
  const sql = (text, file = null) => classifySql(text, config, file);
  const reasonFor = (id) => `auth:sql:${id}: ${rawConfig.sql_content.rules.find((rule) => rule.id === id).reason}`;

  it.each([
    ["ALTER ROLE x SUPERUSER;", "auth_role_superuser", 1],
    ["create user y with createrole login;", "auth_role_createrole", 1],
    ["ALTER ROLE z REPLICATION;", "auth_role_replication", 1],
    ["alter user z with replication;", "auth_role_replication", 1],
    ["GRANT service_role TO x;", "auth_grant_service_role", 1],
    ["grant postgres to app;", "auth_grant_postgres", 1],
    ["grant supabase_admin to app;", "auth_grant_supabase_admin", 1],
    ["grant anon, authenticator to app;", "auth_grant_authenticator", 1],
    ["select 1;\n\nCreate\n  Role\n  Admin\n  SuperUser\n  LOGIN;", "auth_role_superuser", 6],
    ["DO $$\nBEGIN\n  ALTER ROLE x WITH CreateRole;\nEND $$;", "auth_role_createrole", 3],
    ["do $$ begin execute 'grant service_role to app'; end $$;", "auth_grant_service_role", 1],
  ])("%s -> auth (%s) on line %i", (text, id, line) => {
    const result = sql(text);
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toContain(reasonFor(id));
    expect(result.hits).toContainEqual(expect.objectContaining({ id, class: "auth", line, sensitive: true }));
  });

  it.each([
    ["supabase/migrations/20261001000000_x.sql"],
    ["scripts/window-1/setup.sql"],
    ["worker/sql/setup.sql"],
    [".github/sql/setup.sql"],
    ["docs/migration-drafts/x.sql"],
    ["e2e/fixtures/x.sql"],
  ])("SET LOCAL ROLE authenticated stays sensitive outside supabase/tests: %s", (file) => {
    const result = sql("set local role authenticated;", file);
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toEqual([{ id: "auth_set_local_role", class: "auth", path: file, line: 1, sensitive: true }]);
  });

  it.each([
    ["set local role service_role;", "auth_set_local_role"],
    ["SET ROLE postgres;", "auth_set_role"],
    ["set role to supabase_admin;", "auth_set_role"],
    ["set session role = authenticator;", "auth_set_session_role"],
    ["set local role app_writer;", "auth_set_local_role"],
    ["set session authorization postgres;", "auth_set_session_authorization"],
    ["do $$ begin execute 'set local role service_role'; end $$;", "auth_set_local_role"],
  ])("supabase/tests keeps a privileged switch sensitive: %s", (text, id) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toContain(reasonFor(id));
    expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
  });

  // Release decision (final round): the only exempt thing is one top-level statement that is exactly
  // SET [LOCAL] ROLE anon|authenticated (unquoted, comments stripped, optional ';') in supabase/tests/**.
  it.each([
    ["set role anon;", "auth_set_role"],
    ["SET LOCAL ROLE authenticated", "auth_set_local_role"],
    ["set /* c */ local role anon; -- trailing comment", "auth_set_local_role"],
    ["set\n  role\n  anon;", "auth_set_role"],
    ["SET ROLE ANON;", "auth_set_role"],
    ["set local role authenticated;", "auth_set_local_role"],
    ["set local role anon ;", "auth_set_local_role"],
    ["set local role anon;\r\n", "auth_set_local_role"],
  ])("supabase/tests exempts %j as gate_loosening", (text, id) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.hits).toEqual([{ id, class: "auth", path: "supabase/tests/x.sql", line: 1, sensitive: false, exemption: "tests_set_role_unprivileged", gate_loosening: true }]);
  });

  it.each([
    ["do $$ begin execute ('set role anon') || '_x'; end $$;", "auth_set_role"],
    ["execute ('set role anon') || '_x';", "auth_set_role"],
    ["set role 'anon;';", "auth_set_role"],
    ['set role "anon";', "auth_set_role"],
    ["set role 'anon';", "auth_set_role"],
    ['set role U&"anon";', "auth_set_role"],
    ["do $$ begin set role anon; end $$;", "auth_set_role"],
    ["do $$ begin execute 'set local role anon'; end $$;", "auth_set_local_role"],
    ["do $$ begin execute format('set local role authenticated'); end $$;", "auth_set_local_role"],
    ["select format('set role %s', 'anon');", "auth_set_role"],
    ["set role anon, service_role;", "auth_set_role"],
    ["set role anon x;", "auth_set_role"],
    ["set role anon || '_x';", "auth_set_role"],
    ["set role to anon;", "auth_set_role"],
    ["set session role anon;", "auth_set_session_role"],
    ["set local role service_role;", "auth_set_local_role"],
    ["select set_config('role', 'anon', true);", "auth_set_config_role"],
    ['reset "role";', "auth_reset_role"],
    ["reset role all;", "auth_reset_role"],
    ["do $$ begin reset role; end $$;", "auth_reset_role"],
    ["do $$ begin execute 'reset role'; end $$;", "auth_reset_role"],
  ])("supabase/tests keeps %j sensitive", (text, id) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toContain(reasonFor(id));
    expect(result.hits).toContainEqual(expect.objectContaining({ id, line: 1, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
  });

  it("exempts only the plain statement when a grant follows on the same line", () => {
    const result = sql("SET ROLE anon; grant service_role to x;", "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toEqual([reasonFor("auth_grant_service_role")]);
    expect(result.hits).toEqual([
      expect.objectContaining({ id: "auth_set_role", line: 1, sensitive: false, exemption: "tests_set_role_unprivileged", gate_loosening: true }),
      expect.objectContaining({ id: "auth_grant_service_role", line: 1, sensitive: true }),
    ]);
  });

  it("does not exempt set role anon outside supabase/tests", () => {
    const result = sql("set role anon;", "supabase/migrations/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toEqual([{ id: "auth_set_role", class: "auth", path: "supabase/migrations/x.sql", line: 1, sensitive: true }]);
  });

  it("keeps a privileged switch sensitive next to exempt switches and RESET ROLE in the same test file", () => {
    const text = "begin;\nset local role authenticated;\nreset role;\nset local role service_role;\nreset role;\nrollback;";
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toEqual([reasonFor("auth_set_local_role")]);
    expect(result.hits.map((hit) => [hit.line, hit.id, hit.sensitive])).toEqual([
      [2, "auth_set_local_role", false],
      [3, "auth_reset_role", false],
      [4, "auth_set_local_role", true],
      [5, "auth_reset_role", false],
    ]);
  });

  // Release decision (final round): RESET ROLE only returns to the session role, so a plain top-level
  // RESET ROLE is exempt in supabase/tests/** and stays sensitive everywhere else.
  it("leaves a plain RESET ROLE unflagged in supabase/tests", () => {
    const result = sql("set local role anon;\nRESET ROLE;", "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.hits).toEqual([
      expect.objectContaining({ id: "auth_set_local_role", line: 1, sensitive: false, exemption: "tests_set_role_unprivileged", gate_loosening: true }),
      { id: "auth_reset_role", class: "auth", path: "supabase/tests/x.sql", line: 2, sensitive: false, exemption: "tests_reset_role", gate_loosening: true },
    ]);
  });

  it.each([["supabase/migrations/20261001000000_x.sql"], ["supabase/fixtures/x.sql"], ["docs/release/x.sql"], ["supabase/testsx/a.sql"]])(
    "flags RESET ROLE outside supabase/tests: %s",
    (file) => {
      const result = sql("reset role;", file);
      expect(result.classes).toEqual(["auth"]);
      expect(result.reasons).toEqual([reasonFor("auth_reset_role")]);
      expect(result.hits).toEqual([{ id: "auth_reset_role", class: "auth", path: file, line: 1, sensitive: true }]);
    },
  );

  it.each([
    ["ALTER ROLE x NOSUPERUSER;", "auth_role_nosuperuser"],
    ["create role r nocreaterole;", "auth_role_nocreaterole"],
    ["alter user u noreplication;", "auth_role_noreplication"],
  ])("tightening attribute is informational only: %s", (text, id) => {
    const result = sql(text);
    expect(result.classes).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id, line: 1, sensitive: false, informational: true })]);
  });

  it.each([
    ["-- ALTER ROLE x SUPERUSER;\nselect 1;"],
    ["/* grant service_role to x; set role postgres; */ select 1;"],
    ["alter table t add column superuser_flag boolean;"],
    ["create table t (superuser boolean, replication text);"],
    ["select rolsuper, rolcreaterole, rolreplication from pg_roles;"],
    ["grant usage on schema app to service_role;"],
    ["grant select on table t to anon, authenticated, service_role;"],
    ["grant authenticated to app;"],
    ["revoke service_role from app;"],
    ["create publication p for table t;"],
  ])("no false positive: %s", (text) => {
    expect(sql(text).classes).toEqual([]);
  });

  it.each([
    ["create group g superuser;", "auth_role_superuser"],
    ["CREATE GROUP g WITH CREATEROLE;", "auth_role_createrole"],
    ["create group g replication;", "auth_role_replication"],
    ["create role x in role service_role;", "auth_in_role_service_role"],
    ["create role x in group postgres;", "auth_in_role_postgres"],
    ["CREATE USER x WITH LOGIN IN ROLE app, supabase_admin;", "auth_in_role_supabase_admin"],
    ['create group g in role "authenticator";', "auth_in_role_authenticator"],
    ['create role "Anon" in role service_role;', "auth_in_role_service_role"],
    ["alter group service_role add user x;", "auth_alter_group_service_role"],
    ["ALTER GROUP postgres ADD USER x, y;", "auth_alter_group_postgres"],
    ["alter group supabase_admin add user x;", "auth_alter_group_supabase_admin"],
    ["alter group authenticator add user x;", "auth_alter_group_authenticator"],
    ["do $$ begin execute 'create role x in role service_role'; end $$;", "auth_in_role_service_role"],
  ])("%s -> auth (%s)", (text, id) => {
    const result = sql(text);
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toContain(reasonFor(id));
    expect(result.hits).toContainEqual(expect.objectContaining({ id, line: 1, sensitive: true }));
  });

  it.each([
    ["create group g nosuperuser;", "auth_role_nosuperuser"],
    ["create role x in role app;", null],
    ["create role service_role_copy in role app;", null],
    ["create role x role service_role;", null],
    ["alter group app add user service_role;", null],
    ["alter group app drop user x;", null],
    ["select * from t where role in (select role from groups);", null],
  ])("no membership false positive: %s", (text, informational) => {
    const result = sql(text);
    expect(result.classes).toEqual([]);
    expect(result.hits.map((hit) => hit.id)).toEqual(informational ? [informational] : []);
  });

  it.each([["Supabase/Tests/x.sql"], ["supabase/Tests/x.sql"], ["SUPABASE/TESTS/x.sql"]])(
    "matches exemption paths case-sensitively: %s",
    (file) => {
      const result = sql("set local role anon;", file);
      expect(result.classes).toEqual(["auth"]);
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    },
  );
  it.each([["supabase/tests/../migrations/a.sql"], ["supabase/tests/./a.sql"], ["supabase/tests//a.sql"], ["./supabase/tests/a.sql"]])(
    "never exempts a path with a '.', '..' or empty segment: %s",
    (file) => {
      const result = sql("set local role anon;", file);
      expect(result.classes).toEqual(["auth"]);
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    },
  );
});

describe("classifySql: literal-aware statement boundaries (OVD-878)", () => {
  const sql = (text) => classifySql(text, config);

  it.each([
    ["create role x with password ';' superuser;", "auth_role_superuser"],
    ["alter role x with password $p$;$p$ createrole;", "auth_role_createrole"],
    ["create role x valid until ';' replication;", "auth_role_replication"],
    ["create role x password ';' in role service_role;", "auth_in_role_service_role"],
    ["create role x password E'\\';' superuser;", "auth_role_superuser"],
    ["create role x password $a$x$b$;$b$y$a$ superuser;", "auth_role_superuser"],
    ["grant postgres, $q$;$q$ to x;", "auth_grant_postgres"],
  ])("a ';' inside a string does not end the statement: %s", (text, id) => {
    const result = sql(text);
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ id, line: 1, sensitive: true }));
  });

  it("ignores a ';' inside a string for informational rules too", () => {
    expect(sql("alter role x password ';' nosuperuser;").hits.map((hit) => hit.id)).toEqual(["auth_role_nosuperuser"]);
  });

  it.each([
    ["create role x; select 'superuser';"],
    ["create role x; select $$superuser$$;"],
    ["select 'create role x;' ; select superuser;"],
    ["grant select on t to y; select postgres, 1 to_x;"],
  ])("a ';' at the same or a shallower level still ends the statement: %s", (text) => {
    expect(sql(text).classes).toEqual([]);
  });

  it.each([
    ["select ';'; set role anon;"],
    ["select $q$;$q$; set role anon;"],
    ['select ";"; set role anon;'],
    ["/* ; */ set role anon /* ; */;"],
    ["select 1 -- ;\n; set role anon;"],
  ])("finds the exempt top-level statement past literal and comment ';': %j", (text) => {
    const result = classifySql(text, config, "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_set_role", gate_loosening: true })]);
  });

  it.each([
    ["select E'\\'; set role anon; ';"],
    ["select $q$ x; set role anon; $q$;"],
    ["select '*/ set role anon; /*';"],
  ])("never exempts a SET ROLE inside a literal: %j", (text) => {
    const result = classifySql(text, config, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_set_role", sensitive: true })]);
  });

  it("does not read a comment opener inside a string as a comment", () => {
    // The /* and */ sit in strings, so the SET ROLE between them is a plain top-level statement.
    const result = classifySql("select 'a /*'; set role anon; select '*/';", config, "supabase/tests/x.sql");
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_set_role", gate_loosening: true })]);
  });

  it("splits statements at a ';' inside a string body at that body's level", () => {
    const result = sql("do $$ begin create role x; perform 'superuser'; end $$;");
    expect(result.classes).toEqual([]);
    expect(sql("do $$ begin create role x password ';' superuser; end $$;").classes).toEqual(["auth"]);
  });
});

describe("classifySql: role in EXECUTE or format() arguments (OVD-878)", () => {
  const sql = (text, file = null) => classifySql(text, config, file);
  const dynamic = (result) => result.hits.filter((hit) => hit.id.startsWith("auth_dynamic_"));

  it.each([
    ["do $$ begin execute format('set %s anon', 'role'); end $$;", "auth_dynamic_role"],
    ["execute 'set role anon'", "auth_dynamic_role"],
    ["do $$ begin execute 'set ' || 'ROLE' || ' anon'; end $$;", "auth_dynamic_role"],
    ["do $$ begin execute $q$select set_config('role', 'anon', true)$q$; end $$;", "auth_dynamic_role"],
    ["do $$ begin execute 'set ' || role || ' anon'; end $$;", "auth_dynamic_role"],
    ["select format('set %s anon', 'role');", "auth_dynamic_role"],
    ["select pg_catalog.\"format\"('grant %s', (select 'Roles'));", "auth_dynamic_roles"],
    ["select format('x; %s', 'role');", "auth_dynamic_role"],
    ["execute format('select (%s', ')') || 'role';", "auth_dynamic_role"],
  ])("%j -> auth (%s), sensitive in supabase/tests too", (text, id) => {
    for (const file of [null, "supabase/tests/x.sql"]) {
      const result = sql(text, file);
      expect(result.classes).toEqual(["auth"]);
      expect(result.reasons).toContain(`auth:sql:${id}: ${rawConfig.sql_content.rules.find((rule) => rule.id === id).reason}`);
      expect(dynamic(result)).toContainEqual(expect.objectContaining({ id, line: 1, sensitive: true }));
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    }
  });

  it.each([
    ["select format('hello %s', 'world');"],
    ["do $$ begin execute 'select 1'; end $$;"],
    ["do $$ begin execute 'select 1'; perform role; end $$;"],
    ["select format('%s', x), role from t;"],
    ["select has_function_privilege('anon', 'f()', 'EXECUTE'), 'the service role cannot';"],
    ["select $$execute x$$, role;"],
    ["do $$ begin execute 'select controller, roles_x from t'; end $$;"],
  ])("no auth_dynamic hit: %j", (text) => {
    expect(dynamic(sql(text))).toEqual([]);
  });

  // Residual: a role switch spelled from fragments that never contain the word role is not detected.
  it("does not detect 'role' split across literals (documented residual)", () => {
    expect(sql("execute 'set ' || 'ro' || 'le anon';").classes).toEqual([]);
  });

  it.each([["set role anon;"], ["SET LOCAL ROLE authenticated"], ["set local role anon;\r\n"]])("leaves the exempt statement exempt: %j", (text) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ sensitive: false, exemption: "tests_set_role_unprivileged", gate_loosening: true })]);
  });

  it("cannot be exempted", () => {
    const raw = structuredClone(rawConfig);
    raw.sql_content.exemptions[0].rules.push("auth_dynamic_role");
    expect(compileConfig(raw).errors).toContain('sql_content.exemptions[0]: rule "auth_dynamic_role" is not a SET [LOCAL] ROLE or RESET ROLE rule');
  });
});

describe("classifySql: tokenizer stays in step with Postgres (OVD-878 final round)", () => {
  const tests = "supabase/tests/x.sql";
  const migration = "supabase/migrations/1.sql";
  const ids = (result) => result.hits.map((hit) => `${hit.id}${hit.sensitive ? "" : "[EXEMPT]"}`);
  const unknownReason = (result) => result.reasons.filter((reason) => reason.startsWith("sql:tokenizer_unknown_char: "));

  // Review repro: a -- comment ends at a lone CR (Postgres non_newline is [^\n\r]), so the grant after it runs.
  it.each([
    [migration, "select 1;\n-- note\rgrant service_role to authenticated;\n", ["auth_grant_service_role"]],
    [tests, "set role anon; --\rgrant service_role to authenticated;\n", ["auth_set_role[EXEMPT]", "auth_grant_service_role"]],
    [migration, "-- a\r\ngrant service_role to x;\r\n-- b\ngrant postgres to y;", ["auth_grant_service_role", "auth_grant_postgres"]],
  ])("a -- comment ends at CR, LF or CRLF: %s %j", (file, text, expected) => {
    const result = classifySql(text, config, file);
    expect(result.classes).toEqual(["auth"]);
    expect(ids(result)).toEqual(expected);
    expect(unknownReason(result)).toEqual([]);
  });

  it("does not exempt a SET ROLE that a lone CR moves out of a comment into the next statement", () => {
    const result = classifySql("select 1 --\rset role postgres;\nset role anon;", config, tests);
    expect(ids(result)).toEqual(["auth_set_role", "auth_set_role[EXEMPT]"]);
  });

  // Review repros: a non-ASCII letter is an identifier character to Postgres (every byte >= 0x80 is).
  it("reads a\u00e9$$ as one identifier, so a grant after it is top-level code (full-hide repro)", () => {
    const text = "select 1 as a\u00e9$$ /* $$ ' -- */ ; grant service_role to authenticated; /* ' */\n";
    for (const file of [migration, tests]) {
      const result = classifySql(text, config, file);
      expect(result.classes).toEqual(["auth"]);
      expect(ids(result)).toEqual(["auth_grant_service_role"]);
    }
  });

  it("does not exempt SET ROLE that Postgres reads as part of ALTER ROLE a\u00e9$$ ... SET ROLE anon", () => {
    const result = classifySql("alter role a\u00e9$$ -- $$;\nset role anon;", config, tests);
    expect(result.classes).toEqual(["auth"]);
    expect(ids(result)).toEqual(["auth_set_role"]);
  });

  it("reads $\u00e9$...$\u00e9$ as a dollar-quoted string", () => {
    expect(ids(classifySql("select $\u00e9$ x $\u00e9$; set role anon;", config, tests))).toEqual(["auth_set_role[EXEMPT]"]);
    // A SET ROLE inside the $é$ string is never exempt.
    const inside = classifySql("select $\u00e9$ x; set role anon; $\u00e9$;", config, tests);
    expect(inside.classes).toEqual(["auth"]);
    expect(ids(inside)).toEqual(["auth_set_role"]);
  });

  it("does not read \u00e9e'...' as an E'' string", () => {
    // Postgres: identifier \u00e9e, then the standard string '\', then a top-level SET ROLE anon.
    expect(ids(classifySql("select \u00e9e'\\'; set role anon;", config, tests))).toEqual(["auth_set_role[EXEMPT]"]);
    // A real E'' string still takes backslash escapes.
    expect(ids(classifySql("select e'\\'; set role anon;';", config, tests))).toEqual(["auth_set_role"]);
  });

  it("keeps non-ASCII letters and digits inside one word", () => {
    expect(classifySql("create policy \u0436\u0436 on t; select \u00e9t\u00e9_\u0663;", config).hits.map((hit) => hit.id)).toEqual(["rls_create_policy"]);
    expect(classifySql("select 'x' as \u00e9;", config, tests).reasons).toEqual([]);
  });

  // Extra round: as in scan.l, every code point >= U+0080 is an identifier and dollar-tag character.
  it("flags the re-review repro ALTER ROLE x PASSWORD $\u2014$;$\u2014$ SUPERUSER; with the role class", () => {
    const result = classifySql("ALTER ROLE x PASSWORD $\u2014$;$\u2014$ SUPERUSER;", config, migration);
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_role_superuser", line: 1, sensitive: true })]);
    expect(unknownReason(result)).toEqual([]);
  });

  it.each([
    ["select 1 as a\u2014b, $\u{1F600}$ ; x $\u{1F600}$;\nset role anon;"],
    ["select \u00a0x\u00a0, $\u00a0$;$\u00a0$, $\ufeff$ -- $\ufeff$;\nset role anon;"],
    ["select $\u2014$ /* $\u2014$; set role anon;"],
  ])("parses non-ASCII identifiers and dollar tags cleanly: %j", (text) => {
    const result = classifySql(text, config, tests);
    expect(result.reasons).toEqual([]);
    expect(result.classes).toEqual([]);
    expect(ids(result)).toEqual(["auth_set_role[EXEMPT]"]);
  });

  it.each([
    ["set role anon\u00a0;", "auth_set_role"],
    ["\ufeffset role anon; set local role service_role;", "auth_set_local_role"],
    ["select a\u2014$$ /* $$ ' -- */ ; grant service_role to x; /* ' */", "auth_grant_service_role"],
  ])("a non-ASCII character joins the word it touches, as in Postgres: %j", (text, id) => {
    const result = classifySql(text, config, tests);
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    expect(unknownReason(result)).toEqual([]);
  });

  // Belt and braces: an unexpected ASCII control character means the tokenizer may be out of step,
  // so the file gets no exemption and fails closed with every SQL class plus the reason.
  const SQL_CLASSES = ["auth", "definer", "rls"];
  const failsClosed = (result, code, line) => {
    expect([...result.classes].sort()).toEqual(SQL_CLASSES);
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    expect(unknownReason(result)).toEqual([
      `sql:tokenizer_unknown_char: ${code} on line ${line} is not a character the SQL tokenizer classifies, so no comment, string or statement exemption applies to this file and it fails closed`,
    ]);
  };

  it.each([
    ["set role anon;\u0007-- grant service_role to x\n", ["auth_set_role", "auth_grant_service_role"], "U+0007", 1],
    ["select 1;\n/* \u2014 */ select '\u001b';\nset role anon; -- reset role\n", ["auth_reset_role", "auth_set_role"], "U+001B", 2],
    ["\u0000set role anon;", ["auth_set_role"], "U+0000", 1],
    ["select 1;\u007f\nset local role authenticated; /* set role postgres */", ["auth_set_local_role", "auth_set_role"], "U+007F", 1],
  ])("an unexpected ASCII control character fails closed: %j", (text, expected, code, line) => {
    const result = classifySql(text, config, tests);
    failsClosed(result, code, line);
    expect([...ids(result)].sort()).toEqual([...expected].sort());
  });

  it("fails closed on an unexpected ASCII character even with no rule hit", () => {
    const result = classifySql("select 1;\u0008\nselect 2;", config, migration);
    failsClosed(result, "U+0008", 1);
    expect(result.hits).toEqual([]);
  });

  // Re-review @ 2c113e9a: the raw reading alone splits at every ';' and counts every ')', so the
  // structural rules also run over the parsed tokens and both readings' hits are reported.
  it.each([
    ["ALTER ROLE x PASSWORD ';' SUPERUSER;", "auth_role_superuser"],
    ["ALTER ROLE x /* ; */ SUPERUSER;", "auth_role_superuser"],
    ["GRANT /* ; */ service_role TO x;", "auth_grant_service_role"],
    ["CREATE ROLE x -- ;\nIN ROLE postgres;", "auth_in_role_postgres"],
    ["select format(')' || 'set %s anon', 'role');", "auth_dynamic_role"],
    ["EXECUTE 'x;' || 'role';", "auth_dynamic_role"],
  ])("with an unexpected character, still reports what the parsed tokens find: %j", (text, id) => {
    const result = classifySql(`select 'a \u0007 b';\n${text}`, config, tests);
    failsClosed(result, "U+0007", 1);
    expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
  });

  it("reports a hit both readings find once", () => {
    const result = classifySql("select '\u0007';\ngrant service_role to x; grant service_role to y;", config, tests);
    expect(ids(result)).toEqual(["auth_grant_service_role", "auth_grant_service_role"]);
  });

  it("does not count a control character inside a comment as unknown", () => {
    const result = classifySql("-- caf\u00e9 \u0007 \u{1F600}\n/* \u001b */ set role anon;", config, tests);
    expect(ids(result)).toEqual(["auth_set_role[EXEMPT]"]);
    expect(result.reasons).toEqual([]);
  });

  it("counts an unexpected character inside a string body as unknown", () => {
    const result = classifySql("select 'a \u0007 b'; set role anon;", config, tests);
    expect(ids(result)).toEqual(["auth_set_role"]);
    failsClosed(result, "U+0007", 1);
  });
});

describe("classifySql: quoted punctuation and SQL-only trimming (OVD-878)", () => {
  it.each([
    ['CREATE ROLE ";" SUPERUSER;', "auth_role_superuser"],
    ['CREATE ROLE ";" CREATEROLE;', "auth_role_createrole"],
    ['ALTER ROLE ";" REPLICATION;', "auth_role_replication"],
    ['CREATE ROLE ";" IN ROLE postgres;', "auth_in_role_postgres"],
    ['GRANT ";", postgres TO x;', "auth_grant_postgres"],
    [`select format(")" || 'set %s anon', 'role');`, "auth_dynamic_role"],
  ])("flags quoted punctuation without losing parsed hits in the raw-token union: %s", (text, id) => {
    for (const prefix of ["", "select '\u0007';\n"]) {
      const result = classifySql(prefix + text, config, "supabase/migrations/x.sql");
      expect(result.classes).toContain("auth");
      expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
      if (prefix) expect([...result.classes].sort()).toEqual(["auth", "definer", "rls"]);
    }
  });

  it.each([";", "(", ")"])("keeps quoted %s distinct from syntax without splitting statements", (punctuation) => {
    const text = `select "${punctuation}";`;
    const tokens = sqlTokens(text);
    expect(tokens.words).toEqual(["select", `"${punctuation}"`, ";"]);
    expect(tokens.statements).toEqual([text, ""]);
  });

  it.each([
    ["SET ROLE anon\u00a0", "auth_set_role"],
    ["SET ROLE anon\ufeff", "auth_set_role"],
    ["SET ROLE anon\u2028", "auth_set_role"],
    ["set local role authenticated\u3000", "auth_set_local_role"],
  ])("does not exempt a role with trailing non-SQL whitespace at EOF: %j", (text, id) => {
    const result = classifySql(text, config, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    expect(sqlTokens(text).statements).toEqual([text]);
  });

  it.each(["\n", "\t", "\r\n", "\f", "\v"])("keeps SET ROLE exempt with trailing SQL whitespace at EOF: %j", (whitespace) => {
    const result = classifySql(`SET ROLE anon${whitespace}`, config, "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_set_role", sensitive: false, gate_loosening: true })]);
  });
});

describe("classifySql: confirmed privileged membership gaps (PR 824)", () => {
  const postgresRoles = [
    "pg_execute_server_program", "pg_write_server_files", "pg_read_server_files", "pg_write_all_data",
    "pg_read_all_data", "pg_signal_backend", "pg_checkpoint", "pg_create_subscription",
  ];
  const supabaseRoles = [
    "supabase_auth_admin", "supabase_storage_admin", "supabase_realtime_admin", "supabase_functions_admin",
    "supabase_replication_admin", "supabase_read_only_user", "dashboard_user", "pgsodium_keymaker", "pgsodium_keyholder",
  ];
  const paths = ["supabase/migrations/20261021000000_probe.sql", "supabase/tests/database/probe.test.sql"];
  const check = (text, id) => {
    for (const file of paths) {
      const result = classifySql(text, config, file);
      expect(result.classes).toContain("auth");
      expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    }
  };
  for (const [family, roles] of [["PostgreSQL", postgresRoles], ["Supabase", supabaseRoles]]) {
    it.each(roles)(`flags all three membership forms for ${family} privileged role %s`, (role) => {
      check(`GRANT app, "${role}" TO anon;`, `auth_grant_${role}`);
      check(`CREATE ROLE app IN ROLE other, ${role};`, `auth_in_role_${role}`);
      check(`ALTER GROUP ${role} ADD USER anon;`, `auth_alter_group_${role}`);
    });
  }
  const roles = ["postgres", "supabase_admin", "service_role", "authenticator", ...postgresRoles, ...supabaseRoles];
  it.each(roles)("flags USER, ROLE and ADMIN member clauses on privileged role %s", (role) => {
    for (const declaration of ["CREATE ROLE", "CREATE USER", "CREATE GROUP", "ALTER ROLE", "ALTER USER"]) {
      for (const clause of ["USER", "ROLE", "ADMIN"]) {
        check(`${declaration} "${role}" WITH ${clause} anon, authenticated;`, `auth_members_${clause.toLowerCase()}_${role}`);
      }
    }
  });
  it.each([
    "CREATE ROLE app USER service_role;", "CREATE ROLE app ROLE postgres;", "CREATE ROLE app ADMIN supabase_admin;",
    "ALTER ROLE service_role NOSUPERUSER;", "ALTER ROLE service_role; SELECT user;",
    "GRANT SELECT ON TABLE t TO pg_read_all_data;", "REVOKE pg_write_all_data FROM app;",
    "ALTER GROUP supabase_auth_admin DROP USER anon;",
  ])("does not confuse a member or recipient with the privileged role being granted: %s", (text) => {
    expect(classifySql(text, config, paths[0]).classes).toEqual([]);
  });
});

describe("sqlTokens and classifySql: continued and encoded strings (PR 824)", () => {
  const migration = "supabase/migrations/20261021000000_probe.sql";
  const tests = "supabase/tests/probe.sql";
  it.each(["\n", "\r", "\r\n", " -- continuation\n"])("keeps RESET ROLE and GRANT inside a continued E-string DO body: %j", (gap) => {
    const text = `DO E'BEGIN PERFORM '${gap}'\\'x --\\'; GRANT service_role TO anon;\nPERFORM 1;\nRESET ROLE;\nEND;';\nRESET ROLE;`;
    const result = classifySql(text, config, tests);
    const grantLine = gap.includes("\n") ? 2 : 1;
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_grant_service_role", line: grantLine, sensitive: true }));
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_reset_role", line: grantLine + 2, sensitive: true }));
    expect(result.hits.filter((hit) => hit.gate_loosening)).toEqual([
      expect.objectContaining({ id: "auth_reset_role", line: grantLine + 4, exemption: "tests_reset_role" }),
    ]);
    expect(sqlTokens(text).statements).toEqual([text.slice(0, text.lastIndexOf("\n")), "RESET ROLE;", ""]);
  });
  it("concatenates split keywords across multiple continued segments and retains source lines", () => {
    const text = "DO E'BEGIN; GR'\n'ANT service_'\n'role TO anon; RE'\n'SET ROLE; END;';";
    const result = classifySql(text, config, tests);
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_grant_service_role", line: 2, sensitive: true }));
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_reset_role", line: 3, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
  });
  it.each([" ", "\t", " /* gap */\n"])("does not continue strings without PostgreSQL quotecontinue whitespace: %j", (gap) => {
    expect(sqlTokens(`SELECT E'GR'${gap}'ANT';`).words).toEqual(["select", "gr", "ant", ";"]);
  });
  it("keeps ordinary continued strings in standard rather than E-string escape mode", () => {
    const result = classifySql("SELECT 'x'\n'\\'; RESET ROLE;", config, tests);
    expect(result.classes).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id: "auth_reset_role", line: 2, exemption: "tests_reset_role" })]);
  });
  it.each([
    String.raw`ALTER ROLE anon U&"bypass\0072ls";`,
    String.raw`GRANT U&"service\005frole" TO anon;`,
    String.raw`SELECT set_config(U&'ro\006ce', 'service_role', false);`,
    String.raw`SET U&"\0072ole" service_role;`,
    String.raw`GRANT U&"postgre!0073" UESCAPE '!' TO anon;`,
    String.raw`SELECT set_config(u&'ro!+00006ce' UESCAPE '!', 'service_role', false);`,
    String.raw`DO $$ BEGIN EXECUTE U&'GRANT service\005frole TO anon'; END $$;`,
  ])("fails closed on Unicode escaped identifiers and strings: %s", (text) => {
    const result = classifySql(text, config, migration);
    expect(result.classes).toContain("auth");
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_unicode_escape", sensitive: true }));
  });
  it.each([
    [String.raw`DO $$ BEGIN EXECUTE E'ALTER USER anon SUPER\x55SER'; END $$;`, "auth_role_superuser"],
    [String.raw`DO E'GRANT service\x5frole TO anon';`, "auth_grant_service_role"],
    [String.raw`SELECT set_config(E'\x72ole', 'service_role', false);`, "auth_set_config_role"],
    [String.raw`EXECUTE E'SET \x52OLE service_role';`, "auth_set_role"],
    [String.raw`EXECUTE E'ALTER USER anon SUPER\125SER';`, "auth_role_superuser"],
    [String.raw`EXECUTE E'ALTER USER anon SUPER\u0055SER';`, "auth_role_superuser"],
    [String.raw`EXECUTE E'ALTER USER anon SUPER\U00000055SER';`, "auth_role_superuser"],
    [String.raw`EXECUTE E'ALTER USER anon SUPERU\SER';`, "auth_role_superuser"],
    ["DO E'GRANT service_'\n'\\x72ole TO anon';", "auth_grant_service_role"],
  ])("decodes E-string escapes before privileged SQL matching: %s", (text, id) => {
    for (const file of [migration, tests]) {
      const result = classifySql(text, config, file);
      expect(result.classes).toContain("auth");
      expect(result.hits).toContainEqual(expect.objectContaining({ id, sensitive: true }));
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    }
  });
  it("retains source lines through decoded newlines and nested dollar bodies", () => {
    const result = classifySql(String.raw`DO E'BEGIN\nDO $$GRANT service_role TO anon;$$;\nRESET ROLE; END;';`, config, tests);
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_grant_service_role", line: 1, sensitive: true }));
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_reset_role", line: 1, sensitive: true }));
  });
  it("does not flag escape spellings inside comments", () => {
    expect(classifySql(String.raw`-- GRANT U&"service\005frole" TO anon;
/* EXECUTE E'ALTER USER anon SUPER\x55SER'; */ SELECT 1;`, config, migration).classes).toEqual([]);
  });
});

describe.each([
  "supabase/migrations/20261021000000_probe.sql",
  "supabase/tests/probe.sql",
])("classifySql: five fail-closed gaps (PR 824) on %s", (file) => {
  const check = (text, id) => {
    const result = classifySql(text, config, file);
    expect(result.classes).toContain("auth");
    expect(result.hits).toContainEqual(expect.objectContaining({ id, path: file, sensitive: true }));
    expect(result.reasons.some((reason) => reason.startsWith(`auth:sql:${id}:`))).toBe(true);
    return result;
  };
  const nest = (body, count) => {
    const tags = Array.from({ length: count }, (_, level) => `$depth${level}$`);
    return `DO ${tags.join("\n")} ${body} ${tags.toReversed().join("\n")};`;
  };

  it.each([9, 10, 16])("fails closed at nesting depth %i even without keywords", (depth) => {
    for (const body of [
      "", "SELECT 1", "GRANT service_role TO anon", "ALTER ROLE anon BYPASSRLS", "SECURITY DEFINER",
      String.raw`EXECUTE E'GRANT service\x5frole TO anon'`,
      String.raw`EXECUTE 'GRANT U&"service\005frole" TO anon'`,
      String.raw`PERFORM set_config(E'\x72ole', 'service_role', false)`,
    ]) check(nest(body, depth), "auth_depth_limit");
  });
  it("starts the depth guard at the fallback boundary and keeps its source line", () => {
    expect(classifySql(nest("SELECT 1", 8), config, file).classes).toEqual([]);
    const result = check(nest("SELECT 1", 9), "auth_depth_limit");
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_depth_limit", line: 9 }));
  });
  it.each([
    String.raw`EXECUTE E'GRANT service\x5frole TO anon'`,
    String.raw`EXECUTE 'GRANT U&"service\005frole" TO anon'`,
    String.raw`PERFORM set_config(E'\x72ole','service_role',false)`,
  ])("flags the report's nested DO/EXECUTE repro: %s", (body) => {
    let text = `DO $b0$ BEGIN ${body}; END $b0$`;
    for (let level = 1; level < 5; level += 1) text = `DO $b${level}$ BEGIN EXECUTE $s${level}$ ${text} $s${level}$; END $b${level}$`;
    check(`${text};`, "auth_depth_limit");
  });

  it.each(["standard_conforming_strings", "backslash_quote"])("guards every mention of %s", (setting) => {
    for (const text of [
      `SET ${setting} = off;`, `SET LOCAL "${setting}" = on;`,
      `SELECT set_config('${setting}', 'off', false);`,
      `DO $$ BEGIN PERFORM set_config('${setting}', 'off', false); END $$;`,
      `SELECT set_config(replace('--${setting}', '--', ''), 'off', false);`,
      `DO $$ BEGIN PERFORM set_config(replace('--${setting}', '--', ''), 'off', false); END $$;`,
      `SELECT set_config(replace('--${setting}', '--', ''), 'off', false);\nSELECT 'x\\' -- '; ALTER ROLE anon BYPASSRLS; SELECT 1;`,
      `ALTER ROLE anon SET ${setting} = off;`, `ALTER DATABASE db SET ${setting} = off;`,
      `SELECT current_setting('${setting}');`, `SELECT '${setting.toUpperCase()}';`,
      `SET ${setting} = off;\nSET ROLE anon;\nSELECT 'x\\' -- '; RESET ROLE; GRANT service_role TO anon; SELECT 1;\nRESET ROLE;`,
      `SET ${setting} = off;\nSELECT 'x\\' -- '; ALTER ROLE anon BYPASSRLS; SELECT 1;`,
      String.raw`SET ${setting} = off; SELECT set_config('\x72ole','service_role',false);`,
    ]) check(text, `auth_${setting}`);
  });
  it("retains source lines for settings in transformed literals", () => {
    const result = check("SELECT set_config(replace('\n--standard_conforming_strings', '--', ''), 'off', false);", "auth_standard_conforming_strings");
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_standard_conforming_strings", line: 2 }));
  });

  it.each([
    "pg_monitor", "pg_maintain", "pg_read_all_settings", "pg_use_reserved_connections", "pg_future_role",
    "pg_", '"PG_MONITOR"', '"pg_future role"',
    "supabase_etl_admin", "supabase_superuser", "pgbouncer",
    "CURRENT_USER", "SESSION_USER", "CURRENT_ROLE",
  ])("guards every membership form for %s", (role) => {
    check(`GRANT /* target */ app, ${role} TO anon;`, "auth_grant_privileged_target");
    for (const declaration of ["CREATE ROLE", "CREATE USER", "CREATE GROUP"]) {
      for (const clause of ["ROLE", "GROUP"]) {
        check(`${declaration} app IN ${clause} other, ${role};`, "auth_in_role_privileged_target");
      }
    }
    check(`ALTER GROUP ${role} /* members */ ADD USER anon;`, "auth_alter_group_privileged_target");
    for (const declaration of ["CREATE ROLE", "CREATE USER", "CREATE GROUP", "ALTER ROLE", "ALTER USER"]) {
      for (const clause of ["USER", "ROLE", "ADMIN"]) {
        check(`${declaration} ${role} WITH ${clause} anon;`, `auth_members_${clause.toLowerCase()}_privileged_target`);
      }
    }
  });

  it.each([
    "DO $$ BEGIN EXECUTE format('GRANT %I TO anon', 'pg_read_all_data'); END $$;",
    "DO $$ BEGIN EXECUTE format('GRANT %I TO anon', 'service_role'); END $$;",
    "DO $$ BEGIN EXECUTE format('GRANT %s TO %s', 'supabase_auth_admin', 'anon'); END $$;",
    "SELECT pg_catalog.\"format\"('REVOKE %I FROM anon', r);",
    "SELECT pg_catalog.\"format\" /* gap */ ('GRANT %I TO anon', r);",
    "SELECT format /* gap */ ('ALTER /* gap */ ROLE %I USER anon', r);",
    "SELECT format('ALTER ROLE %I WITH USER anon', r);",
    "SELECT format('SET ROLE %I', r);",
    "SELECT 'GRANT ' || r || ' TO anon';", "SELECT 'REVOKE ' || r || ' FROM anon';",
    "SELECT 'ALTER ROLE ' || r || ' USER anon';", "SELECT 'SET ROLE ' || r;",
    "SELECT $$GRANT $$ || r || $$ TO anon$$;",
    "SELECT concat('GRANT ', r, ' TO anon');", "SELECT concat_ws(' ', 'GRANT', r, 'TO anon');",
    "DO $$ BEGIN EXECUTE replace('-- GRANT service_role TO anon', '--', ''); END $$;",
    "DO $$ BEGIN EXECUTE replace('-- ALTER /* gap */ ROLE app USER anon', '--', ''); END $$;",
    "DO $$ BEGIN EXECUTE replace('-- SET /* gap */ ROLE app', '--', ''); END $$;",
    String.raw`DO $$ BEGIN EXECUTE replace(E'\x2d\x2d GRANT service_role TO anon','--',''); END $$;`,
    String.raw`SELECT format('GRANT %I TO anon', 'service_role') \gexec`,
    String.raw`SELECT '-- GRANT app TO anon' \gexec`,
    String.raw`SELECT replace('-- GRANT service_role TO anon', '--', '');
\gexec`,
  ])("guards dynamic command literals: %s", (text) => {
    check(text, "auth_dynamic_sql");
  });
  it.each([
    String.raw`\set r service_role
GRANT :r TO anon;`,
    String.raw`GRANT :"r" TO anon;`, String.raw`GRANT :'r' TO anon;`,
    String.raw`GRANT app TO :recipient;`, String.raw`SET ROLE :r;`,
    String.raw`SET LOCAL ROLE :"r";`, String.raw`SET SESSION ROLE :'r';`,
    String.raw`GRANT app TO anon \gexec`, String.raw`SET ROLE anon \gexec`,
    String.raw`ALTER GROUP :r ADD USER anon;`, String.raw`ALTER ROLE :r USER anon;`,
    String.raw`CREATE ROLE app IN ROLE :r;`,
  ])("guards psql role commands: %s", (text) => {
    check(text, "auth_psql_role");
  });
  it.each([
    "SELECT format('hello %s', 'world');", "SELECT 'hello' || 'world';",
    "-- SET standard_conforming_strings = off;\nSELECT 1;",
    "/* SET backslash_quote = on; */ SELECT 1;",
    "GRANT SELECT ON t TO pg_monitor;", "CREATE ROLE app USER pg_monitor;",
    "ALTER GROUP pg_monitor DROP USER anon;", "SELECT 'standard_conforming_strings_note';",
  ])("keeps unrelated SQL outside the new guards: %s", (text) => {
    expect(classifySql(text, config, file).classes).toEqual([]);
  });
});

describe("sqlTokens and classifySql: inputs of any size (OVD-878)", () => {
  // Spreading an array of about 100k items into push() overflows the call stack.
  const body = "a ".repeat(150_000);

  it.each([
    ["a single-quoted string", `'${body}'`],
    ["a dollar-quoted body", `$$${body}$$`],
  ])("tokenizes %s of 150000 words without overflowing the stack", (_label, text) => {
    const tokens = sqlTokens(text);
    expect(tokens.words).toHaveLength(150_000);
    expect(tokens.lines).toHaveLength(150_000);
    expect(tokens.statement).toHaveLength(150_000);
    expect(tokens.starts[0]).toBe(1);
    expect(tokens.ends.at(-1)).toBe(1);
  });

  it("still finds a role switch after a 150000-word body", () => {
    const result = classifySql(`do $$${body} set role postgres; $$;`, config, "supabase/migrations/x.sql");
    expect(result.classes).toContain("auth");
    expect(result.hits).toContainEqual(expect.objectContaining({ id: "auth_set_role", sensitive: true }));
  });

  it("fails closed on the original 200000-hit fixture above the token budget", () => {
    const result = classifySql("set role anon;\n".repeat(200_000), config, "supabase/migrations/x.sql");
    expect(new Set(result.classes)).toEqual(new Set(config.sqlContent.rules.map((rule) => rule.class)));
    expect(result.reasons).toEqual([SQL_OVERSIZED_REASON]);
    expect(result.hits).toEqual([]);
  });

  it("reports every hit at the token budget", () => {
    const count = MAX_SQL_TOKENS / 4;
    const result = classifySql("set role anon;\n".repeat(count), config, "supabase/migrations/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits.filter((hit) => hit.id === "auth_set_role")).toHaveLength(count);
  });
});

describe("compileConfig: SQL exemptions (OVD-878)", () => {
  const withExemption = (change) => {
    const raw = structuredClone(rawConfig);
    change(raw.sql_content.exemptions[0]);
    return compileConfig(raw).errors;
  };

  it("requires every exemption to be marked gate_loosening and to name known, non-informational rules", () => {
    expect(rawConfig.sql_content.exemptions.every((entry) => entry.gate_loosening === true && entry.reason)).toBe(true);
    expect(withExemption((entry) => delete entry.gate_loosening)).toContain("sql_content.exemptions[0]: gate_loosening must be true");
    expect(withExemption((entry) => entry.rules.push("nope_rule"))).toContain('sql_content.exemptions[0]: unknown rule "nope_rule"');
    expect(withExemption((entry) => entry.rules.push("auth_role_nosuperuser"))).toContain('sql_content.exemptions[0]: rule "auth_role_nosuperuser" is informational');
    expect(withExemption((entry) => (entry.extra = 1))).toContain('sql_content.exemptions[0]: unknown key "extra"');
    expect(withExemption((entry) => (entry.reason = ""))).toContain("sql_content.exemptions[0]: reason must be a non-empty string");
  });

  it("limits exemptions to the SET [LOCAL] ROLE and RESET ROLE rules and unquoted lower-case targets", () => {
    expect(withExemption((entry) => entry.rules.push("auth_reset_all"))).toContain('sql_content.exemptions[0]: rule "auth_reset_all" is not a SET [LOCAL] ROLE or RESET ROLE rule');
    expect(withExemption((entry) => entry.rules.push("auth_set_session_role"))).toContain('sql_content.exemptions[0]: rule "auth_set_session_role" is not a SET [LOCAL] ROLE or RESET ROLE rule');
    expect(withExemption((entry) => delete entry.targets)).toContain("sql_content.exemptions[0].targets must not be empty");
    expect(withExemption((entry) => entry.targets.push("Anon"))).toContain('sql_content.exemptions[0].targets has invalid keyword "Anon"');
    expect(withExemption((entry) => entry.targets.push(".*"))).toContain('sql_content.exemptions[0].targets has invalid keyword ".*"');
  });

  it("allows RESET ROLE only without targets", () => {
    const reset = (change) => {
      const raw = structuredClone(rawConfig);
      change(raw.sql_content.exemptions[1]);
      return compileConfig(raw).errors;
    };
    expect(reset(() => {})).toEqual([]);
    expect(reset((entry) => (entry.targets = ["anon"]))).toContain("sql_content.exemptions[1].targets is only allowed with a SET [LOCAL] ROLE rule");
  });

  it("has exactly two exemptions: SET [LOCAL] ROLE anon or authenticated, and RESET ROLE, in supabase/tests", () => {
    expect(rawConfig.sql_content.exemptions).toEqual([
      expect.objectContaining({
        id: "tests_set_role_unprivileged",
        paths: ["supabase/tests/**"],
        rules: ["auth_set_role", "auth_set_local_role"],
        targets: ["anon", "authenticated"],
        gate_loosening: true,
      }),
      expect.objectContaining({ id: "tests_reset_role", paths: ["supabase/tests/**"], rules: ["auth_reset_role"], gate_loosening: true }),
    ]);
    expect(rawConfig.sql_content.exemptions[1]).not.toHaveProperty("targets");
  });
});

describe("detect: SQL hits and gate_loosening (OVD-878)", () => {
  const files = {
    "supabase/tests/roles.sql": "select 1;\nset local role authenticated;\nreset role;\nSET ROLE postgres;",
    "supabase/migrations/20261001000000_roles.sql": "alter role x nosuperuser;\nset local role authenticated;",
  };
  const readHeadFile = async (file) => files[file];

  it("reports every hit with rule id, path and line, and lists exempt hits as gate_loosening", async () => {
    const result = await detect({ files: Object.keys(files).map(modified), readHeadFile, config });
    const [tests, migration] = result.files;
    expect(tests.classes).toEqual(["schema", "auth"]);
    expect(tests.sql_hits.map(({ id, path: file, line, sensitive }) => [id, file, line, sensitive])).toEqual([
      ["auth_set_local_role", "supabase/tests/roles.sql", 2, false],
      ["auth_reset_role", "supabase/tests/roles.sql", 3, false],
      ["auth_set_role", "supabase/tests/roles.sql", 4, true],
    ]);
    expect(migration.classes).toEqual(["schema", "migrations", "auth"]);
    expect(migration.sql_hits).toEqual([
      expect.objectContaining({ id: "auth_role_nosuperuser", line: 1, informational: true, sensitive: false }),
      expect.objectContaining({ id: "auth_set_local_role", line: 2, sensitive: true }),
    ]);
    expect(result.sql_exemptions).toEqual([
      expect.objectContaining({ id: "auth_set_local_role", path: "supabase/tests/roles.sql", line: 2, exemption: "tests_set_role_unprivileged", gate_loosening: true }),
      expect.objectContaining({ id: "auth_reset_role", path: "supabase/tests/roles.sql", line: 3, exemption: "tests_reset_role", gate_loosening: true }),
    ]);
  });

  it("shows hit locations and gate loosening in the job summary", async () => {
    const result = await detect({ files: Object.keys(files).map(modified), readHeadFile, config });
    const summary = formatSummary(result);
    expect(summary).toContain("Gate loosening: 2 SQL hit(s) exempted by tests_set_role_unprivileged, tests_reset_role");
    expect(summary).toContain("| auth_set_local_role | `supabase/tests/roles.sql:2` | auth | exempt (gate_loosening: tests_set_role_unprivileged) |");
    expect(summary).toContain("| auth_reset_role | `supabase/tests/roles.sql:3` | auth | exempt (gate_loosening: tests_reset_role) |");
    expect(summary).toContain("| auth_set_role | `supabase/tests/roles.sql:4` | auth | sensitive |");
    expect(summary).toContain("| auth_role_nosuperuser | `supabase/migrations/20261001000000_roles.sql:1` | auth | informational |");
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
    expect(result.files[0].reasons).toEqual(["schema:path:**/*.sql", "migrations:path:supabase/migrations/**", `rls:sql:rls_create_policy: ${rawConfig.sql_content.rules[0].reason}`]);
    expect(result.unclassified).toEqual([]);
  });

  it("reads head files one at a time, in file order", async () => {
    let active = 0;
    let peak = 0;
    const order = [];
    const slowRead = async (file) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(file);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "select 1;";
    };
    const files = ["supabase/tests/a.sql", "docs/a.md", "supabase/tests/b.sql", "supabase/tests/c.sql"].map(modified);
    const result = await detect({ files, readHeadFile: slowRead, config });
    expect(result.status).toBe("ok");
    expect(peak).toBe(1);
    // The SQL files are one-way by class, so the door scan skips further content reads.
    expect(order).toEqual(["supabase/tests/a.sql", "supabase/tests/b.sql", "supabase/tests/c.sql"]);
  });

  it("lists each file's error in file order and still classifies the files around it", async () => {
    const files = [{ filename: "" }, modified("supabase/tests/a.sql"), null, modified("supabase/tests/b.sql"), modified("docs/a.md")];
    const result = await detect({ files, readHeadFile: async (file) => { throw new Error(`no ${file}`); }, config });
    expect(result.status).toBe("error");
    expect(result.errors).toEqual([
      'changed file 1: filename "" is not a non-empty path',
      "could not read supabase/tests/a.sql at head: no supabase/tests/a.sql",
      "changed file 3: is not an object",
      "could not read supabase/tests/b.sql at head: no supabase/tests/b.sql",
    ]);
    expect(result.files.map((file) => file.path)).toEqual(["supabase/tests/a.sql", "supabase/tests/b.sql", "docs/a.md"]);
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

  // CPU-heavy: measured 1.3–2.4 s in isolation, over 5 s under 16-way parallel preflight load (OVD-1116).
  describe("oversized SQL bodies", { timeout: 20_000 }, () => {
    const file = "supabase/fixtures/big.sql";
    const expectedClasses = new Set(["schema", ...config.sqlContent.rules.map((rule) => rule.class)]);
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
      expect(new Set(result.files[0].classes)).toEqual(expectedClasses);
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

    // A token in a quoted body is charged once, where it is tokenized, however
    // deeply it is quoted. Each builder returns SQL whose flattened token count
    // is exactly `tokens` (the quote and dollar-tag delimiters are not tokens).
    describe("a token in a nested body is charged once", () => {
      const select = (tokens) => Array(tokens).fill("select").join(" ");
      const dollars = (body, levels) => Array.from({ length: levels }).reduce((inner, _, level) => `$q${level}$ ${inner} $q${level}$`, body);
      const quotes = (body, levels) => Array.from({ length: levels }).reduce((inner) => `'${inner.replaceAll("'", "''")}'`, body);
      const nested = [
        ["a dollar-quoted body", (tokens) => dollars(select(tokens), 1)],
        ["dollar-quoted bodies nested three deep", (tokens) => dollars(select(tokens), 3)],
        ["a single-quoted body", (tokens) => quotes(select(tokens), 1)],
        ["single-quoted bodies nested three deep", (tokens) => quotes(select(tokens), 3)],
        ["single-quoted bodies nested past the depth limit", (tokens) => quotes(select(tokens), 10)],
        ["a quoted string inside a dollar-quoted body", (tokens) => dollars(quotes(select(tokens), 2), 2)],
        ["an E'' string after a word", (tokens) => `select e'${select(tokens - 1)}'`],
        ["decoded E escapes nested in a dollar body", (tokens) => dollars(`E'${String.raw`\x73elect `.repeat(tokens)}'`, 1)],
        ["continued E strings", (tokens) => `E'${select(tokens - 1)} '\n'${String.raw`\x73elect`}'`],
        ["sibling quoted bodies sharing one budget", (tokens) => `${quotes(select(Math.floor(tokens / 2)), 1)} ${dollars(select(Math.ceil(tokens / 2)), 1)}`],
      ];
      const scan = (sql) => detect({ files: [modified(file)], readHeadFile: async () => sql, config });

      it.each(nested)("tokenizes %s of exactly the limit once per token", (_name, build) => {
        expect(sqlWords(build(MAX_SQL_TOKENS))).toHaveLength(MAX_SQL_TOKENS);
      });

      it.each(nested)("scans %s of exactly the limit normally", async (name, build) => {
        const result = await scan(build(MAX_SQL_TOKENS));
        // #824 intentionally adds auth when decoding reaches the depth limit.
        const classes = name.includes("past the depth limit") ? ["schema", "auth"] : ["schema"];
        expect(result).toMatchObject({ status: "ok", errors: [], sensitive_count: 1, classes });
        if (classes.includes("auth")) expect(result.files[0].sql_hits).toContainEqual(expect.objectContaining({ id: "auth_depth_limit" }));
        expect(result.files[0].reasons).not.toContain(`sql:oversized:>${MAX_SQL_TOKENS}`);
        expect(result.manual_review).toBeUndefined();
      });

      it.each(nested)("fails closed on %s one token over the limit", async (_name, build) => {
        const result = await scan(build(MAX_SQL_TOKENS + 1));
        expect(result).toMatchObject({ status: "ok", errors: [], sensitive_count: 1 });
        expect(new Set(result.files[0].classes)).toEqual(expectedClasses);
        expect(result.files[0].reasons).toContain(`sql:oversized:>${MAX_SQL_TOKENS}`);
        expect(result.manual_review).toEqual([
          `SQL body ${file} rejected for size: exceeds the limit of ${MAX_SQL_TOKENS} tokens; manual review is required`,
        ]);
      });

      it.each([
        ["U& string", (body) => `U&'${body}'`],
        ["U& string nested in an E string", (body) => `E'U&''${body}'''`],
        ["E string nested in U&", (body) => `U&'E''${body}'''`],
      ])("charges the decoded body of %s", (_name, wrap) => {
        const atLimit = wrap(select(MAX_SQL_TOKENS - 2)); // U and & are emitted too.
        expect(sqlTokens(atLimit).words).toHaveLength(MAX_SQL_TOKENS);
        expect(classifySql(atLimit, config).reasons).not.toContain(SQL_OVERSIZED_REASON);
        const over = wrap(select(MAX_SQL_TOKENS - 1));
        expect(() => sqlTokens(over)).toThrow(SqlTooLargeError);
        expect(classifySql(over, config).reasons).toEqual([SQL_OVERSIZED_REASON]);
      });

      it("scans a DO block of 50k tokens (over half the limit) normally", () => {
        const statements = 24_999;
        const sql = `DO $$ BEGIN ${"NULL; ".repeat(statements)}END; $$;`;
        expect(sqlWords(sql)).toHaveLength(2 * statements + 5);
        expect(classifySql(sql, config)).toEqual({ classes: [], reasons: [], hits: [] });
      });

      it("still finds a sensitive statement inside a large nested body", () => {
        const sql = dollars(`${select(MAX_SQL_TOKENS / 2)} execute 'create policy p on t'`, 2);
        expect(classifySql(sql, config).classes).toEqual(["rls"]);
      });
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

  // QA @ b5f2340c: nothing pinned the base checkout, so switching it to the PR head left every test green.
  it("checks out the base sha without saved credentials, and runs the detector from that checkout", () => {
    const checkout = job.steps.find((entry) => String(entry.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout).toBeDefined();
    expect(checkout.with.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    // Codex review @ d85756f7: the detector must check the PR's base against the commit it runs from.
    expect(step.env.BASE_SHA).toBe(checkout.with.ref);
    expect(step.env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(step.run).toContain('--head-sha "$HEAD_SHA" --base-sha "$BASE_SHA"');
    expect(job.steps.filter((entry) => String(entry.uses ?? "").startsWith("actions/checkout@"))).toHaveLength(1);
    expect(job.steps.indexOf(checkout)).toBeLessThan(job.steps.indexOf(step));
    expect(step.run).toContain("node scripts/sensitive-class-detect.mjs ");
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
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
      env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, PR_NUMBER: "7", HEAD_SHA: "headsha", BASE_SHA: "basesha", REPOSITORY: "o/r", GITHUB_TOKEN: "test-token" },
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
      expect(run.argv).toEqual(["--repo", "o/r", "--pr", "7", "--head-sha", "headsha", "--base-sha", "basesha", "--json", run.out]);
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

// Routes for a PR that the API returns as pulls[0], then pulls[1], and so on
// (the last one repeats), with one page of files.
function racingPull(pulls, files) {
  let reads = 0;
  return (key) => {
    if (key === "/repos/o/r/pulls/7") return pulls[Math.min(reads++, pulls.length - 1)];
    if (key.startsWith("/repos/o/r/pulls/7/files")) return key.endsWith("page=1") ? files : [];
    return undefined;
  };
}
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

  // Codex review @ d85756f7: a push between the PR read and the file pages
  // swapped sensitive files for safe ones with the same count, and the result
  // was status ok, keyed to the earlier head.
  it("reads the PR again after the last file page", async () => {
    const keys = [];
    const routes = racingPull([PULL], FILES);
    const client = githubClient({ fetchImpl: fakeFetch((key) => (keys.push(key), routes(key))) });
    const pull = await fetchPullRequest(client, "o/r", 7, { expectedHeadSha: "headsha", expectedBaseSha: "basesha" });
    expect(pull.errors).toEqual([]);
    expect(keys).toEqual(["/repos/o/r/pulls/7", "/repos/o/r/pulls/7/files?per_page=100&page=1", "/repos/o/r/pulls/7"]);
  });

  it.each([
    ["head", { head: { sha: "pushedsha" } }, "PR head moved while its files were listed: headsha before, pushedsha after"],
    ["base", { base: { sha: "newbasesha" } }, "PR base moved while its files were listed: basesha before, newbasesha after"],
  ])("errors when the %s moves while the files are listed, with the same count", async (_label, moved, message) => {
    // The safe file stands in for the files after the push; the count still matches.
    const readme = [modified("README.md")];
    const client = githubClient({ fetchImpl: fakeFetch(racingPull([{ ...PULL, changed_files: 1 }, { ...PULL, changed_files: 1, ...moved }], readme)) });
    const pull = await fetchPullRequest(client, "o/r", 7, { expectedHeadSha: "headsha", expectedBaseSha: "basesha" });
    expect(pull).toMatchObject({ sha: "headsha", baseSha: "basesha", changedFiles: 1, errors: [message] });
    expect(await detect({ ...pull, config })).toMatchObject({ status: "error", sha: "headsha", errors: [message] });
  });

  it("errors when the PR's base is not the commit whose rules judge it", async () => {
    const client = githubClient({ fetchImpl: fakeFetch(racingPull([PULL], FILES)) });
    const pull = await fetchPullRequest(client, "o/r", 7, { expectedHeadSha: "headsha", expectedBaseSha: "oldbasesha" });
    expect(pull.errors).toEqual(["PR base moved: the rules come from oldbasesha, API has basesha"]);
    expect((await detect({ ...pull, config })).status).toBe("error");
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

  it("accepts --base-sha when it is the PR's base", async () => {
    const { result } = await run(["--head-sha", "headsha", "--base-sha", "basesha"], filesRoute(FILES, (key) => (key.includes("/contents/") ? "" : undefined)));
    expect(result).toMatchObject({ status: "ok", sha: "headsha", base_sha: "basesha", errors: [] });
  });

  it("reports status error, end to end, when the base moved past the checkout or the head moved during the listing", async () => {
    const stale = await run(["--head-sha", "headsha", "--base-sha", "oldbasesha"], filesRoute(FILES, (key) => (key.includes("/contents/") ? "" : undefined)));
    expect(stale.result).toMatchObject({ status: "error", errors: ["PR base moved: the rules come from oldbasesha, API has basesha"] });
    expect(stale.result.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "not_checked" })]);
    expect(stale.summary).toContain("### Sensitive classes: ERROR");

    const pushed = await run(["--head-sha", "headsha", "--base-sha", "basesha"], racingPull([{ ...PULL, changed_files: 1 }, { ...PULL, changed_files: 1, head: { sha: "pushedsha" } }], [modified("README.md")]));
    expect(pushed.result).toMatchObject({ status: "error", sha: "headsha", errors: ["PR head moved while its files were listed: headsha before, pushedsha after"] });
    expect(pushed.result.files).toEqual([expect.objectContaining({ path: "README.md", category: "docs", classes: [] })]);
    expect(pushed.result.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "not_checked" })]);
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

  it("flags SQL constraint edits and added or widened SQL exemptions", () => {
    expect(kinds(judge((head) => (head.sql_content.rules[0].informational = true)))).toEqual(["sql_rule_changed"]);
    expect(kinds(judge((head) => (head.sql_content.rules[0].within = [["alter"]])))).toEqual(["sql_rule_changed"]);
    expect(kinds(judge((head) => head.sql_content.exemptions[0].paths.push("fixtures/**")))).toEqual(["exemption_added"]);
    const baseRaw = structuredClone(rawConfig);
    delete baseRaw.sql_content.exemptions;
    expect(kinds(detectGateLoosening({ baseRaw, headRaw: rawConfig, gateFiles: configChanged }))).toEqual(["exemption_added", "exemption_added"]);
  });

  it("flags a removed sql_content rule and a narrowed sql_content path", () => {
    expect(kinds(judge((head) => head.sql_content.rules.pop()))).toEqual(["sql_rule_removed"]);
    expect(judge((head) => (head.sql_content.rules[0].tokens = ["create", "policy", "now"]))).toMatchObject({
      detected: true,
      reasons: [{ kind: "sql_rule_removed", value: JSON.stringify([rawConfig.sql_content.rules[0].id, "rls", ["create", "policy"], rawConfig.sql_content.rules[0].reason]) }],
    });
    expect(kinds(judge((head) => (head.sql_content.paths = ["**/*.sql"])))).toEqual(["rule_narrowed"]);
  });

  it.each(["id", "reason"])("flags an edited SQL rule %s", (field) => {
    expect(kinds(judge((head) => (head.sql_content.rules[0][field] += "_changed")))).toEqual(["sql_rule_removed"]);
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
      head.sql_content.rules.push({ id: "new_definer", class: "definer", tokens: ["set", "role"], reason: "test" });
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
    for (const file of [DETECTOR_REPO_PATH, CONFIG_REPO_PATH, DETECTOR_HELPER_REPO_PATH, MATCHER_PATH, SENSITIVE_PATHS_FILE, "scripts/lib/entry-point.mjs"]) {
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


describe("door tier: report-only", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/sensitive-paths/doors.json", import.meta.url), "utf8")).cases;
  const run = (files, content = "export const pure = true;", base = "") => detect({
    files, config, sha: "a".repeat(40), readHeadFile: async () => content, readBaseFile: async () => base,
  });
  it.each(fixtures)("$name", async (fixture) => {
    const result = await run([{ filename: fixture.path, status: "added" }], fixture.content);
    expect(result.door).toBe(fixture.door);
    if (fixture.expected_class) expect(result.classes).toContain(fixture.expected_class);
    if (fixture.code) expect(result.door_reasons.map((reason) => reason.code)).toContain(fixture.code);
    expect(result.status).toBe("ok");
  });
  it("includes the door and reason codes in the existing summary", async () => {
    const result = await run([modified("worker/src/dispatchLogic.ts")]);
    expect(formatSummary(result)).toContain("Door (report only): revertable");
  });
  it("caps content scans and fails closed past the cap instead of reading more", async () => {
    let reads = 0;
    const files = Array.from({ length: 201 }, (_, index) => modified(`worker/src/dispatchLogic${index}.ts`));
    const result = await detect({
      files, config, sha: "a".repeat(40),
      readHeadFile: async () => (reads += 1, "export const pure = true;"), readBaseFile: async () => "export const pure = true;",
    });
    expect(result.door).toBe("one-way");
    expect(result.door_reasons.map((reason) => reason.code)).toContain("door_scan_cap");
    expect(reads).toBe(200);
  });
  const withoutDoor = ({door: _door, door_reasons: _reasons, ...legacy}) => legacy;
  it.each([
    ["input length", "x".repeat(256 * 1024 + 1)],
    ["UTF-8 bytes", "é".repeat(128 * 1024 + 1)],
  ])("fails closed at the per-file %s cap without changing legacy fields", async (_, content) => {
    const files = [modified("worker/src/dispatchLogic.ts")];
    const baseline = await run(files);
    const result = await run(files, content);
    expect(result.door).toBe("one-way");
    expect(result.door_reasons.map((reason) => reason.code)).toContain("door_scan_budget");
    expect(withoutDoor(result)).toEqual(withoutDoor(baseline));
  });
  it("counts both head and base bytes against one total budget", async () => {
    const files = Array.from({length: 9}, (_, index) => modified("worker/src/dispatchLogic" + index + ".ts"));
    const baseline = await run(files);
    let reads = 0;
    const result = await detect({
      files, config, sha: "a".repeat(40),
      readHeadFile: async () => (reads++, "x".repeat(256 * 1024)),
      readBaseFile: async () => (reads++, "x".repeat(256 * 1024)),
    });
    expect(result.door).toBe("one-way");
    expect(result.door_reasons.map((reason) => reason.code)).toContain("door_scan_budget");
    expect(reads).toBe(17);
    expect(withoutDoor(result)).toEqual(withoutDoor(baseline));
  });
  it.each(["before files", "between patterns"])("checks the total deadline %s", async (boundary) => {
    const baseline = await run([modified("worker/src/dispatchLogic.ts")]);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const timedConfig = {...config, door: structuredClone(config.door)};
    try {
      if (boundary === "between patterns") {
        timedConfig.door.rules[0].patterns[0] = "door_deadline_probe";
        const originalTest = RegExp.prototype.test;
        vi.spyOn(RegExp.prototype, "test").mockImplementation(function (text) {
          const matched = originalTest.call(this, text);
          if (this.source === "door_deadline_probe") elapsed = 1001;
          return matched;
        });
      } else clock.mockReturnValueOnce(0).mockReturnValue(1001);
      const result = await doorTier(baseline, {
        config: timedConfig, readHeadFile: async () => "", readBaseFile: async () => "",
      });
      expect(result.door).toBe("one-way");
      expect(result.door_reasons.map((reason) => reason.code)).toContain("door_scan_budget");
      expect(withoutDoor(result)).toEqual(withoutDoor(baseline));
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("bounds a stalled read by the total deadline", async () => {
    const baseline = await run([modified("worker/src/dispatchLogic.ts")]);
    const start = performance.now();
    const result = await doorTier(baseline, {
      config, readHeadFile: () => new Promise(() => {}), readBaseFile: async () => "",
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.door_reasons.map((reason) => reason.code)).toContain("door_scan_budget");
    expect(result.door).toBe("one-way");
    expect(withoutDoor(result)).toEqual(withoutDoor(baseline));
  });
  it.each([
    ["blank lines before a timestamp", "\n".repeat(200_000) + "// migration: 20261027000000", "", "O-MIGDIR"],
    ["blank lines without a timestamp", "\n".repeat(200_000) + "pure code", "", null],
    ["unclosed comment starts", "/* ".repeat(50_000), "", null],
    ["removed blank lines before a job", "", "\n".repeat(200_000) + "name: ci", "O-GATE"],
  ])("%s completes under two seconds", async (_, content, base, code) => {
    const start = performance.now();
    const result = await run([modified("worker/src/dispatchLogic.ts")], content, base);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.door_reasons.map((reason) => reason.code)).not.toContain("door_scan_budget");
    expect(result.door).toBe(code ? "one-way" : "revertable");
    if (code) expect(result.door_reasons.map((reason) => reason.code)).toContain(code);
  });
  it.each([
    [" \t// migration: 20261027000000_example", "O-MIGDIR"],
    ["20261027000000", "O-MIGDIR"],
    ["const timestamp = 20261027000000;", null],
    ["// migration: 2026102700000", null],
    ["CREATE /* spacer */ POLICY p ON t", "O-SQL"],
    ["CREATE /* first */ /* second */ TABLE t (id int)", "O-SQL"],
    ["CREATE /* unclosed POLICY p ON t", null],
    ["CREATE /* spacer */ ordinary text", null],
  ])("preserves normal content classification for %s", async (content, code) => {
    const result = await run([modified("worker/src/dispatchLogic.ts")], content);
    expect(result.door).toBe(code ? "one-way" : "revertable");
    if (code) expect(result.door_reasons.map((reason) => reason.code)).toContain(code);
  });
  it("any one-way file dominates docs and revertable logic", async () => {
    expect((await run([modified("docs/notes.md"), modified("worker/src/dispatchLogic.ts"), modified("supabase/migrations/example.sql")])).door).toBe("one-way");
  });
  it("counts a migration renamed outside its directory and sensitive deletions", async () => {
    for (const file of [
      { filename: "docs/old.md", previous_filename: "supabase/migrations/20261027000000_example.sql", status: "renamed" },
      { filename: "worker/src/providerParser.ts", status: "removed" },
    ]) {
      const result = await run([file]);
      expect(result.door).toBe("one-way");
      expect(result.door_reasons.map((reason) => reason.code)).toContain("O-RM");
    }
  });
  it("renaming between a provider and safe category fails closed", async () => {
    const result = await run([{ filename: "docs/parser.md", previous_filename: "worker/src/providerParser.ts", status: "renamed" }]);
    expect(result.door_reasons.map((reason) => reason.code)).toContain("rename_mixed_doors");
  });
  it("deleting a test, workflow job or required section is one-way", async () => {
    expect((await run([{filename: "e2e/example.test.ts", status: "removed"}])).door).toBe("one-way");
    for (const base of ["name: ci", "test('checks', () => {});", 'const REQUIRED_SECTIONS = ["Summary"];']) {
      const result = await run([modified("scripts/example.mjs")], "", base);
      expect(result.door_reasons.map((reason) => reason.code)).toContain("O-GATE");
    }
  });
  it("ignores an existing literal RPC name and existing secret name", async () => {
    const base = 'db.rpc("existing"); const name = process.env.EXAMPLE;';
    const result = await run([modified("worker/src/providerParser.ts")], base + "\nconst pure = true;", base);
    expect(result.door).toBe("revertable");
  });
  it("a base string mentioning a new RPC name cannot exempt a new call", async () => {
    const result = await run([modified("worker/src/providerParser.ts")], 'db.rpc("new_function")', 'const unrelated = "new_function";');
    expect(result.door_reasons.map((reason) => reason.code)).toContain("O-SQL");
  });
  it("fails closed on stale SHA, partial coverage, errors, throws and timeouts without changing old fields", async () => {
    const result = await run([modified("worker/src/dispatchLogic.ts")]);
    const reads = { readHeadFile: async () => "", readBaseFile: async () => "", config };
    for (const [value, options] of [
      [{...result, status:"error"}, reads], [result, {...reads, headSha:"b".repeat(40)}],
      [result, {...reads, changedFiles:2}], [result, {...reads, files:[]}],
      [result, {...reads, config:{}}], [result, {...reads, readHeadFile:async () => {throw new Error("unreadable");}}],
      [result, {...reads, readHeadFile:() => new Promise(() => {}), timeoutMs:1}],
    ]) {
      const output = await doorTier(value, options);
      expect(output.door).toBe("one-way");
      expect(output.door_reasons.map((reason) => reason.code)).toContain("classifier_error");
      const withoutDoor = ({door: _door, door_reasons: _reasons, ...legacy}) => legacy;
      expect(withoutDoor(output)).toEqual(withoutDoor(value));
    }
  });
  it("removed sensitive globs and door rule changes remain gate loosening", () => {
    const head = structuredClone(rawConfig);
    head.door.classes.infra_ci = "revertable";
    expect(detectGateLoosening({baseRaw:rawConfig,headRaw:head,gateFiles:[{path:CONFIG_REPO_PATH,status:"modified"}]}).reasons.map((reason) => reason.kind)).toContain("door_changed");
  });
});
