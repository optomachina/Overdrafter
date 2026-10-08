import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactJson, runChild, suites, validateResult } from './native-companion-inert-ci.mjs';

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
