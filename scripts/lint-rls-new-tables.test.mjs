import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PATH,
  buildBaseline,
  CHECKER_PATH,
  coveredBy,
  findGateLoosening,
  formatReport,
  GATE_LOOSENING_LINE,
  lintFiles,
  lintSql,
  main,
  parseBaseline,
  parseEscapeHatch,
  RUNNER_PATH,
  serializeBaseline,
} from "./lint-rls-new-tables.mjs";
import { listMigrationFiles } from "./lint-security-definer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, "scripts/fixtures/rls-new-tables");
const fixture = (name) => readFileSync(path.join(fixtureDir, name), "utf8");

// Fixtures live outside supabase/migrations/; map them to a migration name here.
const migrationPath = (name, stamp = "20990101000000") => `supabase/migrations/${stamp}_${name}`;
const migration = (name, stamp) => ({ file: migrationPath(name, stamp), sql: fixture(name) });

function lintFixture(name) {
  return lintSql(fixture(name), migrationPath(name));
}

describe("RLS on new tables lint fixtures", () => {
  it("fails a new table without RLS", () => {
    const { violations } = lintFixture("missing-rls.sql");
    expect(violations).toEqual([
      expect.objectContaining({ table: "public.fixture_no_rls", line: 1, missing: ["enable_rls"] }),
    ]);
    expect(lintFiles({ files: [migration("missing-rls.sql")] }).ok).toBe(false);
  });

  it("passes a new table with RLS enabled in the same file", () => {
    const { tables, violations } = lintFixture("with-rls.sql");
    expect(tables.map((t) => [t.table, t.rlsEnabled])).toEqual([
      ["public.fixture_with_rls", true],
      ["overdrafter.fixture_overdrafter_rls", true],
    ]);
    expect(violations).toEqual([]);
  });

  it("fails a table whose RLS is enabled only in a later file", () => {
    const report = lintFiles({
      files: [migration("create-only.sql", "20990101000000"), migration("later-enable.sql", "20990101000001")],
    });
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        file: migrationPath("create-only.sql", "20990101000000"),
        table: "public.fixture_split",
        missing: ["enable_rls"],
      }),
    ]);
  });

  it("fails an escape hatch without a reason", () => {
    const { violations, escapeHatches } = lintFixture("escape-no-reason.sql");
    expect(violations.map((v) => [v.table, v.missing])).toEqual([
      ["public.fixture_hatch_no_reason", ["enable_rls", "escape_hatch_reason"]],
      ["public.fixture_hatch_empty_reason", ["enable_rls", "escape_hatch_reason"]],
    ]);
    expect(escapeHatches).toEqual([]);
  });

  it("passes an escape hatch with a reason but flags it", () => {
    const file = migration("escape-with-reason.sql");
    const { violations, escapeHatches } = lintSql(file.sql, file.file);
    expect(violations).toEqual([]);
    expect(escapeHatches).toEqual([
      { file: file.file, line: 1, table: "public.fixture_hatch_reason", reason: "lookup table, no rows are user data" },
    ]);

    // In a diff (base copy absent: an added migration) the hatch is gate_loosening.
    const report = lintFiles({
      files: [file],
      baseFiles: [{ file: file.file, sql: null }],
      changedFiles: [{ status: "A", file: file.file }],
      mode: "changed",
      enforce: true,
    });
    expect(report.ok).toBe(true);
    expect(report.gate_loosening).toMatchObject({ detected: true, requires: ["grokbot_countersign", "blaine_card"] });
    expect(report.gate_loosening.reasons).toEqual([
      expect.objectContaining({ code: "escape_hatch_added", file: file.file, line: 1, table: "public.fixture_hatch_reason" }),
    ]);
    const text = formatReport(report);
    expect(text).toContain(GATE_LOOSENING_LINE);
    expect(text).toContain("RLS check skipped by lint-allow: rls-off");
  });

  it("does not flag an escape hatch already in the base copy", () => {
    const file = migration("escape-with-reason.sql");
    const report = lintFiles({ files: [file], baseFiles: [file], mode: "changed" });
    expect(report.gate_loosening.detected).toBe(false);
    expect(report.escapeHatches).toHaveLength(1);
  });

  it("matches quoted, schema-qualified, mixed-case and IF NOT EXISTS names", () => {
    const { tables, violations } = lintFixture("name-forms.sql");
    expect(tables.map((t) => [t.table, t.rlsEnabled])).toEqual([
      ["public.Fixture_Quoted", true],
      ["public.fixture_mixed_case", true],
      ["public.fixture_if_not_exists", true],
      ["public.fixture_unqualified", true],
      ["overdrafter.fixture_quoted_schema", true],
    ]);
    expect(violations).toEqual([]);

    const withoutRls = fixture("name-forms.sql")
      .split("\n")
      .filter((line) => !/^alter table/i.test(line))
      .join("\n");
    expect(lintSql(withoutRls, "x.sql").violations.map((v) => v.table)).toEqual(tables.map((t) => t.table));
  });

  it("does not match a quoted name against a differently cased one", () => {
    const sql = `create table public."Fixture_Case" (id uuid);\nalter table public.fixture_case enable row level security;`;
    expect(lintSql(sql, "x.sql").violations.map((v) => v.table)).toEqual(["public.Fixture_Case"]);
  });

  it("exempts partitions but not the partitioned parent", () => {
    const { tables, violations } = lintFixture("partition.sql");
    expect(tables.map((t) => [t.table, t.exempt])).toEqual([
      ["public.fixture_events", null],
      ["public.fixture_events_2099", "partition"],
      ["public.fixture_partitioned_no_rls", null],
    ]);
    expect(violations.map((v) => v.table)).toEqual(["public.fixture_partitioned_no_rls"]);
  });

  it("exempts temp tables and unlogged tables dropped in the same file", () => {
    const { tables, violations } = lintFixture("temp-unlogged.sql");
    expect(tables.map((t) => [t.table, t.exempt])).toEqual([
      ["pg_temp.fixture_scratch", "schema"],
      ["pg_temp.fixture_scratch_two", "schema"],
      ["public.fixture_staging", "unlogged_dropped"],
      ["public.fixture_unlogged_kept", null],
    ]);
    expect(violations.map((v) => v.table)).toEqual(["public.fixture_unlogged_kept"]);
  });

  it("ignores CREATE TABLE in comments, strings and $$ bodies, and other schemas", () => {
    const { tables, violations } = lintFixture("body-mentions-table.sql");
    expect(tables.map((t) => [t.table, t.exempt])).toEqual([["private.fixture_private", "schema"]]);
    expect(violations).toEqual([]);
  });

  it("fails when RLS is disabled again later in the file", () => {
    const sql = [
      "create table public.t (id uuid);",
      "alter table public.t enable row level security;",
      "alter table public.t disable row level security;",
    ].join("\n");
    expect(lintSql(sql, "x.sql").violations.map((v) => v.missing)).toEqual([["enable_rls"]]);
  });

  it("parses the escape hatch comment", () => {
    expect(parseEscapeHatch(`create table t ( -- lint-allow: rls-off reason="seed data"`)).toMatchObject({ reason: "seed data" });
    expect(parseEscapeHatch("create table t ( -- lint-allow: rls-off")).toMatchObject({ reason: "" });
    expect(parseEscapeHatch("create table t ( -- some other comment")).toBeNull();
  });
});

