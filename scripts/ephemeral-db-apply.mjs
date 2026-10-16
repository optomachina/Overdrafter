/**
 * OVD-849 part 1: prove a PR's migrations in a throwaway local Supabase database.
 *
 *   1. Diff the PR against its base (HEAD^1 of the pull_request merge commit).
 *   2. Start the local stack from a scratch copy of the base's supabase/ tree, so
 *      `supabase db start` applies exactly the base migrations. The checkout's
 *      supabase/migrations is never written.
 *   3. Apply the PR's new migrations with psql, oldest timestamp first, one
 *      transaction per file, stopping at the first failure and naming it.
 *   4. Run the policy pgTAP suite (staged by run-supabase-policy-tests.mjs).
 *   5. Apply touched migration drafts (docs/migration-drafts) and run the touched
 *      pending pgTAP files (supabase/tests/pending/*.sql.pending).
 *
 * Output is a JSON report (schema ovd849.ephemeral-db.v1, consumed by OVD-845),
 * a markdown step summary and human log lines. Report mode (the default) always
 * exits 0; --enforce exits 1 unless the result is "pass".
 *
 * Only the runner's own loopback database is accepted (supabase-target-guard.mjs).
 * The script never links, pushes or connects to a hosted Supabase project.
 *
 * Usage:
 *   node scripts/ephemeral-db-apply.mjs [--root DIR] [--base HEAD^1] [--head HEAD]
 *     [--db-url URL] [--psql docker|local] [--report FILE] [--plan-only] [--enforce]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseMigrationTimestamp } from "./migration-timestamp.mjs";
import { admitPgProve, stagePolicyTests } from "./run-supabase-policy-tests.mjs";
import { assertAllowedTarget, assertLocalDatabaseUrl } from "./supabase-target-guard.mjs";

export const REPORT_SCHEMA = "ovd849.ephemeral-db.v1";
export const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const PSQL_IMAGE = "postgres:17";
export const DEFAULT_PATHS = Object.freeze({
  migrations: "supabase/migrations",
  pending: "supabase/tests/pending",
  drafts: "docs/migration-drafts",
});

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const ERROR_EXCERPT_LINES = 20;

/** Parses `git diff --name-status --no-renames` output into { status, path } entries. */
export function parseNameStatus(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status.charAt(0), path: rest.join("\t") };
    });
}

const inDir = (path, dir) => dirname(path) === dir;
const migrationKey = (path) => `${parseMigrationTimestamp(path) ?? ""}/${basename(path)}`;

/** Migration files in apply order: timestamp, then file name. */
export function orderMigrations(paths) {
  return [...paths].sort((left, right) => migrationKey(left).localeCompare(migrationKey(right)));
}

/**
 * Picks what the PR asks the ephemeral database to prove. Only added migrations
 * are applied: production never re-runs an edited or deleted migration, so those
 * are reported as warnings instead.
 */
export function selectChanges(entries, paths = DEFAULT_PATHS) {
  const added = (entry) => entry.status === "A";
  const present = (entry) => entry.status === "A" || entry.status === "M" || entry.status === "T";
  const migrationEntries = entries.filter((entry) => inDir(entry.path, paths.migrations) && entry.path.endsWith(".sql"));
  const newMigrations = migrationEntries.filter(added).map((entry) => entry.path);
  const unsafe = entries.map((entry) => entry.path).filter((path) => !SAFE_PATH.test(path));
  return {
    migrations: orderMigrations(newMigrations.filter((path) => parseMigrationTimestamp(path) !== null)),
    invalidMigrations: newMigrations.filter((path) => parseMigrationTimestamp(path) === null).sort(),
    modifiedMigrations: migrationEntries.filter((entry) => entry.status === "M" || entry.status === "T").map((entry) => entry.path).sort(),
    deletedMigrations: migrationEntries.filter((entry) => entry.status === "D").map((entry) => entry.path).sort(),
    drafts: entries
      .filter((entry) => present(entry) && inDir(entry.path, paths.drafts) && entry.path.endsWith(".sql") && !entry.path.endsWith(".rollback.sql"))
      .map((entry) => entry.path)
      .sort(),
    pendingTests: entries
      .filter((entry) => present(entry) && inDir(entry.path, paths.pending) && entry.path.endsWith(".sql.pending"))
      .map((entry) => entry.path)
      .sort(),
    unsafePaths: unsafe.sort(),
  };
}

