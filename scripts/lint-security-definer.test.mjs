import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeLintRepo, runLintMain } from "./lint-cli-test-helpers.mjs";
import {
  BASELINE_PATH,
  buildBaseline,
  changedMigrationFiles,
  CHECKER_PATH,
  findBaselineGrowth,
  findGateLoosening,
  findStaleBaselineEntries,
  formatReport,
  GATE_LOOSENING_LINE,
  lintFiles,
  lintSql,
  listMigrationFiles,
  main,
  parseBaseline,
  tokenize,
} from "./lint-security-definer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(repoRoot, "scripts/fixtures/security-definer");
const fixture = (name) => readFileSync(path.join(fixtureDir, name), "utf8");

function lintFixture(name, file = `supabase/migrations/20990101000000_${name}`) {
  return lintSql(fixture(name), file);
}

describe("SECURITY DEFINER lint fixtures", () => {
  it("fails a definer without SET search_path", () => {
    const { violations } = lintFixture("missing-search-path.sql");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ signature: "public.fixture_no_search_path(uuid)", missing: ["search_path"] });
  });

  it("fails search_path = public", () => {
    const { violations } = lintFixture("search-path-public.sql");
    expect(violations).toHaveLength(1);
    expect(violations[0].missing).toEqual(["search_path"]);
    expect(violations[0].problems.search_path).toContain("starts with public");
  });

  it("fails a definer missing REVOKE ... FROM PUBLIC", () => {
    const { violations } = lintFixture("missing-revoke-public.sql");
    expect(violations.map((v) => v.missing)).toEqual([["revoke_public"]]);
  });

  it("fails a definer missing REVOKE ... FROM anon", () => {
    const { violations } = lintFixture("missing-revoke-anon.sql");
    expect(violations.map((v) => v.missing)).toEqual([["revoke_anon"]]);
  });

  it("fails a definer missing an explicit GRANT", () => {
    const { violations } = lintFixture("missing-grant.sql");
    expect(violations.map((v) => v.missing)).toEqual([["grant"]]);
  });

  it("passes fully compliant definers, normalising argument types", () => {
    const { definers, violations } = lintFixture("compliant.sql");
    expect(definers.map((d) => d.signature)).toEqual([
      "public.fixture_compliant(uuid,text)",
      "Private.fixture_pinned_list(timestamp with time zone,integer[])",
      "public.fixture_altered()",
    ]);
    expect(violations).toEqual([]);
  });

  it("ignores SECURITY DEFINER inside comments, strings and $$ bodies", () => {
    const { definers, violations } = lintFixture("body-mentions-definer.sql");
    expect(definers).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("reports file:line and the missing clause", () => {
    const report = lintFiles({ files: [{ file: "x.sql", sql: fixture("missing-revoke-anon.sql") }] });
    expect(report.ok).toBe(false);
    expect(report.violations[0].line).toBe(1);
  });
});

