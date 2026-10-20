#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const GH_BIN = fs.existsSync('/usr/bin/gh') ? '/usr/bin/gh' : 'gh';
export const DEFAULT_IGNORE_CHECKS = '^(Vercel|CodeRabbit)$';
const ignored = (c, re) => re && [c.name, c.context].some((v) => typeof v === 'string' && re.test(v));
const headPass = (c) => c.state ? c.state === 'SUCCESS' : String(c.status).toUpperCase() === 'COMPLETED' && good(c.conclusion);
const DAY = 86400000;
const NA = 'not available (no spend ledger)';
const good = (v) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(v).toUpperCase());
// Both gh sources (statusCheckRollup and the check-runs API) list every run on a commit, including runs that
// workflow concurrency cancelled and a later run replaced. Only the newest run of a check reflects its state.
// The check-runs API has no workflow name, so its runs are keyed by app and name; unnamed runs are never merged.
const checkKey = (c) => {
  if (c.context) return JSON.stringify(['status', c.context]);
  return c.name ? JSON.stringify(['run', c.workflowName || c.app?.slug || '', c.name]) : null;
};
// A missing timestamp (a run still queued or running) counts as newest, so a pending rerun is never hidden.
const stamp = (c, camel, snake) => { const t = Date.parse(c[camel] ?? c[snake]); return Number.isNaN(t) ? Infinity : t; };
function newer(a, b) {
  const started = stamp(a, 'startedAt', 'started_at') - stamp(b, 'startedAt', 'started_at');
  if (started) return started > 0;
  const completed = stamp(a, 'completedAt', 'completed_at') - stamp(b, 'completedAt', 'completed_at');
  if (completed) return completed > 0;
  return !headPass(a) && headPass(b); // an unresolvable tie keeps the worse result
}
function latestRuns(runs) {
  const latest = new Map();
  for (const c of runs) {
    const key = checkKey(c) ?? Symbol('unnamed');
    if (!latest.has(key) || newer(c, latest.get(key))) latest.set(key, c);
  }
  return [...latest.values()];
}
// First-pass CI keeps earlier failures but not a CANCELLED run that a later run of the same check replaced.
function withoutSupersededCancels(runs) {
  const latest = new Set(latestRuns(runs));
  return runs.filter((c) => latest.has(c) || String(c.conclusion).toUpperCase() !== 'CANCELLED');
}
const redactValue = (value, secret) => {
  if (!secret) return value;
  if (typeof value === 'string') return value.replaceAll(secret, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactValue(k, secret), redactValue(v, secret)]));
  return value;
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); };
const date = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new UsageError(`Invalid date: ${v}`);
  return v;
};
const shift = (v, n) => new Date(Date.parse(v) + n * DAY).toISOString().slice(0, 10);
export function windows(end) {
  date(end);
  return { current: { from: shift(end, -6), to: end }, baseline: { from: shift(end, -20), to: shift(end, -7) } };
}
export function inWindow(ts, w) { const t = Date.parse(ts); return t >= Date.parse(w.from) && t < Date.parse(w.to) + DAY; }
export function extractIssues(pr) {
  return [...new Set(JSON.stringify([pr.title, pr.headRefName, pr.body, pr.closingIssuesReferences]).toUpperCase().match(/\bOVD-\d+\b/g) ?? [])];
}
const QA_VERDICT = /^QA:\s*(PASS|FAIL)\b/gm;
const REPAIR_PATTERNS = [/repair budget(?: now)? used:\s*(\d+)\s*\/\s*2/gi, /repair round\s*(\d+)/gi, /round-(\d+) repair/gi];
const OPUS_CHANGES_REQUIRED = /^Opus review @[^\n]*: CHANGES REQUIRED/m;
const OPUS_REVIEW = /^Opus (?:re-review|review) @/;
// Any FAIL wins over a PASS; no verdict line at all is "none" (unknown), never a pass.
function qaVerdict(comments) {
  const verdicts = new Set(comments.flatMap((c) => [...c.matchAll(QA_VERDICT)].map((m) => m[1])));
  if (verdicts.has('FAIL')) return 'fail';
  return verdicts.has('PASS') ? 'pass' : 'none';
}
// The largest recorded repair round; a QA FAIL or an Opus CHANGES REQUIRED implies at least one.
function repairRounds(comments, qaFailed) {
  const recorded = comments.flatMap((c) => REPAIR_PATTERNS.flatMap((re) => [...c.matchAll(re)].map((m) => Number(m[1]))));
  const implied = (qaFailed || comments.some((c) => OPUS_CHANGES_REQUIRED.test(c))) ? 1 : 0;
  return Math.max(implied, ...recorded);
}
function firstPassCI(checks) {
  if (checks.length === 0) return 'unknown';
  return withoutSupersededCancels(checks).every(headPass) ? 'pass' : 'fail';
}
export function analyzePR(pr, detail, checks, ignoreChecks = DEFAULT_IGNORE_CHECKS) {
  const comments = (detail.comments ?? []).map((c) => c.body ?? '');
  const qa = qaVerdict(comments);
  const re = ignoreChecks ? new RegExp(ignoreChecks, 'i') : null;
  const rollup = latestRuns((detail.statusCheckRollup ?? []).filter((c) => !ignored(c, re)));
  return { ...pr, issues: extractIssues({ ...pr, closingIssuesReferences: detail.closingIssuesReferences }),
    accepted: rollup.length > 0 && rollup.every(headPass),
    failingHeadChecks: rollup.filter((c) => !headPass(c)).map((c) => `${c.name ?? c.context ?? 'unnamed'} ${c.state ?? c.conclusion ?? c.status ?? 'UNKNOWN'}`),
    ci: firstPassCI(checks.filter((c) => !ignored(c, re))),
    qa, repairs: repairRounds(comments, qa === 'fail'), opus: comments.some((c) => OPUS_REVIEW.test(c)) };
}
export function summarize(prs, ledger, window) {
  const selected = prs.filter((p) => inWindow(p.mergedAt, window));
  const lines = ledger.filter((l) => inWindow(l.ts, window));
  const known = selected.filter((p) => p.ci !== 'unknown' && p.qa !== 'none');
  const passed = known.filter((p) => p.ci === 'pass' && p.qa === 'pass' && p.repairs === 0).length;
  const accepted = selected.filter((p) => p.accepted).length;
  // Issue-only spend is attributed once, and only when the issue identifies one PR.
  const spending = selected.map((p) => {
    const attributed = lines.filter((l) => l.pr != null ? l.pr === p.number : l.issue && p.issues.includes(l.issue) && prs.filter((q) => q.issues.includes(l.issue)).length === 1);
    return { number: p.number, opus: p.opus, usd: attributed.length ? attributed.reduce((s, l) => s + l.usd, 0) : null };
  });
  const values = spending.filter((p) => p.usd !== null).sort((a, b) => a.usd - b.usd);
  const total = lines.length ? lines.reduce((s, l) => s + l.usd, 0) : null;
  const tier = (opus) => { const v = values.filter((p) => p.opus === opus); return v.length ? v.reduce((s, p) => s + p.usd, 0) / v.length : null; };
  return { prs: selected, accepted, passed, denominator: known.length, rate: known.length ? passed / known.length : null,
    ciKnown: selected.filter((p) => p.ci !== 'unknown').length, ciPassed: selected.filter((p) => p.ci === 'pass').length, qaKnown: selected.filter((p) => p.qa !== 'none').length,
    unknown: selected.length - known.length, unknownCI: selected.filter((p) => p.ci === 'unknown').length, unknownQA: selected.filter((p) => p.qa === 'none').length,
    zero: selected.filter((p) => p.repairs === 0).length, repairs: selected.reduce((s, p) => s + p.repairs, 0),
    lines: lines.length, total, cost: total !== null && accepted ? total / accepted : null, spending,
    mean: values.length ? values.reduce((s, p) => s + p.usd, 0) / values.length : null,
    median: values.length ? (values[Math.floor((values.length - 1) / 2)].usd + values[Math.floor(values.length / 2)].usd) / 2 : null,
    worst: values.at(-1) ?? null, opusCost: tier(true), otherCost: tier(false) };
}
export function matches(pr, match, linear = {}) {
  if (!match) return true;
  return (!match.issues?.length || pr.issues.some((id) => match.issues.includes(id))) &&
    (!match.prLabels?.length || match.prLabels.some((l) => pr.labels?.some((p) => (p.name ?? p) === l))) &&
    (!match.linearLabels?.length || pr.issues.some((id) => linear[id]?.labels?.some((l) => match.linearLabels.includes(l)))) &&
    (!match.titleRegex || new RegExp(match.titleRegex).test(pr.title));
}
export function stopRule(before, after, pct = 25) {
  if (before.cost === null || after.cost === null) return 'cannot evaluate (no cost data)';
  if (before.rate === null || after.rate === null) return 'cannot evaluate (unknown pass rate)';
  return after.cost > before.cost * (1 + pct / 100) && after.rate <= before.rate ? '⚠ STOP RULE BROKEN — revert or kill' : 'OK';
}

