// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  formatSummary,
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
    const nextRule = rawConfig.sql_content.rules.length;
    badRule.sql_content.rules.push({ id: "nope_rule", class: "nope", tokens: ["x"], reason: "x" });
    expect(compileConfig(badRule).errors).toContain(`sql_content.rules[${nextRule}]: unknown class "nope"`);
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

  it("does not read a docs .md file outside the SQL paths", async () => {
    const read = [];
    const result = await detect({
      files: [modified("docs/database-notes.md")],
      readHeadFile: async (file) => (read.push(file), "ALTER ROLE x BYPASSRLS; SET row_security = off;"),
      config,
    });
    expect(read).toEqual([]);
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
    expect(result.hits).toEqual([{ id: "auth_set_local_role", class: "auth", path: file, line: 1, sensitive: true, target: "authenticated" }]);
  });

  it.each([
    ["set local role service_role;", "auth_set_local_role", "service_role"],
    ["SET ROLE postgres;", "auth_set_role", "postgres"],
    ["set role to supabase_admin;", "auth_set_role", "supabase_admin"],
    ["set session role = authenticator;", "auth_set_session_role", "authenticator"],
    ["set local role app_writer;", "auth_set_local_role", "app_writer"],
    ["set session authorization postgres;", "auth_set_session_authorization", "postgres"],
    ["do $$ begin execute 'set local role service_role'; end $$;", "auth_set_local_role", "service_role"],
  ])("supabase/tests keeps a privileged switch sensitive: %s", (text, id, target) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.reasons).toContain(reasonFor(id));
    expect(result.hits).toContainEqual(expect.objectContaining({ id, target, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
  });

  it.each([
    ["set local role authenticated;", "auth_set_local_role", "tests_set_role_unprivileged"],
    ["set local role anon;", "auth_set_local_role", "tests_set_role_unprivileged"],
    ["SET ROLE \"authenticated\";", "auth_set_role", "tests_set_role_unprivileged"],
    ["set role to 'anon';", "auth_set_role", "tests_set_role_unprivileged"],
    ["reset role;", "auth_reset_role", "tests_reset_role"],
  ])("supabase/tests exempts %s as gate_loosening", (text, id, exemption) => {
    const result = sql(text, "supabase/tests/rls_x.test.sql");
    expect(result.classes).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ id, path: "supabase/tests/rls_x.test.sql", line: 1, sensitive: false, exemption, gate_loosening: true })]);
  });

  it("keeps a privileged switch sensitive next to exempt ones in the same test file", () => {
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
    ['set local role "Anon";', "anon"],
    ['SET ROLE "AUTHENTICATED";', "authenticated"],
    ["set role 'Anon';", "anon"],
    ["do $$ begin execute 'set local role anon' || 'x'; end $$;", "anon"],
    ["do $$ begin execute 'set local role anon' || '_x'; end $$;", "anon"],
    ["set local role anon, service_role;", "anon"],
    ["set local role authenticated x;", "authenticated"],
  ])("supabase/tests exempts only an exact anon/authenticated target: %s", (text, target) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual(["auth"]);
    expect(result.hits).toContainEqual(expect.objectContaining({ target, sensitive: true }));
    expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
  });

  it.each([
    ["SET LOCAL ROLE ANON;"],
    ["set local role Authenticated"],
    ['set local role "anon";'],
    ["do $$ begin execute 'set local role anon'; end $$;"],
    ["do $$ begin execute format('set local role authenticated'); end $$;"],
    ["do $$ begin set local role anon; end $$;"],
  ])("supabase/tests still exempts an exact target: %s", (text) => {
    const result = sql(text, "supabase/tests/x.sql");
    expect(result.classes).toEqual([]);
    expect(result.hits).toEqual([expect.objectContaining({ sensitive: false, exemption: "tests_set_role_unprivileged", gate_loosening: true })]);
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
      const result = sql("set local role anon;\nreset role;", file);
      expect(result.classes).toEqual(["auth"]);
      expect(result.hits.some((hit) => hit.gate_loosening)).toBe(false);
    },
  );
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

  it("scopes the SET ROLE exemption to supabase/tests and the anon and authenticated targets", () => {
    const entry = rawConfig.sql_content.exemptions.find((candidate) => candidate.id === "tests_set_role_unprivileged");
    expect(entry).toMatchObject({ paths: ["supabase/tests/**"], targets: ["anon", "authenticated"], gate_loosening: true });
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
    expect(tests.classes).toEqual(["auth"]);
    expect(tests.sql_hits.map(({ id, path: file, line, sensitive }) => [id, file, line, sensitive])).toEqual([
      ["auth_set_local_role", "supabase/tests/roles.sql", 2, false],
      ["auth_reset_role", "supabase/tests/roles.sql", 3, false],
      ["auth_set_role", "supabase/tests/roles.sql", 4, true],
    ]);
    expect(migration.classes).toEqual(["migration", "auth"]);
    expect(migration.sql_hits).toEqual([
      expect.objectContaining({ id: "auth_role_nosuperuser", line: 1, informational: true, sensitive: false }),
      expect.objectContaining({ id: "auth_set_local_role", line: 2, sensitive: true, target: "authenticated" }),
    ]);
    expect(result.gate_loosening).toEqual([
      expect.objectContaining({ id: "auth_set_local_role", path: "supabase/tests/roles.sql", line: 2, exemption: "tests_set_role_unprivileged", gate_loosening: true }),
      expect.objectContaining({ id: "auth_reset_role", path: "supabase/tests/roles.sql", line: 3, exemption: "tests_reset_role", gate_loosening: true }),
    ]);
  });

  it("shows hit locations and gate loosening in the job summary", async () => {
    const result = await detect({ files: Object.keys(files).map(modified), readHeadFile, config });
    const summary = formatSummary(result);
    expect(summary).toContain("Gate loosening: 2 SQL hit(s) exempted by tests_set_role_unprivileged, tests_reset_role");
    expect(summary).toContain("| auth_set_local_role | `supabase/tests/roles.sql:2` | auth | exempt (gate_loosening: tests_set_role_unprivileged) |");
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