describe("SECURITY DEFINER baseline", () => {
  const legacyFile = "supabase/migrations/20200101000000_legacy.sql";
  const legacy = { file: legacyFile, sql: fixture("baseline-noncompliant.sql") };
  const baseline = buildBaseline(lintFiles({ files: [legacy] }).violations);

  it("passes a baselined function that is unchanged", () => {
    expect(baseline.entries).toHaveLength(1);
    const report = lintFiles({ files: [legacy], baseline });
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ violations: 1, baselined: 1, failing: 0 });
  });

  it("fails the same function re-created non-compliant in a new migration", () => {
    const report = lintFiles({
      files: [{ file: "supabase/migrations/20990101000000_recreate.sql", sql: fixture("recreated-noncompliant.sql") }],
      baseline,
    });
    expect(report.ok).toBe(false);
    expect(report.violations[0]).toMatchObject({ signature: "public.fixture_legacy(uuid)", baselined: false });
  });

  it("fails a baselined function whose definition changed in place", () => {
    const edited = { file: legacyFile, sql: legacy.sql.replace("is not null", "is null") };
    expect(lintFiles({ files: [edited], baseline }).ok).toBe(false);
  });

  it("fails a baselined function that now misses more clauses", () => {
    const narrowed = { ...baseline, entries: [{ ...baseline.entries[0], missing: ["search_path"] }] };
    expect(lintFiles({ files: [legacy], baseline: narrowed }).ok).toBe(false);
  });

  it("fails baseline growth relative to the base commit", () => {
    const added = buildBaseline(
      lintFiles({ files: [legacy, { file: "supabase/migrations/20990101000000_new.sql", sql: fixture("missing-grant.sql") }] })
        .violations,
    );
    const growth = findBaselineGrowth(baseline, added);
    expect(growth.map((entry) => entry.signature)).toEqual(["public.fixture_no_grant(uuid)"]);
    expect(findBaselineGrowth(added, baseline)).toEqual([]);

    const report = lintFiles({ files: [], baseline, baseBaseline: baseline, headBaseline: added });
    expect(report.ok).toBe(false);
    expect(report.summary.baselineGrowth).toBe(1);
  });

  it("committed baseline has no entries beyond what the full tree produces", () => {
    const committed = parseBaseline(readFileSync(path.join(repoRoot, BASELINE_PATH), "utf8"));
    const report = lintFiles({
      files: listMigrationFiles(repoRoot).map((file) => ({ file, sql: readFileSync(path.join(repoRoot, file), "utf8") })),
      mode: "full",
    });
    expect(findStaleBaselineEntries(committed, report.violations)).toEqual([]);
  });
});