/** New migrations whose timestamp is not after the newest base migration. */
export function findOutOfOrder(migrations, baseFilenames) {
  const latest = baseFilenames.map(parseMigrationTimestamp).filter(Boolean).sort().at(-1);
  return latest ? migrations.filter((path) => parseMigrationTimestamp(path) <= latest) : [];
}

export function errorExcerpt(result) {
  const text = [result?.stderr, result?.stdout, result?.error?.message].filter(Boolean).join("\n").trim();
  return text.split("\n").slice(-ERROR_EXCERPT_LINES).join("\n") || `exit status ${result?.status ?? "unknown"}`;
}

/**
 * Applies files in order with `applyFile(path) -> { status, stdout, stderr }`.
 * Stops at the first failure and returns which file failed and why.
 */
export function applyInOrder(files, applyFile) {
  const applied = [];
  for (const [index, file] of files.entries()) {
    const result = applyFile(file);
    if (result.error || result.status !== 0) {
      return { applied, failed: { file, error: errorExcerpt(result) }, skipped: files.slice(index + 1) };
    }
    applied.push(file);
  }
  return { applied, failed: null, skipped: [] };
}

export function psqlCommand({ psql, root, dbUrl, file }) {
  const args = ["-v", "ON_ERROR_STOP=1", "-X", "-q", "--single-transaction"];
  if (psql === "local") return { cmd: "psql", args: [dbUrl, ...args, "-f", join(root, file)] };
  return {
    cmd: "docker",
    args: ["run", "--rm", "--network", "host", "-v", `${root}:/w`, "-w", "/w", PSQL_IMAGE, "psql", dbUrl, ...args, "-f", file],
  };
}

function runPgTap({ exec, root, dir, expectedFiles }) {
  const result = exec("supabase", ["test", "db", "--local", "--debug", dir], { cwd: root });
  if (result.error || result.status !== 0) return { status: "fail", error: errorExcerpt(result) };
  try {
    return { status: "pass", ...admitPgProve(result.stdout ?? "", expectedFiles) };
  } catch (error) {
    return { status: "fail", error: error.message };
  }
}

/** Copies each `name.sql.pending` to `dir/name.sql` and returns how many were staged. */
export function stagePendingTests(root, files, dir) {
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(join(root, file), join(dir, basename(file).replace(/\.pending$/, "")));
  return files.length;
}

const skippedTests = (reason) => ({ status: "skipped", reason });

export function emptyReport({ mode, base, head }) {
  return {
    schema: REPORT_SCHEMA,
    mode,
    target: "ephemeral",
    base,
    head,
    result: "fail",
    baseline: { status: "pending", migrations: 0 },
    migrations: { selected: [], applied: [], failed: null, skipped: [] },
    drafts: { selected: [], applied: [], failed: null, skipped: [] },
    policyTests: skippedTests("not run"),
    pendingTests: { selected: [], ...skippedTests("not run") },
    warnings: [],
  };
}

/** "pass" only when every phase that ran passed and nothing stopped early. */
export function decideResult(report) {
  const ok =
    report.baseline.status === "pass" &&
    report.migrations.failed === null &&
    report.drafts.failed === null &&
    report.policyTests.status === "pass" &&
    (report.pendingTests.status === "pass" || (report.pendingTests.status === "skipped" && report.pendingTests.selected.length === 0));
  return ok ? "pass" : "fail";
}

/**
 * Runs the whole flow with an injected `exec(cmd, args, { cwd }) -> { status, stdout, stderr }`.
 * Returns the report; never throws for a database or test failure.
 */
