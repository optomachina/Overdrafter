// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRouting, parseBuiltBy, reviewFamilies } from './built-by.mjs';

const fixture = new URL('../fixtures/agent-graph/model-routing.v2.yaml', import.meta.url);
const routing = loadRouting(fixture);
const both = ['codex-xhigh', 'claude-sonnet'];
const tag = (model = 'codex', bot = 'engineer') => `Built-by: bot=${bot} model=model:${model}`;
const parse = (body, rest = {}) => parseBuiltBy({ body, routing, ...rest });
const reviewers = parsed => reviewFamilies(parsed, { routing });

describe('routing fixture and format drift', () => {
  it('documents all bots and only known bot ids, with a family on every pool', () => {
    const doc = readFileSync(new URL('../../docs/agent-pr-tags.md', import.meta.url), 'utf8');
    const list = doc.match(/Known bot IDs are ([\s\S]*?)\. The fixture/)[1];
    const ids = [...list.matchAll(/`([a-z0-9-]+)`/g)].map(match => match[1]);
    expect(ids.sort()).toEqual(routing.bots.map(bot => bot.id).sort());
    for (const match of doc.matchAll(/bot=([a-z0-9-]+)/g)) {
      if (match[1] !== 'unknown') expect(routing.bots.some(bot => bot.id === match[1])).toBe(true);
    }
    for (const pool of Object.values(routing.pools)) {
      expect(['claude', 'openai', 'grok', 'jev']).toContain(pool.family);
    }
  });
  it('throws for unreadable, invalid YAML and invalid shapes', () => {
    expect(() => loadRouting('/nonexistent/ovd938-routing')).toThrow();
    const directory = mkdtempSync(join(tmpdir(), 'ovd938-'));
    try {
      const file = join(directory, 'bad.yaml');
      for (const content of ['pools: [broken', '{}', JSON.stringify({ ...routing, pools: { bad: {} } }),
        JSON.stringify({ ...routing, review_routing: { ...routing.review_routing, openai: 'codex' } })]) {
        writeFileSync(file, content);
        expect(() => loadRouting(file)).toThrow();
      }
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe('builder attribution', () => {
  it('parses canonical tags and cross-family routes', () => {
    expect(parse(tag())).toEqual({ builders: [{ bot: 'engineer', model: 'model:codex', family: 'openai' }], status: 'ok', findings: [] });
    expect(reviewers(parse(tag()))).toEqual(['claude-sonnet']);
    expect(reviewers(parse(tag('claude-opus')))).toEqual(['codex-xhigh']);
    expect(reviewers(parse(tag('grok-overflow')))).toEqual(['codex-xhigh']);
  });
  it('retains legacy model-only attribution as unknown', () => {
    const result = parse('Model: model:codex');
    expect(result.builders[0]).toEqual({ bot: 'unknown', model: 'model:codex', family: 'openai' });
    expect(result.status).toBe('unknown');
    expect(reviewers(result)).toEqual(both);
  });
  it('retains Codex then Opus repair (#845) and requests both', () => {
    const result = parse(`${tag()}; bot=architect model=model:claude-opus`);
    expect(result.status).toBe('mixed');
    expect(result.builders.map(builder => builder.model)).toEqual(['model:codex', 'model:claude-opus']);
    expect(reviewers(result)).toEqual(both);
  });
  it('lets trailers override body bot attribution and model conflicts stay fail-safe', () => {
    const commits = [{ sha: 'a', message: `Repair\n\n${tag('codex', 'architect')}` }];
    expect(parse(tag(), { commits }).builders[0].bot).toBe('architect');
    expect(parse(tag(), { commits }).status).toBe('ok');
    const result = parse(tag('grok-overflow'), { commits });
    expect(result.status).toBe('conflict');
    expect(result.builders[0].model).toBe('model:codex');
    expect(reviewers(result)).toEqual(both);
  });
  it('reads a commit trailer from a CRLF message the same way as an LF one', () => {
    const commits = [{ sha: 'a', message: `Repair\r\n\r\n${tag('codex', 'architect')}\r\n` }];
    const result = parse(tag(), { commits });
    expect(result.builders).toEqual([{ bot: 'architect', model: 'model:codex', family: 'openai' }]);
    expect(result.status).toBe('ok');
  });
  it('uses body fallback in commit order for commits without trailers', () => {
    const result = parse(tag(), { commits: [
      { sha: 'a', message: tag('claude-opus', 'architect') }, { sha: 'b', message: 'untagged repair' },
    ] });
    expect(result.builders.map(builder => builder.model)).toEqual(['model:claude-opus', 'model:codex']);
    expect(result.status).toBe('conflict');
  });
  it('does not narrow review when only some commits carry a trailer and the body has no history', () => {
    const commits = [{ sha: 'a', message: `Build\n\n${tag()}` }, { sha: 'b', message: 'untagged follow-up' }];
    const result = parse('', { commits });
    expect(result.status).toBe('unknown');
    expect(result.findings).toContain('Commit without Built-by trailer and no body history');
    expect(reviewers(result)).toEqual(both);
    // No attribution anywhere stays "missing", and full trailer coverage stays ok.
    expect(parse('', { commits: [{ sha: 'b', message: 'untagged' }] }).status).toBe('missing');
    expect(parse('', { commits: [commits[0]] }).status).toBe('ok');
    expect(reviewers(parse('', { commits: [commits[0]] }))).toEqual(['claude-sonnet']);
  });
  it('checks model labels against commit-trailer builders when the body declares none', () => {
    const commits = [{ sha: 'a', message: `Build\n\n${tag()}` }];
    const disagree = parse('', { commits, labels: ['model:grok-overflow'] });
    expect(disagree.status).toBe('conflict');
    expect(disagree.findings).toContain('Model label disagrees with builder history: model:grok-overflow');
    expect(reviewers(disagree)).toEqual(both);
    const agree = parse('', { commits, labels: ['model:codex'] });
    expect(agree.status).toBe('ok');
    expect(reviewers(agree)).toEqual(['claude-sonnet']);
  });
  it.each([
    ['unknown bot', tag('codex', 'stranger'), {}, 'unknown'],
    ['bot=unknown', tag('codex', 'unknown'), {}, 'unknown'],
    ['unknown model', tag('unlisted'), {}, 'unknown'],
    ['label disagreement', tag(), { labels: ['model:grok-overflow'] }, 'conflict'],
    ['two labels', tag(), { labels: ['model:codex', 'model:codex-xhigh'] }, 'conflict'],
    ['duplicate labels', tag(), { labels: ['model:codex', 'model:codex'] }, 'unknown'],
    ['empty body', '', {}, 'missing'],
    ['missing line', 'A PR without tags', {}, 'missing'],
    ['garbage', 'Built-by: nonsense', {}, 'unknown'],
    ['existing free text', 'Built-by: Engineer / Codex (gpt via codex exec, ChatGPT plan)', {}, 'unknown'],
    ['unauthorized builder', tag('codex', 'qa'), {}, 'unknown'],
    ['partial garbage', `${tag()}; nonsense`, {}, 'unknown'],
  ])('%s requests both pools', (_name, body, options, status) => {
    const result = parse(body, options);
    expect(result.status).toBe(status);
    if (status !== 'missing') expect(result.findings.length).toBeGreaterThan(0);
    expect(reviewers(result)).toEqual(both);
  });
  it('never throws on internal errors', () => {
    const throwing = new Proxy({}, { get() { throw new Error('test'); } });
    const result = parse(tag(), { routing: throwing });
    expect(result.status).toBe('unknown');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(reviewers(result)).toEqual(both);
    expect(reviewFamilies(parse(tag()), { routing: throwing, extra: ['claude-opus'] })).toEqual([...both, 'claude-opus']);
    expect(parseBuiltBy(throwing).status).toBe('unknown');
  });
});

describe('fail-safe reviewer selection', () => {
  it('handles garbage input and missing or failed routing', () => {
    for (const value of [null, undefined, {}, 'ok', [], { status: 'ok', builders: [] }]) {
      expect(reviewers(value)).toEqual(both);
    }
    expect(reviewFamilies(parse(tag()))).toEqual(both);
    expect(reviewFamilies(parse(tag()), { routing: null })).toEqual(both);
    expect(reviewFamilies(null, null)).toEqual(both);
  });
  it('queues if no required pool is available, preserving extras', () => {
    expect(reviewFamilies(null, { routing, available: [], extra: ['claude-opus'] })).toEqual(['queue', 'claude-opus']);
    expect(reviewFamilies(parse(tag()), { routing, available: ['codex-xhigh'] })).toEqual(['queue']);
    expect(reviewFamilies(null, { routing, available: ['codex-xhigh'] })).toEqual(both);
  });
  it('seeded random inputs never empty the result or discard extras', () => {
    let seed = 938;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = values => values[Math.floor(random() * values.length)];
    for (let i = 0; i < 2000; i++) {
      const extra = ['claude-opus', `extra-${i}`];
      const parsed = pick([null, {}, false, 'garbage', { status: pick(['ok', 'mixed', 'conflict', 'unknown', 'missing']), builders: pick([null, [], [{}]]) },
        parse(pick([tag(), tag('claude-opus'), `garbage ${random()}`, tag('grok-overflow')]))]);
      const result = reviewFamilies(parsed, { routing: pick([routing, null, {}]), available: pick([undefined, [], ['codex-xhigh'], ['claude-sonnet']]), extra });
      expect(result.length).toBeGreaterThan(0);
      for (const entry of extra) expect(result).toContain(entry);
    }
  });
});

describe('report-only CLI', () => {
  it('always exits zero, including errors, and has no check/status writes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovd938-cli-'));
    try {
      const body = join(directory, 'body.txt');
      const bad = join(directory, 'bad.yaml');
      writeFileSync(body, tag());
      writeFileSync(bad, 'bad: [');
      for (const args of [[], ['--body'], ['--invalid'], ['--body', '/nonexistent/ovd938-body'],
        ['--body', body, '--routing', bad], ['--body', body, '--json', '--labels', 'model:codex']]) {
        const child = spawnSync(process.execPath, ['scripts/agent-graph/built-by.mjs', ...args], { encoding: 'utf8' });
        expect(child.status).toBe(0);
        expect(child.stdout, JSON.stringify({ args, stderr: child.stderr })).not.toBe('');
        const output = JSON.parse(child.stdout);
        expect(output.reviewers.length).toBeGreaterThan(0);
        if (output.status === 'unknown') expect(output.findings.length).toBeGreaterThan(0);
        else expect(output.status).toBe('ok');
      }
      const source = readFileSync(new URL('./built-by.mjs', import.meta.url), 'utf8');
      expect(source).not.toMatch(/check[-_]runs|createCheckRun|createCommitStatus|\/statuses|fetch\(|https?:|execSync|spawn\(/i);
      expect(source).not.toMatch(/writeFile|appendFile|process\.exit\(/);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
