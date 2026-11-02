// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBinary, resolveGhBin } from './emit-verdict.mjs';
import { isInfraFailure, decideRerun } from './ci-rerun-once.mjs';
const script = resolve('scripts/ci-rerun-once.mjs');
const sha = 'a'.repeat(40), dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
// `gh run view --log-failed` prefixes each line with `<job>\t<step>\t<timestamp> `. Real timestamps
// have seven fractional digits, and the first line of a step starts with a BOM.
const logLine = (text, { job = 'test', step = 'Run tests', ts = '2026-10-20T04:43:55.2429429Z' } = {}) => `${job}\t${step}\t${ts} ${text}`;
const logOf = (...lines) => lines.map(line => (typeof line === 'string' ? logLine(line) : logLine(...line))).join('\n');
const SHUTDOWN = '##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.';
const INFRA_LOG = logOf(['##[group]Run bash scripts/preflight.sh test', { ts: '\uFEFF2026-10-20T04:43:51.1132377Z' }], SHUTDOWN);
// Modeled on real failed runs 39370478752 and 39051893521: code failures whose logs hold "429" in
// timestamps and passing test names that mention 429, a rate limit and toomanyrequests.
const CODE_LOG = logOf(
  ['>>> Quoting xometry qty 1...', { ts: '2026-10-20T04:43:55.2429429Z' }],
  ' ✓ retries a request on 403, 429 and 503 (4ms)',
  ' ✓ treats a provider reply as a rate limit and backs off',
  'ok 122 - nonthrottle stderr fails after one attempt: toomanyrequests: Rate exceeded',
  '# Subtest: throttle on stderr is rate limited and retried: Error response from daemon: toomanyrequests: Data limit exceeded',
  '##[error]AssertionError: finish cell read CLASS 2 at -fixed 8: expected false to be true // Object.is equality',
  'preflight: test FAIL',
  '##[error]Process completed with exit code 1.',
);
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rerun-')); dirs.push(dir);
  const state = { head: sha, runs: [{ databaseId: 42, attempt: 1, conclusion: 'failure', status: 'completed' }], log: INFRA_LOG, ...overrides };
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
  const exec = (entry, ghBin, ...args) => {
    const out = join(dir, 'stdout'), err = join(dir, 'stderr');
    const fds = [openSync(out, 'w'), openSync(err, 'w')];
    const result = spawnSync(process.execPath, [entry, '--pr', '936', '--sha', sha, '--log', join(dir, 'audit.jsonl'), ...args], { stdio: ['ignore', ...fds], env: { PATH: process.env.PATH, GH_BIN: ghBin } });
    fds.forEach(closeSync);
    return { status: result.status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
  };
  const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const runWithBin = (ghBin, ...args) => exec(script, ghBin, ...args);
  return { dir, run: (...args) => runWithBin(join(dir, 'gh'), ...args), runWithBin, runVia: (entry, ...args) => exec(entry, join(dir, 'gh'), ...args), calls };
}
test.each([
  ['runner shutdown', logOf(SHUTDOWN)],
  ['runner shutdown, first line with BOM', logOf([SHUTDOWN, { ts: '\uFEFF2026-10-20T04:43:51.1132377Z' }])],
  ['hosted runner lost communication', logOf('The hosted runner: GitHub Actions 1000000123 lost communication with the server. Anything in your workflow that terminates the runner process can cause this error.')],
  ['self-hosted runner lost communication', logOf('##[error]The self-hosted runner: box-1 lost communication with the server. Verify the machine is running.')],
  ['npm 429', logOf('npm error 429 Too Many Requests - GET https://registry.npmjs.org/esbuild')],
  ['npm E429 code', logOf('npm error code E429')],
  ['ANSI-coloured npm 429', logOf('\u001b[31mnpm error\u001b[39m 429 Too Many Requests - GET https://registry.npmjs.org/esbuild')],
  ['git 429', logOf("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429")],
  ['GitHub API rate limit annotation', logOf('##[error]HttpError: API rate limit exceeded for installation ID 1')],
  ['secondary rate limit', logOf('##[error]You have exceeded a secondary rate limit. Please wait a few minutes before you try again.')],
  ['registry throttle (run 39049356550)', logOf('Error response from daemon: failed to copy: httpReadSeeker: failed open: unexpected status code https://public.ecr.aws/v2/supabase/postgres/manifests/sha256:0: 429 Too Many Requests - Server message: toomanyrequests: Data limit exceeded')],
  ['image-pull budget exhausted', logOf('##[error]postgres-image-pull: registry public.ecr.aws rate-limited after 5 attempts (budget 300s)')],
  ['truncated pull', logOf('error pulling image configuration: unexpected EOF')],
  ['unprefixed raw log line', '##[error]The runner has received a shutdown signal.'],
])('classifies infrastructure failure: %s', (_name, text) => expect(isInfraFailure(text)).toBe(true));
test.each([
  ['429 only inside 7-digit timestamps', logOf('>>> Quoting xometry qty 1...', 'Starting suite')],
  ['passing test names that mention 429 and a rate limit', logOf(' ✓ retries a request on 403, 429 and 503 (4ms)', ' ✓ treats a provider reply as a rate limit and backs off')],
  ['TAP test names that quote throttle messages (run 39051893546)', logOf('# Subtest: throttle on stderr is rate limited and retried: Error response from daemon: toomanyrequests: Data limit exceeded', 'ok 122 - nonthrottle stderr fails after one attempt: toomanyrequests: Rate exceeded')],
  ['vitest stdout mentioning 429 Too Many Requests', logOf('\u001b[90mstdout\u001b[2m | worker/src/retry.test.ts > retry > surfaces 429 Too Many Requests\u001b[22m')],
  ['test assertion about status 429', logOf('##[error]AssertionError: expected 200 to be 429')],
  ['realistic code failure (preflight: test FAIL)', CODE_LOG],
  ['PR body validation failure', logOf('PR body validation failed:', '- Verification: missing results', '##[error]Process completed with exit code 1.')],
  ['PR body validator without evidence (run 39051893521)', logOf('##[error]PR body validator exited successfully without validation evidence.')],
  ['empty log', ''],
  ['slow Ubuntu apt mirror', logOf('Get:1 http://azure.archive.ubuntu.com/ubuntu noble/main amd64 tesseract-ocr amd64 5.3.4-1build5 [2345 kB]', 'Fetched 9,743 kB in 3min 43s (45.6 kB/s)')],
  ['vitest default timeout on a real-module test', logOf('FAIL  scripts/pre-push.test.mjs > passes gate using real base modules', 'Test timed out in 5000ms')],
  ['job hit its cap', logOf('##[error]The job running on runner hosted has exceeded the maximum execution time of 20 minutes.')],
])('refuses code failure, never infrastructure: %s', (_name, text) => expect(isInfraFailure(text)).toBe(false));
test('a failed stage wins over an infrastructure signal in the same log', () => {
  expect(isInfraFailure(logOf(SHUTDOWN))).toBe(true);
  expect(isInfraFailure(logOf('preflight: typecheck FAIL', SHUTDOWN))).toBe(false);
  expect(isInfraFailure(logOf('npm error 429 Too Many Requests - GET https://registry.npmjs.org/esbuild', 'preflight: lint FAIL'))).toBe(false);
});
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
test('a realistic code-failure log is refused end to end without any rerun', () => {
  const { run, calls, dir } = fixture({ log: CODE_LOG });
  const result = run();
  expect({ status: result.status, out: result.stdout }).toEqual({ status: 3, out: 'rerun-cap: refused (not-infra)\n' });
  expect(calls().some(call => call[1] === 'rerun')).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8'))).toMatchObject({ decision: 'refused', reason: 'not-infra', runs: [42] });
});
test('usage exits 2 and source permits only rerun mutations', () => {
  expect(spawnSync('node', [script], { encoding: 'utf8' }).status).toBe(2);
  const source = readFileSync(script, 'utf8');
  expect(source).not.toMatch(/gh api|check-runs|statuses|neutral|skipped|success|cancel/i);
});

