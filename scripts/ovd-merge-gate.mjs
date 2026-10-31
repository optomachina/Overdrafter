#!/usr/bin/env node
/**
 * OVD-845 / OVD-959 (PR-G1): `ovd-merge-gate`, the single merge gate check.
 *
 * `evaluate()` is pure. For one head SHA it decides whether the PR has
 * (a) a trusted verifier PASS (or PASS_NOTES without a `high:` note) bound to
 *     the head with readiness.checks green,
 * (b) at least one trusted reviewer PASS bound to the head,
 * (c) no outstanding FAIL and no disagreement over the union of every verdict
 *     bound to the head SHA or the head diff_id (a FAIL stands unless a later
 *     same-role verdict at the same SHA supersedes it for `reason: infra` and
 *     cites a new, verified ci-run/verify-run; a FAIL with findings or a high
 *     note is a product FAIL and needs a new head),
 * (d) verdicts from trusted logins only (TRUSTED_VERIFIERS, a constant here,
 *     never an env or repo variable), with a known model_family (ruling 4),
 * (e) no edited, malformed or unterminated trusted verdict for the head until
 *     a fresh one is posted (untrusted and malformed-by-others blocks are
 *     ignored); a removed (deleted, or edited away) trusted verdict is carried
 *     forward only when it blocks (a FAIL, or a pass with a high note or
 *     finding), and then it still stands in the union exactly as if it had
 *     not been removed; a deleted PASS/PASS_NOTES simply disappears and never
 *     counts as a pass; a removed block that cannot be read fails closed until
 *     a fresh verdict is posted. Removals come from the append-only history
 *     (see "Verdict history" below), keyed on the PR and bound by SHA or
 *     diff_id, so a new head with the same diff_id inherits them,
 * (f) Blaine's `overdrafter.approval/v1` record for any sensitive class, from
 *     the default-branch copy of the sensitive-class detector; a detector
 *     status other than ok, or a missing, partial or stale result, is
 *     classifier_error,
 * (g) independence, enforced only when IDENTITY is "app" (stage B). Ruling 1:
 *     a counted verdict whose verifier id equals a builder in the PR body's
 *     Built-by line (parsed by scripts/agent-graph/built-by.mjs, per
 *     docs/agent-pr-tags.md) is verifier_not_independent; a missing or
 *     unparseable Built-by line is builder_unattributed. Both are warnings in
 *     stage A (until K3) and blocking reasons in stage B,
 * (h) PASS evidence that resolves (ruling 6): a PASS or PASS_NOTES counts
 *     only when one of its https ci-run/verify-run links is a GitHub Actions
 *     run of this repository that reported a check run on the verdict's SHA
 *     (the revision the verdict is bound to the head by); otherwise
 *     evidence_unverified.
 *
 * Fail closed: every missing, unparseable, error, unknown or partial input is
 * a reason, never a pass. The advisory `jev-screen` status is never read.
 *
 * MODE is "report": a would-be failure is written as `neutral` with the title
 * `REPORT: would block: <codes>`. In enforce mode the conclusion is only ever
 * `success` or `failure`.
 *
 * CLI (run from a default-branch checkout; reads GITHUB_TOKEN or GH_TOKEN):
 *   node scripts/ovd-merge-gate.mjs evaluate --pr N --sha S [--json] [--repo o/r] [--no-fetch]
 *       prints the summary; exit 0 when gate is pass, 1 when fail, 2 on usage errors
 *   node scripts/ovd-merge-gate.mjs record --pr N [--repo o/r]
 *       appends the trusted blocking verdicts of the event comment and the
 *       live comments to the PR's verdict history
 *   node scripts/ovd-merge-gate.mjs write --pr N [--repo o/r]
 *       evaluates the live head, re-reads the head, writes the check run
 *   node scripts/ovd-merge-gate.mjs merge-group --sha S [--repo o/r]
 *       writes success on the merge group commit (the queue no-op)
 *
 * See docs/verdict-format.md ("OVD-845 merge gate").
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { loadRouting, parseBuiltBy } from "./agent-graph/built-by.mjs";
import { isEntryPoint } from "./lib/entry-point.mjs";
import { pathCandidates } from "./lib/sensitive-paths.mjs";
import { approvalForHead, parseApprovalComments } from "./approval-record.mjs";
import { assertSha, computeDiffId, resolveBinary } from "./emit-verdict.mjs";
import { detect, fetchPullRequest, gateLooseningForPull, loadConfig } from "./sensitive-class-detect.mjs";
import { FENCE_INFO, extractVerdictBlocks, hasHighNote, parseVerdictComments } from "./verdict-schema.mjs";

export const CHECK_NAME = "ovd-merge-gate";
export const MODE = "report";
export const IDENTITY = "shared-account";
// Kill switch: only a separate Blaine-carded PR may flip this. Reporting only.
export const DOOR_AUTOMERGE = false;
export const CROSS_FAMILY = Object.freeze({ claude: ["codex", "grok"], codex: ["claude"], grok: ["claude"] });
const DOOR_REQUIRED_CHECKS = ["ci", "provider-go-live", "secret-scan"];
/** Stage A trust list. A constant in the default-branch script: optomachina can edit repo variables. */
export const TRUSTED_VERIFIERS = Object.freeze(["optomachina"]);
/** Stage B (IDENTITY "app", PR-G5): only the private App's bot counts. */
export const APP_TRUSTED_VERIFIERS = Object.freeze(["overdrafter-verifier[bot]"]);
/** The merging identity; in stage B its verdicts are ignored (verifier_is_merger). */
export const MERGER_LOGINS = Object.freeze(["optomachina"]);
/** Grok Bot posts approval records as optomachina when Blaine approves the card (residual risk R2). */
export const TRUSTED_APPROVERS = Object.freeze(["optomachina"]);
export const IDENTITY_NOTES = Object.freeze({
  "shared-account": "identity: shared-account (not enforced): verifier ≠ author not enforced (single identity)",
  app: "identity: app (enforced)",
});
/** GitHub Actions; protection pins ovd-merge-gate to it. */
export const GITHUB_ACTIONS_APP_ID = 15368;
/** Ruling 4: the verifier's model_family. Anything else is a malformed verdict. */
export const MODEL_FAMILIES = Object.freeze(["claude", "codex", "grok", "jev", "human"]);
export const MODEL_FAMILY_ALIASES = Object.freeze({ opus: "claude", sonnet: "claude" });
export function normalizeModelFamily(value) {
  if (MODEL_FAMILIES.includes(value)) return value;
  return typeof value === "string" && Object.hasOwn(MODEL_FAMILY_ALIASES, value) ? MODEL_FAMILY_ALIASES[value] : null;
}
export const PASS_EVIDENCE_WORKFLOWS = Object.freeze([".github/workflows/ci.yml", ".github/workflows/verify.yml"]);
// Events whose workflow YAML is read from the default branch. merge_group is
// excluded: its YAML comes from the queue ref, and its job never writes history.
const GATE_EVENTS = Object.freeze(["pull_request_target", "issue_comment", "workflow_dispatch"]);
const RUN_ID = /^[1-9]\d{0,19}$/;

/**
 * Verdict history: the durable, append-only record of trusted blocking
 * verdicts (OVD-959, Codex review of dd68f8a5, findings 1-3).
 *
 * Why check runs on a fixed anchor commit. GitHub keeps no readable copy of
 * a deleted issue comment: the comments, timeline and issue-events APIs drop
 * it, comment edit history (GraphQL userContentEdits) disappears with the
 * comment, and the public events feed is lossy (300 events, 90 days, delayed).
 * So the only way to keep a deleted FAIL is to record it while it is still
 * readable, in a store optomachina cannot delete and that no single gate run
 * owns. Check runs fit, with the permissions the workflow already has
 * (checks: write): there is no API to delete a check run, only the app that
 * created one (GitHub Actions) can update it, and they can be listed with
 * filter=all. Every workflow run records first, in its own job outside the
 * per-PR concurrency group, so a replaced pending gate run cannot lose it,
 * and it records at comment creation as well as on deletion, so the FAIL is
 * kept even when the deletion run itself fails. The records are keyed on the
 * PR (check name ovd-merge-gate-history/pr-<N>) on HISTORY_ANCHOR_SHA (the
 * repository's root commit, which exists forever and is never a PR head), not
 * on a head SHA, so a new head with the same diff_id still sees them.
 * Reading fails closed: an unreadable list or record is missing_input.
 * Provenance is the Actions run id in external_id (OVD-1110), not the check
 * suite: a post onto a SHA this workflow did not run on is not
 * attached to the workflow run, and a suite lookup then sticks every later
 * read on missing_input.
 */
export const HISTORY_ANCHOR_SHA = "a1cd387a57f7441a0c498ac6365148b04c39f724";
export const HISTORY_SCHEMA_ID = "overdrafter.gate-history/v1";
export const historyCheckName = (pr) => `${CHECK_NAME}-history/pr-${pr}`;

const MODES = new Set(["report", "enforce"]);
const IDENTITIES = new Set(["shared-account", "app"]);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PASSING = new Set(["PASS", "PASS_NOTES"]);
const RUN_KINDS = new Set(["ci-run", "verify-run"]);
/** Parser rejections that mean a trusted block could not be read (author_mismatch is ignored: it is not the author's verdict). */
const MALFORMED = new Set(["invalid_json", "schema_error", "missing_comment_timestamps", "unterminated_block"]);
const ALL_TRUSTED = Object.freeze([...TRUSTED_VERIFIERS, ...APP_TRUSTED_VERIFIERS]);
const OPEN_FENCE = "```" + FENCE_INFO;
/** https://github.com/<owner>/<repo>/actions/runs/<id>[/job/<id>|/attempts/<n>]; no part can match another. */
const ACTIONS_RUN_PATH = /^\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d{1,20})(?:\/job\/\d{1,20}|\/attempts\/\d{1,6})?\/?$/;
const ROUTING_FIXTURE = new URL("./fixtures/agent-graph/model-routing.v2.yaml", import.meta.url);

const lower = (login) => (typeof login === "string" ? login.toLowerCase() : null);
const inList = (list, login) => login !== null && list.some((entry) => entry.toLowerCase() === login);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const instant = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NaN;
};
const missing = (detail) => ({ code: "missing_input", detail });

