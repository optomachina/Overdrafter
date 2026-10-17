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
 *   5. Resolve every touched migration draft (docs/migration-drafts) and pending
 *      pgTAP file (supabase/tests/pending/*.sql.pending) to its issue family
 *      (resolveDraftFamilies), apply the family's claimed drafts in stem order and
 *      run all of the family's pending tests.
 *
 * Output is a JSON report (schema ovd849.ephemeral-db.v1, consumed by OVD-845),
 * a markdown step summary and human log lines. Report mode (the default) always
 * exits 0; --enforce exits 1 unless the result is "pass".
 *
 * Only the runner's own loopback database is accepted (supabase-target-guard.mjs).
 * The script never links, pushes or connects to a hosted Supabase project.
 *
 * --rollback runs the per-family rollback stage instead of the combined draft
 * apply. For each resolved family that has docs/migration-drafts/ovd-NNN-*.rollback.sql
 * it takes a schema-only pg_dump, applies that family's drafts, re-applies only
 * drafts whose header declares `-- ovd: idempotent`, runs the family's pending
 * pgTAP, applies the rollbacks newest first twice (the second pass must succeed),
 * and requires an empty DM-1R diff against the first dump. A family with no
 * rollback files is reported as rollback "none" and does not fail the run.
 * Pending tests tagged `-- ovd: post-rollback` in their leading comments run
 * after each rollback pass; the second run follows the DM-1R dump/diff.
 * The ovd849.ephemeral-db.v1 report records their aggregate status in
 * families[].rollback.postRollbackPgtap (pass, fail, or skipped).
 * Every family runs and is reported (dm1r, replay, reapply, pgtap) even after
 * an earlier family fails; --rollback then exits 1 unless the result is pass.
 *
 * Usage:
 *   node scripts/ephemeral-db-apply.mjs [--root DIR] [--base HEAD^1] [--head HEAD]
 *     [--db-url URL] [--psql docker|local] [--report FILE] [--work-dir DIR]
 *     [--checker-source base|head|unknown] [--plan-only] [--enforce] [--rollback]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

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
 * are reported as warnings instead. Touched files under the drafts and pending
 * directories (any status, including rollbacks and notes) only seed the issue
 * families that resolveDraftFamilies expands.
 */
export function selectChanges(entries, paths = DEFAULT_PATHS) {
  const added = (entry) => entry.status === "A";
  const migrationEntries = entries.filter((entry) => inDir(entry.path, paths.migrations) && entry.path.endsWith(".sql"));
  const newMigrations = migrationEntries.filter(added).map((entry) => entry.path);
  return {
    migrations: orderMigrations(newMigrations.filter((path) => parseMigrationTimestamp(path) !== null)),
    invalidMigrations: newMigrations.filter((path) => parseMigrationTimestamp(path) === null).sort(),
    modifiedMigrations: migrationEntries.filter((entry) => entry.status === "M" || entry.status === "T").map((entry) => entry.path).sort(),
    deletedMigrations: migrationEntries.filter((entry) => entry.status === "D").map((entry) => entry.path).sort(),
    touchedDrafts: entries.filter((entry) => inDir(entry.path, paths.drafts)).map((entry) => entry.path).sort(),
    touchedPendingTests: entries.filter((entry) => inDir(entry.path, paths.pending)).map((entry) => entry.path).sort(),
  };
}

/** Files the job would hand to psql or pgTAP whose names are not plain ASCII path characters. */
export function findUnsafePaths(paths) {
  return paths.filter((path) => !SAFE_PATH.test(path)).sort();
}

/** "828" for ovd-828-s1.sql, "829" for ovd829_provider_settings.sql.pending, null otherwise. */
export function issueNumber(path) {
  return /^ovd-?(\d+)/i.exec(basename(path))?.[1] ?? null;
}

/** Stable id for one connected family: issue numbers, smallest first ("828+829"). */
export function familyId(paths) {
  const ids = [...new Set(paths.map((path) => issueNumber(path)).filter(Boolean))];
  ids.sort((left, right) => Number(left) - Number(right));
  return ids.join("+") || "unknown";
}

/** The leading comment block of a SQL file, without the `--` markers, as one line. */
export function headerText(text) {
  const lines = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("--")) break;
    lines.push(trimmed.replace(/^--+/, ""));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** A draft whose header retires it ("SUPERSEDED ...", "Do not apply this draft"). */
export function isRetiredDraft(header) {
  return /\bSUPERSEDED\b/.test(header) || /\bdo not apply this draft\b/i.test(header);
}

const draftStem = (path) => basename(path).replace(/\.sql$/, "");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drafts a pending test names in its header, by file stem (`ovd-766-b`, `ovd-766-b.sql`, `.../ovd-766-b.sql`). */
export function claimedDrafts(header, draftPaths) {
  return draftPaths.filter((path) => new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(draftStem(path))}(?![A-Za-z0-9_-])`).test(header));
}

/**
 * Expands touched drafts and pending tests to whole issue families, the way the
 * per-issue ovdNNN-pending-pgtap.yml workflows select them. A family joins:
 *   - drafts and pending tests with the same issue number (ovd-766-c.sql, ovd766_c_guards.sql.pending);
 *   - a pending test and every draft its header names (ovd829_provider_settings
 *     targets ovd-828-s1.sql; ovd768_admin_list_guards targets ovd-766-b.sql).
 * Only drafts some pending test in the family claims are applied, ordered by file
 * stem (so ovd-723.sql precedes ovd-723-contract.sql). Retired drafts (SUPERSEDED,
 * "Do not apply this draft") never join a family. Everything left out is listed in
 * `excluded` with a reason.
 *
 * `drafts` and `tests` are `{ path, text }` from the head tree; `touched` is every
 * diff path under the drafts or pending directories.
 */
export function resolveDraftFamilies({ touched, drafts, tests }) {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(key, root);
    return root;
  };
  const union = (left, right) => parent.set(find(left), find(right));
  const numberKey = (path) => (issueNumber(path) ? `ovd:${issueNumber(path)}` : null);

  const retired = new Set(drafts.filter((draft) => isRetiredDraft(headerText(draft.text))).map((draft) => draft.path));
  const liveDrafts = drafts.map((draft) => draft.path).filter((path) => !retired.has(path));
  const claimed = new Set();
  for (const path of [...liveDrafts, ...tests.map((test) => test.path)]) {
    find(path);
    if (numberKey(path)) union(path, numberKey(path));
  }
  for (const test of tests) {
    for (const draft of claimedDrafts(headerText(test.text), liveDrafts)) {
      claimed.add(draft);
      union(test.path, draft);
    }
  }

  const seeds = new Set();
  for (const path of touched) {
    if (parent.has(path)) seeds.add(find(path));
    else if (numberKey(path) && parent.has(numberKey(path))) seeds.add(find(numberKey(path)));
  }
  const inFamily = (path) => seeds.has(find(path));
  const familyDrafts = liveDrafts.filter(inFamily);
  const byStem = (left, right) => compareStrings(draftStem(left), draftStem(right));
  const touchedSet = new Set(touched);
  const selectedDrafts = familyDrafts.filter((path) => claimed.has(path)).sort(byStem);
  const selectedTests = tests.map((test) => test.path).filter(inFamily).sort(compareStrings);
  const groups = new Map();
  const addMember = (path, bucket) => {
    const root = find(path);
    if (!groups.has(root)) groups.set(root, { drafts: [], pendingTests: [] });
    groups.get(root)[bucket].push(path);
  };
  for (const path of selectedDrafts) addMember(path, "drafts");
  for (const path of selectedTests) addMember(path, "pendingTests");
  const familyKey = (id) => Number(id.split("+")[0]);
  const resolvedFamilies = [...groups.values()]
    .map((group) => ({
      id: familyId([...group.drafts, ...group.pendingTests]),
      drafts: group.drafts.sort(byStem),
      pendingTests: [...group.pendingTests].sort(compareStrings),
    }))
    .sort((left, right) => familyKey(left.id) - familyKey(right.id) || compareStrings(left.id, right.id));
  return {
    drafts: selectedDrafts,
    pendingTests: selectedTests,
    families: resolvedFamilies,
    excluded: [
      ...[...retired].filter((path) => touchedSet.has(path)).map((file) => ({ file, reason: "retired (SUPERSEDED or \"Do not apply this draft\")" })),
      ...familyDrafts.filter((path) => !claimed.has(path)).map((file) => ({ file, reason: "no pending test names this draft" })),
    ].sort((left, right) => left.file.localeCompare(right.file)),
  };
}

/** Reads the head tree's drafts (not rollbacks) and pending tests for resolveDraftFamilies. */
export function readDraftInventory(root, paths = DEFAULT_PATHS) {
  const list = (dir, keep) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir)).filter(keep).sort().map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(root, dir, name), "utf8") }))
      : [];
  return {
    drafts: list(paths.drafts, (name) => name.endsWith(".sql") && !name.endsWith(".rollback.sql")),
    tests: list(paths.pending, (name) => name.endsWith(".sql.pending")),
  };
}

/** Rollback scripts next to drafts (`ovd-NNN-*.rollback.sql`). */
export function listRollbackFiles(root, paths = DEFAULT_PATHS) {
  const dir = join(root, paths.drafts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".rollback.sql"))
    .sort()
    .map((name) => `${paths.drafts}/${name}`);
}

const rollbackStem = (path) => basename(path).replace(/\.rollback\.sql$/, "");

/** Rollbacks for these drafts, newest stem first (the reverse of apply order). */
export function rollbacksNewestFirst(drafts, rollbackFiles) {
  const stems = new Set(drafts.map((path) => draftStem(path)));
  return rollbackFiles
    .filter((path) => stems.has(rollbackStem(path)))
    .sort((left, right) => (rollbackStem(left) < rollbackStem(right) ? 1 : rollbackStem(left) > rollbackStem(right) ? -1 : 0));
}

/** True when the leading comment block declares `-- ovd: idempotent` on its own line. */
export function isIdempotentDraft(text) {
  return leadingCommentDeclares(text, /^--\s*ovd:\s*idempotent\s*$/i);
}

/** True when the leading comment block declares a post-rollback test. */
export function isPostRollbackTest(text) {
  return leadingCommentDeclares(text, /^--\s*ovd:\s*post-rollback\s*$/i);
}

function leadingCommentDeclares(text, pattern) {
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("--")) return false;
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/** Empty when two schema-only dumps match. Otherwise a short added/removed line diff. */
export function schemaDiff(before, after) {
  const left = String(before ?? "").trimEnd();
  const right = String(after ?? "").trimEnd();
  if (left === right) return "";
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const leftSet = new Set(leftLines);
  const rightSet = new Set(rightLines);
  const added = rightLines.filter((line) => !leftSet.has(line)).slice(0, 30);
  const removed = leftLines.filter((line) => !rightSet.has(line)).slice(0, 30);
  return ["DM-1R schema diff is not empty", ...added.map((line) => `+ ${line}`), ...removed.map((line) => `- ${line}`)].join("\n");
}

/** Schema-only dump on stdout. The same `--restrict-key` on both dumps keeps that line stable. */
export function pgDumpCommand({ psql, dbUrl }) {
  const args = ["--schema-only", "--no-owner", "--restrict-key=ovd849"];
  if (psql === "local") return { cmd: "pg_dump", args: [dbUrl, ...args] };
  return { cmd: "docker", args: ["run", "--rm", "--network", "host", PSQL_IMAGE, "pg_dump", dbUrl, ...args] };
}

function dumpSchema({ exec, psql, dbUrl, root }) {
  const { cmd, args } = pgDumpCommand({ psql, dbUrl });
  const result = exec(cmd, args, { cwd: root });
  if (result.error || result.status !== 0) return { ok: false, error: errorExcerpt(result), text: "" };
  return { ok: true, text: result.stdout ?? "" };
}

function familyRollbackOk(family) {
  const rollback = family?.rollback;
  if (rollback == null || rollback === "none" || rollback === "not-run") return true;
  return rollback.dm1r === "pass" && rollback.replay === "pass" && (rollback.reapply === "pass" || rollback.reapply === "skipped") && rollback.pgtap !== "fail" && rollback.postRollbackPgtap !== "fail";
}

const skippedRollback = () => ({ dm1r: "skipped", replay: "skipped", reapply: "skipped", pgtap: "skipped", postRollbackPgtap: "skipped" });

function recordRollbackError(rollback, message) {
  rollback.error ??= message;
  rollback.errors ??= [];
  rollback.errors.push(message);
}

function replayFamily(family, applyFile, rollback, afterFirstPass) {
  for (const pass of [1, 2]) {
    const rolled = applyInOrder(family.rollbacks, applyFile);
    if (rolled.failed) {
      rollback.replay = "fail";
      recordRollbackError(rollback, `family ${family.id}: rollback replay failed on pass ${pass} (${rolled.failed.file}): ${rolled.failed.error}`);
      return;
    }
    if (pass === 1) afterFirstPass();
  }
  rollback.replay = "pass";
}

function checkFamilyDrafts({ root, family, applyFile, rollback }) {
  const idempotent = family.drafts.filter((file) => isIdempotentDraft(readFileSync(join(root, file), "utf8")));
  if (idempotent.length === 0) return;
  const again = applyInOrder(idempotent, applyFile);
  rollback.reapply = "pass";
  if (again.failed) {
    rollback.reapply = "fail";
    recordRollbackError(rollback, `family ${family.id}: re-apply of ${again.failed.file} failed: ${again.failed.error}`);
  }
}

function checkFamilyPending({ root, family, workDir, exec, project, rollback }) {
  if (family.pendingTests.length === 0) return { status: "skipped" };
  const dir = join(workDir, "rollback-tests", family.id);
  const expectedFiles = stagePendingTests(root, family.pendingTests, dir);
  const tap = runPgTap({ exec, root, project, dir, expectedFiles });
  rollback.pgtap = tap.status;
  if (tap.status !== "pass") recordRollbackError(rollback, `family ${family.id}: pending pgTAP failed: ${tap.error ?? "unknown"}`);
  return { ...tap, files: expectedFiles };
}

function checkFamilyDiff(options, before, rollback) {
  if (rollback.replay !== "pass") return;
  const after = dumpSchema(options);
  rollback.dm1r = "fail";
  if (!after.ok) {
    recordRollbackError(rollback, `family ${options.family.id}: post-rollback pg_dump failed: ${after.error}`);
    return;
  }
  const diff = schemaDiff(before.text, after.text);
  if (diff) recordRollbackError(rollback, `family ${options.family.id}: ${diff}`);
  else rollback.dm1r = "pass";
}

function rollbackOneFamily(options) {
  const { family, applyFile, log = () => {} } = options;
  if (family.rollbacks.length === 0) return { result: { ...family, rollback: "none" }, applied: [] };
  log(`rollback family ${family.id}`);
  const rollback = skippedRollback();
  const outcome = { result: { ...family, rollback }, applied: [] };
  const before = dumpSchema(options);
  if (!before.ok) {
    rollback.dm1r = "fail";
    recordRollbackError(rollback, `family ${family.id}: pre-draft pg_dump failed: ${before.error}`);
    return outcome;
  }
  const apply = applyInOrder(family.drafts, applyFile);
  outcome.applied = apply.applied;
  if (apply.failed) {
    outcome.draftFailed = apply.failed;
    outcome.skipped = apply.skipped;
    recordRollbackError(rollback, `family ${family.id}: draft ${apply.failed.file} failed: ${apply.failed.error}`);
    for (const file of family.rollbacks) applyFile(file);
    return outcome;
  }
  checkFamilyDrafts({ ...options, rollback });
  outcome.pending = checkFamilyPending({ ...options, rollback });
  const tagged = family.pendingTests.filter((file) => isPostRollbackTest(readFileSync(join(options.root, file), "utf8")));
  const postRollbackTests = (pass) => {
    if (tagged.length === 0) return;
    const dir = join(options.workDir, "rollback-tests", `${family.id}-post-${pass}`);
    const expectedFiles = stagePendingTests(options.root, tagged, dir);
    const tap = runPgTap({ ...options, dir, expectedFiles });
    if (rollback.postRollbackPgtap !== "fail") rollback.postRollbackPgtap = tap.status;
    if (tap.status !== "pass") recordRollbackError(rollback, `family ${family.id}: post-rollback pgTAP after pass ${pass} failed: ${tap.error ?? "unknown"}`);
  };
  replayFamily(family, applyFile, rollback, () => postRollbackTests(1));
  checkFamilyDiff(options, before, rollback);
  if (rollback.replay === "pass") postRollbackTests(2);
  return outcome;
}

/**
 * Proves every resolved family against its own pre-draft schema baseline:
 * dump, apply, re-apply idempotent drafts, pending pgTAP, rollbacks newest-first
 * twice, dump, empty DM-1R diff. A failing family does not stop the loop; later
 * families carry `afterFailedFamily` because their baseline may hold leftovers.
 * Families with no rollback files are `rollback: "none"`.
 */
export function runFamilyRollbacks(options) {
  const applied = [];
  let draftFailed = null;
  let skipped = [];
  const results = [];
  let failedFamily;
  let pending = { status: "skipped", reason: "no pending tests in families that ran the rollback stage" };
  for (const family of options.families) {
    const outcome = rollbackOneFamily({ ...options, family });
    if (failedFamily) outcome.result.afterFailedFamily = failedFamily;
    results.push(outcome.result);
    applied.push(...outcome.applied);
    if (!draftFailed && outcome.draftFailed) {
      draftFailed = outcome.draftFailed;
      skipped = outcome.skipped;
    }
    if (!familyRollbackOk(outcome.result)) failedFamily = family.id;
    if (pending.status === "fail" || !outcome.pending || outcome.pending.status === "skipped") continue;
    if (outcome.pending.status === "fail") pending = { status: "fail", error: outcome.pending.error };
    else pending = { status: "pass", files: (pending.files ?? 0) + outcome.pending.files };
  }
  return { families: results, applied, draftFailed, skipped, pending };
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

/**
 * New migrations run with --single-transaction, as the migration runner wraps
 * each file in one transaction. A statement that cannot run in a transaction
 * block (`create index concurrently`) therefore fails here; the report adds a
 * distinct warning for it (see transactionBlockWarning). Drafts run without it,
 * as the ovdNNN-pending-pgtap.yml workflows apply them, so drafts carrying their
 * own begin/commit behave the same in both places.
 */
export function psqlCommand({ psql, root, dbUrl, file, singleTransaction = true }) {
  const args = ["-v", "ON_ERROR_STOP=1", "-X", "-q", ...(singleTransaction ? ["--single-transaction"] : [])];
  if (psql === "local") return { cmd: "psql", args: [dbUrl, ...args, "-f", join(root, file)] };
  return {
    cmd: "docker",
    args: ["run", "--rm", "--network", "host", "-v", `${root}:/w`, "-w", "/w", PSQL_IMAGE, "psql", dbUrl, ...args, "-f", file],
  };
}

/** A warning when a migration failed only because it cannot run inside one transaction. */
export function transactionBlockWarning(failed) {
  if (!failed || !/cannot run inside a transaction block/i.test(failed.error)) return null;
  return `${failed.file} cannot run inside a transaction block (for example create index concurrently); this job applies each migration in one transaction, so prove it out of band`;
}

// --workdir points the CLI at the base copy's config.toml (ports, project_id),
// the stack db start brought up, not the PR head's.
function runPgTap({ exec, root, project, dir, expectedFiles }) {
  const result = exec("supabase", ["test", "db", "--local", "--debug", "--workdir", project, dir], { cwd: root });
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

export const CHECKER_SOURCES = Object.freeze(["base", "head", "unknown"]);

/**
 * `checkerSource` says where the workflow took this script from: "base" (HEAD^1,
 * so the PR could not edit the checker), "head" (the base has no copy yet, or a
 * PR listed a file the base lacks) or "unknown" (run by hand). A "head" result
 * proves nothing about an unmodified gate; OVD-845 should not count it as one.
 */
export function emptyReport({ mode, base, head, checkerSource = "unknown", stage = "apply" }) {
  return {
    schema: REPORT_SCHEMA,
    mode,
    stage,
    target: "ephemeral",
    checkerSource,
    base,
    head,
    result: "fail",
    baseline: { status: "pending", migrations: 0 },
    migrations: { selected: [], applied: [], failed: null, skipped: [] },
    drafts: { touched: [], selected: [], excluded: [], applied: [], failed: null, skipped: [] },
    families: [],
    policyTests: skippedTests("not run"),
    pendingTests: { touched: [], selected: [], ...skippedTests("not run") },
    warnings: [],
  };
}

/** "pass" only when every phase that ran passed and nothing stopped early. */
export function decideResult(report) {
  const familiesOk = (report.families ?? []).every(familyRollbackOk);
  const rollbackStage = report.stage === "rollback";
  const policyOk = rollbackStage
    ? report.policyTests.status === "pass" || report.policyTests.status === "skipped"
    : report.policyTests.status === "pass";
  // The rollback stage runs pending pgTAP only for families that have rollback
  // files. A family reported "none" still has selected tests from the apply
  // path; skipping them here must not fail the stage.
  const pendingOk = rollbackStage
    ? report.pendingTests.status !== "fail"
    : report.pendingTests.status === "pass" || (report.pendingTests.status === "skipped" && report.pendingTests.selected.length === 0);
  const ok =
    report.baseline.status === "pass" &&
    report.migrations.failed === null &&
    report.drafts.failed === null &&
    familiesOk &&
    policyOk &&
    pendingOk;
  return ok ? "pass" : "fail";
}

/**
 * Runs the whole flow with an injected `exec(cmd, args, { cwd }) -> { status, stdout, stderr }`.
 * Returns the report; never throws for a database or test failure.
 */
export function runEphemeralDb({ root, base, head, dbUrl = DEFAULT_DB_URL, psql = "docker", mode = "report", checkerSource = "unknown", planOnly = false, rollback = false, paths = DEFAULT_PATHS, exec, workDir, log = () => {} }) {
  const report = emptyReport({ mode, base, head, checkerSource, stage: rollback ? "rollback" : "apply" });
  assertAllowedTarget(report.target);
  assertLocalDatabaseUrl(dbUrl);
  const git = (...args) => {
    const result = exec("git", args, { cwd: root });
    if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${errorExcerpt(result)}`);
    return result.stdout ?? "";
  };

  const changes = selectChanges(parseNameStatus(git("diff", "--name-status", "--no-renames", base, head)), paths);
  const families = resolveDraftFamilies({ touched: [...changes.touchedDrafts, ...changes.touchedPendingTests], ...readDraftInventory(root, paths) });
  const familyRecords = families.families.map((family) => ({
    ...family,
    rollbacks: rollbacksNewestFirst(family.drafts, listRollbackFiles(root, paths)),
    rollback: "not-run",
  }));
  report.families = familyRecords;
  const baseFilenames = git("ls-tree", "-r", "--name-only", base, "--", paths.migrations)
    .split("\n").filter((path) => path.endsWith(".sql")).map((path) => basename(path));
  report.baseline.migrations = baseFilenames.length;
  report.migrations.selected = changes.migrations;
  report.drafts = { ...report.drafts, touched: changes.touchedDrafts, selected: families.drafts, excluded: families.excluded };
  const pendingTests = (result) => ({ touched: changes.touchedPendingTests, selected: families.pendingTests, ...result });
  report.pendingTests = pendingTests(skippedTests("not run"));
  const warn = (message) => { report.warnings.push(message); log(`warning: ${message}`); };
  if (checkerSource === "head") warn("checker scripts came from the PR head, not the base; this run does not prove an unmodified gate");
  for (const path of changes.modifiedMigrations) warn(`${path} edits a migration already on the base; production will not re-run it`);
  for (const path of changes.deletedMigrations) warn(`${path} deletes a migration already on the base`);
  for (const path of findOutOfOrder(changes.migrations, baseFilenames)) warn(`${path} is not newer than the latest base migration`);
  for (const path of changes.invalidMigrations) warn(`${path} is not a valid migration filename and was not applied`);
  for (const { file, reason } of families.excluded) warn(`${file} was not applied: ${reason}`);
  const usedPaths = [...changes.migrations, ...families.drafts, ...families.pendingTests];
  if (rollback) usedPaths.push(...familyRecords.flatMap((family) => family.rollbacks));
  const unsafePaths = findUnsafePaths(usedPaths);
  if (unsafePaths.length > 0) {
    report.baseline = { ...report.baseline, status: "fail", error: `unsafe file names selected: ${unsafePaths.join(", ")}` };
    return { ...report, result: "fail" };
  }
  log(`base ${base}: ${baseFilenames.length} migrations; PR adds ${changes.migrations.length}; draft families select ${families.drafts.length} drafts and ${families.pendingTests.length} pending tests`);
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

  const applyWith = (singleTransaction) => (file) => {
    log(`applying ${file}`);
    const { cmd, args } = psqlCommand({ psql, root, dbUrl, file, singleTransaction });
    return exec(cmd, args, { cwd: root });
  };
  report.migrations = { selected: changes.migrations, ...applyInOrder(changes.migrations, applyWith(true)) };
  if (report.migrations.failed) {
    log(`migration failed: ${report.migrations.failed.file}`);
    const blocked = transactionBlockWarning(report.migrations.failed);
    if (blocked) warn(blocked);
    report.policyTests = skippedTests(`migration ${report.migrations.failed.file} failed`);
    report.pendingTests = pendingTests(skippedTests(`migration ${report.migrations.failed.file} failed`));
    return { ...report, result: "fail" };
  }

  if (rollback) {
    report.policyTests = skippedTests("rollback stage proves draft-family rollbacks; the apply step runs policy pgTAP");
    const outcome = runFamilyRollbacks({
      root,
      families: familyRecords,
      exec,
      psql,
      dbUrl,
      workDir,
      project,
      log,
      applyFile: applyWith(false),
    });
    report.families = outcome.families;
    report.drafts = { ...report.drafts, applied: outcome.applied, failed: outcome.draftFailed, skipped: outcome.skipped };
    report.pendingTests = pendingTests(outcome.pending);
    return { ...report, result: decideResult(report) };
  }

  log("running policy pgTAP");
  try {
    const receipt = stagePolicyTests(join(root, "supabase/tests"), join(workDir, "policy-tests"));
    report.policyTests = { ...runPgTap({ exec, root, project, dir: join(workDir, "policy-tests"), expectedFiles: receipt.selectedSql.length }), staged: receipt.selectedSql.length };
  } catch (error) {
    report.policyTests = { status: "fail", error: error.message };
  }

  report.drafts = { ...report.drafts, ...applyInOrder(families.drafts, applyWith(false)) };
  if (report.drafts.failed) {
    report.pendingTests = pendingTests(skippedTests(`draft ${report.drafts.failed.file} failed`));
  } else if (families.pendingTests.length === 0) {
    report.pendingTests = pendingTests(skippedTests("no pending tests in the touched draft families"));
  } else {
    log("running the draft families' pending pgTAP");
    const dir = join(workDir, "pending-tests");
    const expectedFiles = stagePendingTests(root, families.pendingTests, dir);
    report.pendingTests = pendingTests(runPgTap({ exec, root, project, dir, expectedFiles }));
  }
  return { ...report, result: decideResult(report) };
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function renderSummary(report) {
  const list = (items) => (items.length ? items.map((item) => `\`${item}\``).join(", ") : "none");
  const lines = [
    `## Ephemeral DB (${report.mode} mode): ${report.result.toUpperCase()}`,
    "",
    `- Checker scripts from: ${report.checkerSource}`,
    `- Base \`${report.base}\`: ${report.baseline.migrations} migrations, start ${report.baseline.status}`,
    `- New migrations applied: ${list(report.migrations.applied)}`,
  ];
  if (report.migrations.failed) lines.push(`- **Failed migration: \`${report.migrations.failed.file}\`**`);
  if (report.migrations.skipped.length) lines.push(`- Not reached: ${list(report.migrations.skipped)}`);
  lines.push(`- Policy pgTAP: ${report.policyTests.status}${report.policyTests.reason ? ` (${report.policyTests.reason})` : ""}`);
  lines.push(`- Drafts applied (touched families): ${list(report.drafts.applied)}`);
  if (report.drafts.failed) lines.push(`- **Failed draft: \`${report.drafts.failed.file}\`**`);
  lines.push(`- Pending pgTAP (${list(report.pendingTests.selected)}): ${report.pendingTests.status}`);
  for (const family of report.families ?? []) {
    const rollback = family.rollback;
    if (!rollback || rollback === "not-run") continue;
    if (rollback === "none") lines.push(`- Family \`${family.id}\` rollback: none`);
    else lines.push(`- Family \`${family.id}\` rollback: dm1r ${rollback.dm1r}, replay ${rollback.replay}, reapply ${rollback.reapply}, pgtap ${rollback.pgtap}, post-rollback pgtap ${rollback.postRollbackPgtap}`);
  }
  for (const warning of report.warnings) lines.push(`- Warning: ${warning}`);
  const failure = report.migrations.failed ?? report.drafts.failed;
  const familyErrors = (report.families ?? []).flatMap((family) => family.rollback?.errors ?? (family.rollback?.error ? [family.rollback.error] : []));
  const error = failure?.error ?? report.error ?? report.baseline.error ?? report.policyTests.error ?? report.pendingTests.error;
  for (const message of new Set([error, ...familyErrors].filter(Boolean))) lines.push("", "```", message, "```");
  if (report.stage === "rollback") lines.push("", "_Rollback stage: a family failure fails the job. The job is not a required check._");
  else if (report.mode === "report") lines.push("", "_Report mode: this check never blocks the PR._");
  return `${lines.join("\n")}\n`;
}