export function runEphemeralDb({ root, base, head, dbUrl = DEFAULT_DB_URL, psql = "docker", mode = "report", planOnly = false, paths = DEFAULT_PATHS, exec, workDir, log = () => {} }) {
  const report = emptyReport({ mode, base, head });
  assertAllowedTarget(report.target);
  assertLocalDatabaseUrl(dbUrl);
  const git = (...args) => {
    const result = exec("git", args, { cwd: root });
    if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${errorExcerpt(result)}`);
    return result.stdout ?? "";
  };

  const changes = selectChanges(parseNameStatus(git("diff", "--name-status", "--no-renames", base, head)), paths);
  const baseFilenames = git("ls-tree", "-r", "--name-only", base, "--", paths.migrations)
    .split("\n").filter((path) => path.endsWith(".sql")).map((path) => basename(path));
  report.baseline.migrations = baseFilenames.length;
  report.migrations.selected = changes.migrations;
  report.drafts.selected = changes.drafts;
  report.pendingTests.selected = changes.pendingTests;
  const warn = (message) => { report.warnings.push(message); log(`warning: ${message}`); };
  for (const path of changes.modifiedMigrations) warn(`${path} edits a migration already on the base; production will not re-run it`);
  for (const path of changes.deletedMigrations) warn(`${path} deletes a migration already on the base`);
  for (const path of findOutOfOrder(changes.migrations, baseFilenames)) warn(`${path} is not newer than the latest base migration`);
  for (const path of changes.invalidMigrations) warn(`${path} is not a valid migration filename and was not applied`);
  if (changes.unsafePaths.length > 0) {
    report.baseline = { ...report.baseline, status: "fail", error: `unsafe file names in diff: ${changes.unsafePaths.join(", ")}` };
    return { ...report, result: "fail" };
  }
  log(`base ${base}: ${baseFilenames.length} migrations; PR adds ${changes.migrations.length}, touches ${changes.drafts.length} drafts and ${changes.pendingTests.length} pending tests`);
  if (planOnly) {
    report.baseline.status = "skipped";
    return { ...report, result: "planned" };
  }

  // Base tree in a scratch project directory: db start applies only the base migrations.
  const project = join(workDir, "base-project");
  mkdirSync(project, { recursive: true });
  git("archive", "--format=tar", `--output=${join(workDir, "base.tar")}`, base, "supabase");
  const untar = exec("tar", ["-xf", join(workDir, "base.tar"), "-C", project], { cwd: root });
  if (untar.error || untar.status !== 0) throw new Error(`extracting the base tree failed: ${errorExcerpt(untar)}`);
  if (existsSync(join(project, "supabase/.temp/project-ref"))) throw new Error("base tree carries a linked project ref; refusing to start");
  log(`starting the local database from the base tree (${project})`);
  const start = exec("supabase", ["db", "start", "--workdir", project], { cwd: root });
  if (start.error || start.status !== 0) {
    report.baseline = { ...report.baseline, status: "fail", error: errorExcerpt(start) };
    return { ...report, result: "fail" };
  }
  report.baseline.status = "pass";

  const applyFile = (file) => {
    log(`applying ${file}`);
    const { cmd, args } = psqlCommand({ psql, root, dbUrl, file });
    return exec(cmd, args, { cwd: root });
  };
  report.migrations = { selected: changes.migrations, ...applyInOrder(changes.migrations, applyFile) };
  if (report.migrations.failed) {
    log(`migration failed: ${report.migrations.failed.file}`);
    report.policyTests = skippedTests(`migration ${report.migrations.failed.file} failed`);
    report.pendingTests = { selected: changes.pendingTests, ...skippedTests(`migration ${report.migrations.failed.file} failed`) };
    return { ...report, result: "fail" };
  }

  log("running policy pgTAP");
  try {
    const receipt = stagePolicyTests(join(root, "supabase/tests"), join(workDir, "policy-tests"));
    report.policyTests = { ...runPgTap({ exec, root, dir: join(workDir, "policy-tests"), expectedFiles: receipt.selectedSql.length }), staged: receipt.selectedSql.length };
  } catch (error) {
    report.policyTests = { status: "fail", error: error.message };
  }

  report.drafts = { selected: changes.drafts, ...applyInOrder(changes.drafts, applyFile) };
  if (report.drafts.failed) {
    report.pendingTests = { selected: changes.pendingTests, ...skippedTests(`draft ${report.drafts.failed.file} failed`) };
  } else if (changes.pendingTests.length === 0) {
    report.pendingTests = { selected: [], ...skippedTests("no pending tests touched") };
  } else {
    log("running touched pending pgTAP");
    const dir = join(workDir, "pending-tests");
    const expectedFiles = stagePendingTests(root, changes.pendingTests, dir);
    report.pendingTests = { selected: changes.pendingTests, ...runPgTap({ exec, root, dir, expectedFiles }) };
  }
  return { ...report, result: decideResult(report) };
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function renderSummary(report) {
  const list = (items) => (items.length ? items.map((item) => `\`${item}\``).join(", ") : "none");
  const lines = [
    `## Ephemeral DB (${report.mode} mode): ${report.result.toUpperCase()}`,
    "",
    `- Base \`${report.base}\`: ${report.baseline.migrations} migrations, start ${report.baseline.status}`,
    `- New migrations applied: ${list(report.migrations.applied)}`,
  ];
  if (report.migrations.failed) lines.push(`- **Failed migration: \`${report.migrations.failed.file}\`**`);
  if (report.migrations.skipped.length) lines.push(`- Not reached: ${list(report.migrations.skipped)}`);
  lines.push(`- Policy pgTAP: ${report.policyTests.status}${report.policyTests.reason ? ` (${report.policyTests.reason})` : ""}`);
  lines.push(`- Drafts applied: ${list(report.drafts.applied)}`);
  if (report.drafts.failed) lines.push(`- **Failed draft: \`${report.drafts.failed.file}\`**`);
  lines.push(`- Pending pgTAP (${list(report.pendingTests.selected)}): ${report.pendingTests.status}`);
  for (const warning of report.warnings) lines.push(`- Warning: ${warning}`);
  const failure = report.migrations.failed ?? report.drafts.failed;
  const error = failure?.error ?? report.error ?? report.baseline.error ?? report.policyTests.error ?? report.pendingTests.error;
  if (error) lines.push("", "```", error, "```");
  if (report.mode === "report") lines.push("", "_Report mode: this check never blocks the PR._");
  return `${lines.join("\n")}\n`;
}

