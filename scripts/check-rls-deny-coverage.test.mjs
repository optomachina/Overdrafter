// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  CHECKER_PATH,
  GATE_LOOSENING_LINE,
  baselineGrowth,
  checkerWorkflowSurface,
  detectGateLoosening,
  dynamicSqlWarnings,
  entryKey,
  evaluateAll,
  evaluateDiff,
  hasDenyAssertion,
  loadAllInputs,
  parseDenyTags,
  parseRlsOperations,
  run,
  splitSqlStatements,
} from "./check-rls-deny-coverage.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtures = join(repoRoot, "scripts/fixtures/rls-deny");
const temps = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * Fixtures keep migrations/ and tests/ at their root, not under supabase/, so
 * no fixture path contains supabase/migrations/ (the migration guardrails
 * match that anywhere). copyFixture maps them back into a repo layout.
 */
const FIXTURE_DIRS = { migrations: "supabase/migrations", tests: "supabase/tests" };
function copyFixture(src, dir) {
  for (const name of readdirSync(src)) cpSync(join(src, name), join(dir, FIXTURE_DIRS[name] ?? name), { recursive: true });
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** Build a two-commit repo: _base, then _base overlaid with <fixture>/head. */
function fixtureRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), "rls-deny-"));
  temps.push(dir);
  git(dir, "init", "-q");
  copyFixture(join(fixtures, "_base"), dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  copyFixture(join(fixtures, name, "head"), dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
  return dir;
}

/** Two-commit repo from _base: base gets baseFiles, head gets headFiles (null deletes). */
function overlayRepo(baseFiles, headFiles) {
  const dir = mkdtempSync(join(tmpdir(), "rls-deny-"));
  temps.push(dir);
  git(dir, "init", "-q");
  copyFixture(join(fixtures, "_base"), dir);
  const apply = (files) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      if (content == null) { rmSync(full, { force: true }); continue; }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    git(dir, "add", "-A");
  };
  apply(baseFiles);
  git(dir, "commit", "-qm", "base");
  apply(headFiles);
  git(dir, "commit", "-qm", "head", "--allow-empty");
  return dir;
}

