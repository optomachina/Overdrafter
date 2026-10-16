#!/usr/bin/env node
// OVD-785: builds the versioned trust snapshot (docs/trust/snapshot-<date>.json)
// from merged GitHub PRs, QA verdict comments and OVD-779 live harness
// results.jsonl rows. Metric definitions: docs/trust-metrics.md.
//
// Output is a pure function of the inputs and flags: generatedAt comes from
// --generated-at (or the window end), never the wall clock, and every array
// is sorted, so the same inputs always produce byte-identical JSON.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "trust-snapshot.v1";
export const HARNESS_SCHEMA_VERSION = "live-harness-run-artifacts.v1";
export const DEFAULT_REPOSITORY = "optomachina/Overdrafter";
export const DEFAULT_BASE_BRANCH = "main";
export const QA_UNIT = "latest_verdict_per_merged_pr";
export const DELIVERY_UNAVAILABLE_REASON = "not_captured_by_harness_v1";
/** Adapter VendorStatus values that mean the provider returned a price. */
export const HARNESS_SUCCESS_STATUSES = Object.freeze(["instant_quote_received", "official_quote_received"]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Comments fetched from this far before the window still count for PRs merged in it.
const COMMENT_LOOKBACK_DAYS = 60;

// ---------- dates ----------

function parseDate(value, name) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD.`);
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid date.`);
  }
  return time;
}

function toDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the week containing the instant, as YYYY-MM-DD. */
export function weekStartUtc(isoOrTime) {
  const time = typeof isoOrTime === "number" ? isoOrTime : Date.parse(isoOrTime);
  const day = Math.floor(time / DAY_MS) * DAY_MS;
  const offset = (new Date(day).getUTCDay() + 6) % 7;
  return toDate(day - offset * DAY_MS);
}

/** Inclusive window of whole UTC days; `endExclusive` is the next midnight after `end`. */
export function resolveWindow({ start, end, weeks = 8 }) {
  const endTime = parseDate(end, "window end");
  let startTime;
  if (start === undefined || start === null) {
    if (!Number.isSafeInteger(weeks) || weeks < 1) throw new Error("weeks must be a positive integer.");
    startTime = Date.parse(`${weekStartUtc(endTime)}T00:00:00Z`) - (weeks - 1) * 7 * DAY_MS;
  } else {
    startTime = parseDate(start, "window start");
  }
  if (startTime > endTime) throw new Error("window start must not be after window end.");
  return { start: toDate(startTime), end: toDate(endTime), startTime, endExclusive: endTime + DAY_MS };
}

/** Every Monday week overlapping the window, ascending. */
export function windowWeeks(window) {
  const weeks = [];
  let time = Date.parse(`${weekStartUtc(window.startTime)}T00:00:00Z`);
  while (time < window.endExclusive) {
    weeks.push(toDate(time));
    time += 7 * DAY_MS;
  }
  return weeks;
}

export function normalizeGeneratedAt(value, window) {
  const raw = value ?? `${window.end}T23:59:59Z`;
  const time = Date.parse(raw);
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(time)) {
    throw new Error("generatedAt must be an ISO 8601 timestamp.");
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const inWindow = (iso, window) => {
  const time = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return !Number.isNaN(time) && time >= window.startTime && time < window.endExclusive;
};

// ---------- normalization ----------

/** Accepts the REST pulls shape or `gh pr list --json` camelCase. */
export function normalizePullRequest(raw) {
  return {
    number: raw.number,
    title: typeof raw.title === "string" ? raw.title : "",
    createdAt: raw.created_at ?? raw.createdAt ?? null,
    mergedAt: raw.merged_at ?? raw.mergedAt ?? null,
    headRef: raw.head?.ref ?? raw.headRefName ?? "",
    baseRef: raw.base?.ref ?? raw.baseRefName ?? null,
    labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? label : label?.name))
      .filter((name) => typeof name === "string")
      .map((name) => name.toLowerCase()),
  };
}

