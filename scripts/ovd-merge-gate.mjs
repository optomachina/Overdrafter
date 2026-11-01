#!/usr/bin/env node
/**
 * Enforced merge gate, evaluated only by trusted default-branch code.
 * evaluate() composes the existing durable verdict-history rules with exact
 * head CI, separate Opus/Sonnet review, Jev and QA evidence and held categories.
 * Only the verifier App's comments count. Positive evidence never transfers
 * across SHAs; blocking history still follows an equal diff_id.
 *
 * write records success/failure, rereads the head, and can squash-merge only
 * when vars.DOOR_AUTOMERGE supplied exact true, mergeEligibility passes and
 * no second stop (vars.OVD_AUTOMERGE_DISABLED, the automerge:hold label) applies.
 * GitHub's --match-head-commit closes the push race. No branch protection,
 * labels, repository variables, provider or production operations are changed.
 *
 * Fail closed: every missing, unparseable, error, unknown or partial input is
 * a reason, never a pass. The `jev-screen` marker is a required gate, never
 * independent evidence.
 *
 * MODE is "enforce": the conclusion is only ever `success` or `failure`.
 *
 * CLI (run from a default-branch checkout; reads GITHUB_TOKEN or GH_TOKEN):
 *   node scripts/ovd-merge-gate.mjs evaluate --pr N --sha S [--json] [--repo o/r] [--no-fetch]
 *       prints the summary; exit 0 when gate is pass, 1 when fail, 2 on usage errors
 *   node scripts/ovd-merge-gate.mjs record --pr N [--repo o/r]
 *       appends the trusted blocking verdicts of the event comment and the
 *       live comments to the PR's verdict history
 *   node scripts/ovd-merge-gate.mjs write --pr N [--repo o/r]
 *       evaluates the live head, re-reads the head, writes the check run,
 *       then (only with DOOR_AUTOMERGE exactly true) attempts the guarded squash
 *       merge, then edits the PR's one sticky status comment in place (OVD-1144)
 *   node scripts/ovd-merge-gate.mjs merge-group --sha S [--repo o/r]
 *       writes success on the merge group commit (the queue no-op)
 *
 * See docs/verdict-format.md ("OVD-845 merge gate").
 * Dependency: #972 owns writer cancellation/ENOTEMPTY repairs; retain them.
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
import { ALLOWED_AUTHORS, MARKER_CONTEXT, SCREENER_ID, parseMarkerDescription } from "./lib/jev-screen-marker.mjs";
import { JEV_MODEL } from "./jev-client.mjs";
import { APPROVAL_FENCE_INFO, approvalForHead, parseApprovalComments } from "./approval-record.mjs";
import { assertSha, computeDiffId, resolveBinary } from "./emit-verdict.mjs";
import { detect, fetchPullRequest, gateLooseningForPull, heldContent, inSequence, loadConfig } from "./sensitive-class-detect.mjs";
import { FENCE_INFO, extractVerdictBlocks, hasHighNote, parseVerdictComments } from "./verdict-schema.mjs";

export const CHECK_NAME = "ovd-merge-gate";
export const MODE = "enforce";
export const IDENTITY = "app";
export const CROSS_FAMILY = Object.freeze({ claude: ["codex", "grok"], codex: ["claude"], grok: ["claude"] });
const DOOR_REQUIRED_CHECKS = ["ci", "provider-go-live", "secret-scan"];
/** Fixed default-branch trust. User verdicts cannot authorize a merge. */
export const TRUSTED_VERIFIERS = Object.freeze(["overdrafter-verifier[bot]"]);
/** Only the private verifier App's bot counts. */
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
// Events whose workflow YAML must come from the default branch. merge_group is
// excluded: its YAML comes from the queue ref, and its job never writes history.
// pull_request_target uses the PR base's YAML; verifyGateProvenance requires
// that base to be the default branch (OVD-1109).
const GATE_EVENTS = Object.freeze(["pull_request_target", "issue_comment", "workflow_dispatch"]);

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
  return { entry: { ...base, header: parseArchitectHeader(comment.body), review_model: entry.verdict.verifier.model_family, created_at: comment.created_at, verdict: { ...entry.verdict, verifier: { ...entry.verdict.verifier, model_family: normalizeModelFamily(entry.verdict.verifier.model_family) } } }, rejected: [] };
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
  if (!parsed || typeof parsed !== "object") return { forHead: true, role: null, verifierId: null };
  const verifierId = typeof parsed.verifier?.id === "string" ? parsed.verifier.id : null;
  return { forHead: mayBeForHead(parsed.sha, parsed.diff_id, head), role: typeof parsed.role === "string" ? parsed.role : null, verifierId };
}

/** A later verdict of the role clears it; when the verifier is readable, only that verifier's own (an Opus block is not cleared by Sonnet). */
const hasFresher = (entries, item, role, verifierId = null) => entries.some((entry) => (role === null || entry.verdict.role === role)
  && (verifierId === null || entry.verdict.verifier?.id === verifierId) && postedAfter(entry, item));

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
    const { forHead, role, verifierId } = blockTarget(item.text, head);
    const reason = forHead && !hasFresher(entries, item, role, verifierId) ? rejectedReason(item) : null;
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
  const header = architectBlocker(comment.body);
  if (header) entries.push(historyEntry(base, header));
  return entries;
}

/**
 * A blocking Architect header as a FAIL snapshot bound to its full SHA, so
 * deleting a header-only CHANGES_REQUIRED or a malformed header does not
 * clear it (council 6538642610). Null for passing headers and headers that
 * name no full SHA (those block only while posted).
 */
function architectBlocker(body) {
  const header = parseArchitectHeader(body);
  if (!header) return null;
  const sha = header.error ? header.shas.find((value) => HEX40.test(value)) : header.sha;
  if (!sha || (!header.error && header.verdict !== "CHANGES_REQUIRED")) return null;
  const note = header.error ? "high: malformed Architect review header" : `high: Architect ${header.model} review CHANGES_REQUIRED`;
  return { role: "reviewer", verdict: "FAIL", sha, notes: [note] };
}

/** The deleted verdict blocks to carry forward from an issue_comment deleted event (blocking or unreadable only). */
export function deletedVerdictsFromEvent(event) {
  if (event?.action !== "deleted" || !event.comment) return [];
  return historyEntriesFromComment(event.comment);
}

const snapshotKey = (item) => JSON.stringify(item?.verdict_block ?? null);
const historyKey = (item) => [String(item?.comment_id), lower(item?.author), snapshotKey(item)].join("\u0000");

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
    || parsed.builders.some((builder) => builder.bot === "unknown" || builder.family === "unknown");
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
    door_report: { door: "one-way", ok: false, automerge_enabled: false, reasons: [{ code: "classifier_error", detail: "head input has not been validated" }] },
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
export function evaluateVerdicts(given = {}) {
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
    summary.door_report = { door: "one-way", ok: false, automerge_enabled: false, reasons: [{ code: "classifier_error", detail: "door evaluation failed closed" }] };
  }
  return summary;
}

