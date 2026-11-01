#!/usr/bin/env node
import { assertSupportedPlatform, resolveFixedBinary } from "./lib/fixed-binaries.mjs";
// OVD-857: Release bot merge-plan read-back and show-me-your-work decision log.
// Local git plumbing on a given repo path. This script never merges, pushes,
// fetches, moves a ref, or touches a remote; the operator refreshes refs first.
// The rebased read-back runs `git merge-tree --write-tree` (git >= 2.38), which
// writes loose tree/blob objects into the object store but no refs.
// Exit codes: 0 ok, 1 tree mismatch / unverified / refused / log rewritten,
// 2 usage, platform or git error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DECISION_COLUMNS = ["ts", "pr", "head_sha", "patch_id", "verdict_ref", "action", "merge_sha", "tree_match", "result"];
export const DECISION_HEADER = `${DECISION_COLUMNS.join("\t")}\n`;
export const ACTIONS = ["plan-land", "plan-stop", "plan-digest", "readback", "stop-ack"];

/** Fixed, root-owned binary directories. The caller's PATH is never consulted. */
const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];

// The environment for every git subprocess: the caller's environment with every
// GIT_* variable removed (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE,
// GIT_OBJECT_DIRECTORY, GIT_CONFIG_PARAMETERS, ...), so a hook or wrapper cannot
// point git at another repo, index, or object store than --repo. The tool sets
// no GIT_* variable of its own. PATH is pinned to SAFE_BIN_DIRS. Built per call
// so it reflects the environment at the time git runs.
export function gitEnv(env = process.env) {
  const scrubbed = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...scrubbed, PATH: SAFE_BIN_DIRS.join(":") };
}

/** Absolute path of `name` in the first SAFE_BIN_DIRS entry that has it. */
export function resolveBinary(name, options = {}) {
  return resolveFixedBinary(name, { dirs: SAFE_BIN_DIRS, ...options });
}

export { assertSupportedPlatform };

let gitBinary = null;
const gitBin = () => {
  assertSupportedPlatform();
  return (gitBinary ??= resolveBinary("git"));
};

/** Test hook: use this git binary (null restores normal resolution). */
export function setGitBinaryForTesting(binary) {
  gitBinary = binary;
}

// git answers "no" (unknown revision, not an ancestor, no common ancestor) with
// exit status 1 and an empty stderr. Anything else, including a missing or
// failing git binary, is an error and must never be read as "no".
function gitSaidNo(error) {
  return error?.status === 1 && !error.signal && !String(error.stderr ?? "").trim();
}

