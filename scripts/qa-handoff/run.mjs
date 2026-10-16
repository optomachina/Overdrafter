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
// else DEFAULT_REQUIRED_CHECKS. Marker authors: github-actions[bot] plus the
// QA_HANDOFF_TRUSTED_MARKER_AUTHORS env (comma separated logins).

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_REQUIRED_CHECKS,
  QA_READY_LABEL,
  BASE_BRANCH,
  decide,
  duplicateMarkers,
  hasMarker,
  markerFor,
  parseRequiredChecks,
  trustedMarkerAuthors,
} from "./gate.mjs";

const MODES = new Set(["report", "apply"]);

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
      requiredCheckNames((await request("GET", `${r}/branches/${BASE_BRANCH}`)).data?.protection?.required_status_checks),
    getProtectionRequiredChecks: async () =>
      requiredCheckNames((await request("GET", `${r}/branches/${BASE_BRANCH}/protection/required_status_checks`)).data),
    listCheckRuns: (sha) => paginate(`${r}/commits/${sha}/check-runs?filter=latest`, (data) => data.check_runs),
    listStatuses: async (sha) => (await request("GET", `${r}/commits/${sha}/status`)).data.statuses ?? [],
    listComments: (number) => paginate(`${r}/issues/${number}/comments`),
    createComment: async (number, body) => (await request("POST", `${r}/issues/${number}/comments`, { body })).data,
    deleteComment: async (id) => (await request("DELETE", `${r}/issues/comments/${id}`)).data,
    addLabels: async (number, labels) => (await request("POST", `${r}/issues/${number}/labels`, { labels })).data,
  };
}

function requiredCheckNames(requiredStatusChecks) {
  const names = [
    ...(requiredStatusChecks?.contexts ?? []),
    ...(requiredStatusChecks?.checks ?? []).map((check) => check.context),
  ];
  return [...new Set(names)];
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
        log(`required checks (${label}): ${names.join(", ")}`);
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
  log(`required checks (${fromEnv.length > 0 ? "REQUIRED_CHECKS env" : "DEFAULT_REQUIRED_CHECKS"}): ${names.join(", ")}`);
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
  const sha = pr?.state === "open" && headSha === pr?.head?.sha ? headSha : undefined;
  const [checkRuns, statuses, comments] = sha
    ? await Promise.all([api.listCheckRuns(sha), api.listStatuses(sha), api.listComments(prNumber)])
    : [[], [], []];
  const decision = decide({ event, pr, checkRuns, statuses, requiredChecks, comments, trustedAuthors });
  if (!decision.handoff) {
    log(`#${prNumber} ${decision.key}: no-op (${decision.reason})${formatChecks(decision.checks)}`);
    return { ...decision, action: "noop" };
  }
  if (mode !== "apply") {
    log(`#${prNumber} ${decision.key}: WOULD hand off (report mode)${formatChecks(decision.checks)}`);
    return { ...decision, action: "would-handoff" };
  }
  return lock(`qa-handoff-${prNumber}`, async () => {
    // Re-check inside the critical section: another run may have handed off
    // or the PR may have moved since the first read.
    const current = await api.getPr(prNumber);
    if (current?.head?.sha !== headSha || current?.state !== "open" || current?.draft) {
      log(`#${prNumber} ${decision.key}: no-op (changed before handoff)`);
      return { ...decision, handoff: false, reason: "changed-before-handoff", action: "noop" };
    }
    if (hasMarker(await api.listComments(prNumber), headSha, trustedAuthors)) {
      log(`#${prNumber} ${decision.key}: no-op (already-handed-off)`);
      return { ...decision, handoff: false, reason: "already-handed-off", action: "noop" };
    }
    // Label first: adding a label is idempotent, and the marker is written
    // last so a failure in between is retried rather than recorded as done.
    await api.addLabels(prNumber, [QA_READY_LABEL]);
    await api.createComment(prNumber, handoffComment(headSha));
    const removed = await dedupeMarkers({ api, prNumber, headSha, trustedAuthors });
    log(`#${prNumber} ${decision.key}: handed off${removed > 0 ? ` (removed ${removed} duplicate marker(s))` : ""}`);
    return { ...decision, action: "handoff", duplicatesRemoved: removed };
  });
}

// The backstop is outside the workflow's concurrency group, so both can pass
// the in-lock re-read and write a marker for the same sha. Re-list after the
// write and delete every trusted marker above the lowest id. Both writers
// pick the same survivor; a 404 means the other writer deleted it first.
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
  return ` [${checks.map((check) => `${check.name}=${check.state}`).join(", ")}]`;
}

// Picks the PRs to evaluate, each paired with the sha to evaluate it at.
export async function selectTargets(api, { pr, sha }) {
  if (pr !== undefined) return [{ prNumber: pr, eventSha: sha }];
  const open = await api.listOpenPrs();
  if (sha) return open.filter((item) => item.head?.sha === sha).map((item) => ({ prNumber: item.number, eventSha: sha }));
  return open.map((item) => ({ prNumber: item.number, eventSha: undefined }));
}

export async function run({ args, api, env = {}, log = console.log, lock }) {
  log(`qa-handoff mode=${args.mode} repo=${args.repo}${args.pr ? ` pr=${args.pr}` : ""}${args.sha ? ` sha=${args.sha}` : ""}`);
  const requiredChecks = await resolveRequiredChecks(api, env, log);
  const trustedAuthors = trustedMarkerAuthors(env.QA_HANDOFF_TRUSTED_MARKER_AUTHORS);
  log(`trusted marker authors: ${trustedAuthors.join(", ")}`);
  const targets = await selectTargets(api, args);
  if (targets.length === 0) log("no matching open PR");
  const results = [];
  for (const target of targets) {
    results.push(await handoffPr({ api, ...target, mode: args.mode, requiredChecks, trustedAuthors, lock, log }));
  }
  return results;
}

async function main() {
  const lines = [];
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`qa-handoff: ${error.message}`);
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error("qa-handoff: GITHUB_TOKEN or GH_TOKEN is required");
    process.exit(2);
  }
  const api = createGithubApi({ token, repo: args.repo });
  let status = 0;
  try {
    await run({ args, api, env: process.env, log });
  } catch (error) {
    log(`ERROR: ${error.message}`);
    status = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = `### QA handoff (${args.mode} mode)\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  process.exit(status);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