/**
 * The jev-pr-screen writer uses context jev-screen, not its script name. A
 * marker counts only from a trusted writer that is independent of the PR:
 * never its author, a commit author or committer, or a merger identity
 * (QA review 6554675199). Today the only trusted writer is the builder and
 * merger account, so no marker counts and the gate blocks until the Jev
 * writer moves to a non-builder identity.
 */
export function jevGate(snapshot, sha, { writers = ALLOWED_AUTHORS, excluded = [] } = {}) {
  if (!HEX40.test(sha ?? "") || snapshot?.sha !== sha || !Array.isArray(snapshot?.statuses)) return { ok: false, tier: null };
  const dependent = new Set([...MERGER_LOGINS, ...list(excluded)].map(lower).filter(Boolean));
  const statuses = snapshot.statuses.filter((status) => status?.context === MARKER_CONTEXT
    && list(writers).includes(status.creator?.login) && !dependent.has(lower(status.creator?.login)));
  const markers = statuses.map((status) => status.state === "success"
    && typeof status.url === "string" && status.url.endsWith(`/statuses/${sha}`)
    ? parseMarkerDescription(status.description) : null);
  // A rejected/risky marker cannot be hidden by an older or weaker success.
  if (!markers.length || markers.some((marker) => marker?.model !== JEV_MODEL || marker.screener !== SCREENER_ID
      || marker.jevTier === "risky" || marker.confidence < 0.5)) return { ok: false, tier: null };
  const tiers = ["low", "normal", "risky"];
  return { ok: true, tier: tiers[Math.max(...markers.map((marker) => tiers.indexOf(marker.tier)))] };
}

/** Detector classes that hold the PR, whatever the reviews say. */
const CLASS_HOLDS = Object.freeze([
  ["gate_machinery", "gate_machinery"],
  ["unclassified", "unclassified"],
  ["migrations", "prod_db_migration"],
  ["provider_dispatch", "vendor_spend"],
  ["payments", "vendor_spend"],
]);
/** Conservative path holds over the NFKC-lowercased path, on top of the detector's classes. */
const PATH_HOLDS = Object.freeze([
  [/(?:^|\/)(?:migrations?|migration-drafts)(?:\/|$)/, "prod_db_migration"],
  [/\.(?:sql|pgsql|psql)$/, "prod_db_migration"],
  [/(?:apply|migrat).*prod/, "prod_db_migration"],
  [/prod.*(?:apply|migrat)/, "prod_db_migration"],
  [/vendor|supplier|provider|spend|billing|payment|checkout|purchase|invoice/, "vendor_spend"],
  [/branch[-_]?protection|ruleset|codeowners/, "branch_protection"],
  [/sonar/, "sonar_safe_mark"],
]);

function classificationHolds(files, classification) {
  const held = [...list(classification?.held_categories)];
  const classes = list(classification?.classes);
  for (const [name, hold] of CLASS_HOLDS) if (classes.includes(name)) held.push(hold);
  if (classification?.gate_loosening?.detected) held.push("gate_loosening");
  // An empty, unreadable or incomplete file list (pagination, truncation) can hide a held path.
  if (!Array.isArray(files) || files.length === 0 || classification?.status !== "ok") held.push("file_list_incomplete");
  return held;
}

function fileHolds(file) {
  const held = heldContent(typeof file?.patch === "string" ? file.patch : "");
  if (file?.status === "removed") held.push("deletion");
  for (const name of changedPaths(file).flatMap(pathCandidates)) {
    const path = name.normalize("NFKC").toLowerCase();
    for (const [pattern, hold] of PATH_HOLDS) if (pattern.test(path)) held.push(hold);
  }
  return held;
}

/** Held work never qualifies for this lane, even with approval comments. */
export function heldCategories(files, classification) {
  return [...new Set([...classificationHolds(files, classification), ...list(files).flatMap(fileHolds)])];
}

const reviewModel = (entry) => {
  if (["opus", "sonnet"].includes(entry.review_model)) return entry.review_model;
  // The emitter normalizes model_family to claude. Explicit role ids retain
  // the distinction; a generic Claude reviewer never proves both gates.
  const id = entry.verdict.verifier?.id;
  return ["opus-reviewer", "sonnet-reviewer"].includes(id) && entry.verdict.verifier.model_family === "claude" ? id.split("-")[0] : null;
};

const fromVerifierBot = (entry) => inList(APP_TRUSTED_VERIFIERS, lower(entry.author));

/** Trusted verdicts with findings at the head (or an equal diff_id) need disposition at a new head. */
function findingReasons(entries, input) {
  return entries
    .filter((entry) => fromVerifierBot(entry) && (entry.verdict.sha === input.headSha || entry.verdict.diff_id === input.headDiffId))
    .filter((entry) => list(entry.verdict.findings).length)
    .map((entry) => ({ code: "actionable_findings", detail: `trusted comment ${entry.comment_id} has findings that require disposition at a new head` }));
}

/** A clean, verified, thread-free trusted PASS at exactly this SHA. */
const exactPass = (entry, input) => fromVerifierBot(entry)
  && entry.verdict.sha === input.headSha && PASSING.has(entry.verdict.verdict)
  && (entry.verdict.role !== "reviewer" || architectHeaderMatches(entry))
  && !isHigh(entry.verdict) && list(entry.verdict.findings).length === 0
  && entry.verdict.readiness?.open_threads === 0
  && entry.verdict.readiness?.conflicts === 0
  && evidenceVerified(entry.verdict, input.verifiedEvidence);

/** Separate Opus (when required), Sonnet and QA gates. Retains the all-tier QA floor: no tier waives QA. */
const reviewerId = (entry) => lower(entry.verdict.verifier?.id);

function reviewGateReasons(exact, opusRequired) {
  const reasons = [];
  const passes = (model) => exact.filter((entry) => entry.verdict.role === "reviewer" && reviewModel(entry) === model);
  for (const model of opusRequired ? ["opus", "sonnet"] : ["sonnet"]) {
    if (!passes(model).length) reasons.push({ code: `${model}_not_pass`, detail: `no independent ${model} review PASS at this exact SHA` });
  }
  // Opus and Sonnet need distinct identities: one verifier id cannot satisfy both gates.
  const sonnetIds = passes("sonnet").map(reviewerId);
  if (opusRequired && passes("opus").length && sonnetIds.length && !passes("opus").some((entry) => sonnetIds.some((id) => id !== reviewerId(entry)))) {
    reasons.push({ code: "reviewers_not_distinct", detail: "the Opus and Sonnet passes share one verifier id" });
  }
  if (!exact.some((entry) => entry.verdict.role === "verifier" && entry.verdict.readiness?.checks === "green")) reasons.push({ code: "qa_not_pass", detail: "no QA PASS with green checks at this exact SHA (required at every tier)" });
  return reasons;
}

