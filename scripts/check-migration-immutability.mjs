#!/usr/bin/env node
/**
 * OVD-871: migration immutability check.
 *
 * Applied migrations are history. Under supabase/migrations/ a PR may only add
 * files (git status A). Everything else is a violation: modified (M), deleted
 * (D), renamed (R, including a rename that keeps the bytes) and copied (C)
 * files, mode-only changes and type changes. Each added file must be named
 * <14-digit timestamp>_<name>.sql and its timestamp must sort after the newest
 * timestamp at the base, so a new file cannot be backdated into history.
 * The rules are documented in docs/migration-immutability.md.
 *
 * Override: the migration-edit-approved label waives the violations only when
 * the PR timeline shows the approver (Blaine, GitHub login optomachina by
 * default) applied it after the current head SHA was pushed. A new push voids
 * it. A waiver is reported as gate_loosening. Every timestamp is read with
 * parseGitHubTimestamp; if the decision depends on one it rejects, the
 * override is unavailable (fail closed).
 *
 * Usage:
 *   --base-ref <ref> --head-ref <ref>  refs to compare (CI: HEAD^1 and HEAD).
 *   --timeline <file>                  PR timeline events (JSON array, pages of
 *                                      arrays, or one JSON object per line).
 *   --timeline-error <message>         the timeline could not be fetched.
 *   --head-sha <sha>                   the PR head SHA being checked.
 *   --head-pushed-at <iso>             when that head was pushed (CI: the
 *                                      pull_request event's updated_at), as
 *                                      GitHub writes it: 2026-10-10T09:00:00Z.
 *   --approver <login>                 override approver (default optomachina).
 *
 * Report mode is the default: findings are printed and the exit code is 0.
 * --enforce exits 1 when there are unwaived findings. --json prints the JSON
 * report on stdout instead of the human report; --json-out <file> writes it.
 *
 * gate_loosening (report only, never changes ok or the exit code) also covers
 * edits to this script, its node:test wrapper or its CI job. CI runs the base
 * copy of this script (via `npm run test:portable-node` today), so a PR's edits
 * to the checker take effect only after merge. The script reads git and the
 * timeline file it is given; it never calls the network.
 *
 * Import only Node built-ins: CI copies this file out of the base commit into
 * a temp directory and runs it there, where relative imports do not resolve.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATIONS_DIR = "supabase/migrations";
export const REPORT_SCHEMA = "ovd871.migration-immutability.v1";
export const CHECKER_PATH = "scripts/check-migration-immutability.mjs";
/** Runs the checker inside `npm run test:portable-node`. */
export const NODE_TEST_PATH = "scripts/check-migration-immutability.node-test.mjs";
export const WORKFLOWS_DIR = ".github/workflows";
export const CI_JOB = "migration-immutability";
export const OVERRIDE_LABEL = "migration-edit-approved";
export const DEFAULT_APPROVER = "optomachina";
export const GATE_LOOSENING_REQUIRES = ["grokbot_countersign", "blaine_card"];
export const MIGRATION_NAME = /^(\d{14})_[^/]+\.sql$/;
/** Timeline events that move the head without a new SHA of its own. */
const HEAD_MOVE_EVENTS = new Set(["head_ref_force_pushed", "head_ref_restored"]);

const compareCodeUnits = (a, b) => (a < b ? -1 : Number(a > b));

const STATUS_KIND = { M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };

