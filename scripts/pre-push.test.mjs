// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import ts from 'typescript';
const root = resolve('.');
// Every test here runs the real pre-push.sh in a fresh git fixture, which spawns bash, git and
// two Node + TypeScript validator processes per run. That is about 2 s of work per test without extra
// load, but it took up to about 10 s and hit the 5 s vitest default on loaded runners, so allow
// headroom rather than weakening any assertion (OVD-1021).
vi.setConfig({ testTimeout: 30_000 });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
// Repo-relative files reachable from `entries` through relative imports. The TypeScript scanner
// ignores comments and strings and sees static, re-export and dynamic imports alike.
function relativeImportClosure(entries) {
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (fileName.startsWith('.')) queue.push(relative(root, resolve(root, dirname(file), fileName)));
    }
  }
  return [...seen].sort();
}
// The bash array that pre-push.sh copies from the base ref.
function copiedFromBase(name) {
  const match = readFileSync(join(root, 'scripts/pre-push.sh'), 'utf8').match(new RegExp(`^${name}=\\(([^)]*)\\)$`, 'm'));
  if (!match) throw new Error(`pre-push.sh no longer defines ${name}`);
  return match[1].trim().split(/\s+/);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-')); dirs.push(dir);
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'bin'));
  for (const file of ['scripts/pre-push.sh', 'scripts/preflight.sh', 'scripts/verdict-schema.mjs', ...relativeImportClosure(['scripts/validate-pr-body.mjs'])]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
  }
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  // preflight.sh stops before its test stage unless the worker install matches the worker lockfile.
  mkdirSync(join(dir, 'worker/node_modules'), { recursive: true });
  for (const file of ['worker/package-lock.json', 'worker/node_modules/.package-lock.json']) writeFileSync(join(dir, file), '{"packages":{}}');
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

test('every relative import reachable from the base-copied gate scripts is itself copied', () => {
  const copied = [...copiedFromBase('gate_files'), ...copiedFromBase('gate_optional_files')];
  const reachable = relativeImportClosure(copied);
  // Pin known edges so a scanner regression cannot turn this into an empty comparison.
  expect(reachable).toEqual(expect.arrayContaining(['scripts/validate-pr-body.mjs', 'scripts/provider-enablement-detect.mjs', 'scripts/lib/entry-point.mjs']));
  expect(reachable.filter(file => !copied.includes(file)), 'imported by a base-copied script but missing from pre-push.sh').toEqual([]);
  for (const file of copied) expect(existsSync(join(root, file)), `${file} is listed in pre-push.sh`).toBe(true);
});
test('a base that predates the entry-point helper still runs the gate', () => {
  const { dir, git, run } = fixture();
  const validator = join(dir, 'scripts/validate-pr-body.mjs');
  const current = readFileSync(validator, 'utf8');
  const legacy = current.replace(/^import \{ isEntryPoint \} from "\.\/lib\/entry-point\.mjs";\n/m, 'const isEntryPoint = () => true;\n');
  expect(legacy).not.toBe(current);
  writeFileSync(validator, legacy);
  git('rm', '-q', 'scripts/lib/entry-point.mjs'); git('add', 'scripts'); git('commit', '-qm', 'base before the helper'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = run('--body', 'body.md');
  expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('pre-push: pr-body-gate PASS');
});
test('a base validator that imports a helper the base lacks fails closed', () => {
  const { git, run } = fixture();
  git('rm', '-q', 'scripts/lib/entry-point.mjs'); git('commit', '-qm', 'base lost the helper'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1); expect(result.stdout).toContain('pre-push: pr-body-gate FAIL (validation failed)');
});
test('head-side entry-point helper cannot replace the base helper', () => {
  const { dir, git, run } = fixture();
  writeFileSync(join(dir, 'scripts/lib/entry-point.mjs'), 'console.log("HEAD HELPER RAN");\nexport const isEntryPoint = () => true;\n');
  git('add', 'scripts'); git('commit', '-qm', 'adversarial helper edit');
  const result = run('--body', 'body.md');
  expect(result.status).toBe(1); expect(result.stdout).toContain('pre-push: pr-body-gate FAIL');
  expect(result.stdout + result.stderr).not.toContain('HEAD HELPER RAN');
});
