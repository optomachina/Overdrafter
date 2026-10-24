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
 *     cites a new ci-run/verify-run; a FAIL with findings or a high note is a
 *     product FAIL and needs a new head),
 * (d) verdicts from trusted logins only (TRUSTED_VERIFIERS, a constant here,
 *     never an env or repo variable),
 * (e) no edited, deleted or malformed trusted verdict for the head until a
 *     fresh one is posted (untrusted and malformed-by-others blocks are ignored),
 * (f) Blaine's `overdrafter.approval/v1` record for any sensitive class, from
 *     the default-branch copy of the sensitive-class detector; a detector
 *     status other than ok, or a missing, partial or stale result, is
 *     classifier_error,
 * (g) independence, enforced only when IDENTITY is "app" (stage B).
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
 *   node scripts/ovd-merge-gate.mjs write --pr N [--repo o/r]
 *       evaluates the live head, re-reads the head, writes the check run
 *   node scripts/ovd-merge-gate.mjs merge-group --sha S [--repo o/r]
 *       writes success on the merge group commit (the queue no-op)
 *
 * See docs/verdict-format.md ("OVD-845 merge gate").
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { isEntryPoint } from "./lib/entry-point.mjs";
import { pathCandidates } from "./lib/sensitive-paths.mjs";
import { approvalForHead, parseApprovalComments } from "./approval-record.mjs";
import { assertSha, computeDiffId, resolveBinary } from "./emit-verdict.mjs";
import { detect, fetchPullRequest, gateLooseningForPull, loadConfig } from "./sensitive-class-detect.mjs";
import { FENCE_INFO, extractVerdictBlocks, hasHighNote, parseVerdictComments } from "./verdict-schema.mjs";

export const CHECK_NAME = "ovd-merge-gate";
export const MODE = "report";
export const IDENTITY = "shared-account";
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

const MODES = new Set(["report", "enforce"]);
const IDENTITIES = new Set(["shared-account", "app"]);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PASSING = new Set(["PASS", "PASS_NOTES"]);
const RUN_KINDS = new Set(["ci-run", "verify-run"]);
/** Parser rejections that mean a trusted block could not be read (author_mismatch is ignored: it is not the author's verdict). */
const MALFORMED = new Set(["invalid_json", "schema_error", "missing_comment_timestamps"]);

const lower = (login) => (typeof login === "string" ? login.toLowerCase() : null);
const inList = (list, login) => login !== null && list.some((entry) => entry.toLowerCase() === login);
const instant = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NaN;
};

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

/**
 * Every verdict block in the comments, one at a time, through the shared
 * parser. parseVerdictComments only reports the latest verifier verdict and
 * the ones that disagree with it, so an earlier PASS with a high finding
 * would be hidden; giving it one block at a time keeps every entry while
 * reusing its validation (schema, edited comments, author match, timestamps).
 */
export function collectVerdicts(comments, headSha) {
  const entries = [];
  const rejected = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    extractVerdictBlocks(comment?.body).forEach((text, block) => {
      const single = { ...comment, body: `\`\`\`${FENCE_INFO}\n${text}\n\`\`\`` };
      const parsed = parseVerdictComments([single], { sha: headSha });
      const author = comment.user?.login ?? null;
      if (parsed.rejected.length) {
        for (const item of parsed.rejected) rejected.push({ ...item, block, author, text, created_at: comment.created_at ?? null });
        return;
      }
      const entry = parsed.latest ?? parsed.reviews[0] ?? parsed.other_sha[0];
      if (entry) entries.push({ comment_id: comment.id ?? null, block, created_at: comment.created_at, author, verdict: entry.verdict });
    });
  }
  entries.sort(compareEntries);
  return { entries, rejected };
}

/** The ci-run / verify-run ids a verdict cites (the Actions run id, else the URL). */
function runIds(verdict) {
  return new Set((verdict.evidence ?? []).filter((item) => RUN_KINDS.has(item.kind)).map((item) => /\/actions\/runs\/(\d+)/.exec(item.url)?.[1] ?? item.url));
}

