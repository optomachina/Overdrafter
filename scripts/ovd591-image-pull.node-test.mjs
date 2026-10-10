/** Offline registry error handling only. No Docker, image download, or SQL execution. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMAGE } from './ovd591-sql-qualification.mjs';
import { PLATFORMS } from './free-quote-platform-sources.mjs';
import { isPublicEcrThrottle, pullFixtureImage } from './ovd591-image-pull.mjs';

const ok = { status: 0, stdout: 'synthetic pull receipt', stderr: '', failure: null };
const throttle = { status: 1, stdout: '', stderr: 'Error response from daemon: toomanyrequests: Rate exceeded\n', failure: null };
function simulation(results, options = {}) {
  let time = 1000;
  const calls = [], waits = [], receipts = [];
  const settings = { image: IMAGE, label: 'image-pull', deadline: 1_000_000,
    call: async (command, args, opts) => {
      calls.push({ command, args, ...opts }); time += options.callMs ?? 1000;
      return results[Math.min(calls.length - 1, results.length - 1)];
    }, save: value => receipts.push(structuredClone(value)), ...options.settings };
  return { calls, waits, receipts, run: () => pullFixtureImage(settings, {
    now: () => time, wait: async (ms, _value, { signal }) => {
      assert.equal(signal, settings.signal); waits.push(ms); time += options.waitMs ?? ms;
      options.afterWait?.();
    },
  }) };
}
test('classifier accepts only the observed completed daemon throttle', () => {
  assert(isPublicEcrThrottle(throttle));
  assert(isPublicEcrThrottle({ ...throttle, stderr: 'toomanyrequests: Rate exceeded\n' }));
  for (const patch of [{ status: 0 }, { status: null }, { status: '1' }, { failure: 'timeout' },
    { stderr: 'Error response from daemon: denied: authentication required' }, { stderr: 'HTTP 429' },
    { stderr: 'Error response from daemon: toomanyrequests: Rate exceeded later' }, { stderr: 'generic rate limit exceeded' },
    { stderr: throttle.stderr + 'another error\n' }, { stderr: 'TLS handshake failed' }]) {
    assert.equal(isPublicEcrThrottle({ ...throttle, ...patch }), false);
  }
});
for (const image of [IMAGE, PLATFORMS.auth.image, PLATFORMS.storage.image]) {
  test(`same fixed image is retained across throttle recovery: ${image}`, async () => {
    const s = simulation([throttle, throttle, ok], { settings: { image } });
    assert.equal(await s.run(), ok);
    assert.deepEqual(s.calls.map(call => [call.command, ...call.args]), Array(3).fill(['docker', 'pull', image]));
    assert.deepEqual(s.calls.map(call => call.timeout), [300_000, 289_000, 268_000]);
    assert.deepEqual(s.calls.map(call => call.label), ['image-pull', 'image-pull-attempt-2', 'image-pull-attempt-3']);
    assert(s.calls.every(call => call.allowFailure === true)); assert.deepEqual(s.waits, [10_000, 20_000]);
    assert.equal(s.receipts.at(-1).status, 'passed'); assert.equal(s.receipts.at(-1).attempts.length, 3);
    assert.deepEqual(s.receipts.at(-1).attempts.map(value => value.rateLimited), [true, true, false]);
    assert.equal(s.receipts[0].status, 'running'); assert.equal(s.receipts[0].attempts.length, 1);
  });
}
test('first success makes one attempt and no wait', async () => {
  const s = simulation([ok]); await s.run(); assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []);
});
test('third throttle exhausts the bound and remains failed with all attempts retained', async () => {
  const s = simulation([throttle]); await assert.rejects(s.run(), /image-pull command failed/);
  assert.equal(s.calls.length, 3); assert.deepEqual(s.waits, [10_000, 20_000]);
  assert.equal(s.receipts.at(-1).status, 'failed'); assert.equal(s.receipts.at(-1).attempts.length, 3);
});
test('all subprocess failures and nonthrottle command failures fail without retry', async () => {
  for (const failure of ['timeout', 'aborted', 'spawn_failed', 'output_limit']) {
    const s = simulation([{ ...throttle, failure }]); await assert.rejects(s.run());
    assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []);
  }
  for (const stderr of ['denied: authentication required', 'manifest unknown', 'x509: certificate expired']) {
    const s = simulation([{ ...throttle, stderr }]); await assert.rejects(s.run());
    assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []);
  }
});
test('thrown command errors propagate without being reclassified or retried', async () => {
  let calls = 0; const error = new Error('synthetic execution failure');
  const s = simulation([], { settings: { call: async () => { calls++; throw error; } } });
  await assert.rejects(s.run(), error); assert.equal(calls, 1); assert.deepEqual(s.waits, []);
  assert.equal(s.receipts.at(-1).status, 'failed');
});
test('shared pull and outer fixture deadlines cap commands and prevent late retries', async () => {
  const shorter = simulation([throttle], { settings: { deadline: 5000 } });
  await assert.rejects(shorter.run(), /deadline/); assert.equal(shorter.calls[0].timeout, 4000);
  assert.equal(shorter.calls.length, 1); assert.deepEqual(shorter.waits, []);
  const consumed = simulation([throttle], { callMs: 299_999 });
  await assert.rejects(consumed.run(), /deadline/); assert.equal(consumed.calls.length, 1); assert.deepEqual(consumed.waits, []);
  const expiredWhileWaiting = simulation([throttle], { settings: { deadline: 30_000 }, waitMs: 40_000 });
  await assert.rejects(expiredWhileWaiting.run(), /deadline/); assert.equal(expiredWhileWaiting.calls.length, 1);
  assert.equal(expiredWhileWaiting.receipts.at(-1).status, 'failed');
});
test('cancellation before an attempt or during backoff prevents any subsequent pull', async () => {
  const before = new AbortController(); before.abort();
  const a = simulation([ok], { settings: { signal: before.signal } });
  await assert.rejects(a.run(), /cancelled/); assert.equal(a.calls.length, 0);
  const during = new AbortController();
  const b = simulation([throttle], { settings: { signal: during.signal }, afterWait: () => during.abort() });
  await assert.rejects(b.run(), /cancelled/); assert.equal(b.calls.length, 1); assert.deepEqual(b.waits, [10_000]);
});
test('actual timer wait is interruptible by cancellation', async () => {
  const controller = new AbortController(); let calls = 0; let receipt;
  await assert.rejects(pullFixtureImage({ image: IMAGE, label: 'image-pull', signal: controller.signal,
    call: async () => { calls++; setImmediate(() => controller.abort()); return throttle; }, save: value => { receipt = structuredClone(value); } }),
  { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(receipt.status, 'failed');
});
test('all existing pull call sites use the bounded helper and all hosted gates run its tests', () => {
  const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const fixture = source('scripts/ovd591-ci-fixture.mjs');
  const platform = source('scripts/free-quote-platform-sources.mjs');
  assert.match(fixture, /pullFixtureImage\(\{ call, image: IMAGE, label: 'image-pull', signal, deadline,/);
  assert.match(fixture, /extractPlatformSources\(\{ root, out, state, inputs, call, signal, deadline,/);
  assert.match(platform, /pullFixtureImage\(\{ call, image: spec\.image, label: `\$\{kind\}-image-pull`, signal, deadline,/);
  assert.doesNotMatch(fixture + platform, /call\('docker', \['pull'/);
  for (const name of ['ovd591-qualification', 'ovd591-retention-qualification', 'free-quote-sql-qualification']) {
    assert.match(source(`.github/workflows/${name}.yml`), /node --test scripts\/ovd591-image-pull.node-test.mjs/);
  }
});
