#!/usr/bin/env node
// QA handoff runner (OVD-865). One entry point for the qa-handoff workflow and
// the hourly Mac mini backstop:
//
//   node scripts/qa-handoff/run.mjs --repo optomachina/Overdrafter --mode report|apply [--pr N] [--sha SHA]
//
// --pr N --sha SHA  evaluate one PR at the sha a workflow_run reported (workflow)
// --sha SHA         find the open PR whose head is SHA (fork runs carry no PR number)
// --pr N            evaluate one PR at its current head
// (neither)         scan every open PR at its current head (backstop)
//
// Every decision re-reads the PR, required checks, check runs, statuses and
// comments through the API; the caller's sha and PR number are lookup keys
// only. report mode logs what it would hand off and writes nothing to GitHub.
// apply mode adds the qa:ready label and then posts the hidden marker comment,
// after re-reading the head sha and comments inside the critical section, and
// then deletes any duplicate trusted marker a racing writer posted.
//
// Token: GITHUB_TOKEN or GH_TOKEN. Required checks: GET branches/main, else the
// branch protection endpoint, else the REQUIRED_CHECKS env (comma separated),
// else DEFAULT_REQUIRED_CHECKS. Marker authors: DEFAULT_TRUSTED_MARKER_AUTHORS
// plus the QA_HANDOFF_TRUSTED_MARKER_AUTHORS env (comma separated logins); the
// workflow and the backstop must pass the same list.

import { isEntryPoint } from "../lib/entry-point.mjs";
import { appendFileSync } from "node:fs";
import {
  DEFAULT_REQUIRED_CHECKS,
  QA_READY_LABEL,
  BASE_BRANCH,
  decide,
  duplicateMarkers,
  hasMarker,
  markerFor,
  parseRequiredChecks,
  requiredCheckSpec,
  trustedMarkerAuthors,
} from "./gate.mjs";
import { sanitizeLog } from "./sanitize-log.mjs";

const MODES = new Set(["report", "apply"]);

// A backtick fence is only closed by a backtick fence at least as long as the
// opener, so a fence strictly longer than the longest backtick run in the
// content (minimum 3) cannot be closed by PR-derived text. The scan is a single
// pass with no spread or intermediate array, so it holds for any content size
// (spreading hundreds of thousands of runs into Math.max overflows the stack).
export function codeFence(content) {
  const text = String(content);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

export function stepSummary(mode, lines) {
  const body = lines.join("\n");
  const fence = codeFence(body);
  return `### QA handoff (${mode} mode)\n\n${fence}\n${body}\n${fence}\n`;
}

const UNPRINTABLE_ERROR = "unprintable error";

// Text for a log or warning line from whatever was thrown. The thrown value is
// untrusted: a message getter can throw, a Proxy can throw on every access, a
// Symbol or a null-prototype message cannot be stringified, and null has no
// message at all. Reading it is therefore contained and falls back to a
// constant, so describing a failure can never become a second failure.
export function describeError(error, maxLen = 200) {
  try {
    const text = typeof error === "string" ? error : error?.message;
    return typeof text === "string" ? sanitizeLog(text, maxLen) : UNPRINTABLE_ERROR;
  } catch {
    return UNPRINTABLE_ERROR;
  }
}

// Constant apart from the validated mode, so building it cannot fail on
// PR-derived content.
function fallbackSummary(mode) {
  return `### QA handoff (${mode} mode)\n\nThe detailed job summary could not be rendered; see this step's log for the full output.\n`;
}

// The summary is a convenience view of the log, so it must never change the
// job's result: a failure while building it falls back to a short constant
// summary, and a failure while writing it is reported on stderr. Never throws,
// even when the thrown value is hostile or the warning sink itself throws.
// Returns "full", "fallback" or "failed" for the summary that reached the file.
export function writeStepSummary({ path, mode, lines, build = stepSummary, append = appendFileSync, warn = console.error }) {
  const attempts = [
    ["full", () => build(mode, lines)],
    ["fallback", () => fallbackSummary(mode)],
  ];
  for (const [kind, render] of attempts) {
    try {
      append(path, render());
      return kind;
    } catch (error) {
      // Reporting the failure must not become one: describeError never throws,
      // and a broken warning sink has nowhere left to report to.
      try {
        warn(`qa-handoff: could not write ${kind} step summary: ${describeError(error, 500)}`);
      } catch {
        // Best effort: the next attempt, or the return value, still reports it.
      }
    }
  }
  return "failed";
}

export function parseArgs(argv) {
  const args = { repo: undefined, mode: "report", pr: undefined, sha: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--repo") args.repo = value;
    else if (flag === "--mode") args.mode = value;
    else if (flag === "--pr") args.pr = value;
    else if (flag === "--sha") args.sha = value;
    else throw new Error(`unknown argument: ${flag}`);
    i += 1;
  }
  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) throw new Error("--repo owner/name is required");
  if (!MODES.has(args.mode)) throw new Error("--mode must be report or apply");
  if (args.pr !== undefined && args.pr !== "") {
    if (!/^\d+$/.test(args.pr)) throw new Error("--pr must be a number");
    args.pr = Number(args.pr);
  } else {
    args.pr = undefined;
  }
  if (args.sha !== undefined && args.sha !== "") {
    if (!/^[0-9a-f]{40}$/.test(args.sha)) throw new Error("--sha must be a 40 character hex sha");
  } else {
    args.sha = undefined;
  }
  return args;
}