const hasHighFinding = (verdict) => Array.isArray(verdict.findings) && verdict.findings.some((finding) => finding?.severity === "high");
const isHigh = (verdict) => hasHighNote(verdict) || hasHighFinding(verdict);
/** A FAIL for product reasons (any finding or a high note) can never be superseded at the same SHA. */
const isProductFail = (verdict) => (Array.isArray(verdict.findings) && verdict.findings.length > 0) || hasHighNote(verdict);

/**
 * Split one role's bound entries into outstanding FAILs and the verdicts that
 * supersede a FAIL. A supersede is valid only for a non-product FAIL, at the
 * same SHA, from a later comment, with reason infra and a run id the FAIL did
 * not cite. An invalid claim leaves the FAIL standing and is a conflict.
 */
function resolveFails(entries) {
  const fails = entries.filter((entry) => entry.verdict.verdict === "FAIL");
  const outstanding = [];
  const conflicts = [];
  for (const fail of fails) {
    const claims = entries.filter((entry) => entry !== fail && entry.verdict.supersedes !== undefined && Number(entry.verdict.supersedes) === Number(fail.comment_id));
    const valid = claims.find((entry) => {
      if (isProductFail(fail.verdict) || entry.verdict.reason !== "infra" || entry.verdict.sha !== fail.verdict.sha || !postedAfter(entry, fail)) return false;
      const old = runIds(fail.verdict);
      return [...runIds(entry.verdict)].some((id) => !old.has(id));
    });
    if (valid) continue;
    outstanding.push(fail);
    for (const claim of claims) conflicts.push(`comment ${claim.comment_id} cannot supersede FAIL ${fail.comment_id} (needs reason infra, the same SHA, a later comment, a new run id and a FAIL with no findings or high note)`);
  }
  return { outstanding, conflicts };
}

/** Why a detector result cannot be trusted for this head, or null when its status is ok and complete. */
function classifierProblem(classification, headSha, changedFiles) {
  if (classification === null || classification === undefined || typeof classification !== "object") return "no sensitive-class result (missing)";
  if (classification.status !== "ok") {
    const errors = Array.isArray(classification.errors) && classification.errors.length ? `: ${classification.errors.join("; ")}` : "";
    return `sensitive-class status is ${JSON.stringify(classification.status ?? null)}, not "ok"${errors}`;
  }
  if (classification.sha !== headSha) return `sensitive-class result is for ${JSON.stringify(classification.sha ?? null)}, not the head ${headSha}`;
  if (!Array.isArray(classification.classes) || classification.classes.some((name) => typeof name !== "string")) return "sensitive-class result has no class list (partial)";
  if (!Array.isArray(classification.files)) return "sensitive-class result has no file list (partial)";
  const classified = new Set(classification.files.map((file) => file?.path));
  const missing = changedFiles.map(changedPath).filter((file) => !classified.has(file));
  if (missing.length) return `sensitive-class result does not cover ${missing.length} changed file(s) (partial): ${missing.slice(0, 5).join(", ")}`;
  return null;
}

const changedPath = (file) => (typeof file === "string" ? file : file?.filename);
const changedPaths = (file) => [changedPath(file), typeof file === "object" ? file?.previous_filename : undefined].filter((name) => typeof name === "string");
/** Any .github/** change is sensitive (infra_ci) in every spelling, whatever the shared list says. */
const touchesGithub = (file) => changedPaths(file).some((name) => pathCandidates(name).some((form) => /^\.github(?:\/|$)/i.test(form)));