function runCli(args) {
  let out = "";
  let err = "";
  const code = run(args, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

function diffFixture(name, extra = []) {
  const { code, out } = runCli(["--root", fixtureRepo(name), "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--json", ...extra]);
  return { code, report: JSON.parse(out) };
}

const missing = (report) => report.findings.filter((f) => f.kind === "missing_deny_case").map((f) => `${f.table}#${f.policy ?? ""}:${f.case}`).sort();

describe("RLS deny coverage fixtures (diff mode)", () => {
  it("passes a new policy whose test carries all three deny tags", () => {
    const { code, report } = diffFixture("new-policy-covered", ["--enforce"]);
    expect(report.ok).toBe(true);
    expect(code).toBe(0);
    expect(report.checked.map((c) => `${c.table}#${c.policy ?? ""}`).sort()).toEqual(["public.widgets#", "public.widgets#widgets_select_own"]);
    expect(report.tagProblems).toEqual([]);
  });

  it.each([
    ["missing-anon", "anon"],
    ["missing-other-user", "other_user"],
    ["missing-role-boundary", "role_boundary"],
  ])("%s fails with a %s message", (name, kase) => {
    const { report } = diffFixture(name);
    expect(report.ok).toBe(false);
    expect(missing(report)).toEqual([`public.widgets#:${kase}`, `public.widgets#widgets_select_own:${kase}`]);
    for (const finding of report.findings) {
      expect(finding.message).toContain(`missing deny case "${kase}"`);
      expect(finding.message).toContain(`-- deny: ${kase} public.widgets`);
    }
  });

  it("fails a changed baseline policy that has no tagged tests", () => {
    const { report } = diffFixture("changed-baseline-policy");
    expect(missing(report)).toEqual([
      "public.legacy_items#legacy_items_select_own:anon",
      "public.legacy_items#legacy_items_select_own:other_user",
      "public.legacy_items#legacy_items_select_own:role_boundary",
    ]);
  });

  it("passes when baseline policies are left unchanged", () => {
    const { report } = diffFixture("unchanged-baseline-policy", ["--enforce"]);
    expect(report).toMatchObject({ ok: true, checked: [], findings: [] });
  });

  it("always fails DISABLE ROW LEVEL SECURITY and names Blaine", () => {
    const { code, report } = diffFixture("disable-rls", ["--enforce"]);
    expect(code).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "rls_disabled", table: "public.legacy_items" });
    expect(report.findings[0].message).toContain("needs Blaine");
  });

  it("ignores policy text inside $$ / $tag$ bodies, strings and comments, but warns on the bodies", () => {
    const { code, report } = diffFixture("function-body-ignored", ["--enforce"]);
    expect(report).toMatchObject({ ok: true, checked: [], findings: [] });
    expect(code).toBe(0);
    const file = "supabase/migrations/20260201000000_policy_text_in_bodies.sql";
    expect(report.sqlWarnings).toEqual([
      expect.objectContaining({ kind: "dynamic_rls_disable", file, line: 8 }),
      expect.objectContaining({ kind: "dynamic_rls_disable", file, line: 18 }),
    ]);
  });

  it("fails when the PR baseline adds entries over the base baseline", () => {
    const { report } = diffFixture("baseline-growth");
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([expect.objectContaining({ kind: "baseline_growth", table: "public.sneaky_items", policy: "sneaky_items_select_all" })]);
    expect(report.findings[0].message).toContain("can only shrink");
  });

  it("report mode exits 0 on findings; --enforce exits 1; --json-out writes JSON", () => {
    const dir = fixtureRepo("missing-anon");
    const jsonOut = join(dir, "report.json");
    const report = runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--json-out", jsonOut]);
    expect(report.code).toBe(0);
    expect(report.out).toContain('FAIL public.widgets policy "widgets_select_own"');
    expect(report.out).toContain("Report mode");
    expect(JSON.parse(readFileSync(jsonOut, "utf8"))).toMatchObject({ schema: "ovd847.rls-deny-coverage.v1", mode: "diff", ok: false });
    expect(runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--enforce"]).code).toBe(1);
    expect(runCli(["--bogus"]).code).toBe(2);
  });
});

describe("SQL tokenizer", () => {
  it("parses quoted, unqualified and multi-action statements", () => {
    const ops = parseRlsOperations(`
      CREATE POLICY "Users can read" ON storage.objects FOR SELECT USING (true);
      create policy plain on widgets using (true);
      drop policy if exists "x""y" on "Public"."Odd";
      alter policy plain on public.widgets rename to renamed;
      alter policy renamed on public.widgets using (false);
      alter table if exists only private.t enable row level security, force row level security;
      alter table private.t no force row level security;
    `, "m.sql");
    expect(ops.map(({ op, table, policy, newPolicy }) => [op, table, policy, newPolicy])).toEqual([
      ["create", "storage.objects", "Users can read", undefined],
      ["create", "public.widgets", "plain", undefined],
      ["drop", "Public.Odd", 'x"y', undefined],
      ["rename", "public.widgets", "plain", "renamed"],
      ["alter", "public.widgets", "renamed", undefined],
      ["enable_rls", "private.t", null, undefined],
      ["force_rls", "private.t", null, undefined],
      ["no_force_rls", "private.t", null, undefined],
    ]);
  });

  it("does not split inside strings, E-strings, nested comments or dollar bodies", () => {
    const statements = splitSqlStatements(`select 'a;b', E'c\\';d'; /* x /* y; */ z; */ select $f$ ; $f$; select $1;`);
    expect(statements).toEqual(["select '', E''", "select $$ $$", "select $1"]);
  });
});

describe("dynamic SQL warnings", () => {
  it("warns on RLS / policy SQL inside dollar bodies and singles out dynamic disables", () => {
    const warnings = dynamicSqlWarnings([
      "do $$ begin execute format('create policy p on %I using (true)', 't'); end $$;",
      "do $do$ begin",
      "  execute 'alter table public.t disable row level security';",
      "end $do$;",
      "do $$ begin execute 'alter table public.t no force row level security'; end $$;",
      "create function f() returns int language sql as $$ select 1 $$;",
      "-- alter table public.t disable row level security",
      "select 'drop policy x on public.t';",
    ].join("\n"), "m.sql");
    expect(warnings.map(({ kind, line }) => [kind, line])).toEqual([
      ["dynamic_rls_sql", 1],
      ["dynamic_rls_disable", 2],
      ["dynamic_rls_disable", 5],
    ]);
    expect(warnings[1].message).toContain("m.sql:2: a $$ body disables row level security dynamically");
  });

  it("prints sql warnings in the human report without failing it", () => {
    const { code, out } = runCli(["--root", fixtureRepo("function-body-ignored"), "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--enforce"]);
    expect(code).toBe(0);
    expect(out).toContain("WARN supabase/migrations/20260201000000_policy_text_in_bodies.sql:8: a $$ body disables row level security dynamically");
  });
});

describe("deny tags", () => {
  it("recognises throws / is_empty / zero-row results_eq assertions", () => {
    expect(hasDenyAssertion("select throws_ok($$x$$, '42501');")).toBe(true);
    expect(hasDenyAssertion("select is_empty($$select 1$$);")).toBe(true);
    expect(hasDenyAssertion("select is((select count(*) from t), 0::bigint, 'none');")).toBe(true);
    expect(hasDenyAssertion("select results_eq($$select count(*) from t$$, $$values (0)$$);")).toBe(true);
    expect(hasDenyAssertion("select ok(true);")).toBe(false);
    expect(hasDenyAssertion("select is((select count(*) from t), 3, 'some');")).toBe(false);
    expect(hasDenyAssertion("-- select throws_ok($$x$$);\nselect ok(true);")).toBe(false);
  });

  it("reports a tag line with trailing text as malformed, and it ends the previous block", () => {
    const { coverage, problems } = parseDenyTags([
      "-- deny: anon public.t (owner)",
      "select throws_ok($$select * from public.t$$, '42501');",
      "-- deny: other_user public.t",
      "-- DENY: role_boundary",
      "select throws_ok($$select * from public.t$$, '42501');",
    ].join("\n"), "t.sql");
    expect(coverage.size).toBe(0);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('t.sql:1: malformed deny tag "-- deny: anon public.t (owner)"'),
      expect.stringContaining('t.sql:3: "-- deny: other_user public.t" block has no'),
      expect.stringContaining('t.sql:4: malformed deny tag "-- DENY: role_boundary"'),
    ]);
  });

  it("shares one block across stacked tags and reports malformed tags", () => {
    const { coverage, problems } = parseDenyTags([
      "-- deny: anon public.a",
      "-- deny: anon public.b",
      "select throws_ok($$select * from public.a join public.b using (id)$$, '42501');",
      "-- deny: other_user public.a",
      "select ok(true);",
      "-- deny: admin public.a",
      "-- deny: role_boundary unqualified",
      "-- deny: role_boundary public.never_mentioned",
      "select throws_ok($$select 1$$);",
    ].join("\n"), "t.sql");
    expect([...coverage].map(([t, c]) => [t, [...c]])).toEqual([["public.a", ["anon"]], ["public.b", ["anon"]]]);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("t.sql:4: \"-- deny: other_user public.a\" block has no"),
      expect.stringContaining('t.sql:6: unknown deny case "admin"'),
      expect.stringContaining("t.sql:7: deny tag table must be schema-qualified"),
      expect.stringContaining("t.sql:8: deny tag names public.never_mentioned but the file's SQL never references it"),
    ]);
  });
});

