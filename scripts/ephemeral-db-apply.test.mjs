// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PATHS,
  REPORT_SCHEMA,
  applyInOrder,
  findOutOfOrder,
  orderMigrations,
  parseArgs,
  parseNameStatus,
  psqlCommand,
  renderSummary,
  runEphemeralDb,
  selectChanges,
} from "./ephemeral-db-apply.mjs";
import { listLocalMigrationFilenames } from "./migration-timestamp.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES = "scripts/fixtures/ephemeral-db";
const FIXTURE_PATHS = { ...DEFAULT_PATHS, migrations: `${FIXTURES}/migrations`, pending: `${FIXTURES}/pending` };
const OK = `${FIXTURES}/migrations/20990101000000_ephemeral_fixture_ok.sql`;
const FAIL = `${FIXTURES}/migrations/20990101000100_ephemeral_fixture_fail.sql`;
const PENDING = `${FIXTURES}/pending/ephemeral_fixture_ok.sql.pending`;
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const workDirs = [];
const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ephemeral-db-test-"));
  workDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pgProve = (dir) => {
  const files = readdirSync(dir, { recursive: true }).filter((path) => /\.(?:sql|pg)$/.test(String(path))).length;
  return `ok 1 - fine\nFiles=${files}, Tests=${files * 3},  1 wallclock secs\nResult: PASS\n`;
};

