import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseExactJson, resolveGitExecutable, runChild, runtimeProbeArgs, runtimeProbeDiagnostics, suites, validateResult, validateRuntimeProbe } from './native-companion-inert-ci.mjs';

function receipt(suite) {
  return { schema: suite[1], [suite[2]]: 1, passed: true, network: false, nativeActions: 0,
    disk: suite[0] === 'test-output-replay.ps1', credentialFiles: false, windowsQualified: false,
    dpapiQualified: false, powershell: '5.1.26100.9549' };
}
function execution(value) { return { exitCode: 0, signal: null, failure: null, stdout: JSON.stringify(value), stderr: '' }; }
for (const suite of suites) {
  test(`${suite[0]} requires exit success and independently valid inert JSON`, () => {
    const valid = receipt(suite);
    assert.deepEqual(validateResult(suite, execution(valid), valid.powershell), valid);
    for (const patch of [{ passed: false }, { passed: 'true' }, { network: true }, { nativeActions: 1 }, { [suite[2]]: 0 }, { schema: 'wrong' }]) {
      assert.throws(() => validateResult(suite, execution({ ...valid, ...patch }), valid.powershell));
    }
    for (const patch of [{ exitCode: 1 }, { failure: 'timeout' }, { signal: 'SIGKILL' }, { stdout: JSON.stringify(valid) + '\n{}' }, { stdout: 'noise\n' + JSON.stringify(valid) }]) {
      assert.throws(() => validateResult(suite, { ...execution(valid), ...patch }, valid.powershell));
    }
  });
}
test('skipped Windows disk branch and false runtime/qualification claims fail', () => {
  assert.throws(() => validateResult(suites[3], execution({ ...receipt(suites[3]), disk: false }), '5.1.26100.9549'));
  assert.throws(() => validateResult(suites[0], execution({ ...receipt(suites[0]), dpapiQualified: true })));
  assert.throws(() => validateResult(suites[1], execution({ ...receipt(suites[1]), credentialFiles: true })));
  assert.throws(() => validateResult(suites[2], execution(receipt(suites[2])), '7.5.0'));
});
test('real subprocess captures stdout/stderr and direct failing exit', async () => {
  const outcome = await runChild(process.execPath, ['-e', "process.stdout.write('receipt'); process.stderr.write('error'); process.exitCode=7"], { timeoutMs: 2_000 });
  assert.equal(outcome.exitCode, 7); assert.equal(outcome.stdout, 'receipt'); assert.equal(outcome.stderr, 'error');
});
test('real nonterminating subprocess has finite deadline', async () => {
  const outcome = await runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(outcome.failure, 'timeout');
});
test('real noisy subprocess is rejected with retained bounded output', async () => {
  const outcome = await runChild(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)"], { maxBytes: 1024, timeoutMs: 2_000 });
  assert.equal(outcome.failure, 'output_limit'); assert.equal(Buffer.byteLength(outcome.stdout), 1024);
});
test('missing executable is an explicit failed outcome', async () => {
  const outcome = await runChild('/nonexistent/overdrafter-fixture-binary', [], { timeoutMs: 500 });
  assert.equal(outcome.failure, 'spawn_error'); assert.equal(outcome.exitCode, null);
  assert.equal(outcome.spawned, false); assert.equal(outcome.spawnErrorCode, 'ENOENT');
  assert.deepEqual(outcome.firstOutputAfterMs, { stdout: null, stderr: null });
  assert.equal(runtimeProbeDiagnostics(outcome).lastObservedStage, 'command-entry-not-observed');
  assert.throws(() => validateRuntimeProbe(outcome));
});
test('duplicate or escaped-equivalent JSON keys cannot override a refusal', () => {
  assert.throws(() => parseExactJson('{"passed":false,"passed":true}'));
  assert.throws(() => parseExactJson('{"outer":[{"passed":false,"pass\\u0065d":true}]}'));
  assert.deepEqual(parseExactJson('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
});
test('invalid UTF-8 is failed and original bytes are retained', async () => {
  const outcome = await runChild(process.execPath, ['-e', 'process.stdout.write(Buffer.from([255]))'], { timeoutMs: 2_000 });
  assert.equal(outcome.failure, 'invalid_utf8'); assert.deepEqual(outcome.stdoutBytes, Buffer.from([255]));
});

test('explicit Git resolution refuses missing, relative, wrong-name and directory overrides without PATH fallback', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ovd-git-resolution-'));
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  try {
    const executable = path.join(root, name);
    assert.throws(() => resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: executable, PATH: process.env.PATH } }));
    assert.throws(() => resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: name } }));
    assert.throws(() => resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: '' } }));
    assert.throws(() => resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: path.join(root, 'unrelated') } }));
    mkdirSync(executable);
    assert.throws(() => resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: executable } }));
    rmdirSync(executable);
    writeFileSync(executable, 'inert path-selection fixture; never executed');
    assert.equal(resolveGitExecutable({ env: { OVD_GIT_EXECUTABLE: executable, PATH: '/untrusted/ignored' } }), executable);
    assert.throws(() => resolveGitExecutable({ platform: 'win32', env: { OVD_GIT_EXECUTABLE: 'C:git.exe' } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fixed absolute Git resolution runs Git without depending on PATH', async () => {
  const git = resolveGitExecutable({ env: { PATH: '/untrusted/ignored' } });
  assert.ok(path.isAbsolute(git));
  const result = await runChild(git, ['--version'], { timeoutMs: 2_000 });
  assert.equal(result.failure, null); assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^git version \d/);
});

