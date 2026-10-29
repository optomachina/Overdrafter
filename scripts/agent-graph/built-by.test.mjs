// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertReviewDispatch, loadRouting, parseBuiltBy, reviewFamilies } from './built-by.mjs';

const fixture = new URL('../fixtures/agent-graph/model-routing.v2.yaml', import.meta.url);
const routing = loadRouting(fixture);
const freshOpus = { reviewer: 'claude-opus', fresh_session: true };
const failSafe = [freshOpus, 'claude-sonnet'];
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
        JSON.stringify({ ...routing, review_routing: { ...routing.review_routing, openai: 'codex' } }),
        JSON.stringify({ ...routing, review_routing: { ...routing.review_routing, grok: { reviewer: 'claude-opus', extra: 1 } } })]) {
        writeFileSync(file, content);
        expect(() => loadRouting(file)).toThrow();
      }
    } finally { rmSync(directory, { recursive: true }); }
  });
});

describe('review route families', () => {
  const withRoutes = routes => ({ ...routing, review_routing: { ...routing.review_routing, ...routes } });
  const load = value => {
    const directory = mkdtempSync(join(tmpdir(), 'ovd-routes-'));
    try {
      const file = join(directory, 'routing.yaml');
      writeFileSync(file, JSON.stringify(value));
      return loadRouting(file);
    } finally { rmSync(directory, { recursive: true }); }
  };
  it('allows claude->claude only with fresh_session', () => {
    expect(() => load(withRoutes({ claude: { reviewer: 'claude-opus', fresh_session: true } }))).not.toThrow();
    expect(() => load(withRoutes({ claude: { reviewer: 'claude-opus' } }))).toThrow('cross-family');
    expect(() => load(withRoutes({ claude: { reviewer: 'claude-opus', fresh_session: false } }))).toThrow('cross-family');
    expect(() => load(withRoutes({ claude: 'claude-opus' }))).toThrow('cross-family');
  });
  it('still rejects openai->openai and grok->grok, even with fresh_session', () => {
    expect(() => load(withRoutes({ openai: 'codex' }))).toThrow('cross-family');
    expect(() => load(withRoutes({ openai: { reviewer: 'codex-xhigh', fresh_session: true } }))).toThrow('cross-family');
    expect(() => load(withRoutes({ grok: 'grok-overflow' }))).toThrow('cross-family');
    expect(() => load(withRoutes({ grok: { reviewer: 'grok-overflow', fresh_session: true } }))).toThrow('cross-family');
  });
  it('accepts grok->claude and openai->claude-sonnet', () => {
    expect(() => load(withRoutes({ grok: 'claude-opus' }))).not.toThrow();
    expect(() => load(withRoutes({ grok: 'claude-sonnet' }))).not.toThrow();
    expect(() => load(withRoutes({ openai: 'claude-sonnet' }))).not.toThrow();
  });
  it.each(['true', 1, null])('rejects malformed fresh_session: %s', fresh_session => {
    expect(() => load(withRoutes({ claude: { reviewer: 'claude-opus', fresh_session } }))).toThrow();
  });
  it.each(['__proto__', 'constructor'])('rejects the %s route key', key => {
    expect(() => load(withRoutes({ grok: { reviewer: 'claude-opus', [key]: 'invalid' } }))).toThrow();
  });
  it('rejects non-string reviewers and inherited route properties', () => {
    expect(() => load(withRoutes({ grok: { reviewer: 1 } }))).toThrow();
    const inherited = Object.create({ reviewer: 'claude-opus' });
    expect(reviewFamilies(parse(tag('grok-overflow')), { routing: withRoutes({ grok: inherited }) })).toEqual(failSafe);
  });
  it('rejects a Codex pool mislabeled as Claude', () => {
    const invalid = { ...withRoutes({ claude: { reviewer: 'codex-xhigh', fresh_session: true } }),
      pools: { ...routing.pools, 'codex-xhigh': { family: 'claude' } } };
    expect(() => load(invalid)).toThrow('fail-safe families');
    expect(reviewFamilies(parse(tag('claude-opus')), { routing: invalid })).toEqual(failSafe);
  });
  it.each(['openai', { reviewer: 'openai' }])('resolves the openai alias: %j', target => {
    const custom = load(withRoutes({ grok: target }));
    expect(reviewFamilies(parse(tag('grok-overflow')), { routing: custom })).toEqual(['codex-xhigh']);
  });
  it('rejects fresh_session on cross-family routes and OpenAI review of Claude', () => {
    expect(() => load(withRoutes({ grok: { reviewer: 'claude-opus', fresh_session: true } }))).toThrow('Fresh-session');
    expect(() => load(withRoutes({ claude: { reviewer: 'openai' } }))).toThrow('OpenAI');
  });
  it.each(['unknown_builder', 'mixed_builder'])('requires fresh Opus plus Sonnet for %s', field => {
    for (const entries of [['codex-xhigh', 'claude-sonnet'], ['claude-opus', 'claude-sonnet'],
      [{ reviewer: 'claude-opus', fresh_session: 'true' }, 'claude-sonnet']]) {
      const invalid = { ...routing, [field]: entries };
      expect(() => load(invalid)).toThrow('fail-safe');
      expect(reviewFamilies(parse(tag('claude-opus')), { routing: invalid })).toEqual(failSafe);
    }
  });
  it('keeps the missing-route check', () => {
    const { claude, ...rest } = routing.review_routing;
    expect(claude).toBeDefined();
    expect(() => load({ ...routing, review_routing: rest })).toThrow('Missing review route');
  });
});