/** Comment order: created_at as an instant, then the numeric id, then block order. */
function compareEntries(a, b) {
  const [x, y] = [instant(a.created_at), instant(b.created_at)];
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  const ids = Number(a.comment_id) - Number(b.comment_id);
  if (Number.isFinite(ids) && ids !== 0) return ids;
  return a.block - b.block;
}

/** True when comment `a` was posted after comment `b` (ids are monotonic; created_at as fallback). */
function postedAfter(a, b) {
  const ids = [Number(a?.comment_id), Number(b?.comment_id)];
  if (ids.every(Number.isFinite)) return ids[0] > ids[1];
  const [x, y] = [instant(a?.created_at), instant(b?.created_at)];
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
}

/** Opening verdict fences, counted per line with startsWith (no regex, no backtracking). */
function openFences(body) {
  return typeof body === "string" ? body.split("\n").filter((line) => line.startsWith(OPEN_FENCE)).length : 0;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function familyErrors(verdict) {
  const family = verdict?.verifier?.model_family;
  if (normalizeModelFamily(family) !== null) return [];
  return [`verdict.verifier.model_family: must be one of ${MODEL_FAMILIES.join(", ")} (got ${JSON.stringify(family ?? null)})`];
}

/** One verdict block through the shared parser, plus the gate's ruling-4 family check. */
function readBlock(comment, text, block, headSha) {
  const single = { ...comment, body: [OPEN_FENCE, text, "```"].join("\n") };
  const parsed = parseVerdictComments([single], { sha: headSha });
  const base = { comment_id: comment.id ?? null, block, author: comment.user?.login ?? null, created_at: comment.created_at ?? null };
  if (parsed.rejected.length) return { rejected: parsed.rejected.map((item) => ({ ...item, ...base, text })) };
  const entry = parsed.latest ?? parsed.reviews[0] ?? parsed.other_sha[0];
  if (!entry) return { rejected: [] };
  const errors = familyErrors(entry.verdict);
  if (errors.length) return { rejected: [{ ...base, reason: "schema_error", errors, text }] };
  return { entry: { ...base, created_at: comment.created_at, verdict: { ...entry.verdict, verifier: { ...entry.verdict.verifier, model_family: normalizeModelFamily(entry.verdict.verifier.model_family) } } }, rejected: [] };
}

/**
 * Every verdict block in the comments, one at a time, through the shared
 * parser. parseVerdictComments only reports the latest verifier verdict and
 * the ones that disagree with it, so an earlier PASS with a high finding
 * would be hidden; giving it one block at a time keeps every entry while
 * reusing its validation (schema, edited comments, author match, timestamps).
 * An opening fence that is never closed is an `unterminated_block`: the
 * shared extractor cannot see it, so it must not silently disappear.
 */
export function collectVerdicts(comments, headSha) {
  const entries = [];
  const rejected = [];
  for (const comment of list(comments)) {
    const blocks = extractVerdictBlocks(comment?.body);
    blocks.forEach((text, block) => {
      const result = readBlock(comment, text, block, headSha);
      if (result.entry) entries.push(result.entry);
      rejected.push(...result.rejected);
    });
    if (openFences(comment?.body) > blocks.length) {
      rejected.push({ comment_id: comment.id ?? null, block: blocks.length, reason: "unterminated_block", errors: ["a verdict fence is never closed"], author: comment.user?.login ?? null, text: "", created_at: comment.created_at ?? null });
    }
  }
  entries.sort(compareEntries);
  return { entries, rejected };
}

/** The Actions run id in a URL, else the URL itself (for "a new run id" comparisons). */
const runId = (url) => /\/actions\/runs\/(\d+)/.exec(url)?.[1] ?? url;
/** The ci-run / verify-run ids a verdict cites. */
const runIds = (verdict) => new Set(list(verdict.evidence).filter((item) => RUN_KINDS.has(item?.kind)).map((item) => runId(item.url)));
/** The https ci-run / verify-run URLs that could carry a PASS (ruling 6). */
const carryingUrls = (verdict) => list(verdict.evidence)
  .filter((item) => RUN_KINDS.has(item?.kind) && typeof item.url === "string" && item.url.startsWith("https://"))
  .map((item) => item.url);
/** True when runGate verified `url` as an Actions run of this repository with a check run on `sha`. */
function verifiedAt(verified, sha, url) {
  if (!isRecord(verified) || typeof sha !== "string" || !Object.hasOwn(verified, sha)) return false;
  return Array.isArray(verified[sha]) && verified[sha].includes(url);
}
const evidenceVerified = (verdict, verified) => carryingUrls(verdict).some((url) => verifiedAt(verified, verdict.sha, url));

const hasHighFinding = (verdict) => Array.isArray(verdict.findings) && verdict.findings.some((finding) => finding?.severity === "high");
const isHigh = (verdict) => hasHighNote(verdict) || hasHighFinding(verdict);
/** A FAIL for product reasons (any finding or a high note) can never be superseded at the same SHA. */
const isProductFail = (verdict) => (Array.isArray(verdict.findings) && verdict.findings.length > 0) || hasHighNote(verdict);

/** A valid infra supersede: later, same SHA, reason infra, and a new run id that resolves at that SHA. */
function supersedes(claim, fail, verified) {
  if (isProductFail(fail.verdict) || claim.verdict.reason !== "infra" || claim.verdict.sha !== fail.verdict.sha || !postedAfter(claim, fail)) return false;
  const old = runIds(fail.verdict);
  return carryingUrls(claim.verdict).some((url) => !old.has(runId(url)) && verifiedAt(verified, claim.verdict.sha, url));
}

/**
 * Split one role's bound entries into outstanding FAILs and the verdicts that
 * supersede a FAIL. A supersede is valid only for a non-product FAIL, at the
 * same SHA, from a later comment, with reason infra and a verified run id the
 * FAIL did not cite. An invalid claim leaves the FAIL standing and is a conflict.
 */
function resolveFails(entries, verified) {
  // Any verdict that is not a pass is a FAIL (live verdicts are schema-checked; a deleted snapshot is not).
  const fails = entries.filter((entry) => !PASSING.has(entry.verdict.verdict));
  const outstanding = [];
  const conflicts = [];
  for (const fail of fails) {
    const claims = entries.filter((entry) => entry !== fail && !entry.deleted && entry.verdict.supersedes !== undefined && Number(entry.verdict.supersedes) === Number(fail.comment_id));
    if (claims.some((claim) => supersedes(claim, fail, verified))) continue;
    outstanding.push(fail);
    for (const claim of claims) conflicts.push(`comment ${claim.comment_id} cannot supersede FAIL ${fail.comment_id} (needs reason infra, the same SHA, a later comment, a new verified run id and a FAIL with no findings or high note)`);
  }
  return { outstanding, conflicts };
}

/** Why a detector result cannot be trusted for this head, or null when its status is ok and complete. */
function classifierProblem(classification, headSha, changedFiles) {
  if (classification === null || classification === undefined || typeof classification !== "object") return "no sensitive-class result (missing)";
  if (classification.status !== "ok") {
    const errors = Array.isArray(classification.errors) && classification.errors.length ? ": " + classification.errors.join("; ") : "";
    return `sensitive-class status is ${JSON.stringify(classification.status ?? null)}, not "ok"${errors}`;
  }
  if (classification.sha !== headSha) return `sensitive-class result is for ${JSON.stringify(classification.sha ?? null)}, not the head ${headSha}`;
  if (!Array.isArray(classification.classes) || classification.classes.some((name) => typeof name !== "string")) return "sensitive-class result has no class list (partial)";
  if (!Array.isArray(classification.files)) return "sensitive-class result has no file list (partial)";
  const classified = new Set(classification.files.map((file) => file?.path));
  const absent = changedFiles.map(changedPath).filter((file) => !classified.has(file));
  if (absent.length) return `sensitive-class result does not cover ${absent.length} changed file(s) (partial): ${absent.slice(0, 5).join(", ")}`;
  return null;
}

const changedPath = (file) => (typeof file === "string" ? file : file?.filename);
const changedPaths = (file) => [changedPath(file), typeof file === "object" ? file?.previous_filename : undefined].filter((name) => typeof name === "string");
/** Any .github/** change is sensitive (infra_ci) in every spelling, whatever the shared list says. */
const touchesGithub = (file) => changedPaths(file).some((name) => pathCandidates(name).some((form) => /^\.github(?:\/|$)/i.test(form)));

/** A block may be for the head unless both its sha and its diff_id are readable and point elsewhere. */
const mayBeForHead = (sha, diffId, head) => typeof sha !== "string" || sha === head.sha || typeof diffId !== "string" || diffId === head.diffId;

function blockTarget(text, head) {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== "object") return { forHead: true, role: null };
  return { forHead: mayBeForHead(parsed.sha, parsed.diff_id, head), role: typeof parsed.role === "string" ? parsed.role : null };
}

const hasFresher = (entries, item, role) => entries.some((entry) => (role === null || entry.verdict.role === role) && postedAfter(entry, item));

function rejectedReason(item) {
  if (item.reason === "edited_comment") return { code: "edited_verdict", detail: `trusted verdict comment ${item.comment_id} was edited; post a fresh verdict` };
  // A trusted block that does not parse may be a FAIL; it never counts as a pass and is not silently dropped.
  if (MALFORMED.has(item.reason)) return { code: "verdict_schema_error", detail: `trusted verdict comment ${item.comment_id} block ${item.block} is ${item.reason}; post a fresh verdict` };
  return null;
}

/** Edited, malformed or unreadable removed trusted verdicts that may be for this head and have no fresher trusted verdict. */
function staleTrustedEdits({ rejected, unreadableDeletions, entries, trusted, head }) {
  const reasons = [];
  for (const item of rejected.filter((entry) => inList(trusted, lower(entry.author)))) {
    const { forHead, role } = blockTarget(item.text, head);
    const reason = forHead && !hasFresher(entries, item, role) ? rejectedReason(item) : null;
    if (reason) reasons.push(reason);
  }
  for (const item of unreadableDeletions.filter((entry) => inList(trusted, lower(entry.author)))) {
    const role = typeof item.role === "string" ? item.role : null;
    if (mayBeForHead(item.sha, item.diff_id, head) && !hasFresher(entries, item, role)) {
      reasons.push({ code: "edited_verdict", detail: `trusted verdict comment ${item.comment_id} was removed and its verdict cannot be read; post a fresh verdict` });
    }
  }
  return reasons;
}