/** The Built-by line's builder model families (openai reviews as codex); empty when unparsed. */
function builderFamilies(prBody) {
  if (!routing || typeof prBody !== "string") return [];
  const parsed = parseBuiltBy({ body: builderLines(prBody).join("\n"), routing });
  return [...new Set(list(parsed?.builders).map((builder) => (builder.family === "openai" ? "codex" : builder.family)))];
}

/**
 * The builder's model family never reviews its own work. The gate cannot see
 * fresh-session evidence, so a same-family reviewer PASS blocks (fail closed).
 */
function sameFamilyReasons(exact, input) {
  const families = builderFamilies(input.prBody);
  return exact
    .filter((entry) => entry.verdict.role === "reviewer" && families.includes(entry.verdict.verifier?.model_family))
    .filter((entry) => !freshClaudeOpus(entry, families, buildTrail(input)))
    .map((entry) => ({ code: "reviewer_same_family", detail: `reviewer comment ${entry.comment_id} is from the builder's model family ${entry.verdict.verifier.model_family}` }));
}

/*
 * Architect ruling on hardening checklist item 6 (PR #993 comment 6538018662).
 * A reviewer verdict counts only when its comment, posted by the verifier App
 * and never edited, starts with:
 *   Architect review (<model>) @ <40-hex head SHA>
 *   VERDICT: PASS | PASS_NOTES | CHANGES_REQUIRED
 *   [Context: fresh-session; no-build-context]   (required for same-family review)
 *   [Reviewer-Run: <session or run id>]          (required with the Context line)
 * The JSON verdict block below it is unchanged.
 */
const ARCHITECT_PREFIX = "Architect review";
const ARCHITECT_HEADER = /^Architect review \((opus|sonnet|codex|jev)\) @ ([0-9a-f]{40})$/;
const ARCHITECT_VERDICT = /^VERDICT: (PASS|PASS_NOTES|CHANGES_REQUIRED)$/;
const ARCHITECT_CONTEXT = "Context: fresh-session; no-build-context";
const REVIEWER_RUN = /^Reviewer-Run: ([\w.:-]{6,128})$/;
const HEADER_FAMILY = Object.freeze({ opus: "claude", sonnet: "claude", codex: "codex", jev: "jev" });
const HEADER_VERDICT = Object.freeze({ PASS: "PASS", PASS_NOTES: "PASS_NOTES", FAIL: "CHANGES_REQUIRED" });

/**
 * The Architect header at the very top of a comment body. Null when the body
 * does not start with "Architect review" (not a verdict); { error } when it
 * does but any line fails the exact format (fail closed).
 */
export function parseArchitectHeader(body) {
  if (typeof body !== "string" || !body.startsWith(ARCHITECT_PREFIX)) return null;
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const head = ARCHITECT_HEADER.exec(lines[0]);
  const verdict = ARCHITECT_VERDICT.exec(lines[1] ?? "");
  // The hex runs a malformed line 1 names, so its block binds to a head (never to every later head).
  const shas = (lines[0].match(/[0-9a-f]{7,40}/gi) ?? []).map((value) => value.toLowerCase());
  if (!head || !verdict) return { error: "the Architect header or VERDICT line does not match the exact format", shas };
  const fresh = lines[2] === ARCHITECT_CONTEXT;
  const run = REVIEWER_RUN.exec(lines[fresh ? 3 : 2] ?? "");
  if (fresh && !run) return { error: "a Context line needs a Reviewer-Run line after it", shas };
  return { model: head[1], sha: head[2], verdict: verdict[1], fresh, runId: run?.[1] ?? null };
}

/** The reviewer entry's own comment header agrees with its JSON verdict, model and SHA. */
function architectHeaderMatches(entry) {
  const header = entry.header;
  if (!header || header.error || header.sha !== entry.verdict.sha) return false;
  if (HEADER_VERDICT[entry.verdict.verdict] !== header.verdict) return false;
  if (HEADER_FAMILY[header.model] !== entry.verdict.verifier?.model_family) return false;
  return HEADER_FAMILY[header.model] !== "claude" || reviewModel(entry) === header.model;
}

/** Every id the build left behind: the PR body (Built-by, session links) and commit messages. Lowercased. */
const buildTrail = (input) => [input.prBody, ...list(input.commits).map((commit) => commit?.commit?.message)]
  .filter((text) => typeof text === "string").join("\n").toLowerCase();

/**
 * Same-family review is accepted only for a Claude-built PR reviewed by a
 * fresh-session Opus whose run id appears nowhere in the build trail.
 */
function freshClaudeOpus(entry, families, trail) {
  const header = entry.header;
  return families.includes("claude") && entry.verdict.verifier?.model_family === "claude"
    && architectHeaderMatches(entry) && header.model === "opus" && header.fresh
    && typeof header.runId === "string" && !trail.includes(header.runId.toLowerCase());
}

/**
 * App-authored Architect verdicts at the head: per model the newest counts and
 * CHANGES_REQUIRED blocks. Malformed headers, edited comments and same-time
 * disagreements fail closed. Other authors and quoted headers are ignored.
 */
/** One comment's Architect verdict at the head: { reason } to block, { header, time } to count, or null to ignore. */
function architectComment(comment, headSha) {
  if (!inList(APP_TRUSTED_VERIFIERS, lower(comment?.user?.login))) return null;
  const header = parseArchitectHeader(comment.body);
  if (header?.error) {
    // A malformed header blocks the head it names (by full SHA or a 7+ hex prefix); one naming no head is not a verdict.
    return typeof headSha === "string" && header.shas.some((sha) => headSha.startsWith(sha)) ? { reason: { code: "architect_header_malformed", detail: `comment ${comment.id}: ${header.error}` } } : null;
  }
  if (header?.sha !== headSha) return null;
  if (!comment.created_at || comment.updated_at !== comment.created_at) return { reason: { code: "architect_verdict_edited", detail: `comment ${comment.id} was edited; verdicts are never edited` } };
  const time = Date.parse(comment.created_at);
  if (Number.isNaN(time)) return { reason: { code: "architect_header_malformed", detail: `comment ${comment.id} has no readable timestamp` } };
  return { header, time, id: comment.id };
}

