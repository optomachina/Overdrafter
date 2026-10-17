// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePR, buildReport, createGh, extractIssues, inWindow, loadLedger, loadLinear, loadPRs, main, matches, parseArgs, stopRule, summarize, validateExperiments, windows } from './evals-weekly-report.mjs';
const fixture = fileURLToPath(new URL('./fixtures/evals-weekly/', import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name + '.json'), 'utf8'));
const list = read('prs'), details = read('details'), checks = read('checks');
const prs = list.map((p) => analyzePR(p, details[p.number], checks[`fixture${p.number}`].check_runs));
const ledger = loadLedger([path.join(fixture, 'spend.jsonl')]);
const w = windows('2026-10-16');
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-evals-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const run = (args) => JSON.stringify(args[0] === 'pr' && args[1] === 'list' ? list : args[0] === 'pr' ? details[args[2]] : checks[args[1].split('/commits/')[1].split('/')[0]]);
const report = (overrides = {}) => buildReport({ prs, ledger, experiments: read('experiments').experiments, linear: read('linear'), weekEnding: '2026-10-16', now: '2026-10-16T12:00:00Z', repo: 'example/repo', stats: { calls: 9, hits: 0 }, linearLoaded: true, ...overrides });

describe('weekly evals', () => {
  it('uses inclusive UTC 7-day and preceding 14-day windows', () => {
    expect(w).toEqual({ current: { from: '2026-10-10', to: '2026-10-16' }, baseline: { from: '2026-09-26', to: '2026-10-09' } });
    expect(inWindow('2026-10-16T23:59:59.999Z', w.current)).toBe(true);
    expect(inWindow('2026-10-17T00:00:00Z', w.current)).toBe(false);
    expect(windows('2026-03-01').current.from).toBe('2026-02-23');
  });
  it('distinguishes accepted, failing, pending, status contexts and absent checks', () => {
    expect(prs.map((p) => p.accepted)).toEqual([true, true, false, true]);
    for (const entry of [{ status: 'IN_PROGRESS', conclusion: null }, { state: 'PENDING' }]) expect(analyzePR({}, { statusCheckRollup: [entry] }, []).accepted).toBe(false);
    expect(analyzePR({}, { statusCheckRollup: [{ state: 'SUCCESS' }] }, []).accepted).toBe(true);
    expect(analyzePR({}, {}, []).accepted).toBe(false);
    expect(prs.map((p) => p.ci)).toEqual(['pass', 'pass', 'fail', 'unknown']);
    expect(prs.map((p) => p.qa)).toEqual(['pass', 'pass', 'fail', 'none']);
  });
  it('ignores advisory names and contexts case-insensitively in both check sources', () => {
    const advisory = [{ name: 'vercel', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'CODERABBIT', state: 'PENDING' }];
    const ci = { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(analyzePR({}, { statusCheckRollup: [ci, ...advisory] }, [ci, ...advisory])).toMatchObject({ accepted: true, ci: 'pass', failingHeadChecks: [] });
    expect(analyzePR({}, { statusCheckRollup: advisory }, advisory, '')).toMatchObject({ accepted: false, ci: 'fail' });
    expect(analyzePR({}, { statusCheckRollup: advisory }, advisory)).toMatchObject({ accepted: false, ci: 'unknown' });
    expect(analyzePR({}, { statusCheckRollup: [ci] }, [ci], '^ci$')).toMatchObject({ accepted: false, ci: 'unknown' });
    expect(parseArgs(['--ignore-checks', '']).ignoreChecks).toBe('');
    expect(report()).toContain('^(Vercel\|CodeRabbit)$'.replace('\|', '\\|'));
    expect(report({ ignoreChecks: '' })).toContain('(disabled)');
  });
  it('reports CI and QA coverage separately while retaining the joint first-pass denominator', () => {
    const text = report({ experiments: [] });
    expect(text).toContain('| First-pass pass rate | 1/1 (100.0%) | 1/2 (50.0%) |');
    expect(text).toContain('| First-pass CI rate (CI known) | 1/1 (100.0%) | 1/2 (50.0%) |');
    expect(text).toContain('| QA verdict coverage | 1/1 (100.0%) | 2/3 (66.7%) |');
    expect(text).toContain('Baseline low sample: n=1; treat pass rate as indicative');
    expect(text).toContain('Current week low sample: n=2; treat pass rate as indicative');
    expect(text).toContain('https://github.com/example/repo/blob/main/docs/agent-graph-metrics.md#cost-per-accepted-pr');
    const many = Array.from({ length: 10 }, (_, i) => ({ ...prs[0], number: i, ci: 'pass', qa: 'pass' }));
    expect(report({ prs: many, experiments: [] })).not.toContain('Baseline low sample');
  });
  it('caps rejected links and counts only failing non-ignored head checks', () => {
    const rejected = Array.from({ length: 12 }, (_, i) => analyzePR({ ...list[1], number: i + 100 }, { statusCheckRollup: [
      { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'provider-go-live', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { context: 'Vercel', state: 'FAILURE' },
    ] }, []));
    const text = report({ prs: rejected, experiments: [] });
    const flag = text.split('\n').find((l) => l.startsWith('- Merged-not-accepted:'));
    expect(flag.match(/\[#/g)).toHaveLength(10);
    expect(flag).toContain('and 2 more');
    expect(text).toContain('Failing head checks: ci FAILURE ×12, provider-go-live CANCELLED ×12');
  });
  it('requests 1000 PRs and probes at most four commits in order with immutable SHA checks', () => {
    for (const firstWithChecks of [0, 1, 3, 4]) {
      const calls = [];
      const gh = (args, immutable) => {
        calls.push({ args, immutable });
        if (args[1] === 'list') return [list[1]];
        if (args[0] === 'pr') return { commits: Array.from({ length: 5 }, (_, i) => ({ oid: `sha${i}` })) };
        const i = Number(args[1].match(/sha(\d)/)[1]);
        return { check_runs: i === firstWithChecks ? [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] : [] };
      };
      expect(loadPRs(gh, 'example/repo', w.current)[0].ci).toBe(firstWithChecks < 4 ? 'pass' : 'unknown');
      expect(calls[0].args.slice(calls[0].args.indexOf('--limit'), calls[0].args.indexOf('--limit') + 2)).toEqual(['--limit', '1000']);
      const probes = calls.filter((c) => c.args[0] === 'api');
      expect(probes).toHaveLength(Math.min(firstWithChecks + 1, 4));
      probes.forEach((c, i) => {
        expect(c.immutable).toBe(true);
        expect(c.args[1]).toContain(`/sha${i}/`);
      });
    }
  });
  it.each(['repair budget used: 2/2', 'repair budget now used: 2 / 2', 'repair round 2', 'round-2 repair'] )('parses %s', (body) => {
    expect(analyzePR({}, { comments: [{ body }] }, []).repairs).toBe(2);
  });
  it('recognizes implied repairs, multiline QA and Opus risk tiers', () => {
    const p = analyzePR({}, { comments: [{ body: 'intro\nQA: PASS on sha\nQA: FAIL on sha' }, { body: 'Opus review @ abc: CHANGES REQUIRED' }] }, []);
    expect(p).toMatchObject({ qa: 'fail', repairs: 1, opus: true });
    expect(analyzePR({}, { comments: [{ body: 'Opus re-review @ sha: PASS' }] }, []).opus).toBe(true);
  });
  it('excludes unknowns and includes abandoned and unattributed spend', () => {
    const s = summarize(prs, ledger, w.current);
    expect(s).toMatchObject({ accepted: 2, passed: 1, denominator: 2, rate: 0.5, unknown: 1, unknownCI: 1, unknownQA: 1, zero: 2, repairs: 2, total: 32, cost: 16, mean: 10, median: 10, worst: { number: 3, usd: 12 } });
    expect(s.spending.find((p) => p.number === 4).usd).toBeNull();
  });
  it('does not double attribute ambiguous issues or explicit PR spend', () => {
    const duplicated = prs.map((p) => ({ ...p, issues: ['OVD-2'] }));
    const s = summarize(duplicated, ledger, w.current);
    expect(s.spending.find((p) => p.number === 2).usd).toBeNull();
    expect(s.spending.find((p) => p.number === 3).usd).toBe(12);
  });
  it('reports unavailable costs without inventing zero amounts', () => {
    for (const entries of [[], [{ ts: '2000-01-01', usd: 99 }]]) {
      const text = report({ ledger: entries });
      expect(text).toContain('not available (no spend ledger)');
      expect(text).not.toMatch(/\$\d/);
    }
  });
  it.each([[13, 0.5, 'BROKEN'], [13, 0.6, 'OK'], [11, 0.5, 'OK'], [null, 0.5, 'cannot evaluate (no cost data)']])('stop rule for %s and %s', (cost, rate, expected) => {
    expect(stopRule({ cost: 10, rate: 0.5 }, { cost, rate })).toContain(expected);
  });
  it('leaves unknown rates unevaluated and handles zero cost baseline', () => {
    expect(stopRule({ cost: 10, rate: null }, { cost: 13, rate: 0.5 })).toContain('cannot evaluate');
    expect(stopRule({ cost: 0, rate: 0.5 }, { cost: 1, rate: 0.5 })).toContain('BROKEN');
  });
  it('extracts issue IDs from each supported source', () => {
    expect(extractIssues({ title: 'OVD-1', headRefName: 'bwilson/ovd-894-weekly', body: 'https://linear.app/a/issue/OVD-2', closingIssuesReferences: [{ title: 'OVD-3' }] })).toEqual(['OVD-1', 'OVD-894', 'OVD-2', 'OVD-3']);
  });
  it('renders comparison, flags, A/B, per-PR details and sources', () => {
    const text = report();
    for (const part of ['# Weekly evals report — week ending 2026-10-16', '## Flags', 'docs/agent-graph-metrics.md', 'Baseline (14d)', 'Current week (7d)', '## Experiment:', '### A/B:', '## Data sources and gaps', '## Current week PRs', 'Merged-not-accepted', 'Linear data: loaded']) expect(text).toContain(part);
    const broken = report({ ledger: [...ledger, { ts: '2026-10-12', usd: 20 }] });
    expect(broken.match(/⚠ STOP RULE BROKEN — revert or kill/g)).toHaveLength(2);
    expect(matches(prs[1], { linearLabels: ['experiment'], titleRegex: 'OVD-2', issues: ['OVD-2'] }, read('linear'))).toBe(true);
    expect(matches(prs[2], { prLabels: ['trial'] })).toBe(false);
    expect(report({ experiments: [{ id: 'ending-this-week', title: 'active', start: '2026-10-10', end: '2026-10-12' }] })).toContain('after: 2026-10-10–2026-10-16');
    expect(report({ experiments: [{ id: 'ended', title: 'ended', start: '2026-01-01', end: '2026-10-09' }] })).not.toContain('## Experiment:');
  });
  it('reuses immutable data beyond list TTL and bypasses cache on request', () => {
    const cacheDir = tmp();
    const a = createGh({ cacheDir, run, now: 0 });
    expect(loadPRs(a.gh, 'example/repo', { from: '2026-09-26', to: '2026-10-16' })).toHaveLength(4);
    expect(a.stats.calls).toBe(9);
    const b = createGh({ cacheDir, run: () => { throw new Error('unexpected gh'); }, now: 1000 });
    loadPRs(b.gh, 'example/repo', { from: '2026-09-26', to: '2026-10-16' });
    expect(b.stats).toEqual({ calls: 0, hits: 9 });
    const c = createGh({ cacheDir, run, now: 7200000 });
    loadPRs(c.gh, 'example/repo', { from: '2026-09-26', to: '2026-10-16' });
    expect(c.stats).toEqual({ calls: 1, hits: 8 });
    const d = createGh({ cacheDir, run, noCache: true });
    loadPRs(d.gh, 'example/repo', { from: '2026-09-26', to: '2026-10-16' });
    expect(d.stats.calls).toBe(9);
  });
  it('redacts the runtime key from cached GitHub metadata', () => {
    const cacheDir = tmp();
    const secret = 'test-key-in-metadata';
    const client = createGh({ cacheDir, secret, run: () => JSON.stringify({ comments: [{ body: secret }] }) });
    expect(client.gh(['pr', 'view', '1'], true).comments[0].body).toBe('[REDACTED]');
    for (const f of fs.readdirSync(cacheDir)) expect(fs.readFileSync(path.join(cacheDir, f), 'utf8')).not.toContain(secret);
  });
  it('rejects truncated query and check-run data', () => {
    expect(() => loadPRs(() => Array(1000).fill(list[0]), 'a/b', w.current)).toThrow('1000-PR limit');
    expect(() => loadPRs((args) => args[1] === 'list' ? [list[1]] : args[0] === 'pr' ? details[2] : { total_count: 101 }, 'a/b', w.current)).toThrow('100 first-commit checks');
  });
  it('loads Linear only with both opt-in and key, projecting only labels and state', async () => {
    const linearCache = path.join(tmp(), 'linear.json');
    const secret = 'test-ephemeral-key';
    let calls = 0;
    const fetcher = async (_url, opts) => {
      calls++;
      expect(opts.headers.Authorization).toBe(secret);
      expect(JSON.parse(opts.body).query).toContain('OVD-2');
      return { ok: true, json: async () => ({ data: { i0: { identifier: 'OVD-2', state: { name: 'Done' }, labels: { nodes: [{ name: 'experiment' }] }, ignored: secret } } }) };
    };
    expect((await loadLinear(['OVD-2'], { linearCache }, { LINEAR_API_KEY: secret }, fetcher)).loaded).toBe(false);
    expect(calls).toBe(0);
    await loadLinear(['OVD-2'], { linearCache, linearLive: true }, { LINEAR_API_KEY: secret }, fetcher);
    expect(calls).toBe(1);
    expect(fs.readFileSync(linearCache, 'utf8')).not.toContain(secret);
  });
  it('runs main offline, protects the key, and returns usage/fetch exit codes', async () => {
    const cacheDir = tmp();
    let output = '', errors = '';
    const secret = 'test-ephemeral-key';
    const deps = { run, env: { LINEAR_API_KEY: secret }, stdout: { write: (s) => { output += s; } }, stderr: { write: (s) => { errors += s; } } };
    const args = ['--repo', 'example/repo', '--week-ending', '2026-10-16', '--now', '2026-10-16T12:00:00Z', '--cache-dir', cacheDir, '--spend-ledger', path.join(fixture, 'spend.jsonl')];
    expect(await main(args, deps)).toBe(0);
    expect(output).toContain('Linear data: not loaded');
    expect(output).not.toContain(secret);
    for (const f of fs.readdirSync(cacheDir)) expect(fs.readFileSync(path.join(cacheDir, f), 'utf8')).not.toContain(secret);
    expect(await main(['--unknown'], deps)).toBe(2);
    expect(await main(['--ignore-checks', '['], deps)).toBe(2);
    expect(errors).toContain('Invalid --ignore-checks regex');
    expect(await main([...args, '--no-cache'], { ...deps, run: () => { throw Object.assign(new Error('failed'), { stderr: `gh failed ${secret}` }); } })).toBe(1);
    expect(errors).toContain('gh failed [REDACTED]');
    expect(errors).not.toContain(secret);
  });
  it('validates options, registry and ledger records before fetching', () => {
    for (const args of [['--week-ending', '2026-02-30'], ['--out'], ['--cache-ttl-min', '-1'], ['--now', 'invalid'], ['--repo', '-bad']]) expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(['--now', '2026-10-16T00:00:00Z']).weekEnding).toBe('2026-10-16');
    expect(() => validateExperiments([{ id: 'x', title: 'x', start: '2026-10-01', match: { titleRegex: '[' } }])).toThrow('titleRegex');
    const f = path.join(tmp(), 'bad.jsonl'); fs.writeFileSync(f, '{"ts":"2026-10-16","usd":-1}\n');
    expect(() => loadLedger([f])).toThrow('Invalid ledger');
  });
});
