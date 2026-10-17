// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary, resolveGhBin } from './emit-verdict.mjs';
import { isInfraFailure, decideRerun } from './ci-rerun-once.mjs';
const script = resolve('scripts/ci-rerun-once.mjs');
const sha = 'a'.repeat(40), dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rerun-')); dirs.push(dir);
  const state = { head: sha, runs: [{ databaseId: 42, attempt: 1, conclusion: 'failure', status: 'completed' }], log: 'runner lost communication', ...overrides };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const file = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args)+'\\n');
if (args[0] === 'pr') fs.writeSync(1,JSON.stringify({headRefOid:state.head}));
else if (args[1] === 'list') fs.writeSync(1,JSON.stringify(state.runs));
else if (args[1] === 'view') fs.writeSync(1,typeof state.log === 'string' ? state.log : state.log[args[2]]);
else if (args[1] === 'rerun') { state.runs.find(r=>String(r.databaseId)===args[2]).attempt++; fs.writeFileSync(file,JSON.stringify(state)); }
else process.exit(1);
`, { mode: 0o755 });
  const runWithBin = (ghBin, ...args) => {
    const out = join(dir, 'stdout'), err = join(dir, 'stderr');
    const fds = [openSync(out, 'w'), openSync(err, 'w')];
    const result = spawnSync(process.execPath, [script, '--pr', '936', '--sha', sha, '--log', join(dir, 'audit.jsonl'), ...args], { stdio: ['ignore', ...fds], env: { PATH: process.env.PATH, GH_BIN: ghBin } });
    fds.forEach(closeSync);
    return { status: result.status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
  };
  const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, run: (...args) => runWithBin(join(dir, 'gh'), ...args), runWithBin, calls };
}
test.each(['429', 'Rate Limit', 'runner lost', 'The runner has received a shutdown signal', 'lost communication', 'unexpected EOF'])('classifies %s', text => expect(isInfraFailure(text)).toBe(true));
test('code logs and empty failures refuse', () => {
  expect(isInfraFailure('preflight: test FAIL')).toBe(false);
  expect(decideRerun(sha, sha, [], {})).toBe('not-infra');
});
test('separate processes share GitHub attempt state; refusal preserves failure', () => {
  const { dir, run, calls } = fixture();
  const first = run(); expect({ status: first.status, out: first.stdout, err: first.stderr }).toEqual({ status: 0, out: 'rerun-cap: rerun 42\n', err: '' }); const before = calls().filter(call => call[1] === 'rerun').length;
  const second = run(); expect(second.status).toBe(3); expect(second.stdout).toContain('refused (cap-reached)');
  expect(calls().filter(call => call[1] === 'rerun')).toHaveLength(before);
  expect(JSON.parse(readFileSync(join(dir, 'state.json'))).runs[0].conclusion).toBe('failure');
  expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});
test.each([
  [{ runs: [{ databaseId: 42, attempt: 2, conclusion: 'failure' }] }, 'cap-reached'],
  [{ head: 'b'.repeat(40) }, 'not-head'],
  [{ log: 'preflight: test FAIL' }, 'not-infra'],
  [{ runs: [{ databaseId: 42, attempt: 1, conclusion: 'cancelled' }] }, 'not-infra'],
  [{ runs: [{ databaseId: 42, attempt: 1, conclusion: 'failure' }, { databaseId: 43, attempt: 1, conclusion: 'failure' }], log: 'code failure' }, 'not-infra'],
])('refuses without mutation: %s', (state, reason) => {
  const { run, calls, dir } = fixture(state);
  const before = readFileSync(join(dir, 'state.json'), 'utf8');
  const result = run(); expect(result.status).toBe(3); expect(result.stdout).toContain(`refused (${reason})`);
  expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
  expect(calls().every(call => call[0] === 'pr' || ['list', 'view'].includes(call[1]))).toBe(true);
});
test('usage exits 2 and source permits only rerun mutations', () => {
  expect(spawnSync('node', [script], { encoding: 'utf8' }).status).toBe(2);
  const source = readFileSync(script, 'utf8');
  expect(source).not.toMatch(/gh api|check-runs|statuses|neutral|skipped|success|cancel/i);
});

test('every failed run must be infra before any rerun; cap applies to any run', () => {
  const runs = [{ databaseId: 42, attempt: 1, conclusion: 'failure' }, { databaseId: 43, attempt: 1, conclusion: 'timed_out' }];
  const { run, calls } = fixture({ runs, log: { 42: '429', 43: 'preflight: test FAIL' } });
  expect(run().status).toBe(3);
  expect(calls().some(call => call[1] === 'rerun')).toBe(false);
  expect(decideRerun(sha, sha, [...runs, { attempt: 2 }], {})).toBe('cap-reached');
});
test('reruns each eligible failed run once and excludes cancelled runs', () => {
  const runs = ['failure', 'timed_out', 'startup_failure', 'cancelled'].map((conclusion, i) => ({ databaseId: 42 + i, attempt: 1, conclusion }));
  const { run, calls } = fixture({ runs });
  expect(run().status).toBe(0);
  expect(calls().filter(call => call[1] === 'rerun').map(call => call[2])).toEqual(['42', '43', '44']);
});

test('unset GH_BIN searches only fixed directories, ignoring a PATH-only fake', () => {
  const { dir } = fixture();
  const searched = [];
  expect(() => resolveGhBin({ PATH: dir }, {
    lookup: name => resolveBinary(name, { exists: candidate => { searched.push(candidate); return false; } }),
  })).toThrow();
  expect(searched).toEqual(['/usr/bin/gh', '/bin/gh', '/usr/local/bin/gh']);
});

test('invalid GH_BIN fails closed without exposing its value', () => {
  const { runWithBin, dir } = fixture();
  const result = runWithBin(join(dir, 'missing-gh'));
  expect(result).toEqual({ status: 3, stdout: 'rerun-cap: refused (gh-error)\n', stderr: '' });
  expect(JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8'))).toMatchObject({ decision: 'refused', reason: 'gh-error', runs: [] });
});