/** A blocking verdict: anything that is not a clean PASS/PASS_NOTES (a FAIL, an unknown verdict, a high note or finding). */
const isBlocking = (verdict) => !PASSING.has(verdict?.verdict) || isHigh(verdict);

/**
 * F1 (OVD-959): a snapshot never carries note text, which is unbounded and
 * would push a history record or gate summary past GitHub's 65535-character
 * output.text cap. It keeps what isBlocking reads: one "high:" marker when
 * any note is high, and a digest of the notes so distinct blocks stay
 * distinct. Idempotent: compacting a compacted list returns it unchanged.
 */
const COMPACT_NOTE = /^(?:high|other): \d+ note\(s\) omitted, sha256 [0-9a-f]{64}$/;
function compactNotes(notes) {
  if (!notes.length) return [];
  if (notes.length === 1 && COMPACT_NOTE.test(notes[0])) return notes;
  const digest = createHash("sha256").update(JSON.stringify(notes)).digest("hex");
  const kind = notes.some((note) => note.startsWith("high:")) ? "high" : "other";
  return [`${kind}: ${notes.length} note(s) omitted, sha256 ${digest}`];
}

/** The verdict fields a removed block keeps, so it can stand in the union and in later gate runs. */
function deletedSnapshot(parsed) {
  if (!isRecord(parsed)) return null;
  const { role, verdict, sha, diff_id: diffId, findings, notes, evidence } = parsed;
  if (!["verifier", "reviewer"].includes(role) || typeof verdict !== "string" || typeof sha !== "string") return null;
  const snapshot = { role, verdict, sha };
  if (typeof diffId === "string") snapshot.diff_id = diffId;
  if (Array.isArray(findings)) snapshot.findings = findings.map((finding) => ({ severity: finding?.severity ?? null }));
  if (Array.isArray(notes)) snapshot.notes = compactNotes(notes.filter((note) => typeof note === "string"));
  if (Array.isArray(evidence)) snapshot.evidence = evidence.filter((item) => item && RUN_KINDS.has(item.kind) && typeof item.url === "string" && item.url.length <= MAX_SNAPSHOT_URL).slice(0, MAX_SNAPSHOT_EVIDENCE).map(({ kind, url }) => ({ kind, url }));
  if (Array.isArray(findings) && findings.length > MAX_SNAPSHOT_FINDINGS) snapshot.findings = summarizeFindings(findings);
  return snapshot;
}

const MAX_SNAPSHOT_URL = 500;
const MAX_SNAPSHOT_EVIDENCE = 10;
const MAX_SNAPSHOT_FINDINGS = 20;
/** One finding per distinct severity (keeps isBlocking/isProductFail unchanged, bounds the size). */
const summarizeFindings = (findings) => [...new Set(findings.map((finding) => finding?.severity ?? null))].map((severity) => ({ severity }));

const historyEntry = (base, snapshot) => ({ ...base, sha: snapshot?.sha ?? null, diff_id: snapshot?.diff_id ?? null, role: snapshot?.role ?? null, ...(snapshot ? { verdict_block: snapshot } : {}) });

/**
 * The blocking verdict blocks of one comment, as history entries: a FAIL, a
 * pass with a high note or finding, or a block that cannot be read (kept
 * without a snapshot, possibly a FAIL for the head). A clean PASS/PASS_NOTES
 * is never recorded. An unterminated fence is an unreadable block.
 */
export function historyEntriesFromComment(comment) {
  if (!isRecord(comment)) return [];
  const base = { comment_id: comment.id ?? null, author: comment.user?.login ?? null, created_at: comment.created_at ?? null };
  const blocks = extractVerdictBlocks(comment.body);
  const entries = blocks.flatMap((text) => {
    const snapshot = deletedSnapshot(parseJson(text));
    return snapshot && !isBlocking(snapshot) ? [] : [historyEntry(base, snapshot)];
  });
  if (openFences(comment.body) > blocks.length) entries.push(historyEntry(base, null));
  return entries;
}

/** The deleted verdict blocks to carry forward from an issue_comment deleted event (blocking or unreadable only). */
export function deletedVerdictsFromEvent(event) {
  if (event?.action !== "deleted" || !event.comment) return [];
  return historyEntriesFromComment(event.comment);
}

const snapshotKey = (item) => JSON.stringify(item?.verdict_block ?? null);
/**
 * Two entries dedupe only when every field the gate reads matches. Records
 * are writer-asserted (see verifyGateProvenance), so a copy that shares a
 * comment id but differs in sha, diff_id, role or created_at must not
 * displace the genuine entry; both stay and each blocks on its own terms.
 */
const historyKey = (item) => JSON.stringify([String(item?.comment_id), lower(item?.author), item?.created_at ?? null, item?.sha ?? null, item?.diff_id ?? null, item?.role ?? null, item?.verdict_block ?? null]);

/**
 * The recorded history entries whose block is no longer posted: the comment
 * was deleted, or edited so it no longer holds that block. Entries still
 * posted are left to the live comments (which also catch an edit).
 */
export function removedHistory(history, comments) {
  const live = new Map(list(comments).filter(isRecord).map((comment) => [String(comment.id), comment]));
  return list(history).filter((item) => {
    const comment = live.get(String(item?.comment_id));
    if (!comment) return true;
    const key = snapshotKey(item);
    return !historyEntriesFromComment(comment).some((entry) => snapshotKey(entry) === key);
  });
}