describe("SECURITY DEFINER gate loosening", () => {
  const legacyFile = "supabase/migrations/20200101000000_legacy.sql";
  const legacy = { file: legacyFile, sql: fixture("baseline-noncompliant.sql") };
  const newMigration = { file: "supabase/migrations/20990101000000_new.sql", sql: fixture("missing-grant.sql") };
  const base = buildBaseline(lintFiles({ files: [legacy, newMigration] }).violations);
  const requires = ["grokbot_countersign", "blaine_card"];

  it("detects baseline growth vs the base commit with a reason", () => {
    const grown = buildBaseline(
      lintFiles({ files: [legacy, newMigration, { file: "supabase/migrations/20990101000001_x.sql", sql: fixture("missing-revoke-anon.sql") }] })
        .violations,
    );
    const report = lintFiles({ files: [], baseline: base, baseBaseline: base, headBaseline: grown });
    expect(report.gate_loosening).toMatchObject({ detected: true, requires });
    expect(report.gate_loosening.reasons).toEqual([
      expect.objectContaining({
        code: "baseline_entry_added",
        file: BASELINE_PATH,
        signature: "public.fixture_no_revoke_anon(uuid)",
      }),
    ]);
    expect(formatReport(report)).toContain(GATE_LOOSENING_LINE);
  });

  it("detects a widened entry that allows more missing clauses", () => {
    const widened = {
      ...base,
      entries: base.entries.map((entry) =>
        entry.signature === "public.fixture_no_grant(uuid)" ? { ...entry, missing: ["search_path", "grant"] } : entry,
      ),
    };
    const { reasons } = findGateLoosening({ baseBaseline: base, headBaseline: widened });
    expect(reasons).toEqual([
      expect.objectContaining({ code: "baseline_entry_widened", signature: "public.fixture_no_grant(uuid)", missing_added: ["search_path"] }),
    ]);
  });

  it("does not flag a shrinking baseline", () => {
    const shrunk = { ...base, entries: base.entries.slice(1) };
    const report = lintFiles({ files: [], baseline: base, baseBaseline: base, headBaseline: shrunk });
    expect(report.gate_loosening).toEqual({ detected: false, reasons: [], requires });
    expect(formatReport(report)).not.toContain("GATE LOOSENING");
  });

  it("does not flag an unchanged baseline", () => {
    const report = lintFiles({
      files: [],
      baseline: base,
      baseBaseline: base,
      headBaseline: structuredClone(base),
      changedFiles: [{ status: "M", file: "src/unrelated.ts" }],
    });
    expect(report.gate_loosening.detected).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("flags an edited checker script or workflow for review without failing the report", () => {
    const report = lintFiles({
      files: [],
      baseline: base,
      baseBaseline: base,
      headBaseline: base,
      changedFiles: [
        { status: "M", file: CHECKER_PATH },
        { status: "D", file: ".github/workflows/security-definer-lint.yml" },
      ],
      enforce: true,
    });
    expect(report.gate_loosening.detected).toBe(true);
    expect(report.gate_loosening.reasons.map((reason) => [reason.code, reason.file])).toEqual([
      ["checker_changed", ".github/workflows/security-definer-lint.yml"],
      ["checker_changed", CHECKER_PATH],
    ]);
    expect(report.ok).toBe(true);
  });

  it("does not flag adding the checker when the base has no copy", () => {
    const { detected } = findGateLoosening({ changedFiles: [{ status: "A", file: CHECKER_PATH }] });
    expect(detected).toBe(false);
  });
});

describe("SECURITY DEFINER lint parsing", () => {
  it("tokenises dollar bodies, nested comments and quoted identifiers", () => {
    const tokens = tokenize(`/* a /* nested */ b */ select $x$ ; $$ $x$, "Se""mi;", E'it\\'s;' -- tail ;`);
    expect(tokens.map((t) => [t.type, t.value])).toEqual([
      ["word", "select"],
      ["dollar", " ; $$ "],
      ["punct", ","],
      ["ident", 'Se"mi;'],
      ["punct", ","],
      ["string", "it's;"],
    ]);
  });

  it("matches REVOKE lists, unparenthesised names and schema-wide revokes", () => {
    const sql = `
      create function private.a(text) returns void language sql security definer set search_path = '' as $$ $$;
      create function private.b(p_n int) returns void language sql security definer set search_path = '' as $$ $$;
      revoke all on function private.a, private.b(integer) from public;
      revoke execute on all functions in schema private from anon;
      grant execute on function private.a(text), private.b(int4) to service_role;
    `;
    expect(lintSql(sql, "x.sql").violations).toEqual([]);
  });

  it("treats a later GRANT to PUBLIC or anon as re-opening the function", () => {
    const sql = `
      create function public.c() returns void language sql security definer set search_path = '' as $$ $$;
      revoke all on function public.c() from public, anon;
      grant execute on function public.c() to authenticated, anon;
    `;
    expect(lintSql(sql, "x.sql").violations[0].missing).toEqual(["revoke_anon"]);
  });

  it("rejects user-writable or unpinned search paths", () => {
    const missingFor = (value) =>
      lintSql(
        `create function public.d() returns void language sql security definer set search_path ${value} as $$ $$;
         revoke all on function public.d() from public, anon; grant execute on function public.d() to service_role;`,
        "x.sql",
      ).violations.flatMap((v) => v.missing);
    expect(missingFor("= public, pg_temp")).toEqual(["search_path"]);
    expect(missingFor(`= "$user", pg_catalog`)).toEqual(["search_path"]);
    expect(missingFor("= pg_temp, pg_catalog")).toEqual(["search_path"]);
    expect(missingFor("from current")).toEqual(["search_path"]);
    expect(missingFor("to 'pg_catalog, public'")).toEqual([]);
    expect(missingFor("= private, public, pg_catalog")).toEqual([]);
    expect(missingFor("= pg_catalog, pg_temp")).toEqual([]);
  });

  it("selects added and modified migrations from name-status output", () => {
    const text = [
      "A\tsupabase/migrations/20990101000000_a.sql",
      "M\tsupabase/migrations/20990101000001_b.sql",
      "D\tsupabase/migrations/20990101000002_c.sql",
      "A\tscripts/fixtures/security-definer/compliant.sql",
      "A\tdocs/migration-drafts/ovd-1.sql",
    ].join("\n");
    expect(changedMigrationFiles(text)).toEqual([
      "supabase/migrations/20990101000000_a.sql",
      "supabase/migrations/20990101000001_b.sql",
    ]);
  });
});

describe("SECURITY DEFINER lint CLI", () => {
  const makeRepo = () => makeLintRepo("security-definer-lint-", fixture("baseline-noncompliant.sql"));
  const run = (argv) => runLintMain(main, argv);

  it("reports in report mode, fails with --enforce, and writes JSON", () => {
    const { root, git } = makeRepo();
    expect(run(["--all", "--write-baseline", "--root", root]).code).toBe(0);
    git("add", ".");
    git("commit", "-q", "-m", "base");

    const newFile = "supabase/migrations/20990101000000_new.sql";
    writeFileSync(path.join(root, newFile), fixture("missing-revoke-anon.sql"));
    writeFileSync(path.join(root, "changed.txt"), `A\t${newFile}\n`);

    const report = run(["--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--json-out", "out.json"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain(`${newFile}:1 public.fixture_no_revoke_anon(uuid): missing REVOKE ... FROM anon`);
    const json = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
    expect(json).toMatchObject({ schema: "security-definer-lint.v1", mode: "changed", ok: false });
    expect(json.summary.failing).toBe(1);

    expect(run(["--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--enforce"]).code).toBe(1);
  });

  it("fails --enforce when the PR's baseline grows, even if it covers the new violation", () => {
    const { root, git } = makeRepo();
    run(["--all", "--write-baseline", "--root", root]);
    git("add", ".");
    git("commit", "-q", "-m", "base");

    const newFile = "supabase/migrations/20990101000000_new.sql";
    writeFileSync(path.join(root, newFile), fixture("missing-grant.sql"));
    run(["--all", "--write-baseline", "--root", root]);
    writeFileSync(path.join(root, "changed.txt"), `A\t${newFile}\nM\t${BASELINE_PATH}\n`);

    const result = run([
      "--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--enforce", "--json-out", "out.json",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("baseline may only shrink");
    expect(result.out).toContain("missing GRANT EXECUTE");
    expect(result.out).toContain(GATE_LOOSENING_LINE);
    const json = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
    expect(json.gate_loosening).toMatchObject({
      detected: true,
      reasons: [expect.objectContaining({ code: "baseline_entry_added", signature: "public.fixture_no_grant(uuid)" })],
      requires: ["grokbot_countersign", "blaine_card"],
    });
  });

  it("reports a checker edit as gate loosening without failing --enforce", () => {
    const { root, git } = makeRepo();
    run(["--all", "--write-baseline", "--root", root]);
    writeFileSync(path.join(root, CHECKER_PATH), "// base copy\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");

    writeFileSync(path.join(root, CHECKER_PATH), "// relaxed\n");
    writeFileSync(path.join(root, "changed.txt"), `M\t${CHECKER_PATH}\n`);
    const result = run([
      "--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--enforce", "--json-out", "out.json",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${GATE_LOOSENING_LINE} (report only, does not block)`);
    expect(result.out).toContain(`checker_changed: ${CHECKER_PATH} edited`);
    const json = JSON.parse(readFileSync(path.join(root, "out.json"), "utf8"));
    expect(json).toMatchObject({ ok: true, gate_loosening: { detected: true } });
  });

  it("reports no gate loosening for an unrelated change", () => {
    const { root, git } = makeRepo();
    run(["--all", "--write-baseline", "--root", root]);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(root, "changed.txt"), "M\tsrc/app.ts\n");
    const result = run(["--changed-files-from", "changed.txt", "--base-ref", "HEAD", "--root", root, "--json-out", "out.json"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("GATE LOOSENING");
    expect(JSON.parse(readFileSync(path.join(root, "out.json"), "utf8")).gate_loosening.detected).toBe(false);
  });
});