function git(repo, args, input) {
  return execFileSync(gitBin(), ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: gitEnv(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitOk(repo, args) {
  try {
    execFileSync(gitBin(), ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    if (gitSaidNo(error)) return false;
    throw error;
  }
}

function resolveCommit(repo, rev) {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  } catch (error) {
    if (gitSaidNo(error)) return null;
    throw error;
  }
}

const treeOf = (repo, rev) => git(repo, ["rev-parse", `${rev}^{tree}`]);

// Revisions reach git as argv, so refuse anything git could read as an option.
export function assertSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{4,64}$/i.test(value)) throw new Error(`${label} must be a hex commit SHA, got ${JSON.stringify(value)}`);
  return value;
}

export function assertRef(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("-") || /\s/.test(value) || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a git ref without a leading '-' or whitespace, got ${JSON.stringify(value)}`);
  }
  return value;
}

const isFullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

// True only when base is head or an ancestor of it. Both must already be full
// 40-hex SHAs; anything else is false, so callers fail closed.
export function isAncestor(repo, base, head) {
  if (!isFullSha(base) || !isFullSha(head)) return false;
  return gitOk(repo, ["merge-base", "--is-ancestor", "--end-of-options", base, head]);
}

// Context-free patch-id for forensics only; never a pass, stop, or skip gate.
export function patchId(repo, base, head) {
  const diff = git(repo, ["diff-tree", "-p", "-U0", "--no-color", base, head]);
  if (!diff) return "";
  return git(repo, ["patch-id", "--stable"], `${diff}\n`).split(/\s+/)[0] ?? "";
}

function lookupVerdict(verdicts, pr) {
  if (typeof verdicts === "function") return verdicts(pr);
  if (verdicts instanceof Map) return verdicts.get(pr) ?? verdicts.get(String(pr));
  return verdicts?.[pr] ?? verdicts?.[String(pr)];
}

// stack: bottom-up [{pr, head_sha}]. verdicts: OVD-845 lookup, either a
// function pr -> {sha, verdict_ref, valid} or a map/object keyed by PR.
// base: the commit the bottom PR's branch starts from; it is the bottom PR's
// verified base, and each PR above uses the verified head below it.
// Lands only the contiguous verified run from the bottom; stops at the first
// PR without a valid verdict for its current head SHA.
export function planContiguousVerified(stack, verdicts, { base } = {}) {
  if (base !== undefined) assertSha(base, "stack base");
  assertPlannableStack(stack);
  const land = [];
  for (const entry of stack) {
    const verdict = lookupVerdict(verdicts, entry.pr);
    const reason = verdictStopReason(verdict, entry);
    if (reason) {
      return { base: base ?? null, land, stop: { pr: entry.pr, head_sha: entry.head_sha ?? "", verdict_ref: verdict?.verdict_ref ?? "", reason } };
    }
    land.push({ pr: entry.pr, head_sha: entry.head_sha, verdict_ref: verdict.verdict_ref });
  }
  return { base: base ?? null, land, stop: null };
}

// Rejects a malformed stack before anything is planned or logged.
function assertPlannableStack(stack) {
  const seen = new Set();
  for (const entry of stack) {
    if (entry?.pr === undefined || entry.pr === null || entry.pr === "") throw new Error("stack entry is missing pr");
    // A short or malformed head would plan fine, then compare unequal to the
    // resolved full SHA the read-back logs, and force a false STOP.
    if (!isFullSha(entry.head_sha)) throw new Error(`head_sha for PR ${entry.pr} must be a full 40-hex commit SHA, got ${JSON.stringify(entry.head_sha)}`);
    if (seen.has(String(entry.pr))) throw new Error(`duplicate PR in stack: ${entry.pr}`);
    seen.add(String(entry.pr));
  }
}

// Why this PR cannot land, or null when its verdict is valid at its head.
function verdictStopReason(verdict, entry) {
  if (!verdict) return "no-verdict";
  if (verdict.valid !== true) return "verdict-not-valid";
  if (!entry.head_sha || verdict.sha !== entry.head_sha) return "verdict-sha-stale";
  if (!verdict.verdict_ref) return "verdict-ref-missing";
  return null;
}

// `git fetch` moves origin/main, not local main, so prefer origin/main when the
// repo has it. An explicit mainRef always wins.
export function defaultMainRef(repo) {
  return resolveCommit(repo, "refs/remotes/origin/main") ? "origin/main" : "main";
}

function assertReadBackInputs({ mergeSha, verifiedHead, mainRef }) {
  if (mergeSha) assertSha(mergeSha, "merge sha");
  if (verifiedHead) assertSha(verifiedHead, "verified head");
  if (mainRef) assertRef(mainRef, "main ref");
}

const OVERRIDE_REMOVED = "the verified base is always derived (plan base or the verified head below; merge-base for a standalone read-back); a verified_base override is not accepted";

function mergeBase(repo, a, b) {
  try {
    return git(repo, ["merge-base", "--end-of-options", a, b]);
  } catch (error) {
    if (gitSaidNo(error)) return null;
    throw error;
  }
}

// A bottom PR's verified base must be where its branch left main,
// merge-base(head, main). Anything else fails closed.
function bottomBaseError(repo, head, main, base) {
  const fork = main ? mergeBase(repo, head, main) : null;
  if (fork === base) return null;
  return `bottom-base-differs-from-merge-base: plan base ${base} != merge-base(head, main) ${fork ?? "(none)"}`;
}

// The verified head replayed onto the merge's parent, or a failure reason.
function rebasedTreeOf(repo, base, parent, head) {
  try {
    return { tree: git(repo, ["merge-tree", "--write-tree", `--merge-base=${base}`, parent, head]).split("\n")[0] };
  } catch (error) {
    // merge-tree exits 1 on conflicts; anything else is a git error (e.g. git < 2.38).
    if (error.status === 1) return { reason: "rebase-conflict" };
    throw new Error(`git merge-tree --write-tree failed (needs git >= 2.38): ${String(error.stderr || error.message).trim()}`);
  }
}

function compareToVerified(repo, result, { parent, base, head, main, bottom }) {
  // Without this, a base set to the merge's parent (e.g. the main tip) passes a
  // squash that carries the head tree and so reverts main since the fork point.
  if (!isAncestor(repo, base, head)) return { ...result, reason: "verified-base-not-ancestor-of-head" };
  // An ancestor that is not the fork point (e.g. head~1) would hide the
  // commits below it from the comparison and pass a partial landing.
  const bottomError = bottom ? bottomBaseError(repo, head, main, base) : null;
  if (bottomError) return { ...result, reason: bottomError };
  if (parent === base && result.merge_tree === result.expected_tree) {
    return { ...result, tree_match: true, mode: "exact", reason: "tree-equals-verified-head" };
  }
  const rebased = rebasedTreeOf(repo, base, parent, head);
  if (rebased.reason) return { ...result, reason: rebased.reason };
  const next = { ...result, expected_tree: rebased.tree };
  if (rebased.tree === result.merge_tree) {
    return { ...next, tree_match: true, mode: "rebased", reason: "rebased-tree-matches" };
  }
  return { ...next, reason: "tree-mismatch-after-rebase" };
}

// Read main back after a merge. A queued merge or an armed auto-merge is not a
// merge: the commit must exist, be on mainRef, and either sit directly on the
// verified base with a tree equal to the verified head's tree, or
// (after main moved) equal the verified head
// rebased onto the merge commit's parent. A tree that equals the verified head
// on top of any other parent would silently revert that parent's changes.
// The verified base must be an ancestor of the verified head, or the read-back
// fails closed whatever the trees say.
// The standalone read-back derives the base as merge-base(parent, head), which
// is only right for an unstacked PR; it is a diagnostic, not proof. There is
// no base override: passing verifiedBase throws.
export function readBack(options) {
  if (Object.hasOwn(options ?? {}, "verifiedBase")) throw new Error(OVERRIDE_REMOVED);
  const { repo, mergeSha, verifiedHead, mainRef } = options;
  return readBackOn({ repo, mergeSha, verifiedHead, mainRef, planBase: null, bottom: false });
}

// planBase: the plan-derived base (plan.base for the bottom PR, else the
// verified head below), or null to derive merge-base(parent, head).
// bottom: planBase must also equal merge-base(head, main).
function readBackOn({ repo, mergeSha, verifiedHead, mainRef, planBase, bottom }) {
  assertReadBackInputs({ mergeSha, verifiedHead, mainRef });
  const result = {
    merge_sha: mergeSha ?? "",
    verified_head: verifiedHead ?? "",
    tree_match: false,
    mode: null,
    main_ref: "",
    on_main: false,
    merge_tree: "",
    expected_tree: "",
    patch_id: "",
    verified_patch_id: "",
    reason: "",
  };
  const merge = mergeSha ? resolveCommit(repo, mergeSha) : null;
  const head = verifiedHead ? resolveCommit(repo, verifiedHead) : null;
  if (!merge) return { ...result, reason: "merge-commit-missing" };
  if (!head) return { ...result, reason: "verified-head-missing" };
  result.merge_sha = merge;
  result.verified_head = head;

  result.main_ref = mainRef || defaultMainRef(repo);
  const main = resolveCommit(repo, result.main_ref);
  result.on_main = Boolean(main) && gitOk(repo, ["merge-base", "--is-ancestor", "--end-of-options", merge, main]);

  const parents = git(repo, ["rev-list", "--parents", "-n", "1", merge]).split(" ").slice(1);
  const parent = parents[0] ?? null;
  let base = null;
  if (planBase) base = resolveCommit(repo, planBase);
  else if (parent) base = mergeBase(repo, parent, head);

  result.merge_tree = treeOf(repo, merge);
  result.expected_tree = treeOf(repo, head);
  if (parent) result.patch_id = patchId(repo, parent, merge);
  if (base) result.verified_patch_id = patchId(repo, base, head);

  if (!result.on_main) return { ...result, reason: "not-on-main" };
  if (parents.length !== 1) return { ...result, reason: "not-a-single-parent-squash" };
  if (!base) return { ...result, reason: planBase ? "verified-base-missing" : "tree-mismatch" };
  return compareToVerified(repo, result, { parent, base, head, main, bottom });
}

function readBackRow(merge, result) {
  const outcome = result.tree_match ? `landed (${result.mode})` : `STOP ${result.reason}: flag to Grok Bot and Blaine, no auto-revert`;
  return {
    pr: merge.pr,
    head_sha: result.verified_head || merge.head_sha,
    patch_id: result.patch_id,
    verdict_ref: merge.verdict_ref,
    action: "readback",
    merge_sha: result.merge_sha || merge.merge_sha,
    tree_match: String(result.tree_match),
    result: outcome,
  };
}

const passedReadBack = (rows, entry) =>
  rows.some((row) => row.action === "readback" && row.tree_match === "true" && row.pr === String(entry.pr) && row.head_sha === entry.head_sha);

const isBottomOfPlan = (plan, merge) => plan?.land?.length > 0 && String(plan.land[0].pr) === String(merge.pr);

function planEntryError(entry, merge) {
  if (!entry) return `pr-not-in-plan-land: ${merge.pr}`;
  if (merge.head_sha && merge.head_sha !== entry.head_sha) return `head-sha-not-the-verified-head: ${merge.pr}`;
  if (merge.verdict_ref && merge.verdict_ref !== entry.verdict_ref) return `verdict-ref-differs-from-plan: ${merge.pr}`;
  return null;
}

// expected: the plan index the next merge must be, or null for the first merge,
// which may start above the bottom only over passed read-backs.
function planOrderError(land, index, merge, rows, expected) {
  if (expected === null) {
    const below = land.slice(0, index).find((lower) => !passedReadBack(rows, lower));
    return below ? `out-of-order: ${below.pr} has no passing read-back below ${merge.pr}` : null;
  }
  if (index === expected) return null;
  return `out-of-order: expected ${land[expected]?.pr ?? "(end of plan)"}, got ${merge.pr}`;
}

// Binds read-backs to the plan: every merge must be a PR in plan.land at the
// planned (verdict) head SHA, in bottom-up order. The first merge may start
// above the bottom only if every PR below it already read back true in rows.
// Returns the merges with head_sha and verdict_ref taken from the plan, and
// verified_base derived from stack order: plan.base for the bottom PR, the
// verified head of the PR below for every other PR. A merge that carries its
// own verified_base is refused; there is no override.
export function checkMergesAgainstPlan({ plan, merges, rows = [] }) {
  if (!plan || !Array.isArray(plan.land)) return { ok: false, reason: "plan-missing" };
  if (!Array.isArray(merges)) return { ok: false, reason: "merges-not-a-list" };
  const land = plan.land;
  const resolved = [];
  let expected = null;
  for (const merge of merges) {
    if (merge && Object.hasOwn(merge, "verified_base")) return { ok: false, reason: `verified-base-override-not-allowed: ${merge.pr}` };
    const index = land.findIndex((entry) => String(entry.pr) === String(merge.pr));
    const error = planEntryError(land[index], merge) ?? planOrderError(land, index, merge, rows, expected);
    if (error) return { ok: false, reason: error };
    const entry = land[index];
    expected = index + 1;
    const verifiedBase = index === 0 ? plan.base : land[index - 1].head_sha;
    if (!verifiedBase) return { ok: false, reason: `plan-base-missing: no verified base for bottom PR ${entry.pr}` };
    resolved.push({ ...merge, pr: entry.pr, head_sha: entry.head_sha, verdict_ref: entry.verdict_ref, verified_base: verifiedBase });
  }
  return { ok: true, merges: resolved };
}

// A merge whose PR already read back true at the same head SHA: a no-op when
// it names the same merge commit, a refusal when it names a different one.
// Returns {skip: true}, {refused}, or {} for a merge not yet read back.
function priorReadBack(repo, rows, merge) {
  const prior = rows.find((row) => row.action === "readback" && row.tree_match === "true" && row.pr === String(merge.pr) && row.head_sha === merge.head_sha);
  if (!prior) return {};
  if (resolveCommit(repo, merge.merge_sha) === prior.merge_sha) return { skip: true };
  return { refused: `already-read-back: PR ${merge.pr} at ${merge.head_sha} passed as ${prior.merge_sha}, not ${merge.merge_sha}` };
}

const openStopReason = (stop) => `open-stop: PR ${stop.pr} read back tree_match=false; ack it with stop-ack first`;

function assertMergeShas(merge) {
  assertSha(merge.merge_sha, `merge_sha for PR ${merge.pr}`);
  assertSha(merge.head_sha, `head_sha for PR ${merge.pr}`);
  assertSha(merge.verified_base, `verified_base for PR ${merge.pr}`);
}

// Splits plan-checked merges into those still to read back and those already
// passed, or returns {refused} for a passed PR named at another merge commit.
function partitionByPrior(repo, rows, merges) {
  const todo = [];
  const skipped = [];
  for (const merge of merges) {
    const prior = priorReadBack(repo, rows, merge);
    if (prior.refused) return { refused: prior.refused };
    if (prior.skip) skipped.push({ pr: merge.pr, merge_sha: merge.merge_sha });
    else todo.push(merge);
  }
  return { todo, skipped };
}

function readBackPlanned({ repo, merge, plan, mainRef, rows = [] }) {
  const index = plan.land.findIndex((entry) => String(entry.pr) === String(merge.pr));
  if (index > 0) {
    const lower = plan.land[index - 1];
    const prior = rows.findLast((row) => row.action === "readback" && row.tree_match === "true" && row.pr === String(lower.pr) && row.head_sha === lower.head_sha);
    const commit = resolveCommit(repo, merge.merge_sha);
    const parent = commit ? resolveCommit(repo, `${commit}^1`) : null;
    // A logged lower merge missing from this clone is a recorded STOP, not a git error.
    if (prior && !resolveCommit(repo, prior.merge_sha)) {
      return { tree_match: false, reason: `lower-merge-missing: PR ${lower.pr} below ${merge.pr}` };
    }
    // Array order cannot prove landing order: the lower squash must precede this parent.
    if (!prior || !isAncestor(repo, prior.merge_sha, parent)) {
      return { tree_match: false, reason: `lower-merge-not-ancestor-of-parent: PR ${lower.pr} below ${merge.pr}` };
    }
  }
  return readBackOn({ repo, mergeSha: merge.merge_sha, verifiedHead: merge.head_sha, mainRef, planBase: merge.verified_base, bottom: isBottomOfPlan(plan, merge) });
}

// The plan file must be the one `plan` logged: for every merge, the latest
// plan row for that PR in the log is a plan-land at the same head_sha and
// verdict_ref. A hand-written or edited plan.json, or a plan superseded by a
// later plan-stop for the PR, fails closed. Returns a refusal reason or null.
export function planDigest(plan) {
  const entry = ({ pr, head_sha, verdict_ref }) => ({ pr, head_sha, verdict_ref });
  // Explicit fields keep incidental output metadata out of the plan identity.
  const canonical = { base: plan.base, land: plan.land.map(entry), stop: plan.stop ? { ...entry(plan.stop), reason: plan.stop.reason } : null };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function planLogMismatch(rows, merges, plan) {
  for (const merge of merges) {
    const latest = rows.findLast((row) => (row.action === "plan-land" || row.action === "plan-stop") && row.pr === String(merge.pr));
    if (!latest) return `plan-not-in-log: no plan row for PR ${merge.pr}`;
    if (latest.action !== "plan-land") return `plan-not-in-log: latest plan row for PR ${merge.pr} is ${latest.action}`;
    if (latest.head_sha !== merge.head_sha || latest.verdict_ref !== merge.verdict_ref) {
      return `plan-not-in-log: PR ${merge.pr} plan.json head_sha/verdict_ref differ from the logged plan-land row`;
    }
  }
  const digestIndex = rows.findLastIndex((row) => row.action === "plan-digest");
  if (digestIndex < 0) return "plan-not-in-log: no plan-digest row";
  const latestPlan = rows.findLastIndex((row) => row.action === "plan-land" || row.action === "plan-stop");
  if (digestIndex < latestPlan || rows[digestIndex].result !== `plan-sha256:${planDigest(plan)}`) return "plan-digest-mismatch";
  return null;
}

// merges: bottom-up [{pr, merge_sha}]; plan: the plan JSON.
// Refuses merges that are not the plan's verified run (see
// checkMergesAgainstPlan), a plan that does not match the log's plan-land rows
// (see planLogMismatch), and refuses while the log has an open stop.
// Reads each merge back in order, logs one row per read-back, and stops at the
// first tree_match=false. Later merges are not read back or reported landed.
// A merge that already read back true at the same head and merge SHA is
// skipped without a new row.
export function readBackRun({ repo, merges, logPath, mainRef, plan }) {
  const refused = (reason) => ({ landed: [], skipped: [], stop: null, refused: reason });
  if (mainRef) assertRef(mainRef, "main ref");
  const rows = logPath ? readDecisions(logPath) : [];
  const stop = openStop(rows);
  if (stop) return refused(openStopReason(stop));
  const check = checkMergesAgainstPlan({ plan, merges, rows });
  if (!check.ok) return refused(check.reason);
  check.merges.forEach(assertMergeShas);
  const mismatch = planLogMismatch(rows, check.merges, plan);
  if (mismatch) return refused(mismatch);
  const { todo, skipped, refused: priorRefused } = partitionByPrior(repo, rows, check.merges);
  if (priorRefused) return refused(priorRefused);
  const landed = [];
  for (const merge of todo) {
    const result = readBackPlanned({ repo, merge, plan, mainRef, rows });
    if (logPath) appendDecision(logPath, readBackRow(merge, result));
    if (!result.tree_match) return { landed, skipped, stop: { pr: merge.pr, ...result } };
    rows.push({ ...readBackRow(merge, result), pr: String(merge.pr) });
    landed.push({ pr: merge.pr, ...result });
  }
  return { landed, skipped, stop: null };
}

// Parses the decision log into row objects keyed by column ([] if absent).
export function readDecisions(logPath) {
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) return [];
  const text = fs.readFileSync(logPath, "utf8");
  if (!text.startsWith(DECISION_HEADER)) throw new Error(`${logPath} does not start with the decision-log header`);
  return text
    .slice(DECISION_HEADER.length)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cells = line.split("\t");
      return Object.fromEntries(DECISION_COLUMNS.map((column, index) => [column, cells[index] ?? ""]));
    });
}

// The latest tree_match=false read-back not followed by a stop-ack, or null.
// While one is open, plan and read-back on the same log refuse to proceed.
export function openStop(rows) {
  let open = null;
  for (const row of rows) {
    if (row.action === "readback" && row.tree_match === "false") open = row;
    else if (row.action === "stop-ack") open = null;
  }
  return open;
}

// One TSV cell: single line, no tabs, and no leading formula bytes.
export function sanitizeCell(value) {
  const text = String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function formatDecisionRow(row) {
  const unknown = Object.keys(row).filter((key) => !DECISION_COLUMNS.includes(key));
  if (unknown.length) throw new Error(`unknown decision column(s): ${unknown.join(", ")}`);
  if (!ACTIONS.includes(row.action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
  const filled = { ...row, ts: row.ts ?? new Date().toISOString() };
  return `${DECISION_COLUMNS.map((column) => sanitizeCell(filled[column])).join("\t")}\n`;
}

function readBytes(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

// Append-only: writes the header on first use, never rewrites prior bytes.
// Each row is one O_APPEND write. Refuses to append after a partial last line
// (no trailing newline, e.g. a crash mid-write) so rows never fuse together.
export function appendDecision(logPath, row) {
  const line = formatDecisionRow(row);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    fs.writeFileSync(logPath, DECISION_HEADER + line, { flag: "wx" });
    return line;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const fd = fs.openSync(logPath, "a+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      fs.writeSync(fd, DECISION_HEADER + line);
      return line;
    }
    if (!readBytes(fd, 0, DECISION_HEADER.length).equals(Buffer.from(DECISION_HEADER))) {
      throw new Error(`${logPath} does not start with the decision-log header`);
    }
    if (readBytes(fd, size - 1, 1).toString() !== "\n") {
      throw new Error(`${logPath} ends in a partial row (no trailing newline); inspect it and append a newline before logging`);
    }
    fs.writeSync(fd, line);
    return line;
  } finally {
    fs.closeSync(fd);
  }
}

export function logDigest(logPath) {
  const bytes = fs.readFileSync(logPath);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// prior: a string/Buffer snapshot of earlier content, or {bytes, sha256} from
// logDigest. Passes only if the current log keeps those bytes as its prefix.
export function verifyAppendOnly(logPath, prior) {
  if (!fs.existsSync(logPath)) return { ok: false, reason: "log-missing" };
  const current = fs.readFileSync(logPath);
  if (!current.subarray(0, DECISION_HEADER.length).equals(Buffer.from(DECISION_HEADER))) {
    return { ok: false, reason: "header-changed" };
  }
  const digest = typeof prior === "string" || Buffer.isBuffer(prior)
    ? { bytes: Buffer.byteLength(prior), sha256: createHash("sha256").update(prior).digest("hex") }
    : prior;
  if (!digest || !Number.isInteger(digest.bytes) || typeof digest.sha256 !== "string") {
    return { ok: false, reason: "prior-digest-invalid" };
  }
  if (current.length < digest.bytes) return { ok: false, reason: "log-truncated" };
  const prefix = createHash("sha256").update(current.subarray(0, digest.bytes)).digest("hex");
  if (prefix !== digest.sha256) return { ok: false, reason: "prior-rows-rewritten" };
  return { ok: true, reason: current.length === digest.bytes ? "unchanged" : "appended", bytes: current.length };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, ...keys) {
  const missing = keys.filter((key) => !options[key]);
  if (missing.length) throw new Error(`missing --${missing.join(", --")}`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const SHA_OPTIONS = ["merge-sha", "verified-head"];

function validateRevOptions(options) {
  if (options["verified-base"] !== undefined) throw new Error(`--verified-base is not accepted: ${OVERRIDE_REMOVED}`);
  for (const key of SHA_OPTIONS) if (options[key] !== undefined) assertSha(options[key], `--${key}`);
  if (options.main !== undefined) assertRef(options.main, "--main");
  if (options.repo?.startsWith("-")) throw new Error("--repo must not start with '-'");
}

const USAGE = `usage: merge-readback.mjs <command> [options]
  init-log  --log <tsv>
  plan      --stack <stack.json> --verdicts <verdicts.json> [--log <tsv>]   (stdout is the plan JSON)
            stack.json: {"base": "<sha the bottom PR branches from>", "prs": [{"pr": n, "head_sha": "<sha>"}, ...]}
  readback  --repo <path> --merge-sha <sha> --verified-head <sha> [--main <ref>]
            [--log <tsv> --plan <plan.json> --pr <n>]
  readback-run --repo <path> --merges <merges.json> --plan <plan.json> --log <tsv> [--main <ref>]
  stop-ack  --log <tsv> --pr <n> --by <who> --note <text>
  digest    --log <tsv>
  verify-log --log <tsv> --prior <digest.json>
  plan/readback (with --log)/readback-run/stop-ack: [--prior <digest.json>] [--digest-out <file>]`;

function cmdInitLog({ options }) {
  required(options, "log");
  if (fs.existsSync(options.log) && fs.statSync(options.log).size > 0) throw new Error(`${options.log} already exists`);
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  fs.writeFileSync(options.log, DECISION_HEADER);
  return 0;
}

function logPlan(logPath, plan) {
  for (const entry of plan.land) {
    appendDecision(logPath, { ...entry, action: "plan-land", result: "verified-at-head" });
  }
  if (plan.stop) {
    appendDecision(logPath, { pr: plan.stop.pr, head_sha: plan.stop.head_sha, verdict_ref: plan.stop.verdict_ref, action: "plan-stop", result: `stop: ${plan.stop.reason}` });
  }
  appendDecision(logPath, { action: "plan-digest", result: `plan-sha256:${planDigest(plan)}` });
}

function cmdPlan({ options, print, refuse }) {
  required(options, "stack", "verdicts");
  const stop = options.log ? openStop(readDecisions(options.log)) : null;
  if (stop) return refuse(openStopReason(stop));
  const stack = readJson(options.stack);
  if (!stack || Array.isArray(stack) || !Array.isArray(stack.prs)) throw new Error(`${options.stack} must be {"base": "<sha>", "prs": [...]}`);
  const plan = planContiguousVerified(stack.prs, readJson(options.verdicts), { base: stack.base ?? "" });
  if (options.log) logPlan(options.log, plan);
  print(plan);
  return 0;
}

// The plan-bound merge for `readback --log`: {merge, plan}, {refused}, or {skipped}.
function planBoundMerge(options) {
  required(options, "plan", "pr");
  const rows = readDecisions(options.log);
  const stop = openStop(rows);
  if (stop) return { refused: openStopReason(stop) };
  const plan = readJson(options.plan);
  const check = checkMergesAgainstPlan({
    plan,
    merges: [{ pr: options.pr, head_sha: options["verified-head"], merge_sha: options["merge-sha"] }],
    rows,
  });
  if (!check.ok) return { refused: check.reason };
  const [merge] = check.merges;
  assertSha(merge.verified_base, `verified_base for PR ${merge.pr}`);
  const mismatch = planLogMismatch(rows, [merge], plan);
  if (mismatch) return { refused: mismatch };
  const prior = priorReadBack(options.repo, rows, merge);
  if (prior.refused) return { refused: prior.refused };
  if (prior.skip) return { skipped: { pr: merge.pr, merge_sha: merge.merge_sha } };
  return { merge, plan };
}

function cmdReadback({ options, print, refuse }) {
  required(options, "repo", "merge-sha", "verified-head");
  let result;
  if (options.log) {
    const bound = planBoundMerge(options);
    if (bound.refused) return refuse(bound.refused);
    if (bound.skipped) {
      print({ skipped: bound.skipped, reason: "already-read-back" });
      return 0;
    }
    result = readBackPlanned({ repo: options.repo, merge: bound.merge, plan: bound.plan, mainRef: options.main, rows: readDecisions(options.log) });
    appendDecision(options.log, readBackRow(bound.merge, result));
  } else {
    result = readBack({ repo: options.repo, mergeSha: options["merge-sha"], verifiedHead: options["verified-head"], mainRef: options.main });
  }
  print(result);
  return result.tree_match ? 0 : 1;
}

function cmdReadbackRun({ options, print }) {
  required(options, "repo", "merges", "plan", "log");
  const run = readBackRun({
    repo: options.repo,
    merges: readJson(options.merges),
    plan: readJson(options.plan),
    logPath: options.log,
    mainRef: options.main,
  });
  print(run);
  return run.stop || run.refused ? 1 : 0;
}

function cmdStopAck({ options, print }) {
  required(options, "log", "pr", "by", "note");
  const stop = openStop(readDecisions(options.log));
  if (!stop) throw new Error("no open stop to acknowledge");
  if (stop.pr !== String(options.pr)) throw new Error(`open stop is PR ${stop.pr}, not ${options.pr}`);
  appendDecision(options.log, {
    pr: stop.pr,
    head_sha: stop.head_sha,
    verdict_ref: stop.verdict_ref,
    action: "stop-ack",
    merge_sha: stop.merge_sha,
    result: `ack by ${options.by}: ${options.note}`,
  });
  print({ acknowledged: stop.pr });
  return 0;
}

function cmdDigest({ options, print }) {
  required(options, "log");
  print(logDigest(options.log));
  return 0;
}

function cmdVerifyLog({ options, print }) {
  required(options, "log", "prior");
  const result = verifyAppendOnly(options.log, readJson(options.prior));
  print(result);
  return result.ok ? 0 : 1;
}

const COMMANDS = {
  "init-log": cmdInitLog,
  plan: cmdPlan,
  readback: cmdReadback,
  "readback-run": cmdReadbackRun,
  "stop-ack": cmdStopAck,
  digest: cmdDigest,
  "verify-log": cmdVerifyLog,
};

export function runCli(argv, out = process.stdout, platform = process.platform) {
  assertSupportedPlatform(platform);
  const { command, options } = parseArgs(argv);
  validateRevOptions(options);
  const handler = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command] : null;
  if (!handler) throw new Error(`unknown command: ${command ?? "(none)"}`);
  const print = (value) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  const refuse = (reason) => {
    print({ refused: reason });
    return 1;
  };
  const tracked = ["plan", "readback", "readback-run", "stop-ack"].includes(command);
  if (tracked && options.prior) {
    required(options, "log");
    const verified = verifyAppendOnly(options.log, readJson(options.prior));
    if (!verified.ok) return refuse(verified.reason);
  }
  const withDigest = (value) => {
    if (!tracked || !options.log) return print(value);
    const digest = logDigest(options.log);
    if (options["digest-out"]) fs.writeFileSync(options["digest-out"], `${JSON.stringify(digest, null, 2)}\n`);
    print(command === "plan" ? value : { ...value, log_digest: digest });
  };
  return handler({ options, print: withDigest, refuse });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`merge-readback: ${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  }
}