export function parseArgs(argv) {
  const options = { root: process.cwd(), base: "HEAD^1", head: "HEAD", dbUrl: DEFAULT_DB_URL, psql: "docker", report: null, workDir: null, checkerSource: "unknown", planOnly: false, enforce: false, rollback: false };
  const valued = { "--root": "root", "--base": "base", "--head": "head", "--db-url": "dbUrl", "--psql": "psql", "--report": "report", "--work-dir": "workDir", "--checker-source": "checkerSource" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan-only") options.planOnly = true;
    else if (arg === "--enforce") options.enforce = true;
    else if (arg === "--rollback") options.rollback = true;
    else if (valued[arg] && index + 1 < argv.length) options[valued[arg]] = argv[(index += 1)];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!["docker", "local"].includes(options.psql)) throw new Error("--psql must be docker or local");
  if (!CHECKER_SOURCES.includes(options.checkerSource)) throw new Error(`--checker-source must be one of ${CHECKER_SOURCES.join(", ")}`);
  return { ...options, root: resolve(options.root) };
}

function spawnExec(cmd, args, { cwd }) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64_000_000, timeout: 19 * 60_000 });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.enforce ? "enforce" : "report";
  // The workflow passes --work-dir so its stop step can find <work-dir>/base-project.
  const workDir = options.workDir ? resolve(options.workDir) : mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ephemeral-db-"));
  mkdirSync(workDir, { recursive: true });
  let report;
  try {
    report = runEphemeralDb({ ...options, mode, exec: spawnExec, workDir, log: (line) => console.log(`[ephemeral-db] ${line}`) });
  } catch (error) {
    report = {
      ...emptyReport({ mode, base: options.base, head: options.head, checkerSource: options.checkerSource, stage: options.rollback ? "rollback" : "apply" }),
      result: "error",
      error: error.message,
    };
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) writeFileSync(options.report, json);
  console.log(json);
  if (report.migrations.failed) console.log(`::error file=${report.migrations.failed.file}::migration failed in the ephemeral database`);
  for (const family of report.families ?? []) {
    if (family.rollback?.error) console.log(`::error::${family.rollback.error.split("\n")[0]}`);
  }
  if (report.error) console.log(`::error::ephemeral-db: ${report.error}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(report));
  const passed = report.result === "pass" || report.result === "planned";
  const blocks = options.enforce || options.rollback;
  if (!passed) console.log(`[ephemeral-db] result ${report.result}${blocks ? "" : " (report mode: exit 0)"}`);
  process.exitCode = blocks && !passed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