/** Accepts REST issue comments (issue_url) or rows carrying an explicit prNumber/number. */
export function normalizeComment(raw) {
  const fromUrl = typeof raw.issue_url === "string" ? Number(raw.issue_url.split("/").pop()) : Number.NaN;
  const prNumber = raw.prNumber ?? raw.number ?? (Number.isNaN(fromUrl) ? null : fromUrl);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    prNumber,
    createdAt: raw.created_at ?? raw.createdAt ?? null,
    body: typeof raw.body === "string" ? raw.body : "",
  };
}

/**
 * PRs merged into the base branch inside the window, by merge time then number.
 * Inputs without base information are kept.
 */
export function mergedInWindow(pullRequests, window, baseBranch = DEFAULT_BASE_BRANCH) {
  return pullRequests.map(normalizePullRequest)
    .filter((pr) => inWindow(pr.mergedAt, window) && (pr.baseRef === null || pr.baseRef === baseBranch))
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number);
}

// ---------- metrics ----------

export function computeMerges(merged, window) {
  const counts = new Map(windowWeeks(window).map((week) => [week, 0]));
  for (const pr of merged) {
    const week = weekStartUtc(pr.mergedAt);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  return {
    total: merged.length,
    perWeek: [...counts.entries()].map(([weekStart, count]) => ({ weekStart, count })),
  };
}

/** Reads a verdict from the first non-empty line, e.g. "QA: PASS on 1a2b3c4". */
export function parseQaVerdict(body) {
  const firstLine = (body ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  const line = firstLine.replaceAll(/[*_`#>]/g, "").trim();
  if (/follow-up/i.test(line)) return null;
  const match = /^(?:(?:final-head|final|t\d+\s+final)\s+)?qa:?\s+(pass|fail)\b/i.exec(line);
  return match ? match[1].toLowerCase() : null;
}

export function computeQa(merged, comments, window) {
  const latest = new Map();
  for (const comment of comments.map(normalizeComment)) {
    const verdict = parseQaVerdict(comment.body);
    const time = Date.parse(comment.createdAt);
    if (!verdict || Number.isNaN(time) || time >= window.endExclusive) continue;
    const current = latest.get(comment.prNumber);
    if (!current || time > current.time || (time === current.time && comment.id > current.id)) {
      latest.set(comment.prNumber, { time, id: comment.id, verdict });
    }
  }
  let pass = 0;
  let fail = 0;
  for (const pr of merged) {
    const verdict = latest.get(pr.number)?.verdict;
    if (verdict === "pass") pass += 1;
    else if (verdict === "fail") fail += 1;
  }
  return { pass, fail, noVerdict: merged.length - pass - fail, unit: QA_UNIT };
}

const TICKET_PREFIX = /^[A-Z][A-Z0-9]*-\d+:\s*/;

export function isRevert(pr) {
  return /^revert\b/i.test(pr.title) || /^revert-\d+-/.test(pr.headRef) || pr.labels.includes("revert");
}

export function isRollback(pr) {
  const title = pr.title.replace(TICKET_PREFIX, "");
  return /^(?:rollback|roll[\s-]back)\b/i.test(title) || pr.labels.includes("rollback");
}

/** A PR is counted once: revert rules win over rollback rules. */
export function computeReverts(merged) {
  let reverts = 0;
  let rollbacks = 0;
  for (const pr of merged) {
    if (isRevert(pr)) reverts += 1;
    else if (isRollback(pr)) rollbacks += 1;
  }
  return { reverts, rollbacks };
}

/** Linear interpolation between closest ranks (Hyndman-Fan type 7, PERCENTILE.INC). */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (rank - low) * (sorted[high] - sorted[low]);
}

const roundHours = (value) => (value === null ? null : Math.round(value * 100) / 100);

export function timeToMergeHours(pr) {
  const hours = (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / HOUR_MS;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

export function computeTimeToMerge(merged) {
  const byWeek = new Map();
  const all = [];
  for (const pr of merged) {
    const hours = timeToMergeHours(pr);
    if (hours === null) continue;
    all.push(hours);
    const week = weekStartUtc(pr.mergedAt);
    byWeek.set(week, [...(byWeek.get(week) ?? []), hours]);
  }
  return {
    medianHours: roundHours(percentile(all, 0.5)),
    p90Hours: roundHours(percentile(all, 0.9)),
    perWeek: [...byWeek.keys()].sort().map((weekStart) => ({
      weekStart,
      medianHours: roundHours(percentile(byWeek.get(weekStart), 0.5)),
      p90Hours: roundHours(percentile(byWeek.get(weekStart), 0.9)),
    })),
  };
}

// ---------- live quotes ----------

/** Parses results.jsonl text; blank lines are ignored, malformed lines are reported and skipped. */
export function parseResultsJsonl(text, onSkip = () => undefined) {
  const rows = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      onSkip(index + 1);
    }
  });
  return rows;
}

const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const stringOrNull = (value) => (typeof value === "string" ? value : null);
const leadTimeOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * Picks the committed fields from v1 harness rows inside the window. quoteUrl
 * and providerQuoteId are never copied (G8). estimatedDeliveryDate stays null:
 * the harness records no provider-stated date and none is ever derived (G1).
 */
export function computeLiveQuotes(rows, window) {
  const seen = new Set();
  const quotes = [];
  for (const row of rows) {
    if (row?.schemaVersion !== HARNESS_SCHEMA_VERSION || !inWindow(row.timestamp, window)) continue;
    const quote = {
      runId: stringOrNull(row.runId),
      provider: stringOrNull(row.provider),
      requestedQuantity: finiteOrNull(row.requestedQuantity),
      totalPriceUsd: finiteOrNull(row.totalPriceUsd),
      leadTimeBusinessDays: leadTimeOrNull(row.leadTimeBusinessDays),
      estimatedDeliveryDate: null,
      deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
      status: stringOrNull(row.status),
      timestamp: new Date(Date.parse(row.timestamp)).toISOString(),
      errorCode: stringOrNull(row.errorCode),
    };
    const key = JSON.stringify(quote);
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push(quote);
  }
  const text = (value) => value ?? "";
  return quotes.sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || text(a.runId).localeCompare(text(b.runId))
    || text(a.provider).localeCompare(text(b.provider))
    || (a.requestedQuantity ?? -1) - (b.requestedQuantity ?? -1)
    || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// ---------- snapshot ----------

export function buildSnapshot({
  repository = DEFAULT_REPOSITORY,
  baseBranch = DEFAULT_BASE_BRANCH,
  window: windowInput,
  generatedAt,
  pullRequests,
  comments,
  harnessRows = [],
  harnessResultFiles = 0,
}) {
  const window = resolveWindow(windowInput);
  const merged = mergedInWindow(pullRequests, window, baseBranch);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: normalizeGeneratedAt(generatedAt, window),
    window: { start: window.start, end: window.end },
    sources: { repository, baseBranch, harnessResultFiles },
    merges: computeMerges(merged, window),
    qa: computeQa(merged, comments, window),
    reverts: computeReverts(merged),
    timeToMerge: computeTimeToMerge(merged),
    liveQuotes: computeLiveQuotes(harnessRows, window),
    // OVD-786 owns per-bot attribution; v1 emits an empty list.
    bots: [],
  };
}

export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// ---------- inputs ----------

function ghApiLines(endpoint) {
  const output = execFileSync("gh", ["api", "--paginate", endpoint, "--jq", ".[]"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return output.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** Read-only GitHub fetch through the gh CLI; only the fields the metrics use are kept. */
export function fetchGitHubInputs(repository, window) {
  const pullRequests = ghApiLines(`repos/${repository}/pulls?state=closed&sort=created&direction=desc&per_page=100`)
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      head: { ref: pr.head?.ref ?? "" },
      base: { ref: pr.base?.ref ?? null },
      labels: (pr.labels ?? []).map((label) => ({ name: label.name })),
    }));
  const since = new Date(window.startTime - COMMENT_LOOKBACK_DAYS * DAY_MS).toISOString();
  const comments = ghApiLines(`repos/${repository}/issues/comments?since=${since}&per_page=100`)
    .map((comment) => ({
      id: comment.id,
      issue_url: comment.issue_url,
      created_at: comment.created_at,
      body: comment.body ?? "",
    }));
  return { pullRequests, comments };
}

/** Collects <root>/<runId>/results.jsonl files in run-id order. */
export function findResultsFiles(artifactRoot) {
  const entries = fs.existsSync(artifactRoot) ? fs.readdirSync(artifactRoot, { withFileTypes: true }) : [];
  return entries.filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name, "results.jsonl"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

const USAGE = `Usage: node scripts/trust-metrics.mjs --window-end YYYY-MM-DD [options]

  --window-start YYYY-MM-DD   first day (default: Monday 7 weeks before the end week)
  --weeks N                   weeks in the default window (default 8)
  --generated-at ISO          snapshot generatedAt (default <window-end>T23:59:59Z)
  --repo owner/name           GitHub repository (default ${DEFAULT_REPOSITORY})
  --base BRANCH               count PRs merged into this branch (default ${DEFAULT_BASE_BRANCH})
  --prs-json FILE             offline merged PR list instead of gh api
  --comments-json FILE        offline PR comments instead of gh api
  --results-jsonl FILE        harness results.jsonl (repeatable)
  --artifact-root DIR         read every <DIR>/<runId>/results.jsonl
  --out FILE                  output path (default docs/trust/snapshot-<window-end>.json)
  --stdout                    print the snapshot instead of writing a file`;

export function parseCliArgs(argv) {
  const options = { resultsJsonl: [] };
  const valueFlags = {
    "--window-start": "windowStart",
    "--window-end": "windowEnd",
    "--weeks": "weeks",
    "--generated-at": "generatedAt",
    "--repo": "repository",
    "--base": "baseBranch",
    "--prs-json": "prsJson",
    "--comments-json": "commentsJson",
    "--artifact-root": "artifactRoot",
    "--out": "out",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stdout") options.stdout = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--results-jsonl" || valueFlags[flag]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
      index += 1;
      if (flag === "--results-jsonl") options.resultsJsonl.push(value);
      else options[valueFlags[flag]] = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (options.weeks !== undefined) options.weeks = Number(options.weeks);
  if ((options.prsJson === undefined) !== (options.commentsJson === undefined)) {
    throw new Error("--prs-json and --comments-json must be given together.");
  }
  return options;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function runCli(argv, { fetchInputs = fetchGitHubInputs, log = console.error } = {}) {
  const options = parseCliArgs(argv);
  if (options.help || !options.windowEnd) {
    log(USAGE);
    return options.help ? 0 : 2;
  }
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const windowInput = { start: options.windowStart, end: options.windowEnd, weeks: options.weeks ?? 8 };
  const window = resolveWindow(windowInput);
  const { pullRequests, comments } = options.prsJson
    ? { pullRequests: readJson(options.prsJson), comments: readJson(options.commentsJson) }
    : fetchInputs(repository, window);
  const files = [
    ...options.resultsJsonl,
    ...(options.artifactRoot ? findResultsFiles(options.artifactRoot) : []),
  ];
  const harnessRows = files.flatMap((file) => parseResultsJsonl(fs.readFileSync(file, "utf8"), (line) =>
    log(`Skipped malformed results.jsonl line ${line} in ${path.basename(path.dirname(file))}.`)));
  const snapshot = buildSnapshot({
    repository,
    baseBranch: options.baseBranch ?? DEFAULT_BASE_BRANCH,
    window: windowInput,
    generatedAt: options.generatedAt,
    pullRequests,
    comments,
    harnessRows,
    harnessResultFiles: files.length,
  });
  const json = serializeSnapshot(snapshot);
  if (options.stdout) {
    process.stdout.write(json);
  } else {
    const out = path.resolve(options.out ?? path.join(REPO_ROOT, "docs", "trust", `snapshot-${window.end}.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    log(`Wrote ${path.relative(process.cwd(), out)} (${snapshot.merges.total} merges, ${snapshot.liveQuotes.length} live quotes).`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