const desktopRuntime = { edition: 'Desktop', version: '5.1.26100.9549', major: 5, minor: 1, x64: true };
test('probe preserves exit and entered-stage diagnostics without accepting runtime JSON on failing exit', async () => {
  const result = await runChild(process.execPath, ['-e',
    `process.stderr.write('OVD_PROBE:entered\\n'); process.stdout.write(${JSON.stringify(JSON.stringify(desktopRuntime))}); process.exitCode=7;`], { timeoutMs: 2_000 });
  const diagnostic = runtimeProbeDiagnostics(result);
  assert.equal(diagnostic.lastObservedStage, 'entered'); assert.equal(diagnostic.exitCode, 7);
  assert.equal(diagnostic.spawned, true); assert.equal(diagnostic.spawnErrorCode, null);
  assert.ok(result.elapsedMs >= 0); assert.ok(Number.isFinite(result.spawnedAfterMs) && result.spawnedAfterMs >= 0);
  assert.ok(Number.isFinite(result.firstOutputAfterMs.stderr) && result.firstOutputAfterMs.stderr >= 0);
  assert.throws(() => validateRuntimeProbe(result));
});

test('probe timeout retains the last observed stage and bounded streams', async () => {
  const result = await runChild(process.execPath, ['-e',
    "process.stderr.write('OVD_PROBE:entered\\nOVD_PROBE:runtime-collected\\n'); setInterval(()=>{},1000);"], { timeoutMs: 1_000 });
  assert.equal(result.failure, 'timeout'); assert.equal(result.timeoutMs, 1_000);
  assert.equal(runtimeProbeDiagnostics(result).lastObservedStage, 'runtime-collected');
  assert.ok(result.elapsedMs >= 1_000); assert.ok(result.elapsedMs < 5_000);
  assert.equal(result.stdoutBytes.length, 0); assert.ok(result.stderrBytes.length < result.maxBytes);
  assert.throws(() => validateRuntimeProbe(result));
});

test('runtime acceptance remains exact despite diagnostic markers or successful exit', () => {
  assert.deepEqual(validateRuntimeProbe(execution(desktopRuntime)), desktopRuntime);
  for (const value of [{ ...desktopRuntime, major: 7 }, { ...desktopRuntime, edition: 'Core' },
    { ...desktopRuntime, minor: 0 }, { ...desktopRuntime, x64: false }]) {
    assert.throws(() => validateRuntimeProbe(execution(value)));
  }
  for (const stdout of ['noise', JSON.stringify(desktopRuntime) + '\n{}', '{"major":7,"major":5}']) {
    assert.throws(() => validateRuntimeProbe({ ...execution(desktopRuntime), stdout, stderr: 'OVD_PROBE:json-written\n' }));
  }
  assert.deepEqual(runtimeProbeArgs.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(!runtimeProbeArgs.includes('-ExecutionPolicy'));
});
