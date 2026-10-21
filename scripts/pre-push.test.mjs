// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
const root = resolve('.');
// Every test here runs the real pre-push.sh in a fresh git fixture, which spawns bash, git and
// two Node + TypeScript validator processes per run. That is about 2 s of work per test without extra
// load, but it took up to about 10 s and hit the 5 s vitest default on loaded runners, so allow
// headroom rather than weakening any assertion (OVD-1021).
vi.setConfig({ testTimeout: 30_000 });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-')); dirs.push(dir);
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'bin'));
  for (const file of ['pre-push.sh', 'preflight.sh', 'validate-pr-body.mjs', 'provider-enablement-detect.mjs', 'verdict-schema.mjs']) copyFileSync(join(root, 'scripts', file), join(dir, 'scripts', file));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('add', 'scripts'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(dir, 'body.md'), '');
  const run = (...args) => {
    const out = join(dir, 'stdout'), err = join(dir, 'stderr');
    const fds = [openSync(out, 'w'), openSync(err, 'w')];
    const result = spawnSync('bash', ['scripts/pre-push.sh', ...args], { cwd: dir, stdio: ['ignore', ...fds], env: { PATH: `${dir}/bin:${process.env.PATH}` } });
    fds.forEach(closeSync);
    return { status: result.status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
  };
  return { dir, git, run };
}
test('passes gate using real base modules and TypeScript; full validator only warns; usage exits 2', () => {
  const { run } = fixture();
  const result = run('--body', 'body.md');
  expect(result.status).toBe(0); expect(result.stdout).toContain('pre-push: pr-body-gate PASS');
  expect(result.stdout).toContain('pre-push: pr-body-full WARN');
  for (const args of [[], ['--body'], ['--body', 'body.md', '--skip-preflight']]) expect(run(...args).status).toBe(2);
});
test('head-side validator cannot bypass base validator', () => {
  const { dir, git, run } = fixture();
  writeFileSync(join(dir, 'scripts/validate-pr-body.mjs'), 'process.exit(0);');
  git('add', 'scripts'); git('commit', '-qm', 'adversarial gate edit');
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1); expect(result.stdout).toContain('pre-push: pr-body-gate FAIL');
});
test.each(['body file missing', 'origin/main missing', 'merge-base unreachable', 'base copy missing'])('%s fails closed', reason => {
  const { dir, git, run } = fixture();
  if (reason === 'body file missing') rmSync(join(dir, 'body.md'));
  if (reason === 'origin/main missing') git('update-ref', '-d', 'refs/remotes/origin/main');
  if (reason === 'merge-base unreachable') {
    git('checkout', '--orphan', 'unrelated'); git('commit', '--allow-empty', '-qm', 'unrelated');
  }
  if (reason === 'base copy missing') {
    git('rm', 'scripts/provider-enablement-detect.mjs'); git('commit', '-qm', 'missing base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1); expect(result.stdout).toContain(`pre-push: pr-body-gate FAIL (${reason})`);
});
test('all stages run and remaining checks report after failure; verdict must be valid and match HEAD', () => {
  const { dir, git, run } = fixture();
  const value = { schema: 'overdrafter.verdict/v1', role: 'verifier', verdict: 'PASS', sha: git('rev-parse', 'HEAD'), patch_id: 'a'.repeat(40), diff_id: 'b'.repeat(64), verifier: { id: 'fixture', model_family: 'codex', github_login: 'fixture' }, evidence: [{ kind: 'verify-run', url: 'https://example.com/test' }], notes: [], readiness: { conflicts: 0, open_threads: 0, checks: 'green' }, timestamp: '2026-01-01T00:00:00Z' };
  const save = () => writeFileSync(join(dir, 'verdict.md'), '```overdrafter-verdict\n' + JSON.stringify(value) + '\n```');
  save(); const valid = run('--body', 'body.md', '--verdict', 'verdict.md'); expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  // A PASS needs an https ci-run or verify-run (verdict-schema ruling 6); pre-push inherits that rule.
  value.evidence = [{ kind: 'test', url: 'https://example.com/test' }]; save();
  const testOnly = run('--body', 'body.md', '--verdict', 'verdict.md');
  expect(testOnly.status).toBe(1); expect(testOnly.stdout).toContain('pre-push: verdict FAIL');
  value.evidence = [{ kind: 'verify-run', url: 'https://example.com/test' }];
  value.sha = 'c'.repeat(40); save();
  writeFileSync(join(dir, 'bin/npm'), '#!/bin/sh\necho "stage $3"\nexit 1\n', { mode: 0o755 });
  const result = run('--body', 'body.md', '--verdict', 'verdict.md');
  expect(result.status).toBe(1);
  for (const stage of ['lint', 'typecheck', 'test']) expect(result.stdout).toContain(`preflight: ${stage} FAIL`);
  expect(result.stdout).toContain('pre-push: preflight FAIL'); expect(result.stdout).toContain('pre-push: pr-body-gate PASS'); expect(result.stdout).toContain('pre-push: verdict FAIL');
});

test('symlinked temporary directory still runs the validator for an empty body', () => {
  const { dir, git, run } = fixture();
  const physical = join(dir, 'physical');
  const linked = join(dir, 'linked');
  mkdirSync(physical);
  symlinkSync(physical, linked);
  mkdirSync(join(linked, 'scripts'));
  copyFileSync(join(dir, 'scripts/validate-pr-body.mjs'), join(linked, 'scripts/validate-pr-body.mjs'));
  writeFileSync(join(dir, 'bin/mktemp'), `#!/bin/sh\nprintf '%s\\n' '${linked}'\n`, { mode: 0o755 });
  // Changing the validator requires the strict gate even with an empty body.
  writeFileSync(join(dir, 'scripts/validate-pr-body.mjs'), '// changed validator\n');
  git('add', 'scripts'); git('commit', '-qm', 'validator change');
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('pre-push: pr-body-gate FAIL (validation failed)');
  expect(result.stdout).toContain('pre-push: pr-body-full WARN (validation failed)');
  expect(result.stdout).not.toContain('pre-push: pr-body-gate PASS');
});
test('base validator exiting zero without a pass line fails closed', () => {
  const { dir, git, run } = fixture();
  writeFileSync(join(dir, 'scripts/validate-pr-body.mjs'), 'console.log("validator output");\n');
  git('add', 'scripts'); git('commit', '-qm', 'silent success validator');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('pre-push: pr-body-gate FAIL (validation failed)');
  expect(result.stdout).toContain('pre-push: pr-body-full WARN (validation failed)');
  expect(result.stdout.match(/validator output/g)).toHaveLength(2);
});