describe("RLS on new tables baseline", () => {
  const legacy = migration("missing-rls.sql", "20200101000000");
  const baseline = buildBaseline(lintFiles({ files: [legacy] }).violations);

  it("passes a baselined table that is unchanged", () => {
    expect(baseline.entries).toHaveLength(1);
    const report = lintFiles({ files: [legacy], baseline });
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ violations: 1, baselined: 1, failing: 0 });
  });

  it("fails the same table re-created in a new file and an edited CREATE", () => {
    expect(lintFiles({ files: [migration("missing-rls.sql")], baseline }).ok).toBe(false);
    const edited = { ...legacy, sql: legacy.sql.replace("label text not null", "label text") };
    expect(lintFiles({ files: [edited], baseline }).ok).toBe(false);
  });

  it("flags baseline growth as gate loosening and fails the report", () => {
    const grown = buildBaseline(lintFiles({ files: [legacy, migration("create-only.sql")] }).violations);
    const report = lintFiles({ files: [], baseline, baseBaseline: baseline, headBaseline: grown });
    expect(report.ok).toBe(false);
    expect(report.gate_loosening.reasons).toEqual([
      expect.objectContaining({ code: "baseline_entry_added", file: BASELINE_PATH, table: "public.fixture_split" }),
    ]);
    expect(findGateLoosening({ baseBaseline: grown, headBaseline: baseline }).detected).toBe(false);
  });

  it("flags edits to the checker or its portable-node runner, not adding them", () => {
    const { reasons } = findGateLoosening({
      changedFiles: [
        { status: "M", file: RUNNER_PATH },
        { status: "M", file: CHECKER_PATH },
      ],
    });
    expect(reasons.map((r) => [r.code, r.file])).toEqual([
      ["checker_changed", CHECKER_PATH],
      ["checker_changed", RUNNER_PATH],
    ]);
    expect(findGateLoosening({ changedFiles: [{ status: "A", file: CHECKER_PATH }] }).detected).toBe(false);
  });

  it("regenerates the committed baseline byte-identical from the migrations tree", () => {
    const committedText = readFileSync(path.join(repoRoot, BASELINE_PATH), "utf8");
    const committed = parseBaseline(committedText);
    const { violations } = lintFiles({
      files: listMigrationFiles(repoRoot).map((file) => ({ file, sql: readFileSync(path.join(repoRoot, file), "utf8") })),
      mode: "full",
    });
    // Report mode: violations a PR adds are reported by the lint itself, not
    // here, so only the entries the committed baseline covers are regenerated.
    const regenerated = serializeBaseline(buildBaseline(violations.filter((v) => coveredBy(committed, v))));
    expect(regenerated).toBe(committedText);
  });
});