/** Every gh read, including discovery, uses this JSON-only, secret-free cache. */
export function createGh({ cacheDir, noCache = false, ttl = 60, now = Date.now(), secret, run = (args) => execFileSync(GH_BIN, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const stats = { calls: 0, hits: 0 };
  const gh = (args, immutable = false) => {
    const file = path.join(cacheDir, crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex') + '.json');
    if (!noCache && fs.existsSync(file)) {
      const cached = read(file);
      if (immutable || now - cached.ts < ttl * 60000) {
        stats.hits++;
        return redactValue(cached.dataKey ? read(path.join(cacheDir, cached.dataKey)).data : cached.data, secret);
      }
    }
    stats.calls++;
    const data = redactValue(JSON.parse(run(args)), secret);
    if (!noCache) {
      const sha = immutable && args[0] === 'pr' && args[1] === 'view' ? data.commits?.[0]?.oid : null;
      if (sha) {
        // The query index points to a repository + PR + first-commit SHA entry.
        const dataKey = crypto.createHash('sha256').update(JSON.stringify([args, sha])).digest('hex') + '.json';
        write(path.join(cacheDir, dataKey), { ts: now, data });
        write(file, { ts: now, dataKey });
      } else write(file, { ts: now, data });
    }
    return data;
  };
  return { gh, stats };
}
export function loadPRs(gh, repo, window, ignoreChecks = DEFAULT_IGNORE_CHECKS) {
  const list = gh(['pr', 'list', '-R', repo, '--state', 'merged', '--base', 'main', '--search', `merged:${window.from}..${window.to}`, '--limit', '1000', '--json', 'number,title,body,mergedAt,headRefName,labels,additions,deletions,author,url']);
  if (list.length >= 1000) throw new Error('PR query reached the 1000-PR limit; refusing a potentially incomplete report');
  return list.filter((p) => inWindow(p.mergedAt, window)).map((p) => {
    const detail = gh(['pr', 'view', String(p.number), '-R', repo, '--json', 'number,commits,comments,reviews,statusCheckRollup,closingIssuesReferences'], true);
    let checks = [];
    for (const commit of (detail.commits ?? []).slice(0, 4)) {
      const result = gh(['api', `repos/${repo}/commits/${commit.oid}/check-runs?per_page=100`], true);
      if (result.total_count > 100) throw new Error(`PR ${p.number}: more than 100 first-commit checks; incomplete data`);
      checks = result.check_runs ?? [];
      if (checks.length) break;
    }
    return analyzePR(p, detail, checks, ignoreChecks);
  });
}
// One batched query for labels and state only; nothing else from the issue is read or kept.
function linearQuery(ids) {
  const fields = ids.map((id, i) => `i${i}: issue(id: ${JSON.stringify(id)}) { identifier state { name } labels { nodes { name } } }`);
  return `{${fields.join('\n')}}`;
}
async function fetchLinearIssues(ids, apiKey, fetcher) {
  const response = await fetcher('https://api.linear.app/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: apiKey }, body: JSON.stringify({ query: linearQuery(ids) }) });
  if (!response.ok) throw new Error(`Linear fetch failed (${response.status})`);
  const result = await response.json();
  if (result.errors) throw new Error('Linear GraphQL query failed');
  return Object.values(result.data ?? {}).filter(Boolean)
    .map((issue) => [issue.identifier, redactValue({ labels: issue.labels.nodes.map((l) => l.name), state: issue.state.name }, apiKey)]);
}
export async function loadLinear(ids, options, env, fetcher = fetch) {
  const hasCache = Boolean(options.linearCache && fs.existsSync(options.linearCache));
  const cache = hasCache ? read(options.linearCache) : {};
  let loaded = hasCache;
  if (options.linearLive && env.LINEAR_API_KEY && ids.length) {
    Object.assign(cache, Object.fromEntries(await fetchLinearIssues(ids, env.LINEAR_API_KEY, fetcher)));
    loaded = true;
    if (options.linearCache) write(options.linearCache, redactValue(cache, env.LINEAR_API_KEY));
  }
  return { data: redactValue(cache, env.LINEAR_API_KEY), loaded };
}
const money = (n) => n === null ? NA : `$${n.toFixed(2)}`;
const LOW_SAMPLE = 10;
const fraction = (n, d) => `${n}/${d} (${d ? (100 * n / d).toFixed(1) + '%' : 'n/a'})${d < LOW_SAMPLE ? '; low sample' : ''}`;
const cell = (v) => String(v).replaceAll('|', String.raw`\|`).replaceAll(/[\r\n]/g, ' ');
function comparison(a, b, names = ['Baseline (14d)', 'Current week (7d)']) {
  const rows = [
    ['Merged PRs', (s) => s.prs.length], ['Accepted PRs', (s) => s.accepted],
    ['First-pass pass rate', (s) => fraction(s.passed, s.denominator)],
    ['First-pass CI rate (CI known)', (s) => fraction(s.ciPassed, s.ciKnown)],
    ['QA verdict coverage', (s) => fraction(s.qaKnown, s.prs.length)],
    ['Unknown CI / QA (either)', (s) => `${s.unknownCI} / ${s.unknownQA} (${s.unknown})`],
    ['Zero-repair share', (s) => fraction(s.zero, s.prs.length)], ['Mean repair rounds', (s) => s.prs.length ? (s.repairs / s.prs.length).toFixed(2) : 'n/a'],
    ['Total spend', (s) => money(s.total)], ['Cost per accepted PR (mean)', (s) => s.total !== null && !s.accepted ? 'n/a (no accepted PRs)' : money(s.cost)],
    ['Mean attributed PR spend', (s) => money(s.mean)], ['Median PR spend', (s) => money(s.median)],
    ['Worst PR', (s) => s.worst ? `#${s.worst.number} ${money(s.worst.usd)}` : NA],
    ['Opus-reviewed vs not cost (attributed mean)', (s) => `${money(s.opusCost)} / ${money(s.otherCost)}`],
  ];
  return [`| Metric | ${names.map(cell).join(' | ')} |`, '| --- | --- | --- |', ...rows.map(([name, fn]) => `| ${name} | ${cell(fn(a))} | ${cell(fn(b))} |`)].join('\n');
}
// Cohort costs include only uniquely attributable spend; full-window overhead
// belongs to the before/after comparison, never duplicated across A/B arms.
function abSection(e, { prs, ledger, linear }, afterW) {
  const cohort = (subset) => {
    const ids = new Set(subset.map((p) => p.number));
    const spend = ledger.filter((l) => l.pr != null ? ids.has(l.pr) : l.issue && prs.filter((p) => p.issues.includes(l.issue)).length === 1 && subset.some((p) => p.issues.includes(l.issue)));
    return summarize(subset, spend, afterW);
  };
  const matched = prs.filter((p) => matches(p, e.match, linear));
  const unmatched = prs.filter((p) => !matches(p, e.match, linear));
  return `### A/B: ${cell(e.id)}\n\nAttributed spend only; unattributed/abandoned spend excluded from A/B arms.\n\n${comparison(cohort(matched), cohort(unmatched), ['Matched', 'Unmatched'])}`;
}
function experimentSections(e, data, weekEnding) {
  const { prs, ledger, linear } = data;
  const beforeW = { from: shift(e.start, -14), to: shift(e.start, -1) };
  const afterW = { from: e.start, to: weekEnding };
  const before = summarize(prs, ledger, beforeW), after = summarize(prs, ledger, afterW);
  const verdict = stopRule(before, after, e.stopRule?.maxCostIncreasePct ?? 25);
  const sections = [`## Experiment: ${cell(e.id)} — ${cell(e.title)}\n\nBefore: ${beforeW.from}–${beforeW.to}; after: ${afterW.from}–${afterW.to}.\n\nStop rule: ${verdict}\n\n${comparison(before, after, ['Before', 'After'])}`];
  if (e.match && after.prs.some((p) => !matches(p, e.match, linear))) sections.push(abSection(e, data, afterW));
  return { sections, flags: verdict.includes('BROKEN') ? [`${e.id}: ${verdict}`] : [] };
}
function rejectedFlags(prs, w) {
  const rejected = prs.filter((p) => !p.accepted && (inWindow(p.mergedAt, w.current) || inWindow(p.mergedAt, w.baseline)));
  if (!rejected.length) return [];
  const links = rejected.slice(0, 10).map((p) => `[#${p.number}](${p.url})`).join(', ');
  const more = rejected.length > 10 ? ` and ${rejected.length - 10} more` : '';
  const counts = new Map();
  for (const name of rejected.flatMap((p) => [...new Set(p.failingHeadChecks ?? [])])) counts.set(name, (counts.get(name) ?? 0) + 1);
  const failing = [...counts].map(([name, count]) => `${cell(name)} ×${count}`).join(', ');
  return [`Merged-not-accepted: ${links}${more}`, ...(counts.size ? [`Failing head checks: ${failing}`] : [])];
}
function lowSampleFlags(baseline, current) {
  return [{ label: 'Baseline', s: baseline }, { label: 'Current week', s: current }]
    .filter(({ s }) => s.denominator < LOW_SAMPLE)
    .map(({ label, s }) => `${label} low sample: n=${s.denominator}; treat pass rate as indicative`);
}
function lowSampleNotes(baseline) {
  return [['first-pass pass rate', baseline.denominator], ['first-pass CI rate', baseline.ciKnown], ['QA verdict coverage', baseline.prs.length]]
    .filter(([, n]) => n < LOW_SAMPLE)
    .map(([label, n]) => `Baseline ${label}: n=${n}; treat as indicative`);
}
function sourcesSection({ ignoreChecks, stats, linearLoaded, baseline, current, ledger }) {
  return ['## Data sources and gaps', '',
    `- Ignored infra/advisory contexts (case-insensitive name or context): ${cell(ignoreChecks || '(disabled)')}`,
    `- gh call count: ${stats.calls}; cache hits: ${stats.hits}`,
    `- Linear data: ${linearLoaded ? 'loaded' : 'not loaded'}`,
    `- Spend ledger lines used: baseline ${baseline.lines}; current ${current.lines}; input records ${ledger.length}`,
    '- GitHub rollups are observed after merge, not historical merge-time snapshots. Empty rollups are not accepted. Cached comments and checks may omit later updates.',
    '- Missing QA verdicts are unknown. Missing attributed spend is not zero. Issue spend shared by multiple PRs is left unattributed. A/B costs omit shared overhead.'];
}
function prRow(p, current) {
  const usd = current.spending.find((s) => s.number === p.number)?.usd;
  return `| [#${p.number}](${p.url}) | ${p.issues.join(', ') || '—'} | ${p.accepted ? 'yes' : 'no'} | ${p.ci} | ${p.qa} | ${p.repairs} | ${p.opus ? 'yes' : 'no'} | ${usd == null ? 'n/a' : money(usd)} |`;
}
export function buildReport({ prs, ledger = [], experiments = [], linear = {}, weekEnding, now, repo, stats, linearLoaded, ignoreChecks = DEFAULT_IGNORE_CHECKS }) {
  const w = windows(weekEnding);
  const baseline = summarize(prs, ledger, w.baseline), current = summarize(prs, ledger, w.current);
  const active = experiments.filter((e) => e.start <= weekEnding && (!e.end || e.end >= w.current.from));
  const experimentParts = active.map((e) => experimentSections(e, { prs, ledger, linear }, weekEnding));
  const flags = [...experimentParts.flatMap((x) => x.flags), ...rejectedFlags(prs, w), ...lowSampleFlags(baseline, current)];
  const summaryNotes = lowSampleNotes(baseline);
  return [`# Weekly evals report — week ending ${weekEnding}`, '',
    `Generated-at: ${now}\n\nRepo: ${cell(repo)}\n\nDefinition: [Cost per accepted PR](https://github.com/${repo}/blob/main/docs/agent-graph-metrics.md#cost-per-accepted-pr)`, '',
    '## Flags', '', ...(flags.length ? flags.map((f) => `- ${f}`) : ['None.']), '',
    `Baseline: ${w.baseline.from}–${w.baseline.to}; current: ${w.current.from}–${w.current.to} (UTC inclusive).`, '',
    ...(summaryNotes.length ? ['**Low-sample baseline:** ' + summaryNotes.join('; ') + '.', ''] : []),
    comparison(baseline, current), '', ...experimentParts.flatMap((x) => x.sections), '',
    ...sourcesSection({ ignoreChecks, stats, linearLoaded, baseline, current, ledger }), '',
    '## Current week PRs', '', '| PR | Issue | Accepted | CI first pass | QA | Repair rounds | Opus | Spend |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...current.prs.map((p) => prRow(p, current))].join('\n') + '\n';
}
class UsageError extends Error {}
const FLAG_OPTIONS = new Map([['--no-cache', 'noCache'], ['--linear-live', 'linearLive'], ['--help', 'help']]);
const VALUE_OPTIONS = new Map([['--ignore-checks', 'ignoreChecks'], ['--repo', 'repo'], ['--week-ending', 'weekEnding'], ['--out', 'out'], ['--cache-dir', 'cacheDir'], ['--cache-ttl-min', 'ttl'], ['--linear-cache', 'linearCache'], ['--experiments', 'experiments'], ['--now', 'now']]);
// Takes the value that follows a flag. Only --ignore-checks may be empty: an empty pattern disables ignoring.
function takeValue(queue, arg) {
  const v = queue.shift();
  if (v === undefined || (v === '' && arg !== '--ignore-checks') || v.startsWith('--')) throw new UsageError(`Missing value for ${arg}`);
  return v;
}
function readOptions(args) {
  const o = { ledgers: [], experiments: 'evals/experiments.json', ttl: 60, ignoreChecks: DEFAULT_IGNORE_CHECKS };
  const queue = [...args];
  while (queue.length) {
    const arg = queue.shift();
    if (FLAG_OPTIONS.has(arg)) o[FLAG_OPTIONS.get(arg)] = true;
    else if (arg === '--spend-ledger') o.ledgers.push(takeValue(queue, arg));
    else if (VALUE_OPTIONS.has(arg)) o[VALUE_OPTIONS.get(arg)] = takeValue(queue, arg);
    else throw new UsageError(`Unknown option: ${arg}`);
  }
  return o;
}
function finalizeOptions(o) {
  try { new RegExp(o.ignoreChecks, 'i'); } catch { throw new UsageError('Invalid --ignore-checks regex'); }
  o.ttl = Number(o.ttl);
  if (!Number.isFinite(o.ttl) || o.ttl < 0) throw new UsageError('Cache TTL must be nonnegative');
  o.now ??= new Date().toISOString();
  if (!Number.isFinite(Date.parse(o.now))) throw new UsageError('Invalid --now');
  o.weekEnding ??= new Date(o.now).toISOString().slice(0, 10);
  date(o.weekEnding);
  if (o.repo && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new UsageError('Invalid repo');
  return o;
}
export function parseArgs(args) {
  return finalizeOptions(readOptions(args));
}
const MATCH_KEYS = new Set(['issues', 'prLabels', 'linearLabels', 'titleRegex']);
const MATCH_LIST_KEYS = ['issues', 'prLabels', 'linearLabels'];
const isStringList = (v) => Array.isArray(v) && v.every((item) => typeof item === 'string');
function validateMatch(match) {
  const unknownKey = Object.keys(match).find((key) => !MATCH_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`Unknown match key: ${unknownKey}`);
  const badList = MATCH_LIST_KEYS.find((key) => match[key] && !isStringList(match[key]));
  if (badList !== undefined) throw new UsageError(`Invalid match ${badList}`);
  try { if (match.titleRegex) new RegExp(match.titleRegex); } catch { throw new UsageError('Invalid titleRegex'); }
}
function validateExperiment(e, ids) {
  if (!e.id || !e.title || ids.has(e.id)) throw new UsageError('Experiments require unique id and title');
  ids.add(e.id);
  date(e.start);
  if (e.end) date(e.end);
  if (e.end && e.end < e.start) throw new UsageError('Experiment end precedes start');
  if (e.match) validateMatch(e.match);
  const pct = e.stopRule?.maxCostIncreasePct ?? 25;
  if (!Number.isFinite(pct) || pct < 0) throw new UsageError('Invalid stop rule percentage');
}
export function validateExperiments(entries) {
  if (!Array.isArray(entries)) throw new UsageError('experiments must be an array');
  const ids = new Set();
  for (const e of entries) validateExperiment(e, ids);
  return entries;
}
export function loadLedger(files) {
  return files.flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    let l; try { l = JSON.parse(line); } catch { throw new UsageError(`Invalid ledger JSON at ${file}:${i + 1}`); }
    if (!l || !Number.isFinite(Date.parse(l.ts)) || !Number.isFinite(l.usd) || l.usd < 0 || (l.pr != null && (!Number.isInteger(l.pr) || l.pr < 1)) || (l.issue != null && !/^OVD-\d+$/.test(l.issue))) throw new UsageError(`Invalid ledger line at ${file}:${i + 1}`);
    return { ts: l.ts, usd: l.usd, pr: l.pr, issue: l.issue };
  }));
}
export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const redact = (s) => env.LINEAR_API_KEY ? String(s).replaceAll(env.LINEAR_API_KEY, '[REDACTED]') : String(s);
  try {
    const o = parseArgs(args);
    if (o.help) { (deps.stdout ?? process.stdout).write('Usage: node scripts/evals-weekly-report.mjs [--ignore-checks regex] [--repo owner/repo] [--week-ending YYYY-MM-DD] [--spend-ledger file.jsonl] [--experiments file] [--linear-cache file] [--linear-live] [--cache-dir dir] [--cache-ttl-min 60] [--no-cache] [--out file] [--now ISO]\n'); return 0; }
    const experiments = validateExperiments(read(o.experiments).experiments);
    const ledger = loadLedger(o.ledgers);
    o.cacheDir ??= path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'overdrafter-evals-weekly');
    const { gh, stats } = createGh({ ...o, now: Date.parse(o.now), run: deps.run, secret: env.LINEAR_API_KEY });
    let repo = o.repo;
    if (!repo) { try { repo = gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner; } catch { repo = 'optomachina/Overdrafter'; } }
    const w = windows(o.weekEnding);
    let from = w.baseline.from;
    for (const e of experiments.filter((e) => e.start <= o.weekEnding && (!e.end || e.end >= w.current.from))) if (shift(e.start, -14) < from) from = shift(e.start, -14);
    const prs = loadPRs(gh, repo, { from, to: o.weekEnding }, o.ignoreChecks);
    const linear = await loadLinear([...new Set(prs.flatMap((p) => p.issues))], o, env, deps.fetcher);
    const report = redact(buildReport({ prs, ledger, experiments, linear: linear.data, linearLoaded: linear.loaded, weekEnding: o.weekEnding, now: o.now, repo, stats, ignoreChecks: o.ignoreChecks }));
    if (o.out) { fs.mkdirSync(path.dirname(o.out), { recursive: true }); fs.writeFileSync(o.out, report); } else (deps.stdout ?? process.stdout).write(report);
    return 0;
  } catch (e) {
    (deps.stderr ?? process.stderr).write(redact(e.stderr?.toString() || e.message) + '\n');
    return e instanceof UsageError ? 2 : 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await main();