export class GithubApiError extends Error {
  constructor(status, path, body) {
    super(`GitHub API ${status} for ${path}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

// Minimal REST client over fetch. Methods match the fake used in tests.
export function createGithubApi({ token, repo, fetchImpl = fetch, baseUrl = "https://api.github.com" }) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "overdrafter-qa-handoff",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function request(method, path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new GithubApiError(response.status, path, await response.text());
    return { data: response.status === 204 ? null : await response.json(), link: response.headers.get("link") };
  }

  async function paginate(path, pick = (data) => data) {
    const items = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { data, link } = await request("GET", next);
      items.push(...pick(data));
      const match = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
      next = match ? match[1].replace(baseUrl, "") : null;
    }
    return items;
  }

  const r = `/repos/${repo}`;
  return {
    getPr: async (number) => (await request("GET", `${r}/pulls/${number}`)).data,
    listOpenPrs: () => paginate(`${r}/pulls?state=open&base=${BASE_BRANCH}`),
    // GET branches/main carries protection.required_status_checks and is often
    // readable where the protection endpoint (admin scope) is not.
    getBranchRequiredChecks: async () =>
      requiredChecksFrom((await request("GET", `${r}/branches/${BASE_BRANCH}`)).data?.protection?.required_status_checks),
    getProtectionRequiredChecks: async () =>
      requiredChecksFrom((await request("GET", `${r}/branches/${BASE_BRANCH}/protection/required_status_checks`)).data),
    listCheckRuns: (sha) => paginate(`${r}/commits/${sha}/check-runs?filter=latest`, (data) => data.check_runs),
    listStatuses: async (sha) => (await request("GET", `${r}/commits/${sha}/status`)).data.statuses ?? [],
    listComments: (number) => paginate(`${r}/issues/${number}/comments`),
    createComment: async (number, body) => (await request("POST", `${r}/issues/${number}/comments`, { body })).data,
    deleteComment: async (id) => (await request("DELETE", `${r}/issues/comments/${id}`)).data,
    addLabels: async (number, labels) => (await request("POST", `${r}/issues/${number}/labels`, { labels })).data,
  };
}

// Required checks as names, or { name, appId } when `checks[]` pins a check
// to an app. A pinned entry wins over a bare context of the same name.
export function requiredChecksFrom(requiredStatusChecks) {
  const byName = new Map();
  for (const check of requiredStatusChecks?.checks ?? []) {
    byName.set(check.context, check.app_id == null ? check.context : { name: check.context, appId: check.app_id });
  }
  for (const context of requiredStatusChecks?.contexts ?? []) {
    if (!byName.has(context)) byName.set(context, context);
  }
  return [...byName.values()];
}

function formatRequired(checks) {
  return checks
    .map((check) => {
      const { name, appId } = requiredCheckSpec(check);
      return appId === undefined ? sanitizeLog(name) : `${sanitizeLog(name)} (app ${sanitizeLog(appId)})`;
    })
    .join(", ");
}

const isUnreadable = (error) => error instanceof GithubApiError && (error.status === 403 || error.status === 404);

// Branch protection is the source of truth: first the branch endpoint, then
// the protection endpoint. A 403/404 or an empty list moves to the next
// source; when neither yields names, fall back to the documented list. The log
// names the source used.
export async function resolveRequiredChecks(api, env, log) {
  const sources = [
    [`GET branches/${BASE_BRANCH}`, () => api.getBranchRequiredChecks()],
    [`GET branches/${BASE_BRANCH}/protection/required_status_checks`, () => api.getProtectionRequiredChecks()],
  ];
  for (const [label, read] of sources) {
    try {
      const names = await read();
      if (names.length > 0) {
        log(`required checks (${label}): ${formatRequired(names)}`);
        return names;
      }
      log(`${label} lists no required checks`);
    } catch (error) {
      if (!isUnreadable(error)) throw error;
      log(`${label} unreadable (${error.status})`);
    }
  }
  const fromEnv = parseRequiredChecks(env.REQUIRED_CHECKS);
  const names = fromEnv.length > 0 ? fromEnv : [...DEFAULT_REQUIRED_CHECKS];
  log(`required checks (${fromEnv.length > 0 ? "REQUIRED_CHECKS env" : "DEFAULT_REQUIRED_CHECKS"}): ${names.map((name) => sanitizeLog(name)).join(", ")}`);
  return names;
}

export function handoffComment(sha) {
  return `${markerFor(sha)}\nQA handoff: every required check passed on \`${sha.slice(0, 7)}\`. Labeled \`${QA_READY_LABEL}\`.`;
}

// The workflow already serializes runs per PR through its concurrency group;
// tests pass an in-memory lock with the same key to model that.
const noLock = (_key, fn) => fn();

// Evaluate one PR and, in apply mode, hand it off. eventSha defaults to the
// PR's current head (backstop); a workflow passes the workflow_run head_sha.
export async function handoffPr({
  api,
  prNumber,
  eventSha,
  mode,
  requiredChecks,
  trustedAuthors = trustedMarkerAuthors(),
  lock = noLock,
  log = () => {},
}) {
  const pr = await api.getPr(prNumber);
  const headSha = eventSha ?? pr?.head?.sha;
  const event = { headSha, prNumber };
  const tag = `#${sanitizeLog(prNumber)}`;
  const sha = pr?.state === "open" && headSha === pr?.head?.sha ? headSha : undefined;
  const [checkRuns, statuses, comments] = sha
    ? await Promise.all([api.listCheckRuns(sha), api.listStatuses(sha), api.listComments(prNumber)])
    : [[], [], []];
  const decision = decide({ event, pr, checkRuns, statuses, requiredChecks, comments, trustedAuthors });
  if (!decision.handoff) {
    log(`${tag} ${sanitizeLog(decision.key)}: no-op (${sanitizeLog(decision.reason)})${formatChecks(decision.checks)}`);
    return { ...decision, action: "noop" };
  }
  if (mode !== "apply") {
    log(`${tag} ${sanitizeLog(decision.key)}: WOULD hand off (report mode)${formatChecks(decision.checks)}`);
    return { ...decision, action: "would-handoff" };
  }
  return lock(`qa-handoff-${prNumber}`, async () => {
    // Re-check inside the critical section: another run may have handed off
    // or the PR may have moved since the first read.
    const current = await api.getPr(prNumber);
    if (current?.head?.sha !== headSha || current?.state !== "open" || current?.draft) {
      log(`${tag} ${sanitizeLog(decision.key)}: no-op (changed before handoff)`);
      return { ...decision, handoff: false, reason: "changed-before-handoff", action: "noop" };
    }
    if (hasMarker(await api.listComments(prNumber), headSha, trustedAuthors)) {
      log(`${tag} ${sanitizeLog(decision.key)}: no-op (already-handed-off)`);
      return { ...decision, handoff: false, reason: "already-handed-off", action: "noop" };
    }
    // Label first: adding a label is idempotent, and the marker is written
    // last so a failure in between is retried rather than recorded as done.
    await api.addLabels(prNumber, [QA_READY_LABEL]);
    await api.createComment(prNumber, handoffComment(headSha));
    const removed = await dedupeMarkers({ api, prNumber, headSha, trustedAuthors });
    log(`${tag} ${sanitizeLog(decision.key)}: handed off${removed > 0 ? ` (removed ${removed} duplicate marker(s))` : ""}`);
    return { ...decision, action: "handoff", duplicatesRemoved: removed };
  });
}

// The backstop is outside the workflow's concurrency group, so both can pass
// the in-lock re-read and write a marker for the same sha. Re-list after the
// write and delete every trusted marker but the survivor duplicateMarkers
// picks (a default author's marker first, so writers with uneven trust sets
// agree); a 404 means the other writer deleted it first.
async function dedupeMarkers({ api, prNumber, headSha, trustedAuthors }) {
  let removed = 0;
  for (const comment of duplicateMarkers(await api.listComments(prNumber), headSha, trustedAuthors)) {
    try {
      await api.deleteComment(comment.id);
      removed += 1;
    } catch (error) {
      if (!(error instanceof GithubApiError && error.status === 404)) throw error;
    }
  }
  return removed;
}

function formatChecks(checks) {
  if (!checks) return "";
  return ` [${checks.map((check) => `${sanitizeLog(check.name)}=${sanitizeLog(check.state)}`).join(", ")}]`;
}

// Picks the PRs to evaluate, each paired with the sha to evaluate it at.
export async function selectTargets(api, { pr, sha }) {
  if (pr !== undefined) return [{ prNumber: pr, eventSha: sha }];
  const open = await api.listOpenPrs();
  if (sha) return open.filter((item) => item.head?.sha === sha).map((item) => ({ prNumber: item.number, eventSha: sha }));
  return open.map((item) => ({ prNumber: item.number, eventSha: undefined }));
}

export async function run({ args, api, env = {}, log = console.log, lock }) {
  log(`qa-handoff mode=${sanitizeLog(args.mode)} repo=${sanitizeLog(args.repo)}${args.pr ? ` pr=${sanitizeLog(args.pr)}` : ""}${args.sha ? ` sha=${sanitizeLog(args.sha)}` : ""}`);
  const requiredChecks = await resolveRequiredChecks(api, env, log);
  const trustedAuthors = trustedMarkerAuthors(env.QA_HANDOFF_TRUSTED_MARKER_AUTHORS);
  log(`trusted marker authors: ${trustedAuthors.map((author) => sanitizeLog(author)).join(", ")}`);
  const targets = await selectTargets(api, args);
  if (targets.length === 0) log("no matching open PR");
  const results = [];
  for (const target of targets) {
    results.push(await handoffPr({ api, ...target, mode: args.mode, requiredChecks, trustedAuthors, lock, log }));
  }
  return results;
}

// Dependencies are injectable so tests can drive the whole CLI path in
// process: argv, env, the API client, the summary builder, and exit/out/err.
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  api: injectedApi,
  buildSummary = stepSummary,
  exit = (code) => process.exit(code),
  out = console.log,
  err = console.error,
} = {}) {
  const lines = [];
  // Fields are sanitized where they are formatted; the sink strips any
  // remaining control characters without truncating the composed line. The
  // line is recorded before it is printed, so a stdout writer that throws
  // cannot lose it from the summary or fail the run.
  const log = (line) => {
    const safe = sanitizeLog(line, Number.POSITIVE_INFINITY);
    lines.push(safe);
    try {
      out(safe);
    } catch {
      // stdout is a view of the recorded lines, not a result.
    }
  };
  // stderr only carries diagnostics, so a writer that throws must not change
  // the exit status or skip the summary.
  const warnStderr = (message) => {
    try {
      err(message);
    } catch {
      // Nothing is left to report to.
    }
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    warnStderr(`qa-handoff: ${describeError(error)}`);
    return exit(2);
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    warnStderr("qa-handoff: GITHUB_TOKEN or GH_TOKEN is required");
    return exit(2);
  }
  const api = injectedApi ?? createGithubApi({ token, repo: args.repo });
  let status = 0;
  try {
    await run({ args, api, env, log });
  } catch (error) {
    log(`ERROR: ${describeError(error, 500)}`);
    status = 1;
  }
  if (env.GITHUB_STEP_SUMMARY) {
    writeStepSummary({ path: env.GITHUB_STEP_SUMMARY, mode: args.mode, lines, build: buildSummary, warn: err });
  }
  return exit(status);
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