/** Edited, malformed or deleted trusted verdicts that may be for this head and have no fresher trusted verdict. */
function staleTrustedEdits({ rejected, deletedVerdicts, entries, trusted, headSha, headDiffId }) {
  const reasons = [];
  const mayBeForHead = (text) => {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return { forHead: true, role: null };
      const forHead = typeof parsed.sha !== "string" || parsed.sha === headSha || typeof parsed.diff_id !== "string" || parsed.diff_id === headDiffId;
      return { forHead, role: typeof parsed.role === "string" ? parsed.role : null };
    } catch {
      return { forHead: true, role: null };
    }
  };
  const fresher = (item, role) => entries.some((entry) => (role === null || entry.verdict.role === role) && postedAfter(entry, item));
  for (const item of rejected) {
    if (!inList(trusted, lower(item.author))) continue;
    const { forHead, role } = mayBeForHead(item.text);
    if (!forHead || fresher(item, role)) continue;
    if (item.reason === "edited_comment") reasons.push({ code: "edited_verdict", detail: `trusted verdict comment ${item.comment_id} was edited; post a fresh verdict` });
    // A trusted block that does not parse may be a FAIL; it never counts as a pass and is not silently dropped.
    else if (MALFORMED.has(item.reason)) reasons.push({ code: "verdict_schema_error", detail: `trusted verdict comment ${item.comment_id} block ${item.block} is ${item.reason}; post a fresh verdict` });
  }
  for (const item of Array.isArray(deletedVerdicts) ? deletedVerdicts : []) {
    if (!item || !inList(trusted, lower(item.author))) continue;
    const forHead = typeof item.sha !== "string" || item.sha === headSha || typeof item.diff_id !== "string" || item.diff_id === headDiffId;
    const role = typeof item.role === "string" ? item.role : null;
    if (forHead && !fresher(item, role)) reasons.push({ code: "edited_verdict", detail: `trusted verdict comment ${item.comment_id} was deleted; post a fresh verdict` });
  }
  return reasons;
}