test('every failed run must be infra before any rerun; cap applies to any run', () => {
  const runs = [{ databaseId: 42, attempt: 1, conclusion: 'failure' }, { databaseId: 43, attempt: 1, conclusion: 'timed_out' }];
  const { run, calls } = fixture({ runs, log: { 42: INFRA_LOG, 43: CODE_LOG } });
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

// Node realpaths import.meta.url but leaves argv[1] as typed, so a symlinked caller used to skip
// main() and exit 0 with no gh call and no audit line, which reads as an accepted rerun.
function symlinked() {
  const dir = mkdtempSync(join(tmpdir(), 'rerun-link-')); dirs.push(dir);
  const link = join(dir, 'ci-rerun-link.mjs'), chain = join(dir, 'link-to-link.mjs');
  symlinkSync(script, link); symlinkSync(link, chain);
  return [link, chain];
}
test('runs main() when launched through a symlinked path: usage errors still exit 2', () => {
  for (const entry of [script, ...symlinked()]) {
    const result = spawnSync(process.execPath, [entry, '--bogus'], { encoding: 'utf8' });
    expect({ entry: entry.endsWith('.mjs'), status: result.status, usage: result.stderr.startsWith('Usage: node scripts/ci-rerun-once.mjs') }).toEqual({ entry: true, status: 2, usage: true });
  }
});
test('a rerun requested through a symlinked path reaches gh and writes the audit line', () => {
  for (const entry of symlinked()) {
    const { dir, runVia, calls } = fixture();
    const result = runVia(entry);
    expect({ status: result.status, out: result.stdout, err: result.stderr }).toEqual({ status: 0, out: 'rerun-cap: rerun 42\n', err: '' });
    expect(calls().filter(call => call[1] === 'rerun').map(call => call[2])).toEqual(['42']);
    expect(JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8'))).toMatchObject({ sha, pr: '936', decision: 'rerun', reason: null, runs: [42] });
  }
});
test('a refusal through a symlinked path exits 3 and is audited', () => {
  const [link] = symlinked();
  const { dir, runVia, calls } = fixture({ log: CODE_LOG });
  const result = runVia(link);
  expect({ status: result.status, out: result.stdout }).toEqual({ status: 3, out: 'rerun-cap: refused (not-infra)\n' });
  expect(calls().some(call => call[1] === 'rerun')).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8'))).toMatchObject({ decision: 'refused', reason: 'not-infra' });
});