function architectReasons(comments, headSha) {
  const reasons = [];
  /** model -> its newest App verdict at the head; only that comment may count (QA review 6554675199). */
  const newest = new Map();
  for (const item of list(comments).map((comment) => architectComment(comment, headSha))) {
    if (item?.reason) reasons.push(item.reason);
    if (!item?.header) continue;
    const prior = newest.get(item.header.model);
    const conflict = prior?.time === item.time && prior.header.verdict !== item.header.verdict;
    if (conflict) reasons.push({ code: "architect_verdict_conflict", detail: `comments ${prior.id} and ${item.id} disagree for ${item.header.model}` });
    if (!prior || item.time > prior.time) newest.set(item.header.model, item);
  }
  for (const [model, latest] of newest) {
    if (latest.header.verdict === "CHANGES_REQUIRED") reasons.push({ code: "architect_changes_required", detail: `newest ${model} Architect review (comment ${latest.id}) is CHANGES_REQUIRED` });
  }
  return { reasons, newest };
}

/** A reviewer PASS counts only when it is its model's newest App verdict at the head. */
const isNewest = (entry, newest) => entry.verdict.role !== "reviewer" || newest.get(entry.header?.model)?.id === entry.comment_id;

/** The newest PASS header per model must itself be a counted verdict; one that does not parse or match blocks. */
function newestUncounted(newest, exact) {
  return [...newest].filter(([, latest]) => latest.header.verdict !== "CHANGES_REQUIRED" && !exact.some((entry) => entry.comment_id === latest.id))
    .map(([model, latest]) => ({ code: "architect_newest_not_counted", detail: `newest ${model} Architect review (comment ${latest.id}) has no valid matching verdict block, so no older ${model} PASS counts` }));
}

