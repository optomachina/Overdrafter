#!/usr/bin/env node
// OVD-785: builds the versioned trust snapshot (docs/trust/snapshot-<date>.json)
// from merged GitHub PRs, QA verdict comments and OVD-779 live harness
// results.jsonl rows. Metric definitions: docs/trust-metrics.md.
//
// Output is a pure function of the inputs and flags: generatedAt comes from
// --generated-at (or the window end), never the wall clock, and every array
// is sorted, so the same inputs always produce byte-identical JSON.
import { isEntryPoint } from "./lib/entry-point.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "trust-snapshot.v1";
export const HARNESS_SCHEMA_VERSION = "live-harness-run-artifacts.v1";

/** Fixed binary directories. The caller's PATH is never consulted (Sonar S4036). */
export const SAFE_BIN_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const SAFE_ENV = { ...process.env, PATH: SAFE_BIN_DIRS.join(":") };

/** Absolute path of `name` in the first SAFE_BIN_DIRS entry that has it. */
export function resolveBinary(name, { dirs = SAFE_BIN_DIRS, exists = fs.existsSync } = {}) {
  const found = dirs.map((dir) => path.join(dir, name)).find((candidate) => exists(candidate));
  if (!found) throw new Error(`${name} not found in ${dirs.join(", ")}`);
  return found;
}

/** Code-unit order, identical to the default `Array#sort` for strings (Sonar S2871). */
function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
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