describe('builder attribution', () => {
  it('parses canonical tags and cross-family routes', () => {
    expect(parse(tag())).toEqual({ builders: [{ bot: 'engineer', model: 'model:codex', family: 'openai' }], status: 'ok', findings: [] });
    expect(reviewers(parse(tag()))).toEqual(['claude-sonnet']);
    expect(reviewers(parse(tag('claude-opus')))).toEqual([freshOpus]);
    expect(reviewers(parse(tag('grok-overflow')))).toEqual(['claude-opus']);
  });
  it.each(['claude-opus', 'claude-sonnet', 'codex', 'codex-xhigh', 'grok-overflow'])('carries freshness only for known Claude builders: %s', model => {
    expect(reviewers(parse(tag(model))).some(entry => entry.fresh_session === true)).toBe(routing.pools[model].family === 'claude');
  });
  it('falls back safely for a Jev builder without a route', () => {
    const result = parse(tag('jev'));
    expect(result.status).toBe('ok');
    expect(reviewers(result)).toEqual(failSafe);
  });

  it('retains legacy model-only attribution as unknown', () => {
    const result = parse('Model: model:codex');
    expect(result.builders[0]).toEqual({ bot: 'unknown', model: 'model:codex', family: 'openai' });
    expect(result.status).toBe('unknown');
    expect(reviewers(result)).toEqual(failSafe);
  });
  it('retains Codex then Opus repair (#845) and requests both', () => {
    const result = parse(`${tag()}; bot=architect model=model:claude-opus`);
    expect(result.status).toBe('mixed');
    expect(result.builders.map(builder => builder.model)).toEqual(['model:codex', 'model:claude-opus']);
    expect(reviewers(result)).toEqual(failSafe);
    expect(reviewers(result)).not.toContain('codex-xhigh');
  });
  it('lets trailers override body bot attribution and model conflicts stay fail-safe', () => {
    const commits = [{ sha: 'a', message: `Repair\n\n${tag('codex', 'architect')}` }];
    expect(parse(tag(), { commits }).builders[0].bot).toBe('architect');
    expect(parse(tag(), { commits }).status).toBe('ok');
    const result = parse(tag('grok-overflow'), { commits });
    expect(result.status).toBe('conflict');
    expect(result.builders[0].model).toBe('model:codex');
    expect(reviewers(result)).toEqual(failSafe);
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
  it('conflicts when full trailer coverage omits a builder the body declares', () => {
    const mixedBody = `${tag()}; bot=architect model=model:claude-opus`;
    const codex = { sha: 'a', message: `Build\n\n${tag()}` };
    const more = { sha: 'c', message: `More\n\n${tag()}` };
    const opus = { sha: 'b', message: `Repair\n\n${tag('claude-opus', 'architect')}` };
    // Declared Codex build plus Opus repair, but every trailer names Codex: the Opus repair would get same-family review.
    const onlyCodex = parse(mixedBody, { commits: [codex, more] });
    expect(onlyCodex.status).toBe('conflict');
    expect(onlyCodex.findings).toContain('Commit trailer model disagrees with body');
    expect(reviewers(onlyCodex)).toEqual(failSafe);
    // The same body squashed into one commit trailered Opus: the Codex build would get same-family review.
    const onlyOpus = parse(mixedBody, { commits: [opus] });
    expect(onlyOpus.status).toBe('conflict');
    expect(reviewers(onlyOpus)).toEqual(failSafe);
    // A middle builder that no trailer names is also a gap.
    const threeStep = `${mixedBody}; ${tag()}`;
    expect(parse(threeStep, { commits: [codex, more] }).status).toBe('conflict');
    // Trailers that cover the whole declared history still agree and stay mixed, even under a different bot.
    const agree = parse(mixedBody, { commits: [codex, opus] });
    expect(agree.status).toBe('mixed');
    expect(reviewers(agree)).toEqual(failSafe);
    expect(parse(tag(), { commits: [codex, more] }).status).toBe('ok');
  });
  it('does not narrow review when only some commits carry a trailer and the body has no history', () => {
    const commits = [{ sha: 'a', message: `Build\n\n${tag()}` }, { sha: 'b', message: 'untagged follow-up' }];
    const result = parse('', { commits });
    expect(result.status).toBe('unknown');
    expect(result.findings).toContain('Commit without Built-by trailer and no body history');
    expect(reviewers(result)).toEqual(failSafe);
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
    expect(reviewers(disagree)).toEqual(failSafe);
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
    // Only this existing row's expected status changes: free text is now accepted.
    ['existing free text', 'Built-by: Engineer / Codex (gpt via codex exec, ChatGPT plan)', {}, 'ok'],
    ['unauthorized builder', tag('codex', 'qa'), {}, 'unknown'],
    ['partial garbage', `${tag()}; nonsense`, {}, 'unknown'],
  ])('%s requests both pools', (_name, body, options, status) => {
    const result = parse(body, options);
    expect(result.status).toBe(status);
    if (status === 'ok') {
      expect(result.findings).toEqual([]);
      expect(reviewers(result)).toEqual(['claude-sonnet']);
    } else {
      if (status !== 'missing') expect(result.findings.length).toBeGreaterThan(0);
      expect(reviewers(result)).toEqual(failSafe);
    }
  });
  it('never throws on internal errors', () => {
    const throwing = new Proxy({}, { get() { throw new Error('test'); } });
    const result = parse(tag(), { routing: throwing });
    expect(result.status).toBe('unknown');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(reviewers(result)).toEqual(failSafe);
    expect(reviewFamilies(parse(tag()), { routing: throwing, extra: ['claude-opus'] })).toEqual([...failSafe, 'claude-opus']);
    expect(parseBuiltBy(throwing).status).toBe('unknown');
  });
});

describe('fail-safe reviewer selection', () => {
  it('handles garbage input and missing or failed routing', () => {
    for (const value of [null, undefined, {}, 'ok', [], { status: 'ok', builders: [] }]) {
      expect(reviewers(value)).toEqual(failSafe);
    }
    expect(reviewFamilies(parse(tag()))).toEqual(failSafe);
    expect(reviewFamilies(parse(tag()), { routing: null })).toEqual(failSafe);
    expect(reviewFamilies(null, null)).toEqual(failSafe);
  });
  it('queues if no required pool is available, preserving extras', () => {
    expect(reviewFamilies(null, { routing, available: [], extra: ['claude-opus'] })).toEqual(['queue', 'claude-opus']);
    expect(reviewFamilies(parse(tag()), { routing, available: ['codex-xhigh'] })).toEqual(['queue']);
    expect(reviewFamilies(null, { routing, available: ['codex-xhigh'] })).toEqual(['queue']);
    expect(reviewFamilies(parse(tag('claude-opus')), { routing, available: ['claude-opus'] })).toEqual([freshOpus]);
    expect(reviewFamilies(parse(tag('claude-opus')), { routing, available: ['codex-xhigh'] })).toEqual(['queue']);
    for (const pool of ['claude-opus', 'claude-sonnet']) {
      expect(reviewFamilies(null, { routing, available: [pool] })).toEqual(failSafe);
    }
  });
  it('queues unsafe Codex extras when Claude built or may have built', () => {
    for (const parsed of [null, parse(tag('claude-opus')), parse(`${tag()}; bot=architect model=model:claude-opus`)]) {
      const malformed = { reviewer: 'codex-xhigh', fresh_session: 'true' };
      const result = reviewFamilies(parsed, { routing, extra: ['codex-xhigh', { reviewer: 'openai' }, malformed, 'claude-sonnet'] });
      expect(result).toContain('queue');
      expect(result).toContain('claude-sonnet');
      expect(result).not.toContain('codex-xhigh');
      expect(result).not.toContainEqual({ reviewer: 'openai' });
      expect(result).not.toContainEqual(malformed);
    }
    expect(reviewFamilies(parse(tag()), { routing, extra: ['codex-xhigh'] })).toEqual(['claude-sonnet', 'codex-xhigh']);
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

describe('review dispatch evidence', () => {
  const evidence = { reviewer: 'claude-opus', session_id: 'review-session', no_persistence: true,
    builder_session_ids: ['build-1', 'build-2'], inherited_transcript: false };
  it('accepts a fresh independent review and ordinary cross-family dispatch', () => {
    expect(() => assertReviewDispatch(freshOpus, evidence)).not.toThrow();
    expect(() => assertReviewDispatch('claude-sonnet', { reviewer: 'claude-sonnet' })).not.toThrow();
  });
  it('rejects missing records, mismatched reviewers, and queue dispatch', () => {
    for (const value of [undefined, null, {}, { ...evidence, reviewer: 'claude-sonnet' }]) {
      expect(() => assertReviewDispatch(freshOpus, value)).toThrow();
    }
    expect(() => assertReviewDispatch('queue', { reviewer: 'queue' })).toThrow();
  });
  it.each(['session_id', 'no_persistence', 'builder_session_ids', 'inherited_transcript'])('requires explicit %s evidence', field => {
    const missing = { ...evidence };
    delete missing[field];
    expect(() => assertReviewDispatch(freshOpus, missing)).toThrow();
  });
  it.each([
    ['session_id', ''], ['session_id', ' '], ['session_id', 1], ['session_id', null],
    ['no_persistence', false], ['no_persistence', 'true'], ['no_persistence', 1], ['no_persistence', null],
    ['inherited_transcript', true], ['inherited_transcript', 'false'], ['inherited_transcript', null],
    ['builder_session_ids', []], ['builder_session_ids', null], ['builder_session_ids', 'build-1'],
    ['builder_session_ids', ['']], ['builder_session_ids', [null]], ['builder_session_ids', new Array(1)],
    ['builder_session_ids', ['review-session']], ['builder_session_ids', ['build-1', 'review-session']],
    ['builder_session_ids', [' review-session ']],
  ])('rejects malformed or unsafe %s: %j', (field, value) => {
    expect(() => assertReviewDispatch(freshOpus, { ...evidence, [field]: value })).toThrow();
  });
});

describe('report-only CLI', () => {
  it('emits fresh-session requirements for Claude builds and fail-safe reports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ovd-fresh-cli-'));
    try {
      const body = join(directory, 'body.txt');
      for (const model of ['claude-opus', 'codex', 'grok-overflow', 'unlisted']) {
        writeFileSync(body, tag(model));
        const child = spawnSync(process.execPath, ['scripts/agent-graph/built-by.mjs', '--body', body, '--json'], { encoding: 'utf8' });
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout).reviewers).toEqual(reviewers(parse(tag(model))));
      }
    } finally { rmSync(directory, { recursive: true }); }
  });
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
        if (output.status === 'unknown') {
          expect(output.findings.length).toBeGreaterThan(0);
          expect(output.reviewers).toEqual(failSafe);
        }
        else expect(output.status).toBe('ok');
      }
      const source = readFileSync(new URL('./built-by.mjs', import.meta.url), 'utf8');
      expect(source).not.toMatch(/check[-_]runs|createCheckRun|createCommitStatus|\/statuses|fetch\(|https?:|execSync|spawn\(/i);
      expect(source).not.toMatch(/writeFile|appendFile|process\.exit\(/);
    } finally { rmSync(directory, { recursive: true }); }
  });
});