function independenceProblems({ entries, identity, prAuthor, commits }) {
  if (identity !== "app") return { ignored: [], reasons: [] };
  const ignored = [];
  const reasons = [];
  const authors = new Set([lower(prAuthor)]);
  if (!Array.isArray(commits)) reasons.push({ code: "missing_input", detail: "PR commit list is missing, so independence cannot be checked" });
  for (const commit of Array.isArray(commits) ? commits : []) {
    authors.add(lower(commit?.author?.login));
    authors.add(lower(commit?.committer?.login));
  }
  authors.delete(null);
  const kept = [];
  for (const entry of entries) {
    const author = lower(entry.author);
    if (inList(MERGER_LOGINS, author)) {
      ignored.push({ comment_id: entry.comment_id, code: "verifier_is_merger", detail: `${entry.author} is a merging identity` });
      continue;
    }
    if (authors.has(author)) {
      reasons.push({ code: "verifier_not_independent", detail: `${entry.author} authored or committed this PR (comment ${entry.comment_id})` });
      continue;
    }
    kept.push(entry);
  }
  return { ignored, reasons, kept };
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
  for (const entry of verifiers.filter((item) => PASSING.has(item.verdict.verdict) && isHigh(item.verdict))) {
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

/** Outstanding FAILs and pass/fail disagreement within one role's union. */
function failReasons(role, entries) {
  const reasons = [];
  const { outstanding, conflicts } = resolveFails(entries);
  for (const detail of conflicts) reasons.push({ code: "verdict_conflict", detail });
  if (outstanding.length) {
    const disagree = entries.some((entry) => PASSING.has(entry.verdict.verdict));
    const ids = outstanding.map((entry) => entry.comment_id).join(", ");
    if (disagree) reasons.push({ code: "verdict_conflict", detail: `${role} verdicts bound to the head disagree: FAIL in comment(s) ${ids} stands` });
    else reasons.push({ code: role === "verifier" ? "no_qa_pass_on_head" : "no_review_on_head", detail: `${role} FAIL in comment(s) ${ids}` });
  }
  return { reasons, outstanding };
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

/**
 * Evaluate the gate for one head. Pure: every input is data.
 *
 * @param {object} input
 * @param {string} input.headSha the head SHA being gated (40-hex)
 * @param {string} [input.liveHeadSha] the PR head as re-read from the API; must equal headSha
 * @param {string|null} input.headDiffId diff_id recomputed from base...head, or null when it could not be
 * @param {string} [input.diffIdError] why diff_id could not be computed
 * @param {object[]} input.comments PR issue comments
 * @param {object[]} [input.deletedVerdicts] deleted trusted verdict comments seen ({ comment_id, author, created_at, sha, diff_id, role })
 * @param {object[]} input.commits PR commits ({ author: { login }, committer: { login } })
 * @param {string} input.prAuthor PR author login
 * @param {Array<object|string>} input.changedFiles PR files ({ filename, status, previous_filename })
 * @param {object} input.classification the default-branch sensitive-class detector result
 * @param {"report"|"enforce"} input.mode
 * @param {"shared-account"|"app"} input.identity
 */
export function evaluate(given = {}) {
  const input = given !== null && typeof given === "object" ? given : {};
  const { headSha, liveHeadSha, headDiffId, diffIdError, comments, deletedVerdicts = [], commits, prAuthor, changedFiles, classification } = input;
  const mode = MODES.has(input.mode) ? input.mode : "enforce";
  const identity = IDENTITIES.has(input.identity) ? input.identity : "app";
  const reasons = [];
  const warnings = [];
  if (!MODES.has(input.mode)) reasons.push({ code: "missing_input", detail: `unknown mode ${JSON.stringify(input.mode ?? null)}` });
  if (!IDENTITIES.has(input.identity)) reasons.push({ code: "missing_input", detail: `unknown identity ${JSON.stringify(input.identity ?? null)}` });
  const summary = {
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
    reasons,
    warnings,
    ignored: [],
  };
  if (typeof headSha !== "string" || !HEX40.test(headSha)) {
    reasons.push({ code: "missing_input", detail: "head SHA is missing or not a 40-hex SHA" });
    return summary;
  }
  if (typeof liveHeadSha !== "string" || !HEX40.test(liveHeadSha)) reasons.push({ code: "missing_input", detail: "the live PR head could not be read" });
  else if (liveHeadSha !== headSha) reasons.push({ code: "stale_sha", detail: `PR head is ${liveHeadSha}, not ${headSha}` });
  if (summary.diff_id === null) reasons.push({ code: "error", detail: `head diff_id could not be computed${diffIdError ? `: ${diffIdError}` : ""}` });
  if (!Array.isArray(comments)) reasons.push({ code: "missing_input", detail: "PR comment list is missing" });
  if (typeof prAuthor !== "string" || prAuthor === "") reasons.push({ code: "missing_input", detail: "PR author is missing" });

  const trusted = identity === "app" ? APP_TRUSTED_VERIFIERS : TRUSTED_VERIFIERS;
  const { entries, rejected } = collectVerdicts(Array.isArray(comments) ? comments : [], headSha);
  let candidates = [];
  for (const entry of entries) {
    if (inList(trusted, lower(entry.author))) candidates.push(entry);
    else summary.ignored.push({ comment_id: entry.comment_id, code: identity === "app" && inList(MERGER_LOGINS, lower(entry.author)) ? "verifier_is_merger" : "untrusted_author", detail: `${entry.author ?? "unknown"} is not a trusted verifier` });
  }
  for (const item of rejected) summary.ignored.push({ comment_id: item.comment_id, code: item.reason, detail: (item.errors ?? []).join("; ") });
  const independence = independenceProblems({ entries: candidates, identity, prAuthor, commits });
  if (identity === "app") {
    candidates = independence.kept;
    summary.ignored.push(...independence.ignored);
    reasons.push(...independence.reasons);
  }

  const bound = (entry) => entry.verdict.sha === headSha || (summary.diff_id !== null && entry.verdict.diff_id === summary.diff_id);
  // Only a fresh verdict bound to the head clears an edited, deleted or malformed one.
  reasons.push(...staleTrustedEdits({ rejected, deletedVerdicts, entries: candidates.filter(bound), trusted, headSha, headDiffId: summary.diff_id }));

  const verifiers = candidates.filter((entry) => entry.verdict.role === "verifier" && bound(entry));
  const reviewers = candidates.filter((entry) => entry.verdict.role === "reviewer" && bound(entry));
  const staleVerifier = candidates.filter((entry) => entry.verdict.role === "verifier" && !bound(entry)).at(-1) ?? null;

  const verifierFails = failReasons("verifier", verifiers);
  const reviewerFails = failReasons("reviewer", reviewers);
  reasons.push(...verifierFails.reasons, ...reviewerFails.reasons);
  const verifier = verifierReasons(verifiers, staleVerifier);
  reasons.push(...verifier.reasons);
  const reviewer = reviewerReasons(reviewers);
  reasons.push(...reviewer.reasons);
  summary.verifier_comment_id = verifier.chosen?.comment_id ?? null;
  summary.reviewer_comment_ids = reviewer.ids;

  const sensitive = sensitiveReasons({ classification, headSha, headDiffId: summary.diff_id, changedFiles, comments: Array.isArray(comments) ? comments : [] });
  reasons.push(...sensitive.reasons);
  summary.sensitive_classes = sensitive.classes;
  summary.approval_comment_id = sensitive.approval?.comment_id ?? null;
  // eligible needs proof-check evidence per class (OVD-841), which does not exist yet.
  summary.automerge = sensitive.classifierOk && sensitive.classes.length === 0 ? "needs_release" : "needs_blaine";

  if (identity === "shared-account") warnings.push({ code: "identity_not_enforced", detail: IDENTITY_NOTES["shared-account"] });
  summary.reasons = dedupeReasons(reasons);
  summary.gate = summary.reasons.length === 0 ? "pass" : "fail";
  return summary;
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
  const list = codes.length ? codes.join(", ") : "error";
  if (mode === "report") return { conclusion: "neutral", title: `REPORT: would block: ${list}` };
  return { conclusion: "failure", title: `ovd-merge-gate: fail: ${list}` };
}

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
  for (const reason of summary.reasons) lines.push(`- \`${reason.code}\`: ${String(reason.detail).replaceAll(/[\r\n]+/g, " ")}`);
  if (summary.reasons.length) lines.push("");
  return lines.join("\n");
}

// ----------------------------------------------------------------- IO

const REPO = /^[\w.-]+\/[\w.-]+$/;
const PR_NUMBER = /^[1-9]\d{0,6}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const FETCH_HEAD_REF = "refs/ovd-merge-gate/head";
const FETCH_BASE_REF = "refs/ovd-merge-gate/base";
const SAFE_PATH = "/usr/bin:/bin:/usr/local/bin";

export class GithubApiError extends Error {
  constructor(status, path) {
    super(`GitHub API ${path} returned ${status}`);
    this.status = status;
  }
}

/** Minimal GitHub REST client over fetch: json/raw (what the detector's fetchPullRequest uses), paginate, post. */
export function createApi({ token, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
  const headers = { "x-github-api-version": "2022-11-28", "user-agent": "overdrafter-ovd-merge-gate" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = async (method, path, { body, accept = "application/vnd.github+json" } = {}) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: { ...headers, accept, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new GithubApiError(response.status, path);
    return response;
  };
  const json = async (path) => (await request("GET", path)).json();
  const paginate = async (path, pick = (data) => data) => {
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const batch = pick(data);
      if (!Array.isArray(batch)) throw new Error(`${path} page ${page} is not a list`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(`${path} has more than 100 pages`);
  };
  return {
    json,
    raw: async (path) => (await request("GET", path, { accept: "application/vnd.github.raw" })).text(),
    paginate,
    post: async (path, body) => (await request("POST", path, { body })).json(),
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
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/**
 * Fetch the PR head and the base branch tip as data (no checkout, nothing
 * from the PR runs) and recompute diff_id over base...head. Returns
 * { diffId, error } and never throws: any failure is "cannot compute".
 */
export function headDiffId({ pr, headSha, baseRef, cwd, token, fetch = true, git = defaultGit, diff = computeDiffId }) {
  try {
    const head = assertSha(headSha, "head");
    if (typeof baseRef !== "string" || !BRANCH.test(baseRef)) throw new Error(`base ref ${JSON.stringify(baseRef ?? null)} is not a plain branch name`);
    if (!PR_NUMBER.test(String(pr))) throw new Error("PR number is not valid");
    let base;
    if (fetch) {
      git(["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "origin", `+refs/pull/${pr}/head:${FETCH_HEAD_REF}`, `+refs/heads/${baseRef}:${FETCH_BASE_REF}`], { cwd, env: authEnv(token) });
      base = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${FETCH_BASE_REF}^{commit}`], { cwd }).trim();
    } else {
      base = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/origin/${baseRef}^{commit}`], { cwd }).trim();
    }
    return { diffId: diff({ base: assertSha(base, "base"), head, cwd }), error: null };
  } catch (error) {
    return { diffId: null, error: error?.message ?? String(error) };
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
    if (loosening.errors.length) {
      result.errors.push(...loosening.errors);
      result.status = "error";
    }
    return { classification: result, files: pull.files };
  } catch (error) {
    return { classification: { status: "error", sha: headSha, errors: [`classifier threw: ${error?.message ?? String(error)}`] }, files: null };
  }
}

/** The JSON summary embedded in a check run's output.text, or null. */
function summaryFromCheckRun(run) {
  const match = /```json\n([\s\S]*?)\n```/.exec(String(run?.output?.text ?? ""));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** A deleted verdict comment from an issue_comment deleted event, or null. */
export function deletedVerdictFromEvent(event) {
  if (event?.action !== "deleted" || !event.comment) return null;
  const blocks = extractVerdictBlocks(event.comment.body);
  if (!blocks.length) return null;
  const item = { comment_id: event.comment.id ?? null, author: event.comment.user?.login ?? null, created_at: event.comment.created_at ?? null, sha: null, diff_id: null, role: null };
  if (blocks.length === 1) {
    try {
      const parsed = JSON.parse(blocks[0]);
      if (typeof parsed?.sha === "string") item.sha = parsed.sha;
      if (typeof parsed?.diff_id === "string") item.diff_id = parsed.diff_id;
      if (typeof parsed?.role === "string") item.role = parsed.role;
    } catch {
      // Unreadable: treated as possibly for the head.
    }
  }
  return item;
}

/**
 * Deleted trusted verdicts recorded by earlier gate runs on this head. The
 * GitHub API does not list deleted comments, so each run carries forward the
 * deletions it saw; the union over every gate check run on the head can only
 * add deletions, so a forged run cannot remove one.
 */
async function priorDeletions(client, repo, headSha) {
  const runs = await client.paginate(`/repos/${repo}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}`, (data) => data?.check_runs);
  return runs.flatMap((run) => (Array.isArray(summaryFromCheckRun(run)?.deleted_verdicts) ? summaryFromCheckRun(run).deleted_verdicts : []));
}

/**
 * Read everything evaluate() needs for one PR and evaluate it.
 * Never throws for missing data: an unreadable input becomes a fail reason.
 */
export async function runGate({ client, repo, pr, sha, cwd, root, token, fetch = true, event = null, git, diff, classify = classifyPull }) {
  const pull = await client.json(`/repos/${repo}/pulls/${pr}`);
  const liveHeadSha = pull?.head?.sha ?? null;
  const headSha = sha ?? liveHeadSha;
  const read = async (task) => {
    try {
      return await task();
    } catch {
      return undefined;
    }
  };
  const comments = await read(() => client.paginate(`/repos/${repo}/issues/${pr}/comments`));
  const commits = await read(async () => {
    const list = await client.paginate(`/repos/${repo}/pulls/${pr}/commits`);
    return Number.isInteger(pull?.commits) && list.length === pull.commits ? list : undefined;
  });
  const deleted = deletedVerdictFromEvent(event);
  const prior = HEX40.test(String(headSha)) ? await read(() => priorDeletions(client, repo, headSha)) : [];
  const deletedVerdicts = [...(prior ?? []), ...(deleted ? [deleted] : [])];
  const { diffId, error: diffIdError } = headDiffId({ pr, headSha, baseRef: pull?.base?.ref, cwd, token, fetch, git, diff });
  const { classification, files } = await classify({ client, repo, pr, headSha, root });
  const summary = evaluate({
    headSha,
    liveHeadSha,
    headDiffId: diffId,
    diffIdError,
    comments,
    deletedVerdicts,
    commits,
    prAuthor: pull?.user?.login,
    changedFiles: files,
    classification,
    mode: MODE,
    identity: IDENTITY,
  });
  // A prior run that could not be read keeps no deletion history; say so instead of passing silently.
  if (prior === undefined) {
    summary.reasons.push({ code: "missing_input", detail: "earlier gate check runs on this head could not be read" });
    summary.gate = "fail";
  }
  summary.deleted_verdicts = deletedVerdicts.filter((item) => inList([...TRUSTED_VERIFIERS, ...APP_TRUSTED_VERIFIERS], lower(item?.author)));
  return summary;
}

/** POST the ovd-merge-gate check run. */
export async function writeCheckRun({ client, repo, sha, summary }) {
  const { conclusion, title } = conclusionFor(summary);
  return client.post(`/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion,
    output: { title, summary: formatSummary(summary), text: `\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`` },
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!["evaluate", "write", "merge-group"].includes(command)) throw new Error("command must be evaluate, write or merge-group");
  const options = { command, json: false, fetch: true };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--no-fetch") options.fetch = false;
    else if (["--pr", "--sha", "--repo"].includes(arg)) {
      const value = rest[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.pr !== undefined && !PR_NUMBER.test(options.pr)) throw new Error("--pr must be a positive integer");
  if (options.sha !== undefined) assertSha(options.sha, "--sha");
  if (command !== "merge-group" && options.pr === undefined) throw new Error(`${command} needs --pr`);
  if (command === "evaluate" && options.sha === undefined) throw new Error("evaluate needs --sha");
  if (command === "merge-group" && options.sha === undefined) throw new Error("merge-group needs --sha");
  return options;
}

const USAGE = "usage: ovd-merge-gate.mjs evaluate --pr N --sha S [--json] [--repo o/r] [--no-fetch] | write --pr N [--repo o/r] | merge-group --sha S [--repo o/r]";

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * CLI. Returns the exit code: evaluate 0 pass / 1 fail; write and
 * merge-group 0 once handled (report mode never fails the job), 1 when the
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
    if (options.command === "merge-group") {
      // The rule was evaluated on the PR head; the queue only needs the check to exist.
      const summary = { gate: "pass", sha: options.sha, mode: MODE, identity: IDENTITY, identity_note: IDENTITY_NOTES[IDENTITY], automerge: "needs_release", reasons: [], warnings: [{ code: "merge_group", detail: "merge queue no-op; the gate ran on the PR head" }], ignored: [] };
      await client.post(`/repos/${options.repo}/check-runs`, { name: CHECK_NAME, head_sha: options.sha, status: "completed", conclusion: "success", output: { title: "ovd-merge-gate: merge queue no-op", summary: "The merge gate was evaluated on the PR head.", text: `\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`` } });
      stdout.write(`ovd-merge-gate: merge_group success on ${options.sha}\n`);
      return 0;
    }
    const event = options.command === "write" ? readEvent(env) : null;
    const summary = await runGate({ client, repo: options.repo, pr: options.pr, sha: options.sha, cwd, token, fetch: options.fetch, event, git, diff, classify });
    if (options.command === "evaluate") {
      stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
      return summary.gate === "pass" ? 0 : 1;
    }
    // Re-read the head right before writing: a result for a head that moved is not written.
    const now = (await client.json(`/repos/${options.repo}/pulls/${options.pr}`))?.head?.sha;
    if (now !== summary.sha) {
      stdout.write(`ovd-merge-gate: head moved from ${summary.sha} to ${now}; not writing (the run for the new head writes it)\n`);
      return 0;
    }
    await writeCheckRun({ client, repo: options.repo, sha: summary.sha, summary });
    stdout.write(`${formatSummary(summary)}\n${conclusionFor(summary).title}\n`);
    return 0;
  } catch (error) {
    stderr.write(`ovd-merge-gate: ${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main();
}
