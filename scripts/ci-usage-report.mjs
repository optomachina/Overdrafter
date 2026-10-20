/**
 * OVD-924 AC4: wall-clock CI usage for a date window.
 *
 * Read-only `gh api` (GET). Lists Actions workflow runs created on each UTC day
 * in the window (one day per request, so a busy repo does not silently stop at
 * the 1000-run list cap), attributes each run to pull requests through
 * `pull_requests[]`, and sums job wall-clock minutes from `started_at` /
 * `completed_at`.
 *
 * Minutes are wall-clock, not billable. This repo's billable Actions time
 * reads 0 because the repository is public.
 *
 * A run listed on more than one pull request counts in full on each of those
 * PRs. The workflow table counts each run once. Runs with an empty
 * `pull_requests` array are unattributed.
 *
 * Usage:
 *   node scripts/ci-usage-report.mjs [--repo optomachina/Overdrafter]
 *     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--out FILE]
 *     [--runs-json FILE --jobs-json FILE]
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_REPOSITORY = "optomachina/Overdrafter";
export const RUN_JQ = ".workflow_runs[] | {id,name,path,event,html_url,created_at,pull_requests:[.pull_requests[]?|{number}]}";
export const JOB_JQ = ".jobs[] | {name,started_at,completed_at,conclusion}";
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const SAFE_ENV = { ...process.env, PATH: SAFE_BIN_DIRS.join(":") };

function resolveBinary(name) {
  const found = SAFE_BIN_DIRS.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`${name} not found in ${SAFE_BIN_DIRS.join(", ")}`);
  return found;
}

function parseDay(value, label) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`${label} is not a valid date`);
  return time;
}

/** Inclusive UTC days from `since` through `until`. */
export function eachDay(since, until) {
  let cursor = parseDay(since, "since");
  const end = parseDay(until, "until");
  if (cursor > end) throw new Error("since must be on or before until");
  const days = [];
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days;
}

/** Seven UTC days ending on `until`, both dates inclusive. */
export function sevenDayWindow(until) {
  const end = parseDay(until, "until");
  return { since: new Date(end - 6 * DAY_MS).toISOString().slice(0, 10), until };
}

export function wallClockMinutes(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 0;
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / 60000;
}

export function workflowRunsEndpoint(repo, day) {
  return `repos/${repo}/actions/runs?per_page=100&created=${day}`;
}

export function runJobsEndpoint(repo, runId) {
  return `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=all`;
}

/** `gh api` GET. No `--method`, so the call stays read-only. */
export function ghApiArgs(endpoint, jq) {
  return ["api", "--paginate", endpoint, "--jq", jq];
}

function emptyBucket(number) {
  return { number, runs: 0, jobs: 0, minutes: 0 };
}

/** Code-unit order, so the workflow table sorts the same on every machine. */
function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Attributes workflow runs to PRs and sums job wall-clock minutes.
 * `jobsByRunId` maps a run id (number or numeric string) to its jobs.
 * A run whose `pull_requests` lists several PRs is added in full to each.
 */
export function attributeUsage(runs, jobsByRunId) {
  const byPr = new Map();
  const unattributed = emptyBucket(null);
  const workflows = new Map();
  for (const run of runs) {
    const jobs = jobsByRunId.get(run.id) ?? jobsByRunId.get(String(run.id)) ?? [];
    const minutes = jobs.reduce((sum, job) => sum + wallClockMinutes(job.started_at, job.completed_at), 0);
    const numbers = [...new Set((run.pull_requests ?? []).map((pr) => pr.number).filter((number) => Number.isInteger(number)))].sort((left, right) => left - right);
    for (const number of numbers.length ? numbers : [null]) {
      const bucket = number == null ? unattributed : byPr.get(number) ?? emptyBucket(number);
      if (number != null) byPr.set(number, bucket);
      bucket.runs += 1;
      bucket.jobs += jobs.length;
      bucket.minutes += minutes;
    }
    const name = run.name ?? run.path ?? "unknown";
    const flow = workflows.get(name) ?? { name, path: run.path ?? "", runs: 0, jobs: 0, minutes: 0 };
    flow.runs += 1;
    flow.jobs += jobs.length;
    flow.minutes += minutes;
    workflows.set(name, flow);
  }
  return {
    pullRequests: [...byPr.values()].sort((left, right) => left.number - right.number),
    unattributed: { runs: unattributed.runs, jobs: unattributed.jobs, minutes: unattributed.minutes },
    workflows: [...workflows.values()].sort((left, right) => compareText(left.name, right.name)),
  };
}