/** Every removal candidate (event, earlier gate runs, history), once each. */
function deletionCandidates({ deletedVerdicts, history, comments }) {
  const seen = new Set();
  return [...list(deletedVerdicts), ...removedHistory(history, comments)].filter((item) => {
    const key = historyKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sort removed trusted verdicts into the blocking ones that keep standing
 * and the unreadable ones. A removed clean PASS/PASS_NOTES is dropped: it
 * must never count as a pass, and it does not block either. Anything that
 * cannot be read as a verdict fails closed as unreadable.
 */
export function carriedDeletions(deletedVerdicts, trusted) {
  const blocking = [];
  const unreadable = [];
  for (const item of list(deletedVerdicts)) {
    if (!isRecord(item) || !inList(trusted, lower(item.author))) continue;
    const snapshot = deletedSnapshot(item.verdict_block);
    if (!snapshot) unreadable.push(item);
    else if (isBlocking(snapshot)) blocking.push(item);
  }
  return { blocking, unreadable };
}

let routing = null;
try {
  routing = loadRouting(ROUTING_FIXTURE);
} catch {
  // Without routing every Built-by line is unattributed (fail closed).
}

const BUILDER_PREFIXES = ["built-by:", "model-builder:"];

/** The body's Built-by (or legacy Model-builder) lines, lowercased: ids and display names match case-insensitively. */
function builderLines(body) {
  return body.split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => BUILDER_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .map((line) => (line.startsWith("model-builder:") ? "built-by:" + line.slice("model-builder:".length) : line));
}

/**
 * The builder bot ids in the PR body's Built-by line, parsed by the
 * maintained parser (scripts/agent-graph/built-by.mjs, docs/agent-pr-tags.md),
 * and the problem when the line is missing or cannot be (fully) parsed.
 */
export function builderAttribution(body) {
  if (typeof body !== "string") return { ids: [], problem: "the PR body could not be read" };
  const lines = builderLines(body);
  if (!lines.length) return { ids: [], problem: "the PR body has no Built-by line" };
  if (!routing) return { ids: [], problem: "the builder routing fixture could not be loaded" };
  const parsed = parseBuiltBy({ body: lines.join("\n"), routing });
  const ids = [...new Set(parsed.builders.map((builder) => builder.bot).filter((bot) => typeof bot === "string" && bot !== "unknown"))];
  const unparsed = parsed.findings.some((finding) => finding.startsWith("Unparseable") || finding.startsWith("Parser error"))
    || parsed.builders.some((builder) => builder.bot === "unknown");
  return { ids, problem: ids.length && !unparsed ? null : "the PR body's Built-by line cannot be parsed (docs/agent-pr-tags.md)" };
}

export const bodyBuilders = (body) => builderAttribution(body).ids;

/** Ruling 1: counted verdicts whose verifier id equals a builder; and an unattributed builder. */
function builderReasons(entries, prBody) {
  const { ids, problem } = builderAttribution(prBody);
  const builders = new Set(ids);
  const items = entries
    .filter((entry) => !entry.deleted)
    .map((entry) => ({ entry, id: entry.verdict.verifier?.agent_id ?? entry.verdict.verifier?.id }))
    .filter(({ id }) => typeof id === "string" && builders.has(id.toLowerCase()))
    .map(({ entry, id }) => ({ code: "verifier_not_independent", detail: `${entry.verdict.role} comment ${entry.comment_id} verifier id ${id} is the PR's builder (Built-by line)` }));
  if (problem) items.push({ code: "builder_unattributed", detail: `${problem}; verifier independence from the builder cannot be checked` });
  return items;
}

function independenceProblems({ entries, prAuthor, commits }) {
  const ignored = [];
  const reasons = [];
  const authors = new Set([lower(prAuthor)]);
  for (const commit of list(commits)) {
    authors.add(lower(commit?.author?.login));
    authors.add(lower(commit?.committer?.login));
  }
  authors.delete(null);
  const kept = [];
  for (const entry of entries) {
    const author = lower(entry.author);
    if (inList(MERGER_LOGINS, author)) {
      ignored.push({ comment_id: entry.comment_id, code: "verifier_is_merger", detail: `${entry.author} is a merging identity` });
    } else if (authors.has(author)) {
      reasons.push({ code: "verifier_not_independent", detail: `${entry.author} authored or committed this PR (comment ${entry.comment_id})` });
    } else {
      kept.push(entry);
    }
  }
  return { ignored, reasons, kept };
}

/** Trusted entries (d) and, in stage B, independence (g). */
function trustedCandidates({ entries, rejected, trusted, identity, prAuthor, commits }) {
  const candidates = [];
  const ignored = [];
  for (const entry of entries) {
    if (inList(trusted, lower(entry.author))) {
      candidates.push(entry);
      continue;
    }
    const code = identity === "app" && inList(MERGER_LOGINS, lower(entry.author)) ? "verifier_is_merger" : "untrusted_author";
    ignored.push({ comment_id: entry.comment_id, code, detail: `${entry.author ?? "unknown"} is not a trusted verifier` });
  }
  for (const item of rejected) ignored.push({ comment_id: item.comment_id, code: item.reason, detail: (item.errors ?? []).join("; ") });
  if (identity !== "app") return { candidates, ignored, reasons: [] };
  const independence = independenceProblems({ entries: candidates, prAuthor, commits });
  return { candidates: independence.kept, ignored: [...ignored, ...independence.ignored], reasons: independence.reasons };
}

/** Verifier checks (a): the latest bound verifier pass, high notes/findings, readiness. */
function verifierReasons(verifiers, staleVerifier) {
  const reasons = [];
  const passes = verifiers.filter((entry) => PASSING.has(entry.verdict.verdict));
  const chosen = passes.at(-1) ?? null;
  if (!chosen) {
    if (staleVerifier) reasons.push({ code: "diff_id_changed", detail: `verifier verdict ${staleVerifier.comment_id} is for ${staleVerifier.verdict.sha} with a different diff_id; a fresh verdict is needed` });
    else reasons.push({ code: "no_qa_pass_on_head", detail: verifiers.length ? "no verifier PASS bound to the head" : "no trusted verifier verdict bound to the head" });
    return { reasons, chosen: null };
  }
  for (const entry of passes.filter((item) => isHigh(item.verdict))) {
    reasons.push({ code: "no_qa_pass_on_head", detail: `verifier comment ${entry.comment_id} has a high note or finding` });
  }
  if (chosen.verdict.readiness?.checks !== "green") {
    reasons.push({ code: "checks_not_green", detail: `verifier comment ${chosen.comment_id} reports readiness.checks ${JSON.stringify(chosen.verdict.readiness?.checks ?? null)}` });
  }
  return { reasons, chosen };
}

function reviewerReasons(reviewers) {
  const reasons = [];
  const passes = reviewers.filter((entry) => PASSING.has(entry.verdict.verdict));
  for (const entry of passes.filter((item) => isHigh(item.verdict))) {
    reasons.push({ code: "no_review_on_head", detail: `reviewer comment ${entry.comment_id} has a high note or finding` });
  }
  const clean = passes.filter((entry) => !isHigh(entry.verdict));
  if (!clean.length) reasons.push({ code: "no_review_on_head", detail: "no trusted reviewer PASS without a high finding bound to the head" });
  return { reasons, ids: clean.map((entry) => entry.comment_id) };
}

const deletedLabel = (entry) => (entry.deleted ? String(entry.comment_id) + " (deleted)" : String(entry.comment_id));

/** Outstanding FAILs and pass/fail disagreement within one role's union. */
function failReasons(role, entries, verified) {
  const reasons = [];
  const { outstanding, conflicts } = resolveFails(entries, verified);
  for (const detail of conflicts) reasons.push({ code: "verdict_conflict", detail });
  if (outstanding.length) {
    const disagree = entries.some((entry) => PASSING.has(entry.verdict.verdict));
    const ids = outstanding.map(deletedLabel).join(", ");
    if (disagree) reasons.push({ code: "verdict_conflict", detail: `${role} verdicts bound to the head disagree: FAIL in comment(s) ${ids} stands` });
    else reasons.push({ code: role === "verifier" ? "no_qa_pass_on_head" : "no_review_on_head", detail: `${role} FAIL in comment(s) ${ids}` });
  }
  return reasons;
}

/** (a), (b), (c) and (h) over the live bound verdicts and the carried removals. */
function roleReasons({ candidates, deleted, bound, verified }) {
  const reasons = [];
  const live = (role) => candidates.filter((entry) => entry.verdict.role === role && bound(entry));
  const verifiers = live("verifier");
  const reviewers = live("reviewer");
  const staleVerifier = candidates.findLast((entry) => entry.verdict.role === "verifier" && !bound(entry)) ?? null;
  const union = (role, entries) => [...entries, ...deleted.filter((entry) => entry.verdict.role === role)].sort(compareEntries);
  reasons.push(...failReasons("verifier", union("verifier", verifiers), verified), ...failReasons("reviewer", union("reviewer", reviewers), verified));
  // Ruling 6: a pass whose evidence does not resolve at its SHA never counts.
  const unverified = new Set([...verifiers, ...reviewers].filter((entry) => PASSING.has(entry.verdict.verdict) && !evidenceVerified(entry.verdict, verified)));
  for (const entry of unverified) {
    reasons.push({ code: "evidence_unverified", detail: `${entry.verdict.role} comment ${entry.comment_id} cites no https ci-run/verify-run that is a successful allowed CI/Verify workflow run of this repository on ${entry.verdict.sha}` });
  }
  const counted = (entries) => entries.filter((entry) => !unverified.has(entry));
  const verifier = verifierReasons(counted(verifiers), staleVerifier);
  const reviewer = reviewerReasons(counted(reviewers));
  reasons.push(...verifier.reasons, ...reviewer.reasons);
  return { reasons, live: [...verifiers, ...reviewers], verifierId: verifier.chosen?.comment_id ?? null, reviewerIds: reviewer.ids };
}

function sensitiveReasons({ classification, headSha, headDiffId, changedFiles, comments }) {
  const reasons = [];
  const listed = Array.isArray(changedFiles);
  const problem = classifierProblem(classification, headSha, listed ? changedFiles : []) ?? (listed ? null : "changed-file list is missing");
  if (problem) {
    reasons.push({ code: "classifier_error", detail: problem });
    return { reasons, classes: [], approval: null, classifierOk: false };
  }
  const classes = [...classification.classes];
  if (changedFiles.some(touchesGithub) && !classes.includes("infra_ci")) classes.push("infra_ci");
  if (!classes.length) return { reasons, classes, approval: null, classifierOk: true };
  const { approvals } = parseApprovalComments(comments, { trustedLogins: TRUSTED_APPROVERS });
  const approval = approvalForHead(approvals, { headSha, headDiffId });
  if (!approval) for (const name of classes) reasons.push({ code: `approval_missing:${name}`, detail: `sensitive class ${name} needs Blaine's approval record bound to the head SHA or diff_id` });
  return { reasons, classes, approval, classifierOk: true };
}

function settingProblems(input) {
  const reasons = [];
  if (!MODES.has(input.mode)) reasons.push(missing(`unknown mode ${JSON.stringify(input.mode ?? null)}`));
  if (!IDENTITIES.has(input.identity)) reasons.push(missing(`unknown identity ${JSON.stringify(input.identity ?? null)}`));
  return reasons;
}

function inputProblems({ headSha, liveHeadSha, diffIdError, comments, commits, prAuthor }, diffId) {
  const reasons = [];
  if (typeof liveHeadSha !== "string" || !HEX40.test(liveHeadSha)) reasons.push(missing("the live PR head could not be read"));
  else if (liveHeadSha !== headSha) reasons.push({ code: "stale_sha", detail: `PR head is ${liveHeadSha}, not ${headSha}` });
  if (diffId === null) reasons.push({ code: "error", detail: diffIdError ? "head diff_id could not be computed: " + diffIdError : "head diff_id could not be computed" });
  if (!Array.isArray(comments)) reasons.push(missing("PR comment list is missing"));
  if (typeof prAuthor !== "string" || prAuthor === "") reasons.push(missing("PR author is missing"));
  // Every stage: an unreadable or incomplete commit list is never a pass (stage B also needs it for independence).
  if (!Array.isArray(commits) || !commits.every(isRecord)) reasons.push(missing("PR commit list is missing or incomplete"));
  return reasons;
}

/**
 * (e) for removed verdicts: the stale edited, malformed or unreadable ones
 * (only a fresh verdict bound to the head clears them), and the blocking ones
 * that stand as if they were still posted (never a pass).
 */
function removedReasons({ input, rejected, candidates, trusted, head, bound }) {
  const deletions = carriedDeletions(deletionCandidates(input), trusted);
  const reasons = staleTrustedEdits({ rejected, unreadableDeletions: deletions.unreadable, entries: candidates.filter((entry) => bound(entry)), trusted, head });
  const deleted = deletions.blocking
    .map((item) => ({ comment_id: item.comment_id ?? null, block: 0, created_at: item.created_at ?? null, author: item.author, verdict: deletedSnapshot(item.verdict_block), deleted: true }))
    .filter((entry) => bound(entry));
  for (const entry of deleted.filter((item) => PASSING.has(item.verdict.verdict))) {
    const code = entry.verdict.role === "verifier" ? "no_qa_pass_on_head" : "no_review_on_head";
    reasons.push({ code, detail: `deleted ${entry.verdict.role} comment ${entry.comment_id} had a high note or finding` });
  }
  return { reasons, deleted };
}

/** Ruling 1: a warning until K3 (stage A), blocking from K3 on (stage B). */
function addBuilderReasons(summary, entries, prBody) {
  const builder = builderReasons(entries, prBody);
  if (summary.identity === "app") summary.reasons.push(...builder);
  else summary.warnings.push(...builder, { code: "identity_not_enforced", detail: IDENTITY_NOTES["shared-account"] });
}

function emptySummary({ headSha, headDiffId }, mode, identity) {
  return {
    gate: "fail",
    sha: typeof headSha === "string" ? headSha : null,
    diff_id: typeof headDiffId === "string" && HEX64.test(headDiffId) ? headDiffId : null,
    mode,
    identity,
    identity_note: IDENTITY_NOTES[identity],
    verifier_comment_id: null,
    reviewer_comment_ids: [],
    approval_comment_id: null,
    automerge: "needs_blaine",
    sensitive_classes: [],
    door_report: { door: "one-way", ok: false, automerge_enabled: DOOR_AUTOMERGE, reasons: [{ code: "classifier_error", detail: "head input has not been validated" }] },
    reasons: [],
    warnings: [],
    ignored: [],
  };
}

/**
 * Evaluate the gate for one head. Pure: every input is data.
 *
 * @param {object} input
 * @param {string} input.headSha the head SHA being gated (40-hex)
 * @param {string} [input.liveHeadSha] the PR head as re-read from the API; must equal headSha
 * @param {string|null} input.headDiffId diff_id recomputed from base...head, or null when it could not be
 * @param {string} [input.diffIdError] why diff_id could not be computed
 * @param {object[]} input.comments PR issue comments
 * @param {object[]} [input.deletedVerdicts] deleted trusted verdict comments seen ({ comment_id, author, created_at, sha, diff_id, role, verdict_block })
 * @param {object[]} [input.history] the PR's recorded blocking verdicts (same shape); those no longer posted are carried as removed
 * @param {Object<string, string[]>} [input.verifiedEvidence] SHA -> evidence URLs verified as Actions runs on that SHA
 * @param {string} [input.prBody] PR body (data only), read for the Built-by line
 * @param {object[]} input.commits PR commits ({ author: { login }, committer: { login } })
 * @param {string} input.prAuthor PR author login
 * @param {Array<object|string>} input.changedFiles PR files ({ filename, status, previous_filename })
 * @param {object} input.classification the default-branch sensitive-class detector result
 * @param {object[]} [input.requiredChecks] trusted check runs at head_sha (door report only)
 * @param {object} [input.reviewThreads] complete {sha, complete, threads:[{isResolved}]} snapshot; unknown fails the door report
 * @param {object} [input.revertPlan] trusted {sha, ok, required, errors} validation result; unknown fails the door report
 * @param {"report"|"enforce"} input.mode
 * @param {"shared-account"|"app"} input.identity
 */
export function evaluate(given = {}) {
  const input = given !== null && typeof given === "object" ? given : {};
  const mode = MODES.has(input.mode) ? input.mode : "enforce";
  const identity = IDENTITIES.has(input.identity) ? input.identity : "app";
  const summary = emptySummary(input, mode, identity);
  const { reasons } = summary;
  reasons.push(...settingProblems(input));
  const { headSha } = input;
  if (typeof headSha !== "string" || !HEX40.test(headSha)) {
    reasons.push(missing("head SHA is missing or not a 40-hex SHA"));
    return summary;
  }
  reasons.push(...inputProblems(input, summary.diff_id));
  const comments = list(input.comments);
  const trusted = identity === "app" ? APP_TRUSTED_VERIFIERS : TRUSTED_VERIFIERS;
  const { entries, rejected } = collectVerdicts(comments, headSha);
  const { candidates, ignored, reasons: independence } = trustedCandidates({ entries, rejected, trusted, identity, prAuthor: input.prAuthor, commits: input.commits });
  summary.ignored.push(...ignored);
  reasons.push(...independence);

  const head = { sha: headSha, diffId: summary.diff_id };
  const bound = (entry) => entry.verdict.sha === headSha || (head.diffId !== null && entry.verdict.diff_id === head.diffId);
  const removed = removedReasons({ input, rejected, candidates, trusted, head, bound });
  reasons.push(...removed.reasons);

  const roles = roleReasons({ candidates, deleted: removed.deleted, bound, verified: input.verifiedEvidence });
  reasons.push(...roles.reasons);
  summary.verifier_comment_id = roles.verifierId;
  summary.reviewer_comment_ids = roles.reviewerIds;

  const sensitive = sensitiveReasons({ classification: input.classification, headSha, headDiffId: head.diffId, changedFiles: input.changedFiles, comments });
  reasons.push(...sensitive.reasons);
  summary.sensitive_classes = sensitive.classes;
  summary.approval_comment_id = sensitive.approval?.comment_id ?? null;
  // eligible needs proof-check evidence per class (OVD-841), which does not exist yet.
  summary.automerge = sensitive.classifierOk && sensitive.classes.length === 0 ? "needs_release" : "needs_blaine";

  addBuilderReasons(summary, roles.live, input.prBody);
  summary.reasons = dedupeReasons(reasons);
  summary.gate = summary.reasons.length === 0 ? "pass" : "fail";
  try { summary.door_report = revertableOk(input, { summary, candidates }); } catch {
    summary.door_report = { door: "one-way", ok: false, automerge_enabled: DOOR_AUTOMERGE, reasons: [{ code: "classifier_error", detail: "door evaluation failed closed" }] };
  }
  return summary;
}

/**
 * Shadow evaluation only. These reasons never enter the legacy gate reasons.
 * Checks, thread state and the validator result are trusted caller inputs bound
 * to this SHA; missing/unknown inputs fail closed. No labels are consulted.
 */
export function revertableOk(ctx, { summary, candidates } = {}) {
  if (!summary) return evaluate(ctx).door_report;
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, detail });
  const classification = ctx.classification;
  const door = classification?.door === "revertable" ? "revertable" : "one-way";
  if (classification?.door === undefined || classification?.door === null) add("door_missing", "missing door defaults to one-way");
  if (door === "one-way") add("door_one_way", "only a classified revertable door can qualify");
  const problem = classifierProblem(classification, ctx.headSha, list(ctx.changedFiles));
  if (problem || !Array.isArray(ctx.changedFiles)) add("classifier_error", problem ?? "missing changed files");
  if (ctx.liveHeadSha !== ctx.headSha) add("stale_sha", "the PR head moved");
  // Preserve all existing evidence/failure constraints, excluding only approval:
  // the shadow branch reports whether a card could be waived in a later rollout.
  reasons.push(...summary.reasons.filter((reason) => !reason.code.startsWith("approval_missing:")));
  const parsed = routing && parseBuiltBy({ body: typeof ctx.prBody === "string" ? builderLines(ctx.prBody).join("\n") : "", routing });
  const families = [...new Set(list(parsed?.builders).map((builder) => builder.family === "openai" ? "codex" : builder.family))];
  if (!["ok", "mixed"].includes(parsed?.status) || !families.length || families.some((family) => !Object.hasOwn(CROSS_FAMILY, family))) add("builder_unattributed", "every builder must have a known model family");
  reasons.push(...builderReasons(list(candidates).filter((entry) => entry.verdict.sha === ctx.headSha), ctx.prBody));
  const exact = list(candidates).filter((entry) => entry.verdict.sha === ctx.headSha && PASSING.has(entry.verdict.verdict)
    && !isHigh(entry.verdict) && evidenceVerified(entry.verdict, ctx.verifiedEvidence));
  const reviewers = exact.filter((entry) => entry.verdict.role === "reviewer");
  const crossFamily = (reviewer) => {
    const family = normalizeModelFamily(reviewer.verdict.verifier.model_family);
    if (!families.length || families.includes(family) || !Object.hasOwn(CROSS_FAMILY, family)) return false;
    // A single-family build uses the CROSS_FAMILY table. A mixed build needs a
    // reviewer outside every builder family (plan section 5, condition 3), and any
    // Grok builder still needs Claude (Blaine, 2026-10-27), so claude+grok fails closed.
    if (families.length === 1) return CROSS_FAMILY[families[0]].includes(family);
    return !families.includes("grok") || family === "claude";
  };
  if (!reviewers.length) add("no_review_on_head", "no verified reviewer PASS at this exact SHA");
  else if (!reviewers.some(crossFamily)) add("reviewer_same_family", "no reviewer belongs to an allowed family outside every builder family");
  if (!exact.some((entry) => entry.verdict.role === "verifier" && entry.verdict.readiness?.checks === "green")) add("no_qa_pass_on_head", "no verified QA PASS at this exact SHA");
  for (const name of DOOR_REQUIRED_CHECKS) {
    const runs = list(ctx.requiredChecks).filter((run) => run?.name === name && run.head_sha === ctx.headSha);
    const latest = runs.toSorted((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    if (!latest || latest.status !== "completed" || latest.conclusion !== "success") add("required_check_not_green", `${name} is not proven green at this SHA`);
  }
  // Report-only rollout deliberately does not fetch GraphQL reviewThreads.
  // A future trusted caller must supply a complete snapshot for this exact head.
  if (ctx.reviewThreads?.sha !== ctx.headSha || ctx.reviewThreads?.complete !== true
      || !Array.isArray(ctx.reviewThreads?.threads) || ctx.reviewThreads.threads.some((thread) => thread?.isResolved !== true)) add("threads_unresolved", "review threads are unresolved or unknown");
  if (!ctx.revertPlan) add("revert_plan_missing", "no Revert plan validation result");
  else if (ctx.revertPlan.sha !== ctx.headSha || ctx.revertPlan.ok !== true || ctx.revertPlan.required !== true
      || !Array.isArray(ctx.revertPlan.errors) || ctx.revertPlan.errors.length) add("revert_plan_invalid", "Revert plan is invalid, unknown or stale");
  return { door, ok: reasons.length === 0, automerge_enabled: DOOR_AUTOMERGE, reasons: dedupeReasons(reasons) };
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter((reason) => {
    const key = `${reason.code}\u0000${reason.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Distinct reason codes, in first-seen order. */
export const reasonCodes = (summary) => [...new Set((summary?.reasons ?? []).map((reason) => reason.code))];

/**
 * The check-run conclusion and title for a summary. Enforce mode only ever
 * gives success or failure. Report mode gives success or neutral with
 * `REPORT: would block: <codes>`. Anything unexpected is a failure.
 */
export function conclusionFor(summary, mode = summary?.mode) {
  const pass = summary?.gate === "pass" && Array.isArray(summary.reasons) && summary.reasons.length === 0;
  if (pass) return { conclusion: "success", title: `ovd-merge-gate: pass (${mode === "report" ? "report mode" : "enforce"})` };
  const codes = reasonCodes(summary);
  const names = codes.length ? codes.join(", ") : "error";
  if (mode === "report") return { conclusion: "neutral", title: `REPORT: would block: ${names}` };
  return { conclusion: "failure", title: `ovd-merge-gate: fail: ${names}` };
}

const oneLine = (text) => String(text).replaceAll(/[\r\n]+/g, " ");

/** Markdown summary for the check run. */
export function formatSummary(summary) {
  const lines = [
    `**ovd-merge-gate: ${summary.gate}** for \`${summary.sha ?? "unknown"}\` (mode \`${summary.mode}\`)`,
    "",
    summary.identity_note,
    "",
    `automerge: \`${summary.automerge}\``,
    "",
  ];
  for (const reason of summary.reasons) lines.push(`- \`${reason.code}\`: ${oneLine(reason.detail)}`);
  if (summary.reasons.length) lines.push("");
  const warnings = list(summary.warnings).filter((warning) => warning?.code !== "identity_not_enforced");
  if (warnings.length) {
    lines.push("Warnings (non-blocking):", "");
    for (const warning of warnings) lines.push(`- \`${warning.code}\` (warning): ${oneLine(warning.detail)}`);
    lines.push("");
  }
  const legacy = lines.join("\n");
  if (!summary.door_report) return legacy;
  const report = [
    `Door report (auto-merge off): \`${summary.door_report.door}\`; revertable conditions: ${summary.door_report.ok ? "pass" : "fail"}`,
    "",
    ...summary.door_report.reasons.map((reason) => `- door \`${reason.code}\`: ${oneLine(reason.detail)}`),
    "",
  ].join("\n");
  // Optional reporting cannot make a previously writable summary exceed the API cap.
  return legacy + report.slice(0, Math.max(0, Math.min(4000, MAX_OUTPUT_TEXT - legacy.length)));
}

// ----------------------------------------------------------------- IO

const REPO = /^[\w.-]+\/[\w.-]+$/;
const PR_NUMBER = /^[1-9]\d{0,6}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const FETCH_HEAD_REF = "refs/ovd-merge-gate/head";
const FETCH_BASE_REF = "refs/ovd-merge-gate/base";
const SAFE_PATH = "/usr/bin:/bin:/usr/local/bin";
/** At most this many distinct verdict SHAs have their evidence resolved per run; the rest stay unverified. */
const MAX_EVIDENCE_SHAS = 20;
/** Check-run output.text is capped at 65535 characters by GitHub. */
const MAX_OUTPUT_TEXT = 60000;

export class GithubApiError extends Error {
  constructor(status, apiPath) {
    super(`GitHub API ${apiPath} returned ${status}`);
    this.status = status;
  }
}

/** Minimal GitHub REST client over fetch: json/raw (what the detector's fetchPullRequest uses), paginate, post. */
export function createApi({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
  const headers = { "x-github-api-version": "2022-11-28", "user-agent": "overdrafter-ovd-merge-gate" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = async (method, apiPath, { body, accept = "application/vnd.github+json" } = {}) => {
    const response = await fetchImpl(`${apiUrl}${apiPath}`, {
      method,
      headers: { ...headers, accept, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new GithubApiError(response.status, apiPath);
    return response;
  };
  const json = async (apiPath) => (await request("GET", apiPath)).json();
  const paginate = async (apiPath, pick = (data) => data) => {
    const items = [];
    const joiner = apiPath.includes("?") ? "&" : "?";
    for (let page = 1; page <= 100; page += 1) {
      const data = await json(`${apiPath}${joiner}per_page=100&page=${page}`);
      const batch = pick(data);
      if (!Array.isArray(batch)) throw new Error(`${apiPath} page ${page} is not a list`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(`${apiPath} has more than 100 pages`);
  };
  return {
    json,
    raw: async (apiPath) => (await request("GET", apiPath, { accept: "application/vnd.github.raw" })).text(),
    paginate,
    post: async (apiPath, body) => (await request("POST", apiPath, { body })).json(),
  };
}

/** Default git runner: fixed binary, fixed PATH, no shell; extra env only for this child. */
function defaultGit(args, { cwd, env = {} } = {}) {
  return execFileSync(resolveBinary("git"), args, {
    cwd,
    env: { ...process.env, ...env, PATH: SAFE_PATH, GIT_TERMINAL_PROMPT: "0" },
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Git config through the environment, so the token never reaches argv or .git/config. */
function authEnv(token) {
  if (!token) return {};
  const credentials = Buffer.from("x-access-token:" + token).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + credentials,
  };
}

/** A fresh, empty directory for the bare object store that holds the PR's git data. */
const makeDataStore = () => mkdtempSync(path.join(tmpdir(), "ovd-merge-gate-data-"));

/**
 * Recompute diff_id over base...head. With fetch (the workflow), the PR head
 * and the base branch tip are fetched as git data into a separate, freshly
 * created bare repository (no working tree, so nothing from the PR can be
 * checked out, and the trusted checkout's own object store and refs are never
 * touched), the diff is computed there, and the store is removed. Nothing
 * from the PR is ever executed. Without fetch (a box CLI run) it reads
 * origin/<base> in `cwd`. Returns { diffId, error } and never throws: any
 * failure is "cannot compute".
 */
export function headDiffId({ pr, repo, headSha, baseRef, cwd, token, fetch = true, git = defaultGit, diff = computeDiffId, makeStore = makeDataStore }) {
  let store = null;
  try {
    const head = assertSha(headSha, "head");
    if (typeof baseRef !== "string" || !BRANCH.test(baseRef)) throw new Error(`base ref ${JSON.stringify(baseRef ?? null)} is not a plain branch name`);
    if (!PR_NUMBER.test(String(pr))) throw new Error("PR number is not valid");
    if (!fetch) {
      const base = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/origin/${baseRef}^{commit}`], { cwd }).trim();
      return { diffId: diff({ base: assertSha(base, "base"), head, cwd }), error: null };
    }
    if (typeof repo !== "string" || !REPO.test(repo)) throw new Error("repository is not owner/name");
    store = makeStore();
    git(["init", "--bare", "--quiet", store], { cwd: store });
    git(["--git-dir", store, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", `https://github.com/${repo}.git`, `+refs/pull/${pr}/head:${FETCH_HEAD_REF}`, `+refs/heads/${baseRef}:${FETCH_BASE_REF}`], { cwd: store, env: authEnv(token) });
    const base = git(["--git-dir", store, "rev-parse", "--verify", "--quiet", "--end-of-options", `${FETCH_BASE_REF}^{commit}`], { cwd: store }).trim();
    return { diffId: diff({ base: assertSha(base, "base"), head, cwd: store }), error: null };
  } catch (error) {
    return { diffId: null, error: error?.message ?? String(error) };
  } finally {
    if (store) rmSync(store, { recursive: true, force: true });
  }
}

/**
 * The default-branch sensitive-class detector over the PR, exactly as its
 * CLI runs it (config, file list, SQL content, gate-loosening reads). Any
 * throw becomes a status "error" result.
 */
export async function classifyPull({ client, repo, pr, headSha, root, loadConfigImpl = loadConfig, detectImpl = detect }) {
  try {
    const { config, errors: configErrors, raw: baseRaw, sensitivePathsText } = loadConfigImpl(root ? { root } : {});
    if (!config) return { classification: { status: "error", sha: headSha, errors: configErrors ?? ["detector config did not load"] }, files: null };
    const pull = await fetchPullRequest(client, repo, pr, { expectedHeadSha: headSha });
    const result = await detectImpl({ ...pull, config, allowEmpty: pull.changedFiles === 0 });
    const incomplete = pull.errors.length ? "the changed-file list is incomplete or stale" : null;
    const loosening = await gateLooseningForPull({ ...pull, baseRaw, sensitivePathsText, incomplete });
    if (loosening.gateLoosening.detected) {
      result.door = "one-way";
      (result.door_reasons ??= []).push({ code: "O-GATE" });
    }
    if (loosening.errors.length) {
      result.door = "one-way";
      (result.door_reasons ??= []).push({ code: "classifier_error" });
      result.errors.push(...loosening.errors);
      result.status = "error";
    }
    return { classification: result, files: pull.files };
  } catch (error) {
    return { classification: { status: "error", sha: headSha, errors: [`classifier threw: ${error?.message ?? String(error)}`] }, files: null };
  }
}

const JSON_OPEN = "```json\n";
const JSON_CLOSE = "\n```";
const jsonBlock = (value) => JSON_OPEN + JSON.stringify(value, null, 2) + JSON_CLOSE;

/** The JSON embedded in a check run's output.text, or null. indexOf, not a regex (JSON text never holds a raw newline). */
function jsonFromCheckRun(run) {
  const text = String(run?.output?.text ?? "");
  const start = text.indexOf(JSON_OPEN);
  if (start < 0) return null;
  const end = text.indexOf(JSON_CLOSE, start + JSON_OPEN.length);
  return end < 0 ? null : parseJson(text.slice(start + JSON_OPEN.length, end));
}

const historyItemOk = (item) => isRecord(item) && typeof item.author === "string" && (item.verdict_block === undefined || isRecord(item.verdict_block));

/**
 * Fields that bind a gate check run to the workflow run that wrote it.
 * GITHUB_RUN_ID is the Actions-provided run id; it is not a CLI flag.
 */
export function gateRecordFields(repo, pr, runId) {
  const prText = String(pr);
  const id = typeof runId === "string" ? runId : "";
  if (!REPO.test(String(repo)) || !PR_NUMBER.test(prText) || !RUN_ID.test(id)) throw new Error("gate record needs GITHUB_RUN_ID");
  return {
    external_id: `pr-${prText}:run-${id}`,
    details_url: `https://github.com/${repo}/actions/runs/${id}`,
  };
}

/** The PR number and Actions run id of a gateRecordFields external_id, else null. */
function parseGateExternalId(value) {
  const [prPart, runPart, ...rest] = typeof value === "string" ? value.split(":") : [];
  if (rest.length || !prPart?.startsWith("pr-") || !runPart?.startsWith("run-")) return null;
  const stamp = { pr: prPart.slice(3), runId: runPart.slice(4) };
  return PR_NUMBER.test(stamp.pr) && RUN_ID.test(stamp.runId) ? stamp : null;
}

/**
 * Reject foreign writers before interpreting any stored gate data.
 *
 * OVD-1110: the check suite is not the key. A check run posted with
 * GITHUB_TOKEN onto a SHA this workflow did not run on (the history anchor,
 * or a head whose suite another workflow already owns) is not attached to
 * the ovd-merge-gate run. Looking the suite up then throws on every later
 * read and the gate stays on missing_input. Provenance is external_id
 * `pr-<N>:run-<id>` alone. details_url is informational: GitHub may replace
 * it with the check run's own URL for Actions-created runs, and the writer
 * asserts it just like external_id, so it adds no trust. It is a cross-check
 * only when it is an Actions run URL, which must then be this repository's
 * run <id>. The cited run must be this workflow, on an allowed event, on the
 * default branch (pull_request_target excepted: it reports the PR head branch
 * and runs the base YAML). Records written before this key stay unverifiable
 * and fail closed.
 */
export async function verifyGateProvenance(client, repo, run, pr) {
  if (run?.app?.id !== GITHUB_ACTIONS_APP_ID) throw new Error("gate record has no trusted Actions app");
  const stamp = parseGateExternalId(run?.external_id);
  // pr is required: without it the external_id PR binding would be skipped.
  if (!stamp || stamp.pr !== String(pr)) throw new Error("gate record external_id is not pr-<N>:run-<id> for this PR");
  const { runId } = stamp;
  const linked = typeof run?.details_url === "string" && run.details_url.includes("/actions/runs/");
  if (linked && actionsRunId(run.details_url, repo) !== runId) throw new Error("gate record details_url cites another Actions run");
  const repository = await client.json(`/repos/${repo}`);
  const workflow = await client.json(`/repos/${repo}/actions/runs/${runId}`);
  if (String(workflow?.id) !== runId || workflow.path !== ".github/workflows/ovd-merge-gate.yml"
      || !GATE_EVENTS.includes(workflow.event) || typeof repository.default_branch !== "string"
      // pull_request_target reports the PR's head branch but runs the base branch's YAML.
      || (workflow.event !== "pull_request_target" && workflow.head_branch !== repository.default_branch)) {
    throw new Error("gate record is not from the default-branch merge-gate workflow");
  }
}

/** Earlier gate summaries, including replaced runs; unreadable provenance fails closed. */
async function priorDeletions(client, repo, headSha, pr) {
  const runs = await client.paginate(`/repos/${repo}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=all`, (data) => data?.check_runs);
  await Promise.all(runs.map((run) => verifyGateProvenance(client, repo, run, pr)));
  return runs.flatMap((run) => {
    const summary = jsonFromCheckRun(run);
    if (!isRecord(summary) || !Array.isArray(summary.deleted_verdicts) || !summary.deleted_verdicts.every(historyItemOk)) {
      throw new Error(`earlier ${CHECK_NAME} check run ${run?.id ?? "(no id)"} has no readable summary`);
    }
    return summary.deleted_verdicts;
  });
}

/** One history check run's entries; anything unexpected throws (the caller fails closed). */
export function parseHistoryRun(run, pr) {
  const record = jsonFromCheckRun(run);
  const ok = run?.name === historyCheckName(pr) && isRecord(record) && record.schema === HISTORY_SCHEMA_ID
    && Number(record.pr) === Number(pr) && Array.isArray(record.entries) && record.entries.every(historyItemOk);
  if (!ok) throw new Error(`verdict history check run ${run?.id ?? "(no id)"} for PR ${pr} cannot be read`);
  return record.entries;
}

/** Every recorded blocking verdict for the PR (see HISTORY_ANCHOR_SHA). Throws when unreadable. */
export async function readHistory(client, repo, pr) {
  const name = encodeURIComponent(historyCheckName(pr));
  const runs = await client.paginate(`/repos/${repo}/commits/${HISTORY_ANCHOR_SHA}/check-runs?check_name=${name}&filter=all`, (data) => data?.check_runs);
  await Promise.all(runs.map((run) => verifyGateProvenance(client, repo, run, pr)));
  return runs.flatMap((run) => parseHistoryRun(run, pr));
}

async function attempt(task) {
  try {
    return await task();
  } catch {
    return undefined;
  }
}

/**
 * Append the trusted blocking verdicts of the event comment (created, edited
 * or deleted) and of every live comment to the PR's history, skipping those
 * already recorded. Unreadable live comments or history only mean more is
 * written; a failed write throws (the job fails visibly).
 */
export async function recordHistory({ client, repo, pr, event, runId }) {
  const sources = [];
  const eventPr = event?.issue?.number;
  if (isRecord(event?.comment) && (eventPr === undefined || Number(eventPr) === Number(pr))) sources.push(event.comment);
  sources.push(...list(await attempt(() => client.paginate(`/repos/${repo}/issues/${pr}/comments`))));
  const known = list(await attempt(() => readHistory(client, repo, pr)));
  const seen = new Set(known.map(historyKey));
  const fresh = [];
  for (const entry of sources.flatMap(historyEntriesFromComment)) {
    const key = historyKey(entry);
    if (!inList(ALL_TRUSTED, lower(entry.author)) || seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  if (!fresh.length) return { written: 0 };
  const action = typeof event?.action === "string" ? event.action : null;
  const batches = historyBatches(fresh, (entries) => jsonBlock({ schema: HISTORY_SCHEMA_ID, pr: Number(pr), event: action, entries }));
  const provenance = gateRecordFields(repo, pr, runId);
  await batches.reduce((previous, { entries, text }) => previous.then(() => client.post(`/repos/${repo}/check-runs`, {
      name: historyCheckName(pr),
      head_sha: HISTORY_ANCHOR_SHA,
      ...provenance,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: `ovd-merge-gate history: ${entries.length} blocking verdict(s) for PR #${pr}`,
        summary: "Append-only verdict history (OVD-959). Later gate runs carry these forward if the comment is removed; a record never counts as a pass.",
        text,
      },
    })), Promise.resolve());
  return { written: fresh.length };
}

/**
 * F1: split history entries into records whose output.text fits
 * MAX_OUTPUT_TEXT. An entry that cannot fit even alone throws: the history
 * job fails, and the writer (which runs anyway) fails the gate closed.
 */
export function historyBatches(entries, render, max = MAX_OUTPUT_TEXT) {
  const batches = [];
  let current = [];
  for (const entry of entries) {
    if (render([entry]).length > max) throw new Error(`a verdict history entry (comment ${entry?.comment_id ?? "?"}) does not fit in one check run`);
    if (current.length && render([...current, entry]).length > max) {
      batches.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) batches.push(current);
  return batches.map((batch) => ({ entries: batch, text: render(batch) }));
}

/** The Actions run id of an https://github.com/<repo>/actions/runs/<id> URL in `repo`, else null. */
export function actionsRunId(url, repo) {
  if (typeof url !== "string" || typeof repo !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  const match = ACTIONS_RUN_PATH.exec(parsed.pathname);
  if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repo.toLowerCase()) return null;
  return match[3];
}

/** The Actions run ids that reported a check run on `sha` (details_url of GitHub Actions check runs). */
async function actionsRunIdsAt(client, repo, sha) {
  const runs = await client.paginate(`/repos/${repo}/commits/${sha}/check-runs?filter=all`, (data) => data?.check_runs);
  const ids = new Set();
  for (const run of runs) {
    if (run?.app?.id !== GITHUB_ACTIONS_APP_ID || run?.head_sha !== sha) continue;
    for (const url of [run.details_url, run.html_url]) {
      const id = actionsRunId(url, repo);
      if (id) ids.add(id);
    }
  }
  const verified = await Promise.all([...ids].map(async (id) => {
    const run = await client.json(`/repos/${repo}/actions/runs/${id}`);
    return run.head_sha === sha && run.conclusion === "success" && PASS_EVIDENCE_WORKFLOWS.includes(run.path) ? id : null;
  }));
  return new Set(verified.filter((id) => id !== null));
}

/**
 * Ruling 6: resolve the ci-run/verify-run links of trusted passes and
 * supersede claims. A link counts only when it is an Actions run URL of this
 * repository whose successful, allowlisted workflow run reported on the verdict's SHA. Returns
 * SHA -> verified URLs; anything unreadable stays unverified.
 */
async function verifyEvidence({ client, repo, comments, headSha }) {
  const wanted = new Map();
  for (const entry of collectVerdicts(comments, headSha).entries) {
    const claims = PASSING.has(entry.verdict.verdict) || entry.verdict.supersedes !== undefined;
    if (!claims || !inList(ALL_TRUSTED, lower(entry.author))) continue;
    const urls = carryingUrls(entry.verdict).filter((url) => actionsRunId(url, repo) !== null);
    if (!wanted.has(entry.verdict.sha)) wanted.set(entry.verdict.sha, new Set());
    for (const url of urls) wanted.get(entry.verdict.sha).add(url);
  }
  const verified = {};
  for (const [sha, urls] of [...wanted].slice(0, MAX_EVIDENCE_SHAS)) {
    const ids = urls.size ? await attempt(() => actionsRunIdsAt(client, repo, sha)) : undefined;
    if (ids) verified[sha] = [...urls].filter((url) => ids.has(actionsRunId(url, repo)));
  }
  return verified;
}

async function readCommits(client, repo, pr, pull) {
  const commits = await client.paginate(`/repos/${repo}/pulls/${pr}/commits`);
  if (!Number.isInteger(pull?.commits) || commits.length !== pull.commits) throw new Error("the PR commit list is incomplete");
  return commits;
}

function failClosed(summary, detail) {
  summary.reasons.push(missing(detail));
  summary.gate = "fail";
  if (summary.door_report) {
    summary.door_report.ok = false;
    summary.door_report.reasons.push(missing(detail));
  }
}

/**
 * Read everything evaluate() needs for one PR and evaluate it.
 * Never throws for missing data: an unreadable input becomes a fail reason.
 */
export async function runGate({ client, repo, pr, sha, cwd, root, token, fetch = true, event = null, git, diff, classify = classifyPull, historyResult, reviewThreads }) {
  const pull = await client.json(`/repos/${repo}/pulls/${pr}`);
  const liveHeadSha = pull?.head?.sha ?? null;
  const headSha = sha ?? liveHeadSha;
  const validHead = HEX40.test(String(headSha));
  const comments = await attempt(() => client.paginate(`/repos/${repo}/issues/${pr}/comments`));
  const commits = await attempt(() => readCommits(client, repo, pr, pull));
  const prior = validHead ? await attempt(() => priorDeletions(client, repo, headSha, pr)) : [];
  const history = await attempt(() => readHistory(client, repo, pr));
  const verifiedEvidence = validHead && Array.isArray(comments) ? await verifyEvidence({ client, repo, comments, headSha }) : {};
  const deletedVerdicts = [...(prior ?? []), ...deletedVerdictsFromEvent(event)];
  const { diffId, error: diffIdError } = headDiffId({ pr, repo, headSha, baseRef: pull?.base?.ref, cwd, token, fetch, git, diff });
  const { classification, files } = await classify({ client, repo, pr, headSha, root });
  const requiredChecks = validHead ? await attempt(() => client.paginate(`/repos/${repo}/commits/${headSha}/check-runs?filter=all`, (data) => data?.check_runs)) : undefined;
  // Lazy import: this gate runs without npm install. The PR-body validator's
  // existing TypeScript dependency may be unavailable; that only fails the
  // door report closed and cannot prevent the legacy gate from running.
  const revertPlan = await attempt(async () => {
    const { validateRevertPlan } = await import("./validate-pr-body.mjs");
    return { sha: headSha, ...validateRevertPlan(pull?.body, classification?.door) };
  });
  const summary = evaluate({
    reviewThreads,
    requiredChecks,
    revertPlan,
    headSha,
    liveHeadSha,
    headDiffId: diffId,
    diffIdError,
    comments,
    deletedVerdicts,
    history: history ?? [],
    verifiedEvidence,
    commits,
    prAuthor: pull?.user?.login,
    prBody: typeof pull?.body === "string" ? pull.body : null,
    changedFiles: files,
    classification,
    mode: MODE,
    identity: IDENTITY,
  });
  // Unreadable history may hide a deletion: say so instead of passing silently.
  if (prior === undefined) failClosed(summary, "earlier gate check runs on this head could not be read, or one has no readable summary");
  if (history === undefined) failClosed(summary, "the PR's verdict history could not be read, so a removed FAIL cannot be ruled out");
  // F1: the history job did not record this event, so a FAIL it saw may be missing from the history.
  if (historyResult !== undefined && historyResult !== "success") failClosed(summary, `the verdict history job did not succeed (${oneLine(String(historyResult)).slice(0, 40)}), so a FAIL it should have recorded may be missing`);
  // Carry forward only blocking or unreadable removals; a removed clean pass is never recorded.
  const candidates = deletionCandidates({ deletedVerdicts, history: history ?? [], comments });
  const carried = carriedDeletions(candidates, ALL_TRUSTED);
  summary.deleted_verdicts = candidates.filter((item) => carried.blocking.includes(item) || carried.unreadable.includes(item));
  return summary;
}

/**
 * The check-run text: the JSON summary, fitted to MAX_OUTPUT_TEXT. First the
 * `ignored` details go; then deleted_verdicts lose their snapshots (a later
 * run reads an entry without a snapshot as an unreadable removal, which
 * still blocks); then they collapse to one unreadable marker. Shrinking never
 * turns a blocking summary into a passing one: reasons are kept until last,
 * and a summary that still does not fit is replaced by a failing stub.
 */
export function summaryText(given, max = MAX_OUTPUT_TEXT) {
  const { door_report: _doorReport, ...summary } = given;
  // Drop optional door output before any existing history/reason truncation.
  // A report must never reduce the durable verdict history that fits today.
  const truncatedIgnored = [{ code: "truncated", detail: `${list(summary.ignored).length} ignored entries omitted to fit the check run` }];
  const deleted = list(summary.deleted_verdicts);
  const marker = { comment_id: null, author: "ovd-merge-gate", created_at: null, sha: null, diff_id: null, role: null, truncated: deleted.length };
  const stripped = deleted.map(({ comment_id: commentId, author, created_at: createdAt, sha, diff_id: diffId, role }) => ({ comment_id: commentId ?? null, author: typeof author === "string" ? author.slice(0, 100) : "unknown", created_at: createdAt ?? null, sha: sha ?? null, diff_id: diffId ?? null, role: role ?? null }));
  const steps = [
    given,
    summary,
    { ...summary, ignored: truncatedIgnored },
    { ...summary, ignored: truncatedIgnored, deleted_verdicts: stripped },
    { ...summary, ignored: truncatedIgnored, deleted_verdicts: deleted.length ? [marker] : [], warnings: [], reasons: list(summary.reasons).map(({ code }) => ({ code, detail: "" })) },
  ];
  for (const step of steps) {
    const text = jsonBlock(step);
    if (text.length <= max) return text;
  }
  return jsonBlock({ gate: "fail", sha: summary.sha ?? null, mode: summary.mode, reasons: [missing("the gate summary did not fit in the check run")], warnings: [], ignored: truncatedIgnored, deleted_verdicts: deleted.length ? [marker] : [] });
}

/** POST the ovd-merge-gate check run. */
export async function writeCheckRun({ client, repo, sha, summary, pr, runId }) {
  const { conclusion, title } = conclusionFor(summary);
  return client.post(`/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: sha,
    ...gateRecordFields(repo, pr, runId),
    status: "completed",
    conclusion,
    output: { title, summary: formatSummary(summary), text: summaryText(summary) },
  });
}

const COMMANDS = Object.freeze({ evaluate: ["pr", "sha"], write: ["pr"], record: ["pr"], "merge-group": ["sha"] });
const HISTORY_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);
const SWITCHES = Object.freeze({ "--json": ["json", true], "--no-fetch": ["fetch", false] });
const VALUE_FLAGS = new Set(["--pr", "--sha", "--repo", "--history-result"]);

/** Read the flag at `index` into options; returns the index of the last argument consumed. */
function readFlag(args, index, options) {
  const arg = args[index];
  if (Object.hasOwn(SWITCHES, arg)) {
    const [key, value] = SWITCHES[arg];
    options[key] = value;
    return index;
  }
  if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${arg} needs a value`);
  options[arg === "--history-result" ? "historyResult" : arg.slice(2)] = value;
  return index + 1;
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? "")) throw new Error("command must be evaluate, write, record or merge-group");
  const options = { command, json: false, fetch: true };
  for (let index = 0; index < rest.length; index += 1) index = readFlag(rest, index, options);
  if (options.pr !== undefined && !PR_NUMBER.test(options.pr)) throw new Error("--pr must be a positive integer");
  if (options.sha !== undefined) assertSha(options.sha, "--sha");
  if (options.historyResult !== undefined && command !== "write") throw new Error("--history-result is only for write");
  // An empty or unknown value (a misspelled needs context) is kept: runGate treats anything but "success" as a failure.
  if (options.historyResult !== undefined && !HISTORY_RESULTS.has(options.historyResult)) options.historyResult = `unknown:${options.historyResult.slice(0, 20)}`;
  for (const name of COMMANDS[command]) {
    if (options[name] === undefined) throw new Error(`${command} needs --${name}`);
  }
  return options;
}

const USAGE = "usage: ovd-merge-gate.mjs evaluate --pr N --sha S [--json] [--repo o/r] [--no-fetch] | record --pr N [--repo o/r] | write --pr N [--history-result R] [--repo o/r] | merge-group --sha S [--repo o/r]";

/** Actions sets GITHUB_RUN_ID. A missing or forged-looking value cannot stamp a record. */
function workflowRunId(env) {
  const value = env?.GITHUB_RUN_ID;
  return typeof value === "string" && RUN_ID.test(value) ? value : undefined;
}

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The queue no-op: the rule was evaluated on the PR head; the queue only needs the check to exist.
 * It carries no gateRecordFields stamp: merge-group SHAs are never PR heads,
 * so priorDeletions never reads this check run.
 */
async function writeMergeGroup({ client, options, stdout }) {
  const summary = { gate: "pass", sha: options.sha, mode: MODE, identity: IDENTITY, identity_note: IDENTITY_NOTES[IDENTITY], automerge: "needs_release", reasons: [], warnings: [{ code: "merge_group", detail: "merge queue no-op; the gate ran on the PR head" }], ignored: [], deleted_verdicts: [] };
  await client.post(`/repos/${options.repo}/check-runs`, { name: CHECK_NAME, head_sha: options.sha, status: "completed", conclusion: "success", output: { title: "ovd-merge-gate: merge queue no-op", summary: "The merge gate was evaluated on the PR head.", text: jsonBlock(summary) } });
  stdout.write(`ovd-merge-gate: merge_group success on ${options.sha}\n`);
  return 0;
}

async function writeGate({ client, options, summary, stdout }) {
  // Re-read the head right before writing: a result for a head that moved is not written.
  const now = (await client.json(`/repos/${options.repo}/pulls/${options.pr}`))?.head?.sha;
  if (now !== summary.sha) {
    stdout.write(`ovd-merge-gate: head moved from ${summary.sha} to ${now}; not writing (the run for the new head writes it)\n`);
    return 0;
  }
  await writeCheckRun({ client, repo: options.repo, sha: summary.sha, summary, pr: options.pr, runId: options.runId });
  stdout.write(`${formatSummary(summary)}\n${conclusionFor(summary).title}\n`);
  return 0;
}

async function runCommand({ options, env, client, token, cwd, git, diff, classify, stdout }) {
  if (options.command === "merge-group") return writeMergeGroup({ client, options, stdout });
  if (options.command === "record") {
    const { written } = await recordHistory({ client, repo: options.repo, pr: options.pr, event: readEvent(env), runId: workflowRunId(env) });
    stdout.write(`ovd-merge-gate: recorded ${written} blocking verdict(s) in the history of PR #${options.pr}\n`);
    return 0;
  }
  const event = options.command === "write" ? readEvent(env) : null;
  const summary = await runGate({ client, repo: options.repo, pr: options.pr, sha: options.sha, cwd, token, fetch: options.fetch, event, git, diff, classify, historyResult: options.historyResult });
  if (options.command === "write") return writeGate({ client, options: { ...options, runId: workflowRunId(env) }, summary, stdout });
  stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
  return summary.gate === "pass" ? 0 : 1;
}

/**
 * CLI. Returns the exit code: evaluate 0 pass / 1 fail; record, write and
 * merge-group 0 once handled (report mode never fails the job), 1 when a
 * check run could not be written; 2 on usage errors.
 */
export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), git, diff, classify } = {}) {
  let options;
  try {
    options = parseCli(argv);
    options.repo ??= env.GITHUB_REPOSITORY;
    if (!REPO.test(options.repo ?? "")) throw new Error("--repo owner/name (or GITHUB_REPOSITORY) is required");
  } catch (error) {
    stderr.write(`ovd-merge-gate: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const client = createApi({ token, apiUrl: env.GITHUB_API_URL || undefined, fetchImpl });
  try {
    return await runCommand({ options, env, client, token, cwd, git, diff, classify, stdout });
  } catch (error) {
    stderr.write(`ovd-merge-gate: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main();
}
