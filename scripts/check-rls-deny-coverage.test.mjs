// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  baselineGrowth,
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

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** Build a two-commit repo: _base, then _base overlaid with <fixture>/head. */
function fixtureRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), "rls-deny-"));
  temps.push(dir);
  git(dir, "init", "-q");
  cpSync(join(fixtures, "_base"), dir, { recursive: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  cpSync(join(fixtures, name, "head"), dir, { recursive: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
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

  it("ignores policy text inside $$ / $tag$ bodies, strings and comments", () => {
    const { report } = diffFixture("function-body-ignored", ["--enforce"]);
    expect(report).toMatchObject({ ok: true, checked: [], findings: [] });
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

  it("the committed baseline covers the current tree with no stale entries", () => {
    const result = evaluateAll(loadAllInputs(repoRoot));
    expect(result.findings).toEqual([]);
    expect(result.staleBaselineEntries).toEqual([]);
    expect(JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8")).entries).toEqual(result.baseline.entries);
  });

  it("fixtures live outside supabase/ so pgTAP and migration tooling never read them", () => {
    expect(relative(repoRoot, fixtures).split("/")[0]).toBe("scripts");
  });
});