describe("baseline", () => {
  it("full-tree mode uses the baseline, flags uncovered additions and stale entries", () => {
    const migrations = [
      { path: "supabase/migrations/1.sql", content: "create policy p on public.a using (true); create policy q on public.b using (true);" },
      { path: "supabase/migrations/2.sql", content: "drop policy q on public.b;" },
    ];
    const baseline = { entries: [{ table: "public.a", policy: "p" }, { table: "public.gone", policy: "x" }] };
    const clean = evaluateAll({ migrations, testFiles: [], baseline });
    expect(clean).toMatchObject({ ok: true, stats: { policies: 1, covered: 0, baselined: 1 } });
    expect(clean.staleBaselineEntries).toEqual([{ table: "public.gone", policy: "x" }]);
    const added = evaluateAll({ migrations: [...migrations, { path: "supabase/migrations/3.sql", content: "create policy r on public.c using (true);" }], testFiles: [], baseline });
    expect(added.findings.map((f) => `${f.table}:${f.case}`)).toEqual(["public.c:anon", "public.c:other_user", "public.c:role_boundary"]);
  });

  it("growth is relative to the base baseline and skipped when the base has none", () => {
    const head = { entries: [{ table: "public.a", policy: "p" }] };
    expect(baselineGrowth({ entries: [] }, head)).toHaveLength(1);
    expect(baselineGrowth({ entries: head.entries }, head)).toEqual([]);
    expect(baselineGrowth(null, head)).toEqual([]);
    expect(evaluateDiff({ changedMigrations: [], testFiles: [], baseBaseline: { entries: [] }, headBaseline: head }).ok).toBe(false);
  });

  // Only stale / subset checks here: a new uncovered policy is a report-only
  // finding from the CI job, never a vitest failure (which would push authors
  // to grow the baseline with --write-baseline).
  it("the committed baseline has no stale entries (it lists only uncovered, existing entries)", () => {
    const result = evaluateAll(loadAllInputs(repoRoot));
    expect(result.staleBaselineEntries).toEqual([]);
    const uncovered = new Set(result.baseline.entries.map(entryKey));
    const committed = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8")).entries;
    expect(committed.filter((entry) => !uncovered.has(entryKey(entry)))).toEqual([]);
  });

  it("does not fail vitest on a new uncovered policy: it is a report-only finding", () => {
    const inputs = loadAllInputs(repoRoot);
    const result = evaluateAll({ ...inputs, migrations: [...inputs.migrations, { path: "supabase/migrations/99999999999999_new.sql", content: "create policy p on public.brand_new using (true);" }] });
    expect(result.staleBaselineEntries).toEqual([]);
    expect(result.findings.filter((f) => f.table === "public.brand_new")).toHaveLength(3);
  });

  it("fixtures live outside supabase/ and no fixture path contains supabase/migrations/", () => {
    expect(relative(repoRoot, fixtures).split("/")[0]).toBe("scripts");
    const paths = execFileSync("git", ["ls-files", "--", relative(repoRoot, fixtures)], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => /supabase\/+migrations(\/|$)/i.test(path))).toEqual([]);
  });
});

