// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PATHS,
  REPORT_SCHEMA,
  applyInOrder,
  claimedDrafts,
  decideResult,
  emptyReport,
  findOutOfOrder,
  findUnsafePaths,
  headerText,
  isRetiredDraft,
  issueNumber,
  orderMigrations,
  parseArgs,
  parseNameStatus,
  psqlCommand,
  renderSummary,
  resolveDraftFamilies,
  runEphemeralDb,
  selectChanges,
  transactionBlockWarning,
} from "./ephemeral-db-apply.mjs";
import { listLocalMigrationFilenames } from "./migration-timestamp.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES = "scripts/fixtures/ephemeral-db";
const FIXTURE_PATHS = { migrations: `${FIXTURES}/migrations`, pending: `${FIXTURES}/pending`, drafts: `${FIXTURES}/drafts` };
const OK = `${FIXTURES}/migrations/20990101000000_ephemeral_fixture_ok.sql`;
const FAIL = `${FIXTURES}/migrations/20990101000100_ephemeral_fixture_fail.sql`;
const PENDING = `${FIXTURES}/pending/ephemeral_fixture_ok.sql.pending`;
const DRAFT_OK = `${FIXTURES}/drafts/ovd-9901-fixture.sql`;
const DRAFT_OK_ROLLBACK = `${FIXTURES}/drafts/ovd-9901-fixture.rollback.sql`;
const DRAFT_FAIL = `${FIXTURES}/drafts/ovd-9902-fixture-fail.sql`;
const DRAFT_RETIRED = `${FIXTURES}/drafts/ovd-9903-fixture-superseded.sql`;
const PENDING_DRAFT_OK = `${FIXTURES}/pending/ovd9901_fixture.sql.pending`;
const PENDING_DRAFT_FAIL = `${FIXTURES}/pending/ovd9902_fixture_fail.sql.pending`;
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
      "M\tios/App/Assets.xcassets/LaunchMark@2x.png",
    ].join("\n"));
    expect(selectChanges(entries)).toEqual({
      migrations: ["supabase/migrations/20261019000000_a.sql", "supabase/migrations/20261020000000_b.sql"],
      invalidMigrations: ["supabase/migrations/not_a_migration.sql"],
      modifiedMigrations: ["supabase/migrations/20261001000000_old.sql"],
      deletedMigrations: ["supabase/migrations/20260901000000_gone.sql"],
      touchedDrafts: [
        "docs/migration-drafts/ovd-898.sql",
        "docs/migration-drafts/ovd-899.sql",
        "docs/migration-drafts/ovd-900.rollback.sql",
        "docs/migration-drafts/ovd-900.sql",
      ],
      touchedPendingTests: ["supabase/tests/pending/ovd898.sql.pending", "supabase/tests/pending/ovd900.sql.pending"],
    });
  });

  it("flags unsafe names only among the files the job will use", () => {
    expect(findUnsafePaths(["supabase/migrations/20261019000000_a b.sql", "supabase/migrations/20261019000000_a.sql"]))
      .toEqual(["supabase/migrations/20261019000000_a b.sql"]);
  });

  it("does not fail a run because an unrelated file name is unusual", () => {
    const fake = fakeExec({ diff: `A\t${OK}\nM\tios/App/Assets.xcassets/LaunchMark.imageset/LaunchMark@2x.png\n` });
    const report = run(fake);
    expect(report.baseline.status).toBe("pass");
    expect(report.result).toBe("pass");
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
    // Drafts run as the per-issue workflows run them: no wrapping transaction.
    expect(psqlCommand({ psql: "local", root: "/r", dbUrl: DB_URL, file: "d/x.sql", singleTransaction: false }).args)
      .toEqual([DB_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", "/r/d/x.sql"]);
  });

  it("warns distinctly when a migration cannot run inside a transaction block", () => {
    const failed = { file: "m/20260324010000_idx.sql", error: "psql:m/x.sql:10: ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block" };
    expect(transactionBlockWarning(failed)).toMatch(/m\/20260324010000_idx\.sql cannot run inside a transaction block/);
    expect(transactionBlockWarning({ file: "m/x.sql", error: "ERROR: syntax error" })).toBeNull();
    expect(transactionBlockWarning(null)).toBeNull();
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

describe("draft families", () => {
  const draft = (stem, header = `-- ${stem} draft`) => ({ path: `docs/migration-drafts/${stem}.sql`, text: `${header}\nselect 1;\n` });
  const test = (name, header) => ({ path: `supabase/tests/pending/${name}.sql.pending`, text: `${header}\nbegin;\n` });

  it("reads issue numbers, headers and retirement markers", () => {
    expect(issueNumber("docs/migration-drafts/ovd-828-s1.sql")).toBe("828");
    expect(issueNumber("supabase/tests/pending/ovd829_provider_settings.sql.pending")).toBe("829");
    expect(issueNumber("docs/migration-drafts/provider-fanout-guards.sql")).toBeNull();
    expect(headerText("-- one\n--\n--   two\n\ncreate table x();\n-- three")).toBe("one two");
    expect(isRetiredDraft(headerText("-- SUPERSEDED by ovd-828-s1.sql."))).toBe(true);
    expect(isRetiredDraft(headerText("-- kept as history. Do\n-- not apply this draft; ever."))).toBe(true);
    expect(isRetiredDraft(headerText("-- constants in other.sql are superseded by this draft.\n-- Do not copy into supabase/migrations/ or apply to any hosted project."))).toBe(false);
  });

  it("matches claimed drafts by whole file stem", () => {
    const paths = ["d/ovd-723.sql", "d/ovd-723-contract.sql", "d/ovd-766-e.sql"];
    expect(claimedDrafts("Targets the EXPAND draft d/ovd-723.sql followed by d/ovd-723-contract.sql", paths)).toEqual(["d/ovd-723.sql", "d/ovd-723-contract.sql"]);
    expect(claimedDrafts("Requires ovd-723-contract.sql only", paths)).toEqual(["d/ovd-723-contract.sql"]);
    expect(claimedDrafts("Pending pgTAP for ovd-766-e (runs once the draft is applied).", paths)).toEqual(["d/ovd-766-e.sql"]);
  });

  it("joins by issue number and by claim, applies only claimed drafts, expand before contract", () => {
    const families = resolveDraftFamilies({
      touched: ["supabase/tests/pending/ovd723_contract.sql.pending"],
      drafts: [draft("ovd-723-contract"), draft("ovd-723"), draft("ovd-723-extra"), draft("ovd-766-b")],
      tests: [
        test("ovd723_contract", "-- Targets docs/migration-drafts/ovd-723.sql then docs/migration-drafts/ovd-723-contract.sql."),
        test("ovd768_admin", "-- Targets the draft docs/migration-drafts/ovd-766-b.sql."),
      ],
    });
    expect(families).toEqual({
      drafts: ["docs/migration-drafts/ovd-723.sql", "docs/migration-drafts/ovd-723-contract.sql"],
      pendingTests: ["supabase/tests/pending/ovd723_contract.sql.pending"],
      excluded: [{ file: "docs/migration-drafts/ovd-723-extra.sql", reason: "no pending test names this draft" }],
    });
  });
});

// #792 (OVD-829, merge d2b7981b), verbatim `git diff --name-status --no-renames d2b7981b^ d2b7981b`.
const PR_792_DIFF = `A\t.github/workflows/ovd829-pending-pgtap.yml
M\tdocs/business/business-model.md
M\tdocs/migration-drafts/ovd-678-provider-daily-quote-cap.sql
A\tdocs/migration-drafts/ovd-828-s1.rollback.sql
A\tdocs/migration-drafts/ovd-828-s1.sql
M\tdocs/migration-drafts/provider-fanout-guards.sql
M\tdocs/release/ovd-206-window-kit.md
M\tdocs/workflows/geomiq-live-readiness.md
M\tdocs/workflows/ovd678-rmfg-live-readiness.md
M\te2e/admin-operations.spec.ts
M\te2e/admin-operations.vite.config.ts
M\tsrc/components/admin/ProviderKillSwitchCard.test.tsx
M\tsrc/components/admin/ProviderKillSwitchCard.tsx
M\tsrc/features/quotes/api/provider-kill-switch-api.test.ts
M\tsrc/features/quotes/api/provider-kill-switch-api.ts
M\tsrc/features/quotes/provider-fanout.test.ts
M\tsrc/features/quotes/provider-fanout.ts
A\tsupabase/tests/pending/ovd829_provider_settings.sql.pending
M\tworker/.env.example
M\tworker/src/adapters/rmfg.test.ts
M\tworker/src/adapters/rmfg.ts
M\tworker/src/adapters/rmfgHttpTransport.test.ts
M\tworker/src/adapters/rmfgHttpTransport.ts
M\tworker/src/adapters/weergProductionPortal.test.ts
M\tworker/src/config.ts
M\tworker/src/dispatchRouting.test.ts
M\tworker/src/dispatchRouting.ts
M\tworker/src/fictivDispatchBinding.test.ts
M\tworker/src/fixtureHeal/fixtureHeal.handler.test.ts
M\tworker/src/index.ts
M\tworker/src/jev/operationalTask.test.ts
M\tworker/src/providerKillSwitch.genericRoute.test.ts
M\tworker/src/providerKillSwitch.handler.test.ts
M\tworker/src/providerKillSwitch.test.ts
M\tworker/src/providerKillSwitch.ts
A\tworker/src/providerSettings.test.ts
A\tworker/src/providerSettings.ts
M\tworker/src/providerTaskPipeline.ts
M\tworker/src/tools/operatorKillSwitchGate.test.ts
M\tworker/src/tools/operatorKillSwitchGate.ts
M\tworker/src/tools/vendorWorkflowSmoke.ts
M\tworker/src/tools/xometryQuantitySweep.ts
M\tworker/src/types.ts
A\tworker/test-support/providerDispatchReservation.ts
`;

describe("replay of real diffs against the #792 drafts tree", () => {
  // Header-only snapshot of docs/migration-drafts and supabase/tests/pending at d2b7981b.
  const REPLAY_ROOT = join(ROOT, FIXTURES, "replay-792");
  const plan = (diff) => runEphemeralDb({ root: REPLAY_ROOT, base: "HEAD^1", head: "HEAD", dbUrl: DB_URL, exec: fakeExec({ diff }).exec, workDir: workDir(), planOnly: true });
  const D = "docs/migration-drafts";
  const T = "supabase/tests/pending";
  const FAMILY_766 = {
    drafts: ["a", "b", "c", "d", "e"].map((part) => `${D}/ovd-766-${part}.sql`),
    tests: [`${T}/ovd766_a_guards.sql.pending`, `${T}/ovd766_c_guards.sql.pending`, `${T}/ovd766_d_guards.sql.pending`, `${T}/ovd766_e_job_editor_scope.sql.pending`, `${T}/ovd768_admin_list_guards.sql.pending`],
  };

  it("#792 applies only ovd-828-s1 and runs only ovd829, as ovd829-pending-pgtap.yml does", () => {
    const report = plan(PR_792_DIFF);
    expect(report.result).toBe("planned");
    expect(report.drafts.selected).toEqual([`${D}/ovd-828-s1.sql`]);
    expect(report.pendingTests.selected).toEqual([`${T}/ovd829_provider_settings.sql.pending`]);
    expect(report.drafts.excluded.map((entry) => entry.file)).toEqual([`${D}/ovd-678-provider-daily-quote-cap.sql`, `${D}/provider-fanout-guards.sql`]);
    expect(report.warnings).toEqual([
      `${D}/ovd-678-provider-daily-quote-cap.sql was not applied: retired (SUPERSEDED or "Do not apply this draft")`,
      `${D}/provider-fanout-guards.sql was not applied: no pending test names this draft`,
    ]);
  });

  it("a PR touching only one pending test gets its whole family's drafts", () => {
    const report = plan(`M\t${T}/ovd766_c_guards.sql.pending\n`);
    expect(report.drafts.selected).toEqual(FAMILY_766.drafts);
    expect(report.pendingTests.selected).toEqual(FAMILY_766.tests);
  });

  it("a PR touching only one draft gets the rest of its family", () => {
    const report = plan(`M\t${D}/ovd-766-c.sql\n`);
    expect(report.drafts.selected).toEqual(FAMILY_766.drafts);
    expect(report.pendingTests.selected).toEqual(FAMILY_766.tests);
  });

  it("orders an expand draft before its contract draft", () => {
    expect(plan(`M\t${D}/ovd-723-contract.sql\n`).drafts.selected).toEqual([`${D}/ovd-723.sql`, `${D}/ovd-723-contract.sql`]);
  });
});

describe("runEphemeralDb with fixture drafts", () => {
  it("applies a family's drafts without a wrapping transaction and runs its pending tests", () => {
    const fake = fakeExec({ diff: `M\t${DRAFT_OK_ROLLBACK}\n` });
    const report = run(fake);
    expect(report).toMatchObject({
      result: "pass",
      drafts: { touched: [DRAFT_OK_ROLLBACK], selected: [DRAFT_OK], applied: [DRAFT_OK], failed: null, excluded: [] },
      pendingTests: { touched: [], selected: [PENDING_DRAFT_OK], status: "pass", files: 1 },
    });
    expect(report.pendingTests.reason).toBeUndefined();
    const draftCall = fake.calls.find((call) => call[0] === "docker" && call.at(-1) === DRAFT_OK);
    expect(draftCall).not.toContain("--single-transaction");
    // pgTAP runs against the base copy's config, the one db start used.
    const start = fake.calls.find(([cmd, sub]) => cmd === "supabase" && sub === "db");
    for (const call of fake.calls.filter(([cmd, sub]) => cmd === "supabase" && sub === "test")) {
      expect(call.slice(0, 6)).toEqual(["supabase", "test", "db", "--local", "--debug", "--workdir"]);
      expect(call[6]).toBe(start[4]);
    }
  });

  it("names a failing draft and skips the family's pending tests", () => {
    const fake = fakeExec({ diff: `M\t${PENDING_DRAFT_FAIL}\n` });
    const report = run(fake);
    expect(report.result).toBe("fail");
    expect(report.policyTests.status).toBe("pass");
    expect(report.drafts).toMatchObject({ selected: [DRAFT_FAIL], applied: [], failed: { file: DRAFT_FAIL } });
    expect(report.drafts.failed.error).toMatch(/ephemeral_fixture_missing/);
    expect(report.pendingTests).toEqual({ touched: [PENDING_DRAFT_FAIL], selected: [PENDING_DRAFT_FAIL], status: "skipped", reason: `draft ${DRAFT_FAIL} failed` });
    expect(renderSummary(report)).toContain(`**Failed draft: \`${DRAFT_FAIL}\`**`);
  });

  it("does not apply a retired draft and says so", () => {
    const fake = fakeExec({ diff: `M\t${DRAFT_RETIRED}\n` });
    const report = run(fake);
    expect(report.result).toBe("pass");
    expect(report.drafts.selected).toEqual([]);
    expect(report.warnings).toEqual([`${DRAFT_RETIRED} was not applied: retired (SUPERSEDED or "Do not apply this draft")`]);
    expect(applied(fake.calls)).toEqual([]);
  });

  it("records a head-sourced checker with a warning", () => {
    const report = run(fakeExec({ diff: "" }), { checkerSource: "head", planOnly: true });
    expect(report.checkerSource).toBe("head");
    expect(report.warnings[0]).toMatch(/checker scripts came from the PR head/);
    expect(renderSummary(report)).toContain("Checker scripts from: head");
  });
});

describe("decideResult", () => {
  const passing = () => ({
    ...emptyReport({ mode: "report", base: "b", head: "h" }),
    baseline: { status: "pass", migrations: 1 },
    policyTests: { status: "pass" },
    pendingTests: { touched: [], selected: [], status: "skipped", reason: "none" },
  });

  it("passes when no pending tests were selected", () => {
    expect(decideResult(passing())).toBe("pass");
  });

  it("fails when pending tests were selected but skipped", () => {
    expect(decideResult({ ...passing(), pendingTests: { touched: [], selected: ["t.sql.pending"], status: "skipped", reason: "draft failed" } })).toBe("fail");
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
    expect(workflow).toMatch(/--checker-source "\$CHECKER_SOURCE"/);
    expect(workflow).toMatch(/supabase stop --no-backup --workdir "\$RUNNER_TEMP\/ephemeral-db\/base-project"/);
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
    expect(parseArgs(["--enforce", "--report", "r.json", "--psql", "local"])).toMatchObject({ enforce: true, report: "r.json", psql: "local", checkerSource: "unknown" });
    expect(parseArgs(["--checker-source", "head", "--work-dir", "w"])).toMatchObject({ checkerSource: "head", workDir: "w" });
    expect(() => parseArgs(["--checker-source", "pr"])).toThrow(/--checker-source/);
    expect(() => parseArgs(["--psql", "ssh"])).toThrow(/--psql/);
    expect(() => parseArgs(["--base"])).toThrow(/incomplete/);
    expect(() => parseArgs(["--project-ref", "x"])).toThrow(/unknown/);
  });
});