/** The newest run of each hosted required check must be a GitHub Actions success at this exact SHA. */
function requiredCheckReasons(requiredChecks, headSha) {
  return DOOR_REQUIRED_CHECKS.filter((name) => {
    const latest = list(requiredChecks).filter((run) => run?.name === name).toSorted((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    return !latest || latest.head_sha !== headSha || latest.app?.id !== GITHUB_ACTIONS_APP_ID
      || latest.status !== "completed" || latest.conclusion !== "success";
  }).map((name) => ({ code: "ci_not_pass", detail: `${name} is not green at this exact SHA from GitHub Actions` }));
}

const threadsResolved = (snapshot, headSha) => snapshot?.sha === headSha && snapshot?.complete === true
  && Array.isArray(snapshot.threads) && snapshot.threads.every((thread) => thread?.isResolved === true);

/** Enforced decision; all positive evidence is for this exact head. Pure. */
export function evaluate(given = {}) {
  const input = isRecord(given) ? given : {};
  const summary = evaluateVerdicts({ ...input, mode: MODE, identity: IDENTITY });
  const reasons = [];
  const builders = [input.prAuthor, ...list(input.commits).flatMap((commit) => [commit?.author?.login, commit?.committer?.login])];
  const jev = jevGate(input.commitStatuses, input.headSha, { writers: input.jevWriters ?? ALLOWED_AUTHORS, excluded: builders });
  if (!jev.ok) reasons.push({ code: "jev_not_pass", detail: "missing, no_verdict, stale, uncertain, risky or non-independent jev-pr-screen marker (a marker from the PR author, a committer or the merger never counts)" });
  const held = heldCategories(input.changedFiles, input.classification);
  for (const category of held) reasons.push({ code: `held:${category}`, detail: `held category ${category} requires Blaine's separate operation` });
  // The Jev marker is written by the builder identity, so its tier must not
  // lower the review requirement: Opus is required at every tier (council 6538642259).
  const opusRequired = true;
  const { entries } = collectVerdicts(input.comments, input.headSha);
  reasons.push(...findingReasons(entries, input));
  const architect = architectReasons(input.comments, input.headSha);
  const exact = entries.filter((entry) => exactPass(entry, input) && isNewest(entry, architect.newest));
  // All counted reviews, including ones beyond the minimum, must be independent.
  reasons.push(
    ...reviewGateReasons(exact, opusRequired),
    ...builderReasons(exact, input.prBody),
    ...sameFamilyReasons(exact, input),
    ...architect.reasons,
    ...newestUncounted(architect.newest, exact),
    ...requiredCheckReasons(input.requiredChecks, input.headSha),
  );
  if (!threadsResolved(input.reviewThreads, input.headSha)) reasons.push({ code: "threads_unresolved", detail: "review threads are unresolved, unknown or stale" });
  // Sensitive-list work keeps its approval_missing reasons: Blaine's per-head
  // approval record is never waived (council 6538642259, Opus 6534928475 finding 1).
  summary.reasons = dedupeReasons([...summary.reasons, ...reasons]);
  summary.gate = summary.reasons.length ? "fail" : "pass";
  summary.automerge = summary.gate === "pass" ? "eligible" : "blocked";
  summary.enforced = true;
  summary.tier = jev.tier;
  summary.held_categories = held;
  summary.opus_required = opusRequired;
  return summary;
}

/** The switch is supplied only by vars.DOOR_AUTOMERGE in the trusted workflow. */
export function mergeEligibility(summary, switchValue, pull) {
  return switchValue === "true" && summary?.enforced === true && summary.mode === "enforce"
    && HEX40.test(summary.sha ?? "") && summary.gate === "pass" && summary.automerge === "eligible"
    && Array.isArray(summary.reasons) && summary.reasons.length === 0
    && Array.isArray(summary.held_categories) && summary.held_categories.length === 0
    && pull?.head?.sha === summary.sha && pull.state === "open" && pull.draft === false
    && pull.mergeable === true && pull.mergeable_state === "clean";
}

/**
 * Shadow evaluation only. These reasons never enter the legacy gate reasons.
 * Checks, thread state and the validator result are trusted caller inputs bound
 * to this SHA; missing/unknown inputs fail closed. No labels are consulted.
 */
export function revertableOk(ctx, { summary, candidates } = {}) {
  if (!summary) return evaluateVerdicts(ctx).door_report;
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
  return { door, ok: reasons.length === 0, automerge_enabled: false, reasons: dedupeReasons(reasons) };
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
    `Legacy door report (not merge authority): \`${summary.door_report.door}\`; revertable conditions: ${summary.door_report.ok ? "pass" : "fail"}`,
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

/** Retries of a rate-limited request (retry-after, or x-ratelimit-remaining 0); never of any other error. */
export const RATE_LIMIT_RETRIES = 3;
/** Longest single wait. A limit that resets later than this is not waited for: the call fails closed at once. */
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;
const RATE_LIMIT_BASE_WAIT_MS = 1_000;
const DIGITS = /^\d{1,12}$/;

/** A response header as a short digit string, or null; anything else is not trusted as a number. */
function digitHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === "string" && DIGITS.test(value.trim()) ? value.trim() : null;
}

/** The rate-limit headers and the body's message of a 403/429 (the body is GitHub's error JSON; data only). */
async function rateLimitDetail(response) {
  const rawRetryAfter = response?.headers?.get?.("retry-after");
  let message = null;
  try {
    const parsed = JSON.parse(await response.text());
    if (typeof parsed?.message === "string") message = parsed.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  } catch {
    // No readable body: the status and headers still describe the failure.
  }
  return {
    remaining: digitHeader(response, "x-ratelimit-remaining"),
    reset: digitHeader(response, "x-ratelimit-reset"),
    retryAfter: typeof rawRetryAfter === "string" && rawRetryAfter.trim() ? (digitHeader(response, "retry-after") ?? "unparsed") : null,
    message,
  };
}

/**
 * Milliseconds to wait before retry `attempt` (0-based), or null when the
 * failure is not a rate limit or its limit resets beyond the cap. A rate
 * limit is a retry-after header or x-ratelimit-remaining 0; the wait is the
 * later of retry-after and (when remaining is 0) x-ratelimit-reset, with an
 * exponential floor.
 */
export function rateLimitWait(detail, attempt, nowMs) {
  const waits = [];
  if (detail?.retryAfter) waits.push(DIGITS.test(detail.retryAfter) ? Number(detail.retryAfter) * 1000 : 0);
  if (detail?.remaining === "0") waits.push(detail.reset ? Number(detail.reset) * 1000 - nowMs : 0);
  if (!waits.length) return null;
  const wait = Math.max(...waits, RATE_LIMIT_BASE_WAIT_MS * 2 ** attempt);
  return wait <= RATE_LIMIT_MAX_WAIT_MS ? wait : null;
}

export class GithubApiError extends Error {
  constructor(status, apiPath, detail = null) {
    const fields = detail
      ? [
          ["x-ratelimit-remaining", detail.remaining],
          ["x-ratelimit-reset", detail.reset],
          ["retry-after", detail.retryAfter],
          ["message", detail.message === null || detail.message === undefined ? null : JSON.stringify(detail.message)],
          ["attempts", detail.attempts],
        ].filter(([, value]) => value !== null && value !== undefined)
      : [];
    const pairs = fields.map(([key, value]) => key + ": " + value).join(", ");
    const suffix = fields.length ? ` (${pairs})` : "";
    super(`GitHub API ${apiPath} returned ${status}${suffix}`);
    this.status = status;
    this.rateLimit = detail;
  }
}

/**
 * Minimal GitHub REST client over fetch: json/raw (what the detector's
 * fetchPullRequest uses), paginate, post. A 403/429 records its rate-limit
 * headers and message in the error; only a rate limit is retried (up to
 * RATE_LIMIT_RETRIES times), and a call that still fails throws, so the gate
 * fails closed.
 */
export function createApi({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const headers = { "x-github-api-version": "2022-11-28", "user-agent": "overdrafter-ovd-merge-gate" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = async (method, apiPath, { body, accept = "application/vnd.github+json" } = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${apiUrl}${apiPath}`, {
        method,
        headers: { ...headers, accept, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.ok) return response;
      if (response.status !== 403 && response.status !== 429) throw new GithubApiError(response.status, apiPath);
      const detail = await rateLimitDetail(response);
      const wait = attempt < RATE_LIMIT_RETRIES ? rateLimitWait(detail, attempt, now()) : null;
      if (wait === null) throw new GithubApiError(response.status, apiPath, { ...detail, attempts: attempt + 1 });
      log(`ovd-merge-gate: ${method} ${apiPath} rate limited (${response.status}); retry ${attempt + 1}/${RATE_LIMIT_RETRIES} in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
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
    patch: async (apiPath, body) => (await request("PATCH", apiPath, { body })).json(),
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
const removeDataStore = (store) => rmSync(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

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
export function headDiffId({ pr, repo, headSha, baseRef, cwd, token, fetch = true, git = defaultGit, diff = computeDiffId, makeStore = makeDataStore, removeStore = removeDataStore }) {
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
    // No auto-maintenance: newer git (seen on 2.56) can detach a background commit-graph
    // write after fetch, which races the store removal below (ENOTEMPTY).
    git(["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "fetch.writeCommitGraph=false", "--git-dir", store, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", `https://github.com/${repo}.git`, `+refs/pull/${pr}/head:${FETCH_HEAD_REF}`, `+refs/heads/${baseRef}:${FETCH_BASE_REF}`], { cwd: store, env: authEnv(token) });
    const base = git(["--git-dir", store, "rev-parse", "--verify", "--quiet", "--end-of-options", `${FETCH_BASE_REF}^{commit}`], { cwd: store }).trim();
    return { diffId: diff({ base: assertSha(base, "base"), head, cwd: store }), error: null };
  } catch (error) {
    return { diffId: null, error: error?.message ?? String(error) };
  } finally {
    // Best effort: cleanup of a temp store must never turn a computed result
    // into a writer failure.
    if (store) {
      try {
        removeStore(store);
      } catch (error) {
        process.stderr.write(`ovd-merge-gate: could not remove ${store}: ${error?.message ?? error}\n`);
      }
    }
  }
}

const MAX_SCAN_FILES = 200;
const MAX_SCAN_FILE_BYTES = 256 * 1024;
const MAX_SCAN_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Scan complete head text, not truncated API patches. Unreadable/binary or
 * oversized work cannot quietly bypass a held operation. No code executes.
 * Files are read one at a time (inSequence), so a large PR never fans out
 * hundreds of concurrent API reads.
 */
async function scanHeldContent(pull) {
  if (pull.files.length > MAX_SCAN_FILES) throw new Error(`held-content scan exceeds ${MAX_SCAN_FILES}-file ceiling`);
  const held = new Set();
  let scannedBytes = 0;
  const heads = pull.files.filter((file) => file.status !== "removed");
  for await (const text of inSequence(heads, (file) => pull.readHeadFile(file.filename))) {
    if (typeof text !== "string" || text.length > MAX_SCAN_FILE_BYTES) throw new Error("held-content scan unreadable or oversized");
    scannedBytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > MAX_SCAN_FILE_BYTES || scannedBytes > MAX_SCAN_TOTAL_BYTES) throw new Error("held-content scan exceeds byte ceiling");
    for (const hold of heldContent(text)) held.add(hold);
  }
  return [...held];
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
    result.held_categories = await scanHeldContent(pull);
    const incomplete = pull.errors.length ? "the changed-file list is incomplete or stale" : null;
    const loosening = await gateLooseningForPull({ ...pull, baseRaw, sensitivePathsText, incomplete });
    result.gate_loosening = loosening.gateLoosening;
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
 * pull_request_target runs the base branch's workflow file. Its head_branch is
 * the PR head, so that field cannot prove the YAML was the default branch's.
 * workflow_run.pull_requests is computed when the API is read, not when the
 * run happened, so a run on a non-default base whose PR was later retargeted
 * (or re-opened) into the default branch would show the default base. Trust is
 * therefore tied to the trigger (OVD-1109):
 * - pull_requests is exactly [the PR being evaluated], based on the default branch;
 * - that PR (still based on the default branch) was created no later than the run;
 * - the run was created after the PR's last base_ref_changed event, so the PR
 *   already targeted the default branch when the run happened;
 * - the run's head branch and head repository are that PR's head;
 * - every PR, open or closed, from the same head branch targets the default
 *   branch and had no base_ref_changed event at or after the run (a closed
 *   sibling drops out of pull_requests but could have triggered the run, and a
 *   sibling retargeted before it closed shows only its final base).
 * Anything else, including a missing list (closed or fork PRs), fails closed.
 * PR, timeline, sibling and sibling-timeline reads are cached per client and PR.
 */
const prFactsCache = new WeakMap();
function prFacts(client, repo, pr) {
  let byPr = prFactsCache.get(client);
  if (!byPr) {
    byPr = new Map();
    prFactsCache.set(client, byPr);
  }
  const key = `${repo}#${Number(pr)}`;
  if (!byPr.has(key)) {
    const facts = (async () => {
      const pull = await client.json(`/repos/${repo}/pulls/${Number(pr)}`);
      const timeline = await client.paginate(`/repos/${repo}/issues/${Number(pr)}/timeline`, (data) => data);
      const owner = pull?.head?.repo?.owner?.login;
      const ref = pull?.head?.ref;
      const head = `${owner}:${ref}`;
      const siblings = typeof owner === "string" && typeof ref === "string"
        ? await client.paginate(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(head)}`, (data) => data)
        : null;
      const others = (Array.isArray(siblings) ? siblings : [])
        .filter((sibling) => PR_NUMBER.test(String(sibling?.number ?? "")) && Number(sibling.number) !== Number(pr))
        .map((sibling) => Number(sibling.number));
      const siblingTimelines = new Map(await Promise.all(others.map(async (number) =>
        [number, await client.paginate(`/repos/${repo}/issues/${number}/timeline`, (data) => data)])));
      return { pull, timeline, siblings, siblingTimelines };
    })();
    facts.catch(() => byPr.delete(key));
    byPr.set(key, facts);
  }
  return byPr.get(key);
}

/** True when the timeline is readable and has no base change at or after `since` (or at an unknown time). */
function baseUnchangedSince(timeline, since) {
  if (!Array.isArray(timeline) || timeline.some((item) => !isRecord(item))) return false;
  return timeline.every((item) => {
    if (item.event !== "base_ref_changed") return true;
    const changed = Date.parse(item.created_at);
    return Number.isFinite(changed) && changed < since;
  });
}

async function pullRequestTargetOnDefaultBranch(client, repo, workflow, defaultBranch, pr) {
  const pulls = workflow?.pull_requests;
  if (!Array.isArray(pulls) || pulls.length !== 1 || typeof defaultBranch !== "string" || !PR_NUMBER.test(String(pr ?? ""))) return false;
  const [listed] = pulls;
  if (!isRecord(listed) || Number(listed.number) !== Number(pr) || !isRecord(listed.base) || listed.base.ref !== defaultBranch) return false;
  const { pull, timeline, siblings, siblingTimelines } = await prFacts(client, repo, pr);
  const pullCreated = Date.parse(pull?.created_at);
  const runCreated = Date.parse(workflow?.created_at);
  if (pull?.base?.ref !== defaultBranch || !Number.isFinite(pullCreated) || !Number.isFinite(runCreated) || pullCreated > runCreated) return false;
  const headRepo = pull?.head?.repo?.full_name;
  if (typeof headRepo !== "string" || workflow?.head_repository?.full_name !== headRepo || workflow?.head_branch !== pull?.head?.ref) return false;
  if (!baseUnchangedSince(timeline, runCreated)) return false;
  if (!Array.isArray(siblings) || !siblings.some((s) => isRecord(s) && Number(s.number) === Number(pr))) return false;
  return siblings.every((s) => isRecord(s) && isRecord(s.base) && s.base.ref === defaultBranch
    && (Number(s.number) === Number(pr) || baseUnchangedSince(siblingTimelines.get(Number(s.number)), runCreated)));
}

/** Reject foreign writers before interpreting any stored gate data. `pr` is the PR the record is read for. */
export async function verifyGateProvenance(client, repo, run, pr) {
  if (run?.app?.id !== GITHUB_ACTIONS_APP_ID || !Number.isInteger(run?.check_suite?.id)) throw new Error("gate record has no trusted Actions check suite");
  const repository = await client.json(`/repos/${repo}`);
  const workflows = await client.paginate(`/repos/${repo}/actions/runs?check_suite_id=${run.check_suite.id}`, (data) => data?.workflow_runs);
  if (workflows.length !== 1) throw new Error("gate record workflow provenance is ambiguous or missing");
  const workflow = workflows[0];
  const defaultBranch = repository.default_branch;
  if (workflow.check_suite_id !== run.check_suite.id || workflow.path !== ".github/workflows/ovd-merge-gate.yml"
      || !GATE_EVENTS.includes(workflow.event) || typeof defaultBranch !== "string") {
    throw new Error("gate record is not from the default-branch merge-gate workflow");
  }
  const onDefaultBranch = workflow.event === "pull_request_target"
    ? await pullRequestTargetOnDefaultBranch(client, repo, workflow, defaultBranch, pr)
    : workflow.head_branch === defaultBranch;
  if (!onDefaultBranch) throw new Error("gate record is not from the default-branch merge-gate workflow");
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
export async function recordHistory({ client, repo, pr, event }) {
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
  await batches.reduce((previous, { entries, text }) => previous.then(() => client.post(`/repos/${repo}/check-runs`, {
      name: historyCheckName(pr),
      head_sha: HISTORY_ANCHOR_SHA,
      external_id: `pr-${pr}`,
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
export async function runGate({ client, repo, pr, sha, cwd, root, token, fetch = true, event = null, git, diff, classify = classifyPull, historyResult, reviewThreads, jevWriters }) {
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
  const statuses = validHead ? await attempt(() => client.paginate(`/repos/${repo}/commits/${headSha}/statuses`)) : undefined;
  const threads = reviewThreads ?? await attempt(() => readReviewThreads(client, repo, pr, headSha));
  // Lazy import: this gate runs without npm install. The PR-body validator's
  // existing TypeScript dependency may be unavailable; that only fails the
  // door report closed and cannot prevent the legacy gate from running.
  const revertPlan = await attempt(async () => {
    const { validateRevertPlan } = await import("./validate-pr-body.mjs");
    return { sha: headSha, ...validateRevertPlan(pull?.body, classification?.door) };
  });
  const summary = evaluate({
    reviewThreads: threads,
    commitStatuses: { sha: headSha, statuses },
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
    jevWriters,
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
  summary.comments_fingerprint = commentsFingerprint(comments);
  summary.body_fingerprint = bodyFingerprint(pull?.body);
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
export async function writeCheckRun({ client, repo, sha, summary }) {
  const { conclusion, title } = conclusionFor(summary);
  return client.post(`/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion,
    output: { title, summary: formatSummary(summary), text: summaryText(summary) },
  });
}

// ------------------------------------------------- comment trigger filter

/**
 * OVD-1144. The issue_comment substrings that start a gate run. Both jobs'
 * job-level `if:` is built from this list by commentFilterExpression(), and a
 * test pins the workflow to it, so every other comment (relay, progress or
 * status chatter) starts no job and spends no run. GitHub's contains() is
 * case-insensitive, so this is a superset of what the parsers accept:
 * - the two fences the gate reads (verdicts and Blaine's approval records),
 * - plain verdict markers ("VERDICT: PASS" also covers PASS_NOTES and the
 *   emit-verdict summary line "OverDrafter verdict: PASS"; "QA PASS"/"QA FAIL"
 *   are the QA lines trust-metrics reads).
 * An edit also matches on its previous body, so editing a verdict away
 * re-evaluates the gate.
 */
export const TRIGGER_COMMENT_MARKERS = Object.freeze([
  "```" + FENCE_INFO,
  "```" + APPROVAL_FENCE_INFO,
  "VERDICT: PASS",
  "VERDICT: FAIL",
  // Architect header verdicts (item-6 ruling): a header-only CHANGES_REQUIRED must reach the history.
  "VERDICT: CHANGES_REQUIRED",
  "QA PASS",
  "QA FAIL",
]);

const COMMENT_FIELDS = Object.freeze(["github.event.comment.body", "github.event.changes.body.from"]);

/** The GitHub expression both jobs use: every non-comment event passes, a comment only with a marker. */
export function commentFilterExpression(markers = TRIGGER_COMMENT_MARKERS) {
  const terms = COMMENT_FIELDS.flatMap((field) => markers.map((marker) => `contains(${field}, '${marker.replaceAll("'", "''")}')`));
  return `(github.event_name != 'issue_comment' || ${terms.join(" || ")})`;
}

/**
 * The same decision in JS (contains() semantics: case-insensitive substring,
 * a missing field is the empty string), for tests and local checks.
 */
export function isTriggerComment({ body, previousBody } = {}, markers = TRIGGER_COMMENT_MARKERS) {
  const texts = [body, previousBody].map((text) => (typeof text === "string" ? text.toLowerCase() : ""));
  return markers.some((marker) => texts.some((text) => text.includes(marker.toLowerCase())));
}

// ------------------------------------------------- sticky status comment

/**
 * OVD-1144. The writer keeps exactly one status comment per PR, found by this
 * hidden marker and edited in place (REST PATCH); it never posts a comment per
 * run. Only a comment by STATUS_COMMENT_AUTHOR (the workflow's GITHUB_TOKEN
 * identity) counts: anyone can paste the marker. The comment is advisory; the
 * check run is the gate. Comments posted or edited with GITHUB_TOKEN start no
 * workflow, and the body carries no trigger marker (tested), so it cannot
 * loop.
 */
export const STATUS_MARKER = "<!-- ovd-merge-gate-status -->";
export const STATUS_COMMENT_AUTHOR = "github-actions[bot]";

/** The status comment body: the marker, then head, conclusion, title and reason codes (no free text). */
export function formatStatusComment(summary, { checkUrl } = {}) {
  const { conclusion, title } = conclusionFor(summary);
  const codes = reasonCodes(summary);
  const blockingCodes = codes.length ? codes.map((code) => "`" + code + "`").join(", ") : "none";
  const lines = [
    STATUS_MARKER,
    `**ovd-merge-gate** \`${conclusion}\` for \`${summary?.sha ?? "unknown"}\` (mode \`${summary?.mode ?? MODE}\`)`,
    "",
    `- result: ${oneLine(title)}`,
    `- blocking codes: ${blockingCodes}`,
  ];
  if (typeof checkUrl === "string" && checkUrl.startsWith("https://github.com/")) lines.push(`- check run: ${checkUrl}`);
  lines.push("", "_Edited in place on every gate run. Not a verdict; details are in the check run._", "");
  return lines.join("\n");
}

/** The sticky comment: the oldest trusted-author comment whose body starts with the marker, or null. */
export function findStatusComment(comments, author = STATUS_COMMENT_AUTHOR) {
  const mine = list(comments).filter((comment) => isRecord(comment) && comment.user?.login === author && typeof comment.body === "string" && comment.body.startsWith(STATUS_MARKER));
  mine.sort((a, b) => Number(a.id) - Number(b.id));
  return mine[0] ?? null;
}

/**
 * Create the status comment once, then PATCH it in place; unchanged bodies
 * are left alone. Returns { action: "created" | "updated" | "unchanged", id }.
 */
export async function upsertStatusComment({ client, repo, pr, body }) {
  const existing = findStatusComment(await client.paginate(`/repos/${repo}/issues/${pr}/comments`));
  if (existing && existing.body === body) return { action: "unchanged", id: existing.id };
  if (existing) {
    await client.patch(`/repos/${repo}/issues/comments/${existing.id}`, { body });
    return { action: "updated", id: existing.id };
  }
  const created = await client.post(`/repos/${repo}/issues/${pr}/comments`, { body });
  return { action: "created", id: created?.id ?? null };
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

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** The queue no-op: the rule was evaluated on the PR head; the queue only needs the check to exist. */
async function writeMergeGroup({ client, options, stdout }) {
  const summary = { gate: "pass", sha: options.sha, mode: MODE, identity: IDENTITY, identity_note: IDENTITY_NOTES[IDENTITY], automerge: "needs_release", reasons: [], warnings: [{ code: "merge_group", detail: "merge queue no-op; the gate ran on the PR head" }], ignored: [], deleted_verdicts: [] };
  await client.post(`/repos/${options.repo}/check-runs`, { name: CHECK_NAME, head_sha: options.sha, status: "completed", conclusion: "success", output: { title: "ovd-merge-gate: merge queue no-op", summary: "The merge gate was evaluated on the PR head.", text: jsonBlock(summary) } });
  stdout.write(`ovd-merge-gate: merge_group success on ${options.sha}\n`);
  return 0;
}

/** Read every thread and bind the connection to GitHub's live PR head. */
export async function readReviewThreads(client, repo, pr, sha) {
  const [owner, name] = repo.split("/");
  const threads = [];
  let after = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await client.post("/graphql", {
      query: `query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`,
      variables: { owner, name, pr: Number(pr), after },
    });
    const pull = data?.data?.repository?.pullRequest;
    const connection = pull?.reviewThreads;
    if (data.errors || pull?.headRefOid !== sha || !Array.isArray(connection?.nodes)
        || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("review thread snapshot is incomplete or stale");
    threads.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return { sha, complete: true, threads };
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error("review thread cursor did not advance");
    after = connection.pageInfo.endCursor;
  }
  throw new Error("too many review thread pages");
}

/** A label that stops the merge; labels can only ever stop it, never enable it. */
export const HOLD_LABEL = "automerge:hold";

/**
 * The second stop, checked on the freshly re-read PR right before the merge
 * call: any non-empty vars.OVD_AUTOMERGE_DISABLED, the automerge:hold label,
 * or an unreadable label list. Returns why the merge is stopped, or null.
 */
export function mergeStop(disabledValue, pull) {
  if (disabledValue !== undefined && disabledValue !== "") return "OVD_AUTOMERGE_DISABLED is set";
  if (!Array.isArray(pull?.labels)) return "the PR labels could not be read";
  if (pull.labels.some((label) => typeof label?.name !== "string" || label.name.trim().toLowerCase() === HOLD_LABEL)) return `the PR has the ${HOLD_LABEL} label (or an unreadable label)`;
  return null;
}

/**
 * Identity of the evaluated comment set. A comment created, edited or deleted
 * after evaluation changes it, so a verdict cannot change between read and merge.
 * Null when the comments were unreadable.
 */
export function commentsFingerprint(comments) {
  if (!Array.isArray(comments)) return null;
  const keys = comments.map((comment) => `${comment?.id}@${comment?.updated_at}`).toSorted((a, b) => a.localeCompare(b, "en"));
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

/**
 * Identity of the evaluated PR body: its Built-by line and build-session ids
 * decide reviewer independence, so a body edited after evaluation blocks the
 * merge (council 6538642610). Null when the body was unreadable.
 */
export function bodyFingerprint(body) {
  return typeof body === "string" ? createHash("sha256").update(body).digest("hex") : null;
}

/** Returns { merged, reason }: reason says why no merge was attempted. */
export async function mergePull({ client, repo, pr, summary, switchValue, disabledValue, merge = (args) => execFileSync(resolveBinary("gh"), args, { stdio: "ignore", timeout: 60_000 }) }) {
  if (switchValue !== "true") return { merged: false, reason: "DOOR_AUTOMERGE is not exactly true" };
  // The variable needs no API read; refuse before touching the PR.
  const disabled = mergeStop(disabledValue, { labels: [] });
  if (disabled) return { merged: false, reason: disabled };
  const pull = await client.json(`/repos/${repo}/pulls/${pr}`);
  if (!mergeEligibility(summary, switchValue, pull)) return { merged: false, reason: "the gate did not pass for the live, open, clean head" };
  // Re-read the comments: a verdict added, edited or deleted after evaluation blocks.
  const evaluated = summary.comments_fingerprint;
  const live = await attempt(() => client.paginate(`/repos/${repo}/issues/${pr}/comments`));
  if (typeof evaluated !== "string" || commentsFingerprint(live) !== evaluated) return { merged: false, reason: "PR comments changed after evaluation (or could not be re-read)" };
  if (typeof summary.body_fingerprint !== "string" || bodyFingerprint(pull?.body) !== summary.body_fingerprint) return { merged: false, reason: "the PR body changed after evaluation (or could not be read)" };
  // The stop wins over everything else, so it is the last check before the call.
  const stop = mergeStop(disabledValue, pull);
  if (stop) return { merged: false, reason: stop };
  // GitHub performs the final atomic head comparison. Never queue --auto or
  // bypass branch protection with --admin.
  await merge(["pr", "merge", String(pr), "--repo", repo, "--squash", "--match-head-commit", summary.sha]);
  return { merged: true, reason: null };
}

async function writeGate({ client, options, summary, stdout, stderr, switchValue, disabledValue, merge }) {
  // Re-read the head right before writing: a result for a head that moved is not written.
  const now = (await client.json(`/repos/${options.repo}/pulls/${options.pr}`))?.head?.sha;
  if (now !== summary.sha) {
    stdout.write(`ovd-merge-gate: head moved from ${summary.sha} to ${now}; not writing (the run for the new head writes it)\n`);
    return 0;
  }
  const check = await writeCheckRun({ client, repo: options.repo, sha: summary.sha, summary });
  stdout.write(`${formatSummary(summary)}\n${conclusionFor(summary).title}\n`);
  // Merge before the status edit: editing a comment changes the evaluated comment set.
  const { merged, reason } = await mergePull({ client, repo: options.repo, pr: options.pr, summary, switchValue, disabledValue, merge });
  stdout.write(merged ? "ovd-merge-gate: squash merge submitted for the evaluated head\n" : `ovd-merge-gate: no merge: ${reason}\n`);
  // Advisory and best effort, after the check run: a failed edit warns and never changes the gate.
  try {
    const { action } = await upsertStatusComment({ client, repo: options.repo, pr: options.pr, body: formatStatusComment(summary, { checkUrl: check?.html_url }) });
    stderr.write(`ovd-merge-gate: status comment ${action}\n`);
  } catch (error) {
    stderr.write(`::warning::ovd-merge-gate: status comment not updated: ${oneLine(error?.message ?? String(error))}\n`);
  }
  return 0;
}

async function runCommand({ options, env, client, token, cwd, git, diff, classify, stdout, stderr, merge, jevWriters }) {
  if (options.command === "merge-group") return writeMergeGroup({ client, options, stdout });
  if (options.command === "record") {
    const { written } = await recordHistory({ client, repo: options.repo, pr: options.pr, event: readEvent(env) });
    stdout.write(`ovd-merge-gate: recorded ${written} blocking verdict(s) in the history of PR #${options.pr}\n`);
    return 0;
  }
  const event = options.command === "write" ? readEvent(env) : null;
  const summary = await runGate({ client, repo: options.repo, pr: options.pr, sha: options.sha, cwd, token, fetch: options.fetch, event, git, diff, classify, historyResult: options.historyResult, jevWriters });
  if (options.command === "write") return writeGate({ client, options, summary, stdout, stderr, switchValue: env.DOOR_AUTOMERGE, disabledValue: env.OVD_AUTOMERGE_DISABLED, merge });
  stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
  return summary.gate === "pass" ? 0 : 1;
}

/**
 * CLI. Returns the exit code: evaluate 0 pass / 1 fail; record, write and
 * merge-group 0 once handled (the check carries the enforced result), 1 when a
 * check run could not be written; 2 on usage errors.
 */
export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), git, diff, classify, merge, jevWriters } = {}) {
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
    return await runCommand({ options, env, client, token, cwd, git, diff, classify, stdout, stderr, merge, jevWriters });
  } catch (error) {
    stderr.write(`ovd-merge-gate: ${error?.message ?? String(error)}\n`);
    // The writer step tees stdout into the step summary, so the API failure (status, rate-limit headers, message) shows there too.
    if (error instanceof GithubApiError) stdout.write(`### ovd-merge-gate: ERROR\n\n${error.message}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main();
}