describe('free-text Built-by form', () => {
  it('retains the first family token and routes the safe-build form', () => {
    const result = parse('Built-by: Engineer / codex via safe-build (host)');
    expect(result).toEqual({ builders: [{ bot: 'engineer', model: 'model:codex', family: 'openai', token: 'codex' }], status: 'ok', findings: [] });
    expect(reviewers(result)).toEqual(['claude-sonnet']);
  });
  it('routes the real #848 grok form', () => {
    const result = parse('Built-by: Engineer / grok-4.7 via Cursor cloud agent');
    expect(result.status).toBe('ok');
    expect(result.builders[0].family).toBe('grok');
    expect(reviewers(result)).toEqual(['claude-opus']);
  });
  it.each([
    ['  built-by:   eNgInEeR   /   CoDeX, via safe-build (host)  ', 'engineer', 'CoDeX', 'codex'],
    ['BUILT-BY: Cursor Cloud / GPT-5 via agent', 'cursor-cloud', 'GPT-5', 'codex'],
    ['Built-by: engineer / openai', 'engineer', 'openai', 'codex'],
    ['Built-by: Engineer / sonnet', 'engineer', 'sonnet', 'claude-sonnet'],
    ['Built-by: Engineer / claude', 'engineer', 'claude', 'claude-sonnet'],
    ['Built-by: Engineer / opus', 'engineer', 'opus', 'claude-opus'],
    ['Built-by: Engineer / claude-opus', 'engineer', 'claude-opus', 'claude-opus'],
    ['Built-by: Engineer / jev', 'engineer', 'jev', 'jev'],
    ['Built-by: Engineer / GPT-5.1, via safe-build (host)', 'engineer', 'GPT-5.1', 'codex'],
    ['Built-by: Engineer / codex. via safe-build', 'engineer', 'codex', 'codex'],
    ['Built-by: Engineer / codex via safe-build (host/ci+gpt, opus)', 'engineer', 'codex', 'codex'],
    // Context naming the token's own family is still one builder (#824's lines, one at a time).
    ['Built-by: Engineer / gpt-6-astra via Codex CLI (codex-safe, Workstation) for the Oct 17 repair round',
      'engineer', 'gpt-6-astra', 'codex'],
    ['Built-by: Engineer / claude-sonnet-5-5 via Claude Code for the Oct 20 repair', 'engineer', 'claude-sonnet-5-5', 'claude-sonnet'],
    ['Built-by: Engineer / opus via Claude Code', 'engineer', 'opus', 'claude-opus'],
    ['Built-by: Engineer / gpt-5-codex via OpenAI agent', 'engineer', 'gpt-5-codex', 'codex'],
  ])('accepts %s', (body, bot, token, pool) => {
    const result = parse(body);
    expect(result.status).toBe('ok');
    expect(result.builders[0]).toEqual({ bot, token, model: `model:${pool}`, family: routing.pools[pool].family });
  });
  it.each([
    'Built-by: Jev', 'Built-by: Engineer /', 'Built-by: Engineer',
    'Built-by: Engineer /   ', 'Built-by: garbage', 'Built-by: Engineer / mystery',
    'Built-by: / codex',
    'Built-by: Engineer / Codex (...) + grok-4.7 via Cursor cloud agent',
    'Built-by: Engineer / Codex (...), grok-4.7 via Cursor cloud agent',
    'Built-by: Engineer / Codex, grok-4.7 via Cursor cloud agent',
    // A second builder glued to the first token or hidden behind later words.
    'Built-by: Engineer / codex+opus',
    'Built-by: Engineer / codex,opus',
    'Built-by: Engineer / codex/opus',
    'Built-by: Engineer / codex, Architect / claude-opus',
    'Built-by: Engineer / codex + Architect / opus repair',
    'Built-by: Engineer / codex via safe-build (host) + Architect / claude-opus',
    'Built-by: Engineer / codex, Architect repaired it',
    'Built-by: Engineer / codex, then cursor-cloud finished',
    'Built-by: Engineer / codex via ci/cd',
    // Another family after any glue, not only "+", "/" or ",".
    'Built-by: Engineer / codex.opus',
    'Built-by: Engineer / codex:opus',
    'Built-by: Engineer / codex_opus',
    'Built-by: Engineer / codex\\opus',
    'Built-by: Engineer / codex\u2013opus',
    'Built-by: Engineer / codex & opus',
    'Built-by: Engineer / codex | opus',
    'Built-by: Engineer / codex -> opus',
    'Built-by: Engineer / codex and opus',
    'Built-by: Engineer / codex then claude-opus repair',
    'Built-by: Engineer / codex with Opus repair',
    'Built-by: Engineer / gpt-6-astra via Codex CLI (codex-safe, Workstation) for the Oct 17 repair round and claude-sonnet-5-5 for the Oct 20 repair',
    'Built-by: Engineer / claude-sonnet then gpt-5 finished',
    'Built-by: Engineer / grok-4.7 then jev',
    // Another family inside the token itself.
    'Built-by: Engineer / codex-opus',
    'Built-by: Engineer / gpt-5-claude',
    'Built-by: Engineer / codexopus',
    'Built-by: Engineer / opus-grok-4.7',
    'Built-by: Engineer / codex\nBuilt-by: Engineer / grok-4.7',
    `Built-by: Engineer / codex\n${tag()}`,
  ])('fails safe for %s', body => {
    const result = parse(body);
    expect(result.status).toBe('unknown');
    expect(result.findings.length).toBeGreaterThan(0);
    expect(reviewers(result)).toEqual(failSafe);
  });
  it('preserves unknown bot names for the existing finding', () => {
    const result = parse('Built-by: Strange Bot / codex');
    expect(result.builders[0].bot).toBe('strange-bot');
    expect(result.findings).toContain('Unknown bot: strange-bot');
    expect(reviewers(result)).toEqual(failSafe);
  });
  it('requires the mapped pool to exist', () => {
    const pools = { ...routing.pools };
    delete pools.codex;
    const result = parse('Built-by: Engineer / codex', { routing: { ...routing, pools } });
    expect(result.status).toBe('unknown');
    expect(reviewers(result)).toEqual(failSafe);
  });
  it('preserves canonical bot=... model=... parsing unchanged', () => {
    expect(parse(tag())).toEqual({ builders: [{ bot: 'engineer', model: 'model:codex', family: 'openai' }], status: 'ok', findings: [] });
  });
  it('reads the free-text form in commit trailers and still gates partial attribution', () => {
    const trailer = 'Build\n\nBuilt-by: Engineer / codex via safe-build (host)';
    const commits = [{ sha: 'a', message: trailer }];
    const result = parse('', { commits });
    expect(result.status).toBe('ok');
    expect(result.builders[0]).toMatchObject({ bot: 'engineer', model: 'model:codex', token: 'codex' });
    expect(reviewers(result)).toEqual(['claude-sonnet']);
    const partial = parse('', { commits: [...commits, { sha: 'b', message: 'untagged follow-up' }] });
    expect(partial.status).toBe('unknown');
    expect(reviewers(partial)).toEqual(failSafe);
  });
  it('parses hostile free-text input in linear time and fails safe', () => {
    const started = performance.now();
    for (const body of [
      `Built-by: Engineer / ${'('.repeat(50_000)}codex`,
      `Built-by: ${'/ '.repeat(50_000)}`,
      `Built-by: Engineer / codex ${', '.repeat(50_000)}grok`,
      `Built-by: Engineer / ${' '.repeat(50_000)}x`,
      `Built-by: Engineer / codex${'+'.repeat(50_000)}`,
    ]) {
      expect(reviewers(parse(body))).toEqual(failSafe);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('scans boundary-free keyword lookalikes after a comma in linear time', () => {
    const started = performance.now();
    const result = parse(`Built-by: Engineer / codex, ${'xgpt qax '.repeat(50_000)}`);
    expect(result.status).toBe('ok');
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('scans other-family keyword lookalikes without a comma in linear time', () => {
    const started = performance.now();
    const result = parse(`Built-by: Engineer / claude ${'xgpt xopus-codexy '.repeat(50_000)}`);
    expect(result.status).toBe('ok');
    expect(reviewers(parse(`Built-by: Engineer / claude ${'xgpt '.repeat(50_000)}gpt`))).toEqual(failSafe);
    expect(reviewers(parse(`Built-by: Engineer / claude${'-x'.repeat(50_000)}gpt`))).toEqual(failSafe);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