function formatMinutes(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

export function renderUsageMarkdown({ repo, since, until, pullRequests, unattributed, workflows }) {
  const row = (label, bucket) => `| ${label} | ${bucket.runs} | ${bucket.jobs} | ${formatMinutes(bucket.minutes)} |`;
  const lines = [
    "# CI usage",
    "",
    `Repository: \`${repo}\`. Window: ${since} through ${until} (UTC, both days inclusive).`,
    "Source: read-only `gh api` workflow runs. Each UTC day is requested on its own so the 1000-run list cap does not drop the rest of a busy week.",
    "A run is attributed through `pull_requests[]`. A run listed on more than one pull request counts in full on each. Runs with an empty list are unattributed.",
    "GitHub leaves `pull_requests` empty on most `pull_request` runs in this repository, including a direct GET of the run. Those runs stay in the unattributed row.",
    "Minutes are wall-clock sums of job `started_at`..`completed_at`, not billable minutes. Billable time for this public repository reads 0.",
    "The workflow table counts each run once. The pull-request table can count a shared run more than once.",
    "",
    "| PR | Workflow runs | Jobs | Wall-clock minutes |",
    "| --- | ---: | ---: | ---: |",
    ...pullRequests.map((bucket) => row(`#${bucket.number}`, bucket)),
    row("unattributed", unattributed),
    "",
    "## Workflows",
    "",
    "| Workflow | Path | Runs | Jobs | Wall-clock minutes |",
    "| --- | --- | ---: | ---: | ---: |",
    ...workflows.map((flow) => `| ${flow.name} | \`${flow.path || ""}\` | ${flow.runs} | ${flow.jobs} | ${formatMinutes(flow.minutes)} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function parseJsonLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function ghText(args) {
  const { stdout } = await execFileAsync(resolveBinary("gh"), args, {
    encoding: "utf8",
    env: SAFE_ENV,
    maxBuffer: 64_000_000,
  });
  return stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 5;
const RATE_LIMIT_PATTERN = /rate limit|HTTP 403|HTTP 429|secondary rate/i;

function isRateLimited(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString?.() ?? "";
  return RATE_LIMIT_PATTERN.test(`${stderr}\n${error?.message ?? error}`);
}

/**
 * Runs `fn`, pausing and retrying a rate-limited call up to MAX_ATTEMPTS times.
 * Any other failure, and the last rate-limited one, throws at once. The retry
 * recurses instead of looping, so each pause is awaited outside a loop.
 */
export async function withRateLimitRetry(label, fn, { pause = sleep, attempt = 1 } = {}) {
  try {
    return await fn();
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS || !isRateLimited(error)) throw new Error(`${label} failed: ${error?.stderr || error?.message || error}`);
    await pause(attempt * 2000);
    return withRateLimitRetry(label, fn, { pause, attempt: attempt + 1 });
  }
}

/**
 * Runs `worker` on every item with at most `limit` calls in flight. A lane takes
 * the next item when its last call settles, so `limit` 1 keeps the input order.
 * The lane recurses instead of looping, so each call is awaited outside a loop.
 */
export async function forEachLimited(items, limit, worker) {
  const queue = [...items];
  const lane = async () => {
    if (queue.length === 0) return;
    await worker(queue.shift());
    await lane();
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, lane));
}

export async function fetchUsage({ repo, since, until }) {
  const runs = [];
  const seen = new Set();
  const fetchDay = async (day) => {
    const endpoint = workflowRunsEndpoint(repo, day);
    const head = JSON.parse(await withRateLimitRetry(`runs ${day}`, () => ghText(["api", endpoint])));
    const total = head.total_count ?? 0;
    if (total > 1000) throw new Error(`day ${day} has ${total} workflow runs, above the 1000-run API cap`);
    if (total === 0) {
      console.error(`runs ${day}: 0`);
      return;
    }
    const page = await withRateLimitRetry(`runs ${day} page`, () => ghText(ghApiArgs(endpoint, RUN_JQ)).then(parseJsonLines));
    console.error(`runs ${day}: ${page.length} of ${total}`);
    for (const run of page) {
      if (!Number.isInteger(run.id) || seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    }
  };
  // One day at a time, oldest first, so the run list keeps the window's order.
  await forEachLimited(eachDay(since, until), 1, fetchDay);
  const jobsByRunId = new Map();
  let finished = 0;
  await forEachLimited(runs, 4, async (run) => {
    const jobs = await withRateLimitRetry(`jobs ${run.id}`, () => ghText(ghApiArgs(runJobsEndpoint(repo, run.id), JOB_JQ)).then(parseJsonLines));
    jobsByRunId.set(run.id, jobs);
    finished += 1;
    if (finished % 50 === 0 || finished === runs.length) console.error(`jobs ${finished}/${runs.length}`);
  });
  return { runs, jobsByRunId };
}

function parseArgs(argv) {
  const options = { repo: DEFAULT_REPOSITORY, since: null, until: null, out: null, runsJson: null, jobsJson: null };
  const valued = { "--repo": "repo", "--since": "since", "--until": "until", "--out": "out", "--runs-json": "runsJson", "--jobs-json": "jobsJson" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valued[arg] || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${arg}`);
    index += 1;
    options[valued[arg]] = argv[index];
  }
  if (!options.until) options.until = new Date().toISOString().slice(0, 10);
  if (!options.since) options.since = sevenDayWindow(options.until).since;
  if ((options.runsJson == null) !== (options.jobsJson == null)) throw new Error("--runs-json and --jobs-json are a pair");
  return options;
}

function loadFixture(options) {
  const runs = JSON.parse(readFileSync(options.runsJson, "utf8"));
  const jobs = JSON.parse(readFileSync(options.jobsJson, "utf8"));
  const jobsByRunId = new Map(Object.entries(jobs).map(([id, list]) => [Number(id), list]));
  return { runs, jobsByRunId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { runs, jobsByRunId } = options.runsJson ? loadFixture(options) : await fetchUsage(options);
  const summary = attributeUsage(runs, jobsByRunId);
  const markdown = renderUsageMarkdown({ repo: options.repo, since: options.since, until: options.until, ...summary });
  if (options.out) writeFileSync(options.out, markdown);
  else process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