describe("gate_loosening (base-to-head)", () => {
  const baseBaseline = JSON.parse(readFileSync(join(fixtures, "_base", BASELINE_PATH), "utf8"));
  const withEntries = (entries) => `${JSON.stringify({ ...baseBaseline, entries }, null, 2)}\n`;
  const diffRepo = (dir, extra = []) => {
    const { code, out } = runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--json", ...extra]);
    return { code, report: JSON.parse(out) };
  };
  const workflow = (step) => [
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "  rls-deny-coverage:",
    "    continue-on-error: true",
    "    steps:",
    `      - run: ${step}`,
    "  # next job",
    "  ci:",
    "    needs:",
    "      - lint",
    "",
  ].join("\n");

  it("detects baseline growth vs the base with a reason, without changing ok or exit code beyond baseline_growth", () => {
    const { code, report } = diffFixture("baseline-growth", ["--enforce"]);
    expect(report.gate_loosening).toEqual({
      detected: true,
      reasons: [expect.objectContaining({ kind: "baseline_entry_added", path: BASELINE_PATH, table: "public.sneaky_items", policy: "sneaky_items_select_all" })],
      requires: ["grokbot_countersign", "blaine_card"],
    });
    expect(report.findings.map((f) => f.kind)).toEqual(["baseline_growth"]);
    expect(code).toBe(1);
  });

  it("does not detect a shrinking baseline", () => {
    const { report } = diffRepo(overlayRepo({}, { [BASELINE_PATH]: withEntries(baseBaseline.entries.slice(1)) }), ["--enforce"]);
    expect(report.ok).toBe(true);
    expect(report.gate_loosening).toEqual({ detected: false, reasons: [], requires: ["grokbot_countersign", "blaine_card"] });
  });

  it("does not detect an unchanged baseline", () => {
    const { report } = diffFixture("unchanged-baseline-policy");
    expect(report.gate_loosening.detected).toBe(false);
    expect(report.gate_loosening.reasons).toEqual([]);
  });

  it("detects an edited checker script, reports only, and prints the human line", () => {
    const dir = overlayRepo({ [CHECKER_PATH]: "// base checker\n" }, { [CHECKER_PATH]: "// relaxed checker\n" });
    const { code, report } = diffRepo(dir, ["--enforce"]);
    expect(report.ok).toBe(true);
    expect(code).toBe(0);
    expect(report.gate_loosening.detected).toBe(true);
    expect(report.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "checker_changed", path: CHECKER_PATH })]);
    const human = runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD"]);
    expect(human.out).toContain(GATE_LOOSENING_LINE);
    expect(human.out).toContain("GATE LOOSENING: needs Grok Bot countersign + Blaine's card");
    expect(human.out).toContain(CHECKER_PATH);
  });

  it("detects a removed checker but not one the base never had", () => {
    expect(diffRepo(overlayRepo({ [CHECKER_PATH]: "// base\n" }, { [CHECKER_PATH]: null })).report.gate_loosening.reasons)
      .toEqual([expect.objectContaining({ kind: "checker_removed" })]);
    expect(diffRepo(overlayRepo({}, { [CHECKER_PATH]: "// new\n" })).report.gate_loosening.detected).toBe(false);
  });

  it("detects changes to the CI job and its references, ignoring unrelated workflow edits", () => {
    const path = ".github/workflows/ci.yml";
    const base = workflow("node checker --base-ref HEAD^1");
    const reasons = (head) => diffRepo(overlayRepo({ [path]: base }, { [path]: head })).report.gate_loosening.reasons.map((r) => r.kind);
    expect(reasons(base.replace("node checker --base-ref HEAD^1", "node checker --base-ref HEAD"))).toEqual(["ci_job_changed"]);
    expect(reasons(base.replace("      - lint\n", "      - lint\n      - rls-deny-coverage\n"))).toEqual(["ci_job_changed"]);
    expect(reasons(base.replace(/ {2}rls-deny-coverage:[\s\S]*?(?= {2}# next job)/, ""))).toEqual(["ci_job_removed"]);
    expect(reasons(base.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-24.04").replace("# next job", "# the next job"))).toEqual([]);
    expect(diffRepo(overlayRepo({}, { [path]: base })).report.gate_loosening.detected).toBe(false);
  });

  it("flags widened and unreadable baselines", () => {
    const entry = { table: "public.a", policy: "p" };
    expect(detectGateLoosening({ baseBaseline: { entries: [entry] }, headBaseline: { entries: [{ ...entry, missing: ["anon", "other_user"] }] } }).reasons)
      .toEqual([expect.objectContaining({ kind: "baseline_entry_widened", table: "public.a", policy: "p" })]);
    expect(detectGateLoosening({ baseBaseline: { entries: [entry] }, headBaseline: { entries: [{ policy: "p", table: "public.a" }] } }).detected).toBe(false);
    expect(detectGateLoosening({ baseBaseline: null, headBaseline: { entries: [entry] } }).detected).toBe(false);
    const { report } = diffRepo(overlayRepo({}, { [BASELINE_PATH]: "{\"schema\":\"nope\"}\n" }));
    expect(report.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "baseline_unreadable", ref: "head" })]);
  });

  it("reports a malformed base baseline as baseline_unreadable instead of crashing", () => {
    const dir = overlayRepo({ [BASELINE_PATH]: "{ not json\n" }, { [BASELINE_PATH]: withEntries(baseBaseline.entries) });
    const { code, report } = diffRepo(dir, ["--enforce"]);
    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "baseline_unreadable", ref: "base", path: BASELINE_PATH })]);
    expect(runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD"]).out).toContain(GATE_LOOSENING_LINE);
  });

  it("finds the committed CI job surface", () => {
    const surface = checkerWorkflowSurface(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
    expect(surface.job).toMatch(/^ {2}rls-deny-coverage:\n/);
    expect(surface.job).toContain(CHECKER_PATH);
    expect(surface.job).not.toContain("verify-worker");
  });
});