const BOT_KEY = /^[a-z0-9][a-z0-9._-]*$/;
const stripMarkdown = (line) => line.replaceAll(/[*`#>]/g, "").replaceAll(/(^|\s)(_+)([^_\s](?:.*?[^_\s])?)\2(?=\s|$)/g, "$1$3").trim();

function authorBotKey(raw) {
  const author = raw.user ?? raw.author;
  const login = author?.login;
  if (typeof login !== "string" || !(author.type === "Bot" || author.is_bot === true || /\[bot\]$/i.test(login))) return null;
  const key = login.toLowerCase().replace(/\[bot\]$/, "");
  return BOT_KEY.test(key) ? key : null;
}

/** Accepts the REST pulls shape or `gh pr list --json` camelCase. */
export function normalizePullRequest(raw) {
  return {
    number: raw.number,
    body: typeof raw.body === "string" ? raw.body : "",
    authorBot: authorBotKey(raw),
    title: typeof raw.title === "string" ? raw.title : "",
    createdAt: raw.created_at ?? raw.createdAt ?? null,
    mergedAt: raw.merged_at ?? raw.mergedAt ?? null,
    headRef: raw.head?.ref ?? raw.headRefName ?? "",
    headSha: raw.headRefOid ?? raw.head?.sha ?? null,
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

function collectLabelDeclarations(labels, add) {
  for (const label of labels ?? []) {
    const name = (typeof label === "string" ? label : label?.name)?.toLowerCase();
    if (name?.startsWith("model:")) add(name.slice(6), "label");
  }
}

function parseBodyModelToken(line) {
  const text = stripMarkdown(line.trim().replace(/^[-*+]\s+/, "")).replace(/^[-+]\s+/, "");
  const match = /^(?:build(?:er)?\s+)?model\s*:\s*/i.exec(text);
  if (!match) return null;
  // PR bodies often restate the label syntax ("Model: model:codex"); judge the key after one leading "model:".
  const remainder = text.slice(match[0].length).replace(/^model:/i, "");
  let token = /^\S*/.exec(remainder)[0];
  if (token === remainder && /[^.]\.$/.test(token)) token = token.slice(0, -1);
  while (token.length > 0 && ",;:)·".includes(token.at(-1))) token = token.slice(0, -1);
  return token.toLowerCase();
}

function collectBodyDeclarations(body, declare) {
  let fenced = false;
  for (const line of (body ?? "").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const token = parseBodyModelToken(line);
    if (token !== null) declare(token);
  }
}

/** Builder evidence is unanimous or unknown; human author identities are discarded. */
export function attributePullRequest(pr) {
  const candidates = new Map();
  const add = (key, source) => {
    if (!key || key === "unknown" || !BOT_KEY.test(key)) return;
    if (!candidates.has(key)) candidates.set(key, new Set());
    candidates.get(key).add(source);
  };
  let conflictingBody = false;
  collectLabelDeclarations(pr.labels, add);
  collectBodyDeclarations(pr.body, (token) => {
    if (BOT_KEY.test(token)) add(token, "body");
    else conflictingBody = true;
  });
  add(pr.authorBot ?? authorBotKey(pr), "author");
  const sources = [...new Set([...candidates.values()].flatMap((values) => [...values]))].sort(compareCodeUnits);
  if (conflictingBody) return { bot: "unknown", status: "conflicting", sources: [...new Set([...sources, "body"])].sort(compareCodeUnits) };
  if (candidates.size === 1) return { bot: [...candidates.keys()][0], status: "attributed", sources };
  return { bot: "unknown", status: candidates.size ? "conflicting" : "no_signal", sources };
}

export function parseReviewVerdict(body) {
  const first = (body ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
  const match = /^(\S+)\s+(review|re-review)\s*@\s*([0-9a-f]{7,40})\s*:\s*(approved|changes required)\b/i.exec(stripMarkdown(first));
  if (!match || !/^[a-z][a-z0-9._-]*$/i.test(match[1]) || match[1].toLowerCase() === "unknown") return null;
  return { bot: match[1].toLowerCase(), round: match[2].toLowerCase(), sha: match[3].toLowerCase(), verdict: match[4].toLowerCase().replace(" ", "_") };
}

/**
 * Architect comments start with `Architect review (<model>) @ <40-hex sha>`. The header may carry a
 * trailing `: VERDICT` and/or qualifiers (e.g. `(round 2)`, `— notes`). The verdict comes from the
 * header suffix or a later `Verdict:` line in any case, optionally bold. Short shas and
 * non-Architect comments are rejected.
 */
const skipSeparator = (text) => text.trimStart().replace(/^[:\-\u2014]/, "").trimStart();

// Uppercase verdict after the header's sha: optional separator, optional `(qualifier)`, optional separator.
function inlineArchitectVerdict(rest) {
  let text = skipSeparator(rest);
  if (text.startsWith("(")) {
    const close = text.indexOf(")");
    if (close === -1) return null;
    text = skipSeparator(text.slice(close + 1));
  }
  return /^[A-Z][A-Z_]+\b/.exec(text)?.[0] ?? null;
}

export function parseArchitectReviewHeader(body) {
  const [header, ...lines] = (body ?? "").split(/\r?\n/);
  const match = /^Architect review \((?<model>[^)]+)\) @ (?<sha>[0-9a-f]{40})(?![0-9a-z])(?<rest>.*)$/.exec(header.trimEnd());
  if (!match) return null;
  const verdict = lines.map((line) => /^\**Verdict:\**[\t ]+(\w+)\b/i.exec(line)).find(Boolean);
  const value = verdict?.[1] ?? inlineArchitectVerdict(match.groups.rest);
  return value ? { model: match.groups.model, sha: match.groups.sha, verdict: value.toLowerCase() } : null;
}

const MODEL_FAMILY_BY_TOKEN = { opus: "claude", sonnet: "claude", claude: "claude", codex: "openai", gpt: "openai", grok: "xai" };

/**
 * Family of an Architect header's model field, read from its known tokens so qualifiers such as
 * `delta since <sha>`, `Claude Code, Opus` or `git + claude-opus` still attribute. A field naming
 * two families, or none (`git`, `git delta`), is not a model review.
 */
export function modelFamily(model) {
  const tokens = (model ?? "").toLowerCase().split(/[^a-z0-9]+/);
  const families = new Set(tokens.map((token) => MODEL_FAMILY_BY_TOKEN[token]).filter(Boolean));
  return families.size === 1 ? [...families][0] : null;
}

export function isReviewShaValid(reviewSha, qaHead, { isCommentsOnlyAncestor = () => false } = {}) {
  if (!reviewSha || !qaHead) return false;
  return reviewSha === qaHead || isCommentsOnlyAncestor(reviewSha, qaHead) === true;
}

const BUILDER_MODEL_NAMES = ["codex", "opus", "sonnet", "claude(?:-opus|-sonnet)?", String.raw`grok(?:-\d[\d.]*)?`, String.raw`gpt-\d[a-z\d.-]*`, "jev"];
const BUILDER_MODEL = new RegExp(String.raw`\b(${BUILDER_MODEL_NAMES.join("|")})\b`, "gi");

const UNKNOWN_BUILDER = "unknown";
function builderKey(model) {
  let key = model.toLowerCase();
  while (key && ".,;".includes(key.at(-1))) key = key.slice(0, -1);
  return key;
}

/**
 * Model named on `Built-by:` lines (unanimous across lines) or else on the first `Model:` line.
 * Only the rest of the same line counts, so a blank template line never credits the next line,
 * and a literal `unknown` names no model.
 */
export function builderFromBodyLines(text = "") {
  const built = new Set();
  for (const [, line] of text.matchAll(/^[\t >*-]*Built-by:(.*)$/gim)) {
    const tagged = [...line.matchAll(/model[:=](?:model:)?([a-z0-9._-]+)/gi)].map((m) => m[1]);
    const found = tagged.length ? tagged : [...line.matchAll(BUILDER_MODEL)].map((m) => m[1]);
    for (const model of found.map(builderKey)) if (model !== UNKNOWN_BUILDER) built.add(model);
  }
  if (built.size === 1) return [...built][0];
  if (built.size > 1) return null;
  const model = /^[\t >*-]*Model:[\t ]*(?:model:)?([a-z0-9._-]+)/im.exec(text)?.[1];
  return model && builderKey(model) !== UNKNOWN_BUILDER ? builderKey(model) : null;
}

// A blank `Model:` template line names no builder; any other conflicting evidence stays unknown.
const withoutBlankModelLines = (body) => (body ?? "").split("\n").filter((line) => parseBodyModelToken(line) !== "").join("\n");

export function qaFamilyBuilder(pr) {
  const { bot, status } = attributePullRequest({ ...pr, body: withoutBlankModelLines(pr.body) });
  if (bot !== "unknown" || status === "conflicting") return bot;
  const fromLines = builderFromBodyLines(pr.body ?? "");
  if (fromLines) return fromLines;
  return /^[\t ]*Built on[\t ]+(\S+)/im.exec(pr.body ?? "")?.[1].toLowerCase() ?? UNKNOWN_BUILDER;
}

export function computeQaFamilies(merged, comments, window, options = {}) {
  const latest = latestQaJudgments(comments, window);
  const reviews = new Map();
  for (const comment of comments.map(normalizeComment)) {
    const time = Date.parse(comment.createdAt);
    const review = parseArchitectReviewHeader(comment.body);
    const family = review && modelFamily(review.model);
    if (!family || !Number.isFinite(time) || time >= window.endExclusive) continue;
    if (!reviews.has(comment.prNumber)) reviews.set(comment.prNumber, []);
    reviews.get(comment.prNumber).push({ family, ...review });
  }
  const perPr = merged.map((pr) => {
    const judgment = latest.get(pr.number);
    const qaHead = judgment ? judgment.sha ?? pr.headSha ?? null : null;
    const kept = (reviews.get(pr.number) ?? [])
      .filter((review) => isReviewShaValid(review.sha, qaHead, options));
    const reviewers = [...new Map(kept.map((review) => [JSON.stringify(review), review])).values()]
      .sort((a, b) => compareCodeUnits(a.family, b.family) || compareCodeUnits(a.model, b.model)
        || compareCodeUnits(a.sha, b.sha) || compareCodeUnits(a.verdict, b.verdict));
    return { prNumber: pr.number, qaHead, reviewers: judgment && reviewers.length === 0 ? "none" : reviewers, builder: qaFamilyBuilder(pr) };
  }).sort((a, b) => a.prNumber - b.prNumber);
  return {
    perPr,
    summary: {
      qaJudged: merged.filter((pr) => latest.has(pr.number)).length,
      reviewersNone: perPr.filter((pr) => pr.reviewers === "none").length,
      prs: perPr.length,
      builderUnknown: perPr.filter((pr) => pr.builder === "unknown").length,
    },
  };
}

export function computeBotAttribution(merged) {
  const result = { attributed: 0, noSignal: 0, conflicting: 0, bySource: { label: 0, body: 0, author: 0 } };
  for (const pr of merged) {
    const attribution = attributePullRequest(pr);
    result[attribution.status === "no_signal" ? "noSignal" : attribution.status] += 1;
    if (attribution.status === "attributed") {
      for (const source of attribution.sources) result.bySource[source] += 1;
    }
  }
  return result;
}

function groupPullRequestsByBot(merged) {
  const groups = new Map();
  for (const pr of merged) {
    const { bot } = attributePullRequest(pr);
    if (!groups.has(bot)) groups.set(bot, []);
    groups.get(bot).push(pr);
  }
  return groups;
}

function tallyBotReviews(merged, comments, window, groups) {
  const reviews = new Map();
  const numbers = new Set(merged.map((pr) => pr.number));
  const seen = new Set();
  for (const comment of comments.map(normalizeComment)) {
    const time = Date.parse(comment.createdAt);
    const verdict = parseReviewVerdict(comment.body);
    if (!numbers.has(comment.prNumber) || !Number.isFinite(time) || time >= window.endExclusive || !verdict) continue;
    if (comment.id !== 0 && seen.has(comment.id)) continue;
    if (comment.id !== 0) seen.add(comment.id);
    if (!groups.has(verdict.bot)) groups.set(verdict.bot, []);
    if (!reviews.has(verdict.bot)) reviews.set(verdict.bot, { approved: 0, changesRequired: 0 });
    reviews.get(verdict.bot)[verdict.verdict === "approved" ? "approved" : "changesRequired"] += 1;
  }
  return reviews;
}

function compareBotKeys(a, b) {
  if (a === "unknown") return 1;
  if (b === "unknown") return -1;
  return compareCodeUnits(a, b);
}

function buildBotRow(bot, prs, reviews, comments, window) {
  const { pass, fail, noVerdict } = computeQa(prs, comments, window);
  return {
    bot,
    prs: prs.length,
    qa: { pass, fail, noVerdict, passRate: pass + fail === 0 ? null : Math.round(pass / (pass + fail) * 10000) / 10000 },
    reverts: computeReverts(prs),
    reviews: reviews.get(bot) ?? { approved: 0, changesRequired: 0 },
  };
}

export function computeBots(merged, comments, window) {
  const groups = groupPullRequestsByBot(merged);
  const reviews = tallyBotReviews(merged, comments, window, groups);
  return [...groups.keys()].sort(compareBotKeys)
    .map((bot) => buildBotRow(bot, groups.get(bot), reviews, comments, window));
}

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
  return parseQaJudgment(body)?.verdict ?? null;
}

function parseQaJudgment(body) {
  const firstLine = (body ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  const line = firstLine.replaceAll(/[*_`#>]/g, "").trim();
  if (/follow-up/i.test(line)) return null;
  const match = /^(?:(?:final-head|final|t\d+\s+final)\s+)?qa:?\s+(pass|fail)\b/i.exec(line);
  if (!match) return null;
  const sha = /\b(?:on|at)\s+(?:head\s+)?([0-9a-f]{7,40})\b/i.exec(line.slice(match[0].length))?.[1].toLowerCase() ?? null;
  return { verdict: match[1].toLowerCase(), sha };
}

function latestQaJudgments(comments, window) {
  const latest = new Map();
  for (const comment of comments.map(normalizeComment)) {
    const judgment = parseQaJudgment(comment.body);
    const time = Date.parse(comment.createdAt);
    if (!judgment || Number.isNaN(time) || time >= window.endExclusive) continue;
    const current = latest.get(comment.prNumber);
    if (!current || time > current.time || (time === current.time && comment.id > current.id)) {
      latest.set(comment.prNumber, { time, id: comment.id, ...judgment });
    }
  }
  return latest;
}

export function computeQa(merged, comments, window) {
  const latest = latestQaJudgments(comments, window);
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
    perWeek: [...byWeek.keys()].sort(compareCodeUnits).map((weekStart) => ({
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
  isCommentsOnlyAncestor = () => false,
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
    bots: computeBots(merged, comments, window),
    botAttribution: computeBotAttribution(merged),
    qaFamilies: computeQaFamilies(merged, comments, window, { isCommentsOnlyAncestor }),
  };
}

export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// ---------- inputs ----------

// `//` reads as a line comment everywhere; `#` and `--` only where the file type uses them, since
// they are headings in Markdown, custom properties in CSS and content elsewhere.
const LINE_COMMENT_PREFIXES = [
  { prefix: "//" },
  { prefix: "#", extensions: new Set([".py", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".rb", ".ini", ".cfg"]) },
  { prefix: "--", extensions: new Set([".sql", ".pgsql", ".psql", ".lua"]) },
];

function lineCommentPrefixes(filename) {
  const extension = path.extname(filename ?? "").toLowerCase();
  return LINE_COMMENT_PREFIXES.filter(({ extensions }) => !extensions || extensions.has(extension)).map(({ prefix }) => prefix);
}

// Track block comments separately on each side of a patch, using context lines.
function commentLine(line, block, prefixes) {
  let text = line.trim();
  while (text) {
    if (block) {
      const end = text.indexOf(block);
      if (end === -1) return { onlyComment: true, block };
      text = text.slice(end + block.length).trim();
      block = null;
    } else if (prefixes.some((prefix) => text.startsWith(prefix))) {
      return { onlyComment: true, block: null };
    } else if (text.startsWith("/*") || text.startsWith("<!--")) {
      block = text.startsWith("/*") ? "*/" : "-->";
      text = text.slice(block === "*/" ? 2 : 4);
    } else {
      return { onlyComment: false, block: null };
    }
  }
  return { onlyComment: true, block };
}

const hasOddBackticks = (text) => (text.match(/(?<!\\)`/g)?.length ?? 0) % 2 === 1;

// A line inside a template literal is content, never a comment; an odd count of unescaped
// backticks on a code line opens or closes one. A hunk starting mid-literal is not detected.
function scanPatchLine(text, state, prefixes) {
  const result = state.template ? { onlyComment: false, block: null } : commentLine(text, state.block, prefixes);
  state.block = result.block;
  if (!result.onlyComment && hasOddBackticks(text)) state.template = !state.template;
  return result.onlyComment;
}

const freshSides = () => ({ "+": { block: null, template: false }, "-": { block: null, template: false } });
const sidesAgree = (sides) => sides["+"].block === sides["-"].block && sides["+"].template === sides["-"].template;
const BLOCK_CLOSER = /\*\/|-->/;

// Comment state is known only from the top of a file, so a side whose hunk starts below line 1 may
// open inside an unseen block. There, a changed line holding a block closer (`// */`, `/* x */`)
// could end that block and run the code after it, so it is never comments-only.
function hunkStartsAtTop(header) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return { "-": match !== null && Number(match[1]) <= 1, "+": match !== null && Number(match[2]) <= 1 };
}

// Scans one patch line into `scan` and returns false as soon as the patch is not comments-only.
// An unchanged context line must read the same on both sides, and each hunk must end with both
// sides in the same block/template state, so adding or removing a bare `/*`…`*/` pair around
// unchanged code (commenting it out or back in) is a code change, not a comments-only one.
function scanCommentsOnlyLine(line, scan) {
  const marker = line[0];
  if (line.startsWith("@@")) {
    if (!sidesAgree(scan.sides)) return false;
    scan.sides = freshSides();
    scan.atTop = hunkStartsAtTop(line);
    return true;
  }
  const text = line.slice(1);
  if (marker === " ") {
    return scanPatchLine(text, scan.sides["+"], scan.prefixes) === scanPatchLine(text, scan.sides["-"], scan.prefixes);
  }
  if (!(marker in scan.changed)) return true;
  scan.changed[marker] += 1;
  if (!scan.atTop[marker] && BLOCK_CLOSER.test(text)) return false;
  return scanPatchLine(text, scan.sides[marker], scan.prefixes);
}

function isCommentsOnlyPatch(file) {
  if (!["modified", "added", "removed"].includes(file.status) || typeof file.patch !== "string") return false;
  const scan = { changed: { "+": 0, "-": 0 }, sides: freshSides(), atTop: { "+": false, "-": false }, prefixes: lineCommentPrefixes(file.filename) };
  if (!file.patch.split("\n").every((line) => scanCommentsOnlyLine(line, scan)) || !sidesAgree(scan.sides)) return false;
  const { changed } = scan;
  return changed["+"] + changed["-"] > 0 && changed["+"] === file.additions && changed["-"] === file.deletions;
}

/** Missing/binary/truncated patches and comparisons beyond GitHub's file cap fail closed. */
export function isCommentsOnlyComparison(comparison) {
  if (!["ahead", "identical"].includes(comparison?.status) || !Array.isArray(comparison.files)) return false;
  return comparison.files.length < 300 && comparison.files.every(isCommentsOnlyPatch);
}

export function fetchCommentsOnlyAncestor(repository, base, head) {
  const output = execFileSync(resolveBinary("gh"), ["api", `repos/${repository}/compare/${base}...${head}`], {
    encoding: "utf8", env: SAFE_ENV, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"],
  });
  return isCommentsOnlyComparison(JSON.parse(output));
}

function ghApiLines(endpoint) {
  const output = execFileSync(resolveBinary("gh"), ["api", "--paginate", endpoint, "--jq", ".[]"], {
    encoding: "utf8",
    env: SAFE_ENV,
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
      body: pr.body ?? "",
      user: pr.user?.type === "Bot" ? { login: pr.user.login, type: pr.user.type } : null,
      title: pr.title,
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      head: { ref: pr.head?.ref ?? "", sha: pr.head?.sha ?? null },
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
    .sort(compareCodeUnits);
}

const USAGE = `Usage: node scripts/trust-metrics.mjs --window-end YYYY-MM-DD [options]

  --window-start YYYY-MM-DD   first day (default: Monday 7 weeks before the end week)
  --weeks N                   weeks in the default window (default 8)
  --generated-at ISO          snapshot generatedAt (default <window-end>T23:59:59Z)
  --repo owner/name           GitHub repository (default ${DEFAULT_REPOSITORY})
  --base BRANCH               count PRs merged into this branch (default ${DEFAULT_BASE_BRANCH})
  --prs-json FILE             offline merged PR list instead of gh api
  --comments-json FILE        offline PR comments instead of gh api
  --commits-json FILE         offline "<base>...<head>" -> comments-only ancestor boolean
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
    "--commits-json": "commitsJson",
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

export function runCli(argv, { fetchInputs = fetchGitHubInputs, compareCommits = fetchCommentsOnlyAncestor, log = console.error } = {}) {
  const options = parseCliArgs(argv);
  if (options.help || !options.windowEnd) {
    log(USAGE);
    return options.help ? 0 : 2;
  }
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const windowInput = { start: options.windowStart, end: options.windowEnd, weeks: options.weeks ?? 8 };
  const window = resolveWindow(windowInput);
  const commits = options.commitsJson ? readJson(options.commitsJson) : null;
  const comparisons = new Map();
  const compare = (base, head) => {
    try {
      return compareCommits(repository, base, head);
    } catch {
      log(`Comparison ${base}...${head} unavailable; treated as not comments-only.`);
      return false;
    }
  };
  const isCommentsOnlyAncestor = (base, head) => {
    const key = `${base}...${head}`;
    if (commits || options.prsJson) return commits?.[key] === true;
    if (!comparisons.has(key)) comparisons.set(key, compare(base, head));
    return comparisons.get(key);
  };
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
    isCommentsOnlyAncestor,
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

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