/** Fake executor: git and supabase answer from the arguments; psql "runs" the real fixture file. */
function fakeExec({ diff, baseFiles = ["supabase/migrations/20261015074957_ovd736_revoke_anon_definer_execute.sql"], startStatus = 0, pgTap = pgProve }) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "diff") return { status: 0, stdout: diff };
    if (cmd === "git" && args[0] === "ls-tree") return { status: 0, stdout: `${baseFiles.join("\n")}\n` };
    if (cmd === "git" || cmd === "tar") return { status: 0, stdout: "" };
    if (cmd === "supabase" && args[0] === "db") return { status: startStatus, stdout: "", stderr: startStatus ? "start failed" : "" };
    if (cmd === "supabase" && args[0] === "test") return { status: 0, stdout: pgTap(args.at(-1)) };
    if (cmd === "docker") {
      const file = args.at(-1);
      if (readFileSync(join(ROOT, file), "utf8").includes("ephemeral_fixture_missing")) {
        return { status: 3, stdout: "", stderr: `psql:${file}:3: ERROR:  relation "public.ephemeral_fixture_missing" does not exist` };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

const run = (fake, extra = {}) =>
  runEphemeralDb({ root: ROOT, base: "HEAD^1", head: "HEAD", dbUrl: DB_URL, paths: FIXTURE_PATHS, exec: fake.exec, workDir: workDir(), ...extra });
const applied = (calls) => calls.filter(([cmd]) => cmd === "docker").map((call) => call.at(-1));

describe("migration diff selection", () => {
  it("parses name-status output, including tabs in paths", () => {
    expect(parseNameStatus("A\tsupabase/migrations/a.sql\nM\tdocs/x.md\n\nD\tb\tc\n")).toEqual([
      { status: "A", path: "supabase/migrations/a.sql" },
      { status: "M", path: "docs/x.md" },
      { status: "D", path: "b\tc" },
    ]);
  });

  it("applies only added migrations and reports edits, deletions and bad names", () => {
    const entries = parseNameStatus([
      "A\tsupabase/migrations/20261020000000_b.sql",
      "A\tsupabase/migrations/20261019000000_a.sql",
      "M\tsupabase/migrations/20261001000000_old.sql",
      "D\tsupabase/migrations/20260901000000_gone.sql",
      "A\tsupabase/migrations/not_a_migration.sql",
      "A\tsupabase/migrations/nested/20261021000000_c.sql",
      "A\tsupabase/migrations/README.md",
      "A\tdocs/migration-drafts/ovd-900.sql",
      "A\tdocs/migration-drafts/ovd-900.rollback.sql",
      "M\tdocs/migration-drafts/ovd-899.sql",
      "D\tdocs/migration-drafts/ovd-898.sql",
      "A\tsupabase/tests/pending/ovd900.sql.pending",
      "D\tsupabase/tests/pending/ovd898.sql.pending",
      "A\tsupabase/tests/ovd900.sql",
    ].join("\n"));
    expect(selectChanges(entries)).toEqual({
      migrations: ["supabase/migrations/20261019000000_a.sql", "supabase/migrations/20261020000000_b.sql"],
      invalidMigrations: ["supabase/migrations/not_a_migration.sql"],
      modifiedMigrations: ["supabase/migrations/20261001000000_old.sql"],
      deletedMigrations: ["supabase/migrations/20260901000000_gone.sql"],
      drafts: ["docs/migration-drafts/ovd-899.sql", "docs/migration-drafts/ovd-900.sql"],
      pendingTests: ["supabase/tests/pending/ovd900.sql.pending"],
      unsafePaths: [],
    });
  });

  it("flags unsafe paths", () => {
    expect(selectChanges(parseNameStatus("A\tsupabase/migrations/20261019000000_a b.sql")).unsafePaths)
      .toEqual(["supabase/migrations/20261019000000_a b.sql"]);
  });

  it("orders by timestamp, then by file name, regardless of directory", () => {
    expect(orderMigrations(["z/20261020000000_a.sql", "a/20261019000000_z.sql", "b/20261020000000_0.sql"]))
      .toEqual(["a/20261019000000_z.sql", "b/20261020000000_0.sql", "z/20261020000000_a.sql"]);
  });

  it("finds new migrations that are not newer than the base", () => {
    const base = ["20261015074957_ovd736.sql", "20261013043000_ovd723.sql"];
    expect(findOutOfOrder(["m/20261015074957_same.sql", "m/20261001000000_old.sql", "m/20261016000000_new.sql"], base))
      .toEqual(["m/20261015074957_same.sql", "m/20261001000000_old.sql"]);
    expect(findOutOfOrder(["m/20261001000000_x.sql"], [])).toEqual([]);
  });
});

describe("apply order and failure reporting", () => {
  it("stops at the first failing file, names it and lists what was not reached", () => {
    const seen = [];
    const result = applyInOrder(["a.sql", "b.sql", "c.sql"], (file) => {
      seen.push(file);
      return file === "b.sql" ? { status: 3, stderr: "ERROR: boom" } : { status: 0 };
    });
    expect(seen).toEqual(["a.sql", "b.sql"]);
    expect(result).toEqual({ applied: ["a.sql"], failed: { file: "b.sql", error: "ERROR: boom" }, skipped: ["c.sql"] });
  });

  it("treats a spawn error as a failure", () => {
    expect(applyInOrder(["a.sql"], () => ({ status: null, error: new Error("ENOENT docker") })).failed)
      .toEqual({ file: "a.sql", error: "ENOENT docker" });
  });

  it("builds psql commands for docker and a local client", () => {
    expect(psqlCommand({ psql: "docker", root: "/r", dbUrl: DB_URL, file: "m/1.sql" }).args)
      .toEqual(["run", "--rm", "--network", "host", "-v", "/r:/w", "-w", "/w", "postgres:17", "psql", DB_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "--single-transaction", "-f", "m/1.sql"]);
    expect(psqlCommand({ psql: "local", root: "/r", dbUrl: DB_URL, file: "m/1.sql" }))
      .toEqual({ cmd: "psql", args: [DB_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "--single-transaction", "-f", "/r/m/1.sql"] });
  });
});

describe("runEphemeralDb with fixture migrations", () => {
  it("applies the ok fixture, runs policy and pending pgTAP and passes", () => {
    const fake = fakeExec({ diff: `A\t${OK}\nA\t${PENDING}\n` });
    const report = run(fake);
    expect(report).toMatchObject({
      schema: REPORT_SCHEMA,
      mode: "report",
      target: "ephemeral",
      result: "pass",
      baseline: { status: "pass", migrations: 1 },
      migrations: { selected: [OK], applied: [OK], failed: null, skipped: [] },
      policyTests: { status: "pass", result: "PASS" },
      pendingTests: { selected: [PENDING], status: "pass", files: 1 },
      warnings: [],
    });
    expect(report.policyTests.staged).toBeGreaterThan(0);
    expect(applied(fake.calls)).toEqual([OK]);
    // The base project is started from a scratch copy, never from the checkout.
    const start = fake.calls.find(([cmd, sub]) => cmd === "supabase" && sub === "db");
    expect(start.slice(0, 4)).toEqual(["supabase", "db", "start", "--workdir"]);
    expect(start[4]).not.toBe(ROOT);
  });

  it("names the failing fixture migration and skips the tests", () => {
    const fake = fakeExec({ diff: `A\t${FAIL}\nA\t${OK}\nA\t${PENDING}\n` });
    const report = run(fake);
    expect(applied(fake.calls)).toEqual([OK, FAIL]);
    expect(report.result).toBe("fail");
    expect(report.migrations.applied).toEqual([OK]);
    expect(report.migrations.failed.file).toBe(FAIL);
    expect(report.migrations.failed.error).toMatch(/ephemeral_fixture_missing/);
    expect(report.policyTests).toEqual({ status: "skipped", reason: `migration ${FAIL} failed` });
    expect(report.pendingTests.status).toBe("skipped");
    expect(fake.calls.some(([cmd, sub]) => cmd === "supabase" && sub === "test")).toBe(false);
    const summary = renderSummary(report);
    expect(summary).toContain(`**Failed migration: \`${FAIL}\`**`);
    expect(summary).toContain("Report mode");
  });

  it("reports a failing pgTAP run", () => {
    const fake = fakeExec({ diff: `A\t${OK}\n`, pgTap: () => "not ok 1 - broken\nFiles=1, Tests=1\nResult: FAIL\n" });
    const report = run(fake, { mode: "enforce" });
    expect(report.policyTests.status).toBe("fail");
    expect(report.result).toBe("fail");
    expect(report.mode).toBe("enforce");
  });

  it("reports a base that does not start", () => {
    const report = run(fakeExec({ diff: `A\t${OK}\n`, startStatus: 1 }));
    expect(report.baseline).toMatchObject({ status: "fail", error: "start failed" });
    expect(report.migrations.applied).toEqual([]);
    expect(report.result).toBe("fail");
  });

  it("plans without touching a database", () => {
    const fake = fakeExec({ diff: `A\t${OK}\n` });
    const report = run(fake, { planOnly: true });
    expect(report.result).toBe("planned");
    expect(report.migrations.selected).toEqual([OK]);
    expect(fake.calls.every(([cmd]) => cmd === "git")).toBe(true);
  });

  it("refuses a non-loopback database before running anything", () => {
    const fake = fakeExec({ diff: "" });
    expect(() => run(fake, { dbUrl: "postgresql://postgres:pw@db.ozuatdcakezjtevztjlr.supabase.co:5432/postgres" })).toThrow(/not loopback/);
    expect(fake.calls).toEqual([]);
  });
});

describe("fixtures stay out of migration lineage", () => {
  it("keeps fixtures out of supabase/migrations", () => {
    const lineage = listLocalMigrationFilenames(ROOT);
    for (const fixture of readdirSync(join(ROOT, FIXTURES, "migrations"))) expect(lineage).not.toContain(fixture);
    expect(selectChanges(parseNameStatus(`A\t${OK}\nA\t${FAIL}\n`)).migrations).toEqual([]);
  });
});

describe("ephemeral-db workflow", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ephemeral-db.yml"), "utf8");

  it("runs in report mode from the base copy and uses no secrets", () => {
    expect(workflow).toMatch(/continue-on-error: \$\{\{ !inputs\.enforce \}\}/);
    expect(workflow).toMatch(/fetch-depth: 2/);
    expect(workflow).toMatch(/git show "HEAD\^1:\$file"/);
    expect(workflow).not.toMatch(/secrets\.|SUPABASE_ACCESS_TOKEN|db push|supabase link/);
  });

  it("copies every local module the checker imports", () => {
    const copied = /files="([^"]+)"/.exec(workflow)[1].split(" ");
    const pending = ["scripts/ephemeral-db-apply.mjs"];
    const seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, rel] of readFileSync(join(ROOT, file), "utf8").matchAll(/from ['"]\.\/([^'"]+)['"]/g)) pending.push(`scripts/${rel}`);
    }
    expect([...seen].sort()).toEqual([...copied].sort());
  });
});

describe("parseArgs", () => {
  it("defaults to report mode against HEAD^1 and validates flags", () => {
    expect(parseArgs([])).toMatchObject({ base: "HEAD^1", head: "HEAD", enforce: false, planOnly: false, psql: "docker" });
    expect(parseArgs(["--enforce", "--report", "r.json", "--psql", "local"])).toMatchObject({ enforce: true, report: "r.json", psql: "local" });
    expect(() => parseArgs(["--psql", "ssh"])).toThrow(/--psql/);
    expect(() => parseArgs(["--base"])).toThrow(/incomplete/);
    expect(() => parseArgs(["--project-ref", "x"])).toThrow(/unknown/);
  });
});