export function parseArgs(argv) {
  const options = { root: process.cwd(), base: "HEAD^1", head: "HEAD", dbUrl: DEFAULT_DB_URL, psql: "docker", report: null, planOnly: false, enforce: false };
  const valued = { "--root": "root", "--base": "base", "--head": "head", "--db-url": "dbUrl", "--psql": "psql", "--report": "report" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan-only") options.planOnly = true;
    else if (arg === "--enforce") options.enforce = true;
    else if (valued[arg] && index + 1 < argv.length) options[valued[arg]] = argv[(index += 1)];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!["docker", "local"].includes(options.psql)) throw new Error("--psql must be docker or local");
  return { ...options, root: resolve(options.root) };
}

function spawnExec(cmd, args, { cwd }) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64_000_000, timeout: 19 * 60_000 });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.enforce ? "enforce" : "report";
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ephemeral-db-"));
  let report;
  try {
    report = runEphemeralDb({ ...options, mode, exec: spawnExec, workDir, log: (line) => console.log(`[ephemeral-db] ${line}`) });
  } catch (error) {
    report = { ...emptyReport({ mode, base: options.base, head: options.head }), result: "error", error: error.message };
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) writeFileSync(options.report, json);
  console.log(json);
  if (report.migrations.failed) console.log(`::error file=${report.migrations.failed.file}::migration failed in the ephemeral database`);
  if (report.error) console.log(`::error::ephemeral-db: ${report.error}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(report));
  const passed = report.result === "pass" || report.result === "planned";
  if (!passed) console.log(`[ephemeral-db] result ${report.result}${mode === "report" ? " (report mode: exit 0)" : ""}`);
  process.exitCode = options.enforce && !passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