// ---------------------------------------------------------------------------
// Status rule
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --raw -z` output into
 * [{ status, score, oldMode, newMode, oldBlob, newBlob, path, oldPath? }].
 * R and C entries carry two paths (source, then destination).
 */
export function parseRawDiff(raw) {
  const parts = raw.split("\0");
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head.startsWith(":")) { i += 1; continue; }
    const [oldMode, newMode, oldBlob, newBlob, code] = head.slice(1).split(" ");
    const status = code[0];
    const score = code.length > 1 ? Number(code.slice(1)) : null;
    if (status === "R" || status === "C") {
      entries.push({ status, score, oldMode, newMode, oldBlob, newBlob, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      entries.push({ status, score, oldMode, newMode, oldBlob, newBlob, path: parts[i + 1] });
      i += 2;
    }
  }
  return entries;
}

const inMigrations = (path) => typeof path === "string" && path.startsWith(`${MIGRATIONS_DIR}/`);
const baseName = (path) => path.slice(MIGRATIONS_DIR.length + 1);

export function migrationTimestamp(path) {
  const match = MIGRATION_NAME.exec(baseName(path));
  return match ? match[1] : null;
}

function statusFinding(entry) {
  const { status, path, oldPath } = entry;
  const kind = status === "M" && entry.oldBlob === entry.newBlob && entry.oldMode !== entry.newMode
    ? "mode_changed"
    : STATUS_KIND[status] ?? "unknown_status";
  const finding = { kind, status, path };
  if (oldPath) finding.oldPath = oldPath;
  const detail = {
    modified: `${path} is modified.`,
    mode_changed: `${path} changes mode ${entry.oldMode} -> ${entry.newMode} (content unchanged).`,
    deleted: `${path} is deleted.`,
    renamed: entry.score === 100 ? `${oldPath} is renamed to ${path} (content unchanged).` : `${oldPath} is renamed to ${path} and edited.`,
    copied: `${path} is a copy of ${oldPath}.`,
    type_changed: `${path} changes file type.`,
    unknown_status: `${path} has git status ${status}.`,
  }[kind];
  finding.message = `${detail} Migrations are append-only: add a new, later migration instead.`;
  return finding;
}

/** Timestamp and naming findings for added files, against the newest base timestamp. */
function addedFindings(added, newestBase) {
  const findings = [];
  const seen = new Map();
  for (const path of [...added].sort(compareCodeUnits)) {
    const stamp = migrationTimestamp(path);
    if (stamp == null) {
      findings.push({ kind: "invalid_name", status: "A", path, message: `${path} is not named <14-digit timestamp>_<name>.sql directly under ${MIGRATIONS_DIR}/.` });
      continue;
    }
    if (newestBase != null && stamp <= newestBase) {
      findings.push({ kind: "backdated", status: "A", path, timestamp: stamp, newestBaseTimestamp: newestBase, message: `${path} has timestamp ${stamp}, not after the newest base migration ${newestBase}. New migrations cannot be backdated; rename it with a later timestamp.` });
    }
    if (seen.has(stamp)) {
      findings.push({ kind: "duplicate_timestamp", status: "A", path, timestamp: stamp, message: `${path} reuses timestamp ${stamp} from ${seen.get(stamp)}.` });
    } else {
      seen.set(stamp, path);
    }
  }
  return findings;
}

/**
 * Status rule plus backdating. entries: parseRawDiff output limited to the
 * migrations dir. baseFiles: every path under it at the base.
 */
export function evaluateStatus({ entries, baseFiles }) {
  const findings = [];
  const added = [];
  for (const entry of entries) {
    if (!inMigrations(entry.path) && !inMigrations(entry.oldPath)) continue;
    if (entry.status === "A") added.push(entry.path);
    else findings.push(statusFinding(entry));
  }
  const stamps = baseFiles.map(migrationTimestamp).filter(Boolean).sort(compareCodeUnits);
  const newestBaseTimestamp = stamps.at(-1) ?? null;
  findings.push(...addedFindings(added, newestBaseTimestamp));
  return { findings, added: added.sort(compareCodeUnits), newestBaseTimestamp };
}

// ---------------------------------------------------------------------------
// Override (migration-edit-approved, applied by the approver after the push)
// ---------------------------------------------------------------------------

/** Accept a JSON array, pages of arrays (gh --paginate --slurp) or NDJSON. */
export function parseTimeline(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) return [JSON.parse(trimmed)].flat(2);
  return trimmed.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * A full ISO-8601 UTC timestamp exactly as GitHub emits it (timeline
 * created_at, the pull_request payload's updated_at): 2026-10-10T09:00:00Z,
 * or with a fraction, 2026-10-10T09:00:00.123Z.
 */
const GITHUB_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * The only timestamp parser in this file. Returns the instant in ms, or null
 * when the value is unusable. Date.parse alone is not enough: it reads "1",
 * "2026", "Oct 10" and "2026-10-10 9:00" as real dates, so a malformed event
 * would be ordered as if it were genuine. Unusable means:
 * - not a string (numbers, null, objects, arrays, Date objects);
 * - not exactly GITHUB_TIMESTAMP (no time, no seconds, no Z, an offset,
 *   lowercase t/z, surrounding whitespace, an expanded +YYYYYY year);
 * - does not round-trip: the input, with its fraction padded to milliseconds,
 *   must equal Date's own ISO form of the parsed instant. Date.parse rolls
 *   2026-02-30 over to March 2 and 24:00:00 to the next day, and truncates a
 *   fraction finer than a millisecond, so all of those are rejected.
 */
export function parseGitHubTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = GITHUB_TIMESTAMP.exec(value);
  if (match == null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const [, dateTime, fraction = ""] = match;
  return new Date(ms).toISOString() === `${dateTime}.${fraction.padEnd(3, "0")}Z` ? ms : null;
}

/** Pair each event with its parsed created_at (null when unusable). */
const dated = (events) => events.map((event) => ({ event, at: parseGitHubTimestamp(event.created_at) }));

/**
 * Decide whether the override label counts. It counts only when:
 * - the label is on the PR now (its last labeled/unlabeled event is labeled);
 * - that last labeled event's actor is the approver (case-insensitive);
 * - it was created strictly after the head was pushed. The push time is the
 *   later of headPushedAt and any force-push / restore event in the timeline,
 *   so a new push (or force push back to an older SHA) voids the label.
 * Every timestamp below goes through parseGitHubTimestamp; a value it rejects
 * is unusable, and an unusable timestamp that the decision depends on means no
 * override. Fails closed (status unavailable): no timeline, no head SHA, an
 * unusable head push time, a force-push / restore event with an unusable
 * created_at (the head may have moved after the label, and we cannot tell),
 * or a labeled / unlabeled event for the override label with an unusable
 * created_at (we cannot order it against the other label events, so a
 * removal or a non-approver relabel could be hidden). Events for other labels
 * and other event kinds are not read, so their timestamps are irrelevant.
 */
export function evaluateOverride({ timeline = null, timelineError = null, headSha = null, headPushedAt = null, approver = DEFAULT_APPROVER, label = OVERRIDE_LABEL }) {
  const base = { label, approver, headSha, headPushedAt: null, applied: false };
  if (timelineError) return { ...base, status: "unavailable", reason: `timeline unavailable: ${timelineError}` };
  if (timeline == null) return { ...base, status: "unavailable", reason: "no PR timeline (not a pull_request run)" };
  if (!headSha) return { ...base, status: "unavailable", reason: "no PR head SHA given" };
  const givenPushedAt = parseGitHubTimestamp(headPushedAt);
  if (givenPushedAt == null) return { ...base, status: "unavailable", reason: "no usable head push time given" };
  const headMoves = dated(timeline.filter((event) => HEAD_MOVE_EVENTS.has(event?.event)));
  const undated = headMoves.find(({ at }) => at == null);
  if (undated) return { ...base, status: "unavailable", reason: `timeline ${undated.event.event} event has no usable created_at, so the push time is unknown` };
  const pushedAt = Math.max(givenPushedAt, ...headMoves.map(({ at }) => at));
  const pushed = { ...base, headPushedAt: new Date(pushedAt).toISOString() };
  const labelEvents = dated(timeline.filter((event) => (event?.event === "labeled" || event?.event === "unlabeled") && event.label?.name === label));
  if (labelEvents.some(({ at }) => at == null)) {
    return { ...pushed, status: "unavailable", reason: "label event has no usable created_at" };
  }
  const last = labelEvents.reduce((latest, entry) => (latest == null || entry.at >= latest.at ? entry : latest), null);
  if (last == null || last.event.event !== "labeled") return { ...pushed, status: "not_applied", reason: `${label} is not on the PR` };
  const actor = last.event.actor?.login ?? null;
  const event = { actor, created_at: last.event.created_at };
  if (actor == null || actor.toLowerCase() !== approver.toLowerCase()) {
    return { ...pushed, event, status: "ignored", reason: `${label} was applied by ${actor ?? "an unknown actor"}, not ${approver}` };
  }
  if (last.at <= pushedAt) {
    return { ...pushed, event, status: "ignored", reason: `${label} was applied at ${event.created_at}, before the head ${headSha} was pushed (${pushed.headPushedAt}); a new push voids it` };
  }
  return { ...pushed, event, applied: true, status: "approved", reason: `${approver} applied ${label} at ${event.created_at}, after the head ${headSha} was pushed (${pushed.headPushedAt})` };
}

// ---------------------------------------------------------------------------
// Gate loosening (Plan §6): base-to-head changes that weaken this gate
// ---------------------------------------------------------------------------

/**
 * The checker's CI surface in a workflow file: the migration-immutability job
 * block plus any non-comment line elsewhere that names it (needs:, other
 * steps). Returns null when the workflow does not mention the checker at all.
 */
const JOB_HEADER = `  ${CI_JOB}:`;
/** A non-blank line indented by at most two spaces ends a job block. */
const OUTDENTED = /^ {0,2}\S/;
const isComment = (line) => line.trimStart().startsWith("#");

export function checkerWorkflowSurface(text) {
  if (text == null) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === JOB_HEADER);
  let job = null;
  let outside = lines;
  if (start !== -1) {
    const length = lines.slice(start + 1).findIndex((line) => OUTDENTED.test(line));
    const end = length === -1 ? lines.length : start + 1 + length;
    job = lines.slice(start, end).join("\n").trimEnd();
    outside = [...lines.slice(0, start), ...lines.slice(end)];
  }
  const mentions = outside.filter((line) => !isComment(line) && line.includes(CI_JOB)).map((line) => line.trim());
  return job == null && mentions.length === 0 ? null : { job, mentions };
}

const sameSurface = (a, b) => a.job === b.job && JSON.stringify(a.mentions) === JSON.stringify(b.mentions);

/** An edited or deleted checker script; null when unchanged or new. */
function scriptChange({ path, base, head }) {
  if (base == null || base === head) return null;
  if (head == null) return { kind: "checker_removed", path, message: `${path} is deleted.` };
  return { kind: "checker_changed", path, message: `${path} is edited; needs review that it does not relax the check (CI runs the base copy, so the edit takes effect only after merge).` };
}

/** A removed or changed CI job surface; null when the base never ran the job or nothing changed. */
function workflowChange({ path, base, head }) {
  const before = checkerWorkflowSurface(base);
  if (before == null) return null;
  const after = checkerWorkflowSurface(head);
  if (after == null || (before.job != null && after.job == null)) {
    return { kind: "ci_job_removed", path, message: `${path} no longer runs the ${CI_JOB} job.` };
  }
  if (sameSurface(before, after)) return null;
  return { kind: "ci_job_changed", path, message: `${path} changes the ${CI_JOB} job or its references; needs review that it does not relax the check.` };
}

/**
 * Report-only gate_loosening classification. Any of these needs a Grok Bot
 * countersign on top of Blaine's card:
 * - the override label waives violations;
 * - the checker script or its node:test wrapper, or its CI job / workflow
 *   references, changed or were removed.
 * A file the base does not have is being introduced, not loosened.
 * gateFiles: [{ path, kind: "script" | "workflow", base: string|null, head: string|null }].
 */
export function detectGateLoosening({ override = null, waived = [], gateFiles = [] }) {
  const reasons = [];
  if (override?.applied && waived.length > 0) {
    reasons.push({ kind: "override_used", label: override.label, actor: override.event.actor, paths: waived.map((f) => f.path), message: `${override.label} (applied by ${override.event.actor} at ${override.event.created_at}) waives ${waived.length} migration immutability finding(s): ${[...new Set(waived.map((f) => f.path))].join(", ")}.` });
  }
  for (const file of gateFiles) {
    const reason = file.kind === "script" ? scriptChange(file) : workflowChange(file);
    if (reason) reasons.push(reason);
  }
  return { detected: reasons.length > 0, reasons, requires: GATE_LOOSENING_REQUIRES };
}

// ---------------------------------------------------------------------------
// Evaluation and report
// ---------------------------------------------------------------------------

export function evaluate({ entries, baseFiles, gateFiles = [], override: overrideInput = {} }) {
  const { findings, added, newestBaseTimestamp } = evaluateStatus({ entries, baseFiles });
  const override = evaluateOverride(overrideInput);
  const waived = override.applied ? findings : [];
  return {
    schema: REPORT_SCHEMA,
    ok: findings.length === 0 || override.applied,
    findings,
    waived: waived.length > 0,
    added,
    newestBaseTimestamp,
    override,
    gate_loosening: detectGateLoosening({ override, waived, gateFiles }),
  };
}

export const GATE_LOOSENING_LINE = "GATE LOOSENING: needs Grok Bot countersign + Blaine's card (report only; does not fail the build).";

export function formatHuman(result) {
  const lines = [`Migration immutability: ${result.added.length} added migration(s), newest base timestamp ${result.newestBaseTimestamp ?? "none"}.`];
  const prefix = result.waived ? "WAIVED" : "FAIL";
  for (const finding of result.findings) lines.push(`${prefix} ${finding.message}`);
  lines.push(`Override (${result.override.label}): ${result.override.status} — ${result.override.reason}.`);
  if (result.findings.length === 0) lines.push("OK: supabase/migrations only gains new, later files.");
  else if (result.waived) lines.push(`${result.findings.length} finding(s) waived by ${result.override.label}. See docs/migration-immutability.md.`);
  else lines.push(`${result.findings.length} finding(s). See docs/migration-immutability.md.`);
  const loosening = result.gate_loosening?.detected
    ? [GATE_LOOSENING_LINE, ...result.gate_loosening.reasons.map((reason) => `  - ${reason.message}`)]
    : [];
  return [...lines, ...loosening].join("\n");
}

// ---------------------------------------------------------------------------
// Input loading (git refs)
// ---------------------------------------------------------------------------

/** Fixed absolute path, no shell: the PATH never picks the git binary. */
export const GIT = "/usr/bin/git";
const GIT_OPTIONS = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };

const git = (cwd, args) => {
  assertGitPlatform();
  return execFileSync(GIT, args, { ...GIT_OPTIONS, cwd });
};
function assertGitPlatform() {
  if (process.platform === "win32") throw new Error("git on Windows requires WSL");
}

/** A file's content at a ref, or null when it does not exist there. */
export function gitShow(cwd, ref, path, { binary = GIT } = {}) {
  assertGitPlatform();
  const entry = execFileSync(binary, ["ls-tree", "--full-tree", "-z", "--end-of-options", ref, "--", `:(top,literal)${path}`], { ...GIT_OPTIONS, cwd });
  if (!entry) return null;
  const blob = /^[0-7]{6} blob ([0-9a-f]{40}|[0-9a-f]{64})\t[^\0]+\0$/.exec(entry);
  if (!blob) throw new Error(`Expected a single blob for ${ref}:${path}`);
  return execFileSync(binary, ["cat-file", "blob", "--end-of-options", blob[1]], { ...GIT_OPTIONS, cwd });
}

/**
 * -C100% sets the shared rename/copy score to exact matches, so a pure rename
 * or copy shows as R100 / C100 and an edited rename shows as D plus A (both
 * still caught). --find-copies-harder also matches unmodified base files.
 */
export function loadStatusEntries(root, baseRef, headRef) {
  const raw = git(root, ["-c", "diff.renameLimit=0", "diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-C100%", "--find-copies-harder", "--end-of-options", baseRef, headRef, "--", MIGRATIONS_DIR]);
  return parseRawDiff(raw);
}

/** The checker script, its node:test wrapper and every changed workflow file, at both refs. */
function loadGateFiles(root, baseRef, headRef) {
  const changed = git(root, ["diff", "--name-only", "--no-renames", "--end-of-options", baseRef, headRef, "--", CHECKER_PATH, NODE_TEST_PATH, WORKFLOWS_DIR]).split("\n").filter(Boolean);
  return changed.map((path) => ({
    path,
    kind: path === CHECKER_PATH || path === NODE_TEST_PATH ? "script" : "workflow",
    base: gitShow(root, baseRef, path),
    head: gitShow(root, headRef, path),
  }));
}

export function loadInputs(root, baseRef, headRef) {
  return {
    entries: loadStatusEntries(root, baseRef, headRef),
    baseFiles: git(root, ["ls-tree", "--full-tree", "-r", "--name-only", "--end-of-options", baseRef, "--", `:(top,literal)${MIGRATIONS_DIR}`]).split("\n").filter(Boolean),
    gateFiles: loadGateFiles(root, baseRef, headRef),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { enforce: false, json: false, root: process.cwd(), approver: DEFAULT_APPROVER };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--enforce") args.enforce = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--json-out") args.jsonOut = value();
    else if (arg === "--base-ref") args.baseRef = value();
    else if (arg === "--head-ref") args.headRef = value();
    else if (arg === "--root") args.root = resolve(value());
    else if (arg === "--timeline") args.timeline = value();
    else if (arg === "--timeline-error") args.timelineError = value();
    else if (arg === "--head-sha") args.headSha = value();
    else if (arg === "--head-pushed-at") args.headPushedAt = value();
    else if (arg === "--approver") args.approver = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!(args.baseRef && args.headRef)) throw new Error("use --base-ref <ref> --head-ref <ref>");
  return args;
}

function readOverrideInput(args) {
  const input = { headSha: args.headSha ?? null, headPushedAt: args.headPushedAt ?? null, approver: args.approver, timelineError: args.timelineError ?? null };
  if (args.timeline && !input.timelineError) {
    try {
      input.timeline = parseTimeline(readFileSync(args.timeline, "utf8"));
    } catch (error) {
      input.timelineError = `cannot read ${args.timeline}: ${error.message}`;
    }
  }
  return input;
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`check-migration-immutability: ${error.message}\n`);
    return 2;
  }
  const result = evaluate({ ...loadInputs(args.root, args.baseRef, args.headRef), override: readOverrideInput(args) });
  const report = `${JSON.stringify(result, null, 2)}\n`;
  if (args.jsonOut) writeFileSync(args.jsonOut, report);
  if (args.json) {
    stdout.write(report);
  } else {
    const reportMode = result.ok || args.enforce ? "" : "Report mode: not failing the build (pass --enforce to fail).\n";
    stdout.write(`${formatHuman(result)}\n${reportMode}`);
  }
  return args.enforce && !result.ok ? 1 : 0;
}

/**
 * True when node was started on this very file. Node resolves symlinks in
 * import.meta.url but leaves process.argv[1] as given, so compare real paths:
 * on macOS a checker reached through /var/folders (a symlink to /private/var)
 * would otherwise never run, printing nothing and exiting 0 (a silent
 * fail-open). If a path cannot be resolved, fall back to the literal compare.
 */
function isInvokedDirectly(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(resolve(argv1)).href;
  }
}

if (isInvokedDirectly()) process.exitCode = run(process.argv.slice(2));
