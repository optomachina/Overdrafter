/** Pure spend collection and reporting. All dates come from caller inputs. */
export const POOLS = ["codex", "claude", "cursor", "jev"];
export const BOT_TO_POOL = Object.freeze({
  codex: "codex", chatgpt: "codex", "chatgpt-codex-connector": "codex",
  claude: "claude", "claude-code": "claude", opus: "claude", sonnet: "claude",
  cursor: "cursor", grok: "cursor", "cursor-agent": "cursor", jev: "jev",
});
export class UsageError extends Error {}
const present = (v) => v !== null && v !== undefined;
const money = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (message) => { throw new UsageError(message); };
/** Validate a real UTC calendar day. */
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const nextDay = (day, n = 1) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
const short = (v) => v.slice(0, 64);
const zonedTimestamp = (v) => typeof v === "string" && v.includes("T") && (v.endsWith("Z") || /[+-]\d\d:\d\d$/.test(v)) && Number.isFinite(Date.parse(v));
const checker = (location) => (condition, message) => { if (!condition) fail(`${location}: ${message}`); };
function checkUsageShape(record, check) {
  check(object(record), "expected object");
  check(record.schema === "token-watcher-usage.v1", "bad schema");
  check(POOLS.includes(record.pool), "bad pool");
  check(validDate(record.period), "bad period date");
  check(typeof record.source === "string" && record.source.trim().length > 0, "source required");
}
/** Validate that at most one valuation input is present and well formed. */
function checkValuationInputs(record, check) {
  const dollars = present(record.dollars), share = present(record.subscriptionShare);
  check(!(dollars && share), "dollars and subscriptionShare are mutually exclusive");
  if (dollars) check(money(record.dollars), "invalid dollars");
  if (share) {
    check(money(record.subscriptionShare) && record.subscriptionShare <= 1, "invalid subscriptionShare");
    check(money(record.subscriptionUsd) && record.subscriptionUsd > 0, "subscriptionUsd required and positive");
    check(Number.isFinite(record.subscriptionShare * record.subscriptionUsd), "nonfinite valuation");
  }
  return { dollars, share };
}
function checkOptionalFields(record, tokens, check) {
  check(tokens === null || integer(tokens) || (object(tokens) && Object.values(tokens).every(integer)), "invalid tokens");
  if (present(record.pr)) check(integer(record.pr) && record.pr > 0, "invalid pr");
  if (present(record.issue)) check(typeof record.issue === "string" && /^OVD-\d+$/.test(record.issue), "invalid issue");
  for (const key of ["bot", "model"]) if (present(record[key])) check(typeof record[key] === "string", `invalid ${key}`);
}
/** Dollars are metered, a subscription share is priced at share x plan, anything else is unvalued (never 0). */
function valuate(record, dollars, share) {
  if (dollars) return { usd: record.dollars, valuation: "metered" };
  if (share) return { usd: record.subscriptionShare * record.subscriptionUsd, valuation: "subscription-share" };
  return { usd: null, valuation: "unvalued" };
}
/** Validate usage and whitelist fields into the canonical ledger shape. */
export function usageToLedger(record, location = "input:1") {
  const check = checker(location);
  checkUsageShape(record, check);
  const { dollars, share } = checkValuationInputs(record, check);
  const tokens = record.tokens ?? null;
  checkOptionalFields(record, tokens, check);
  const result = {
    schema: "spend-ledger.v1", ts: `${record.period}T00:00:00Z`, period: record.period, pool: record.pool,
    ...valuate(record, dollars, share),
    ...(share ? { subscriptionShare: record.subscriptionShare, subscriptionUsd: record.subscriptionUsd } : {}),
    tokens: object(tokens) ? Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => compare(a, b))) : tokens, source: short(record.source),
  };
  for (const key of ["pr", "issue"]) if (present(record[key])) result[key] = record[key];
  if (present(record.bot)) result.agent = short(record.bot);
  if (present(record.model)) result.model = short(record.model);
  return result;
}
export const ledgerKey = (r) => JSON.stringify([r.pool, r.period, r.source, r.pr ?? null, r.issue ?? null]);
/** Parse JSONL with safe, file:line diagnostics. */
export function parseLines(text, file, convert = (r) => r) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const location = `${file}:${index + 1}`;
    let value;
    try { value = JSON.parse(line); } catch { fail(`${location}: invalid JSON`); }
    rows.push(convert(value, location));
  });
  return rows;
}
/** Reject duplicate keys across the supplied collection batch. */
export function uniqueUsage(rows, location = "input:1") {
  const keys = new Set();
  for (const row of rows) {
    const key = ledgerKey(row);
    if (keys.has(key)) fail(`${location}: duplicate ledger key`);
    keys.add(key);
  }
  return rows;
}
const compare = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
/** Canonical merge: later records replace earlier records. */
export function mergeLedger(existing, incoming) {
  const map = new Map();
  for (const row of [...existing, ...incoming]) map.set(ledgerKey(row), row);
  return [...map.values()].sort((a, b) => compare(a.period, b.period) || compare(a.pool, b.pool) || compare(a.source, b.source) || compare(a.pr ?? 0, b.pr ?? 0) || compare(a.issue ?? "", b.issue ?? ""));
}
export const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
/** Revalidate stored ledgers instead of trusting arbitrary JSON. */
export function validateLedger(row, location) {
  if (!object(row) || row.schema !== "spend-ledger.v1" || !["metered", "subscription-share", "unvalued"].includes(row.valuation)) fail(`${location}: invalid ledger schema or valuation`);
  const canonical = usageToLedger({ ...row, schema: "token-watcher-usage.v1", bot: row.agent,
    dollars: row.valuation === "metered" ? row.usd : null,
    subscriptionShare: row.valuation === "subscription-share" ? row.subscriptionShare : null,
  }, location);
  if (row.usd !== canonical.usd || row.ts !== canonical.ts || row.valuation !== canonical.valuation) fail(`${location}: inconsistent ledger valuation or timestamp`);
  return canonical;
}
/** ISO week identifier and full Monday/Sunday bounds. */
export function isoWeek(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const start = nextDay(day, -((date.getUTCDay() + 6) % 7));
  const thursday = new Date(`${nextDay(start, 3)}T00:00:00Z`);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - new Date(`${year}-01-01T00:00:00Z`)) / 86400000 + 1) / 7);
  return { week: `${year}-W${String(week).padStart(2, "0")}`, weekStart: start, weekEnd: nextDay(start, 6) };
}
/** Validate explicit attribution, including shorthand and bot signals. */
export function parseAttribution(value) {
  if (!object(value)) fail("attribution: expected object");
  const entries = value.schema ? value.prs : value;
  if (value.schema && value.schema !== "pr-pool-attribution.v1") fail("attribution: bad schema");
  if (!object(entries)) fail("attribution: expected prs map");
  const result = {};
  for (const [number, entry] of Object.entries(entries)) {
    if (!/^[1-9]\d*$/.test(number)) fail("attribution: invalid PR number");
    const normalized = typeof entry === "string" ? { pool: entry } : entry;
    if (!object(normalized) || (present(normalized.pool) && ![...POOLS, "unknown"].includes(normalized.pool)) || (present(normalized.bot) && typeof normalized.bot !== "string")) fail("attribution: invalid entry");
    result[number] = normalized;
  }
  return result;
}
export function attributePR(pr, attribution) {
  const entry = attribution[pr.number];
  const signals = new Set();
  if (entry?.pool) signals.add(entry.pool);
  if (entry?.bot && BOT_TO_POOL[entry.bot.toLowerCase()]) signals.add(BOT_TO_POOL[entry.bot.toLowerCase()]);
  for (const label of pr.labels ?? []) {
    const match = /^(?:(?:model|pool):(codex|claude|cursor|jev)|model:(opus|sonnet))$/.exec(typeof label === "string" ? label : label?.name);
    if (match) signals.add(match[1] ?? BOT_TO_POOL[match[2]]);
  }
  if (signals.size > 1) return { pool: "unknown", attributionStatus: "conflicting" };
  if (!signals.size) return { pool: "unknown", attributionStatus: "no_signal" };
  return { pool: [...signals][0], attributionStatus: "explicit" };
}
const ratio = (usd, count) => usd === null || !count ? null : Math.round((usd / count) * 100 + Number.EPSILON * Math.max(1, (usd / count) * 100)) / 100;
function metrics(usd, count, minSample, partial = false) {
  const flags = [];
  if (usd === null) flags.push("unknown");
  if (!count) flags.push("no-merges");
  if (count > 0 && count < minSample) flags.push("low-sample");
  if (partial) flags.push("partial");
  return { usdPerMergedPR: ratio(usd, count), status: flags[0] ?? "ok", flags };
}
function coverageOf(own, valued, valuedDays, dayCount) {
  if (!own.length) return "missing";
  return valuedDays.size === dayCount && valued.length === own.length ? "complete" : "partial";
}
/** Compute weekly and whole-window results using only the supplied records. */
export function weeklyReport({ ledger, prs, from, to, attribution = {}, minSample = 5, generatedAt = `${to}T23:59:59Z`, sources = {} }) {
  if (!validDate(from) || !validDate(to) || from > to) fail("invalid from/to window");
  if (!Number.isSafeInteger(minSample) || minSample < 1) fail("invalid min-sample");
  if (!zonedTimestamp(generatedAt) || !/^\d{4}-\d\d-\d\dT/.test(generatedAt)) fail("invalid generated-at");
  if (!Array.isArray(prs)) fail("prs: expected array");
  const seen = new Set();
  const normalized = prs.map((pr) => {
    if (!object(pr) || !Number.isSafeInteger(pr.number) || pr.number < 1 || seen.has(pr.number)) fail("prs: invalid or duplicate number");
    seen.add(pr.number);
    const mergedAt = pr.mergedAt ?? pr.merged_at;
    if (!zonedTimestamp(mergedAt)) fail("prs: invalid mergedAt");
    if (pr.labels && !Array.isArray(pr.labels)) fail("prs: invalid labels");
    const day = new Date(mergedAt).toISOString().slice(0, 10);
    const issues = [...new Set(`${pr.title ?? ""} ${pr.headRefName ?? ""} ${pr.body ?? ""}`.toUpperCase().match(/\bOVD-\d+\b/g) ?? [])];
    return { number: pr.number, day, issues, ...attributePR(pr, attribution) };
  }).sort((a, b) => a.number - b.number);
  const selected = normalized.filter((pr) => pr.day >= from && pr.day <= to);
  const rows = mergeLedger([], ledger).filter((r) => r.period >= from && r.period <= to);
  const issuePRs = new Map();
  for (const pr of normalized) for (const issue of pr.issues) issuePRs.set(issue, [...(issuePRs.get(issue) ?? []), pr.number]);
  const target = (r) => r.pr ?? (issuePRs.get(r.issue)?.length === 1 ? issuePRs.get(r.issue)[0] : null);
  function summarize(days) {
    const records = rows.filter((r) => days.includes(r.period));
    const merges = selected.filter((pr) => days.includes(pr.day));
    const pools = POOLS.map((pool) => {
      const own = records.filter((r) => r.pool === pool);
      const valued = own.filter((r) => r.usd !== null);
      const data = new Set(own.map((r) => r.period)), valuedDays = new Set(valued.map((r) => r.period));
      const coverage = coverageOf(own, valued, valuedDays, days.length);
      const usd = valued.length ? valued.reduce((sum, r) => sum + r.usd, 0) : null;
      const mergedPRs = merges.filter((pr) => pr.pool === pool).length;
      const result = metrics(usd, mergedPRs, minSample, coverage === "partial");
      return {
        pool, usd, mergedPRs, ...result, coverage,
        ...(coverage === "partial" ? { partial: true, lowerBound: true } : {}),
        recordsValued: valued.length, recordsUnvalued: own.length - valued.length,
        daysWithData: data.size, daysWithValuedData: valuedDays.size,
        missingDays: days.filter((day) => !data.has(day)),
      };
    });
    const missingPools = pools.filter((p) => p.coverage === "missing").map((p) => p.pool);
    const partialPools = pools.filter((p) => p.coverage === "partial").map((p) => p.pool);
    const valued = pools.filter((p) => p.usd !== null);
    const totalUsd = valued.length ? valued.reduce((sum, p) => sum + p.usd, 0) : null;
    const partial = missingPools.length > 0 || partialPools.length > 0;
    const perPR = merges.map((pr) => {
      const direct = records.filter((r) => r.usd !== null && target(r) === pr.number);
      return { number: pr.number, pool: pr.pool, attributionStatus: pr.attributionStatus, attributedUsd: direct.length ? direct.reduce((sum, r) => sum + r.usd, 0) : null };
    });
    const attributedUsd = records
      .filter((r) => r.usd !== null && selected.some((pr) => pr.number === target(r)))
      .reduce((sum, r) => sum + r.usd, 0);
    return {
      daysInWindow: days.length, pools,
      overall: {
        totalUsd, mergedPRs: merges.length,
        unattributedPRs: merges.filter((pr) => pr.pool === "unknown").length,
        ...metrics(totalUsd, merges.length, minSample, partial),
        missingPools, partialPools, ...(partial ? { lowerBound: true } : {}),
      },
      attributedUsd, prs: perPR,
    };
  }
  const days = [];
  for (let day = from; day <= to; day = nextDay(day)) days.push(day);
  const groups = new Map();
  for (const day of days) {
    const key = isoWeek(day).week;
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  const totals = summarize(days);
  return { schema: "spend-per-pr.v1", generatedAt, window: { from, to }, minSample, pools: [...POOLS], sources,
    weeks: [...groups.values()].map((group) => ({ ...isoWeek(group[0]), ...summarize(group) })), totals,
    prs: totals.prs, notes: ["Pool spend includes reviews and overhead; cross-pool reviews are not reallocated.", "Partial or missing coverage makes ratios lower bounds."] };
}
/** Export only valued records in the pending evals reader's compatible shape. */
export function exportEvals(rows) {
  const merged = mergeLedger([], rows);
  const exportUnvaluedRecords = merged.filter((r) => r.usd === null).length;
  return merged.filter((r) => r.usd !== null).map((r) => {
    const result = { ts: r.ts, usd: r.usd, exportUnvaluedRecords, exportComplete: exportUnvaluedRecords === 0 };
    for (const key of ["pr", "issue", "agent", "source", "pool"]) if (present(r[key])) result[key] = r[key];
    return result;
  });
}
const spend = (usd) => usd === null ? "unknown" : `$${usd.toFixed(2)}`;
/** Cost per merged PR as text: unknown spend and no merges are never shown as $0. */
function costLabel(usd, mergedPRs, lowerBound, perPR) {
  if (usd === null) return "unknown";
  if (!mergedPRs) return "n/a (no merges)";
  return lowerBound ? `≥ ${spend(perPR)} (partial)` : spend(perPR);
}
/** Human view; JSON remains the Evaluator contract. */
export function markdownReport(report) {
  const sections = report.weeks.map((week) => {
    const lines = week.pools.map((p) => {
      const cost = costLabel(p.usd, p.mergedPRs, p.lowerBound, p.usdPerMergedPR);
      return `| ${p.pool} | ${spend(p.usd)} | ${p.mergedPRs} | ${cost} | ${p.status} | ${p.coverage} |`;
    });
    const o = week.overall;
    const overallCost = costLabel(o.totalUsd, o.mergedPRs, o.lowerBound, o.usdPerMergedPR);
    const gaps = [...o.missingPools.map((p) => `${p} missing`), ...o.partialPools.map((p) => `${p} partial`)].join(", ") || "complete";
    lines.push(`| **all pools** | ${spend(o.totalUsd)} | ${o.mergedPRs} (${o.unattributedPRs} unattributed) | ${overallCost} | ${o.flags.join(", ") || "ok"} | ${gaps} |`);
    return `## ${week.week}\n\n| Pool | Spend | Merged PRs | $/merged PR | Status | Coverage |\n| --- | --- | --- | --- | --- | --- |\n${lines.join("\n")}`;
  });
  return `${sections.join("\n\n")}\n\n[Cost per accepted PR](https://github.com/optomachina/Overdrafter/blob/main/docs/agent-graph-metrics.md#cost-per-accepted-pr)\n`;
}