describe("RLS on new tables lint CLI", () => {
  function makeRepo() {
    const root = mkdtempSync(path.join(tmpdir(), "rls-new-tables-lint-"));
    mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "lint@example.invalid");
    git("config", "user.name", "lint");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "supabase/migrations/20200101000000_legacy.sql"), fixture("missing-rls.sql"));
    return { root, git };
  }

  const run = (argv) => {
    const out = [];
    const code = main(argv, { stdout: (line) => out.push(line), stderr: (line) => out.push(line), env: {} });
    return { code, out: out.join("\n") };
  };

  it("writes a deterministic baseline", () => {
    const { root } = makeRepo();
    expect(run(["--all", "--write-baseline", "--root", root]).code).toBe(0);
    const first = readFileSync(path.join(root, BASELINE_PATH), "utf8");
    run(["--all", "--write-baseline", "--root", root]);
    expect(readFileSync(path.join(root, BASELINE_PATH), "utf8")).toBe(first);
    expect(run(["--all", "--root", root, "--enforce"]).code).toBe(0);
  });

  it("reports in --report mode, fails with --enforce, and writes JSON", () => {
    const { root, git } = makeRepo();
    run(["--all", "--write-baseline", "--root", root]);
    git("add", ".");
    git("commit", "-q", "-m", "base");

    const newFile = "supabase/migrations/20990101000000_new.sql";
    writeFileSync(path.join(root, newFile), fixture("create-only.sql"));
    writeFileSync(path.join(root, "changed.txt"), `A\t${newFile}\n`);
    const args = ["--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root];

    const report = run([...args, "--report", "--json-out", "out.json"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain(`${newFile}:1 public.fixture_split: missing ALTER TABLE ... ENABLE ROW LEVEL SECURITY`);
    expect(report.out).toContain("FAIL (report mode, not enforced)");
    const json = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
    expect(json).toMatchObject({ schema: "rls-new-tables-lint.v1", mode: "changed", ok: false, summary: { failing: 1 } });

    expect(run([...args, "--enforce"]).code).toBe(1);
    expect(run([...args, "--enforce", "--report"]).code).toBe(2);
    expect(run(["--all", "--root", root, "--enforce"]).code).toBe(1);
  });

  it("reports an escape hatch added in the diff as gate loosening without failing --enforce", () => {
    const { root, git } = makeRepo();
    run(["--all", "--write-baseline", "--root", root]);
    git("add", ".");
    git("commit", "-q", "-m", "base");

    const newFile = "supabase/migrations/20990101000000_hatch.sql";
    writeFileSync(path.join(root, newFile), fixture("escape-with-reason.sql"));
    writeFileSync(path.join(root, "changed.txt"), `A\t${newFile}\n`);
    const result = run([
      "--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--enforce", "--json-out", "out.json",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${GATE_LOOSENING_LINE} (report only, does not block)`);
    expect(result.out).toContain("gate_loosening escape_hatch_added");
    const json = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
    expect(json).toMatchObject({ ok: true, gate_loosening: { detected: true } });
  });
});
