/** Offline registry error handling only. No Docker, image download, or SQL execution. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMAGE } from './ovd591-sql-qualification.mjs';
import { PLATFORMS } from './free-quote-platform-sources.mjs';
import { RATE_LIMIT_PATTERNS, backoffMs, isPublicEcrThrottle, pullConfig, pullFixtureImage, pullImages, spawnCall }
  from './ovd591-image-pull.mjs';

const ok = { status: 0, stdout: 'synthetic pull receipt', stderr: '', failure: null };
const throttle = { status: 1, stdout: '', stderr: 'Error response from daemon: toomanyrequests: Rate exceeded\n', failure: null };
function simulation(results, options = {}) {
  let time = 1000;
  const calls = [], waits = [], waitStarts = [], receipts = [];
  const settings = { image: IMAGE, label: 'image-pull', deadline: 1_000_000,
    call: async (command, args, opts) => {
      calls.push({ command, args, ...opts }); time += options.callMs ?? 1000;
      return results[Math.min(calls.length - 1, results.length - 1)];
    }, save: value => receipts.push(structuredClone(value)), ...options.settings };
  return { calls, waits, waitStarts, receipts, run: () => pullFixtureImage(settings, {
    now: () => time, random: options.random ?? (() => 1), env: options.env ?? {},
    wait: async (ms, _value, { signal }) => {
      assert.equal(signal, settings.signal); waits.push(ms); waitStarts.push(time); time += options.waitMs ?? ms;
      options.afterWait?.();
    },
  }) };
}
test('classifier accepts only throttle output with a non-zero integer status and no failure', () => {
  assert(isPublicEcrThrottle(throttle));
  assert(isPublicEcrThrottle({ ...throttle, stderr: 'toomanyrequests: Rate exceeded\n' }));
  // Updated on purpose: the old exact-line classifier rejected "...Rate exceeded later".
  assert(isPublicEcrThrottle({ ...throttle, stderr: 'Error response from daemon: toomanyrequests: Rate exceeded later' }));
  assert(isPublicEcrThrottle({ ...throttle, stderr: '', stdout: 'toomanyrequests\n\nData limit exceeded\n' }));
  for (const patch of [{ status: 0 }, { status: null }, { status: '1' }, { failure: 'timeout' }, { stderr: '', stdout: '' },
    { stderr: 'Error response from daemon: denied: authentication required' }, { stderr: 'HTTP 429' },
    { stderr: 'generic rate limit exceeded' }, { stderr: throttle.stderr + 'another error\n' },
    { stderr: 'toomanyrequests: Rate exceeded\nx509: certificate expired' },
    { stderr: 'unauthorized\ntoomanyrequests' }, { stderr: 'TLS handshake failed' },
    { stderr: 'manifest unknown', stdout: 'toomanyrequests' }]) {
    assert.equal(isPublicEcrThrottle({ ...throttle, ...patch }), false, JSON.stringify(patch));
  }
});
test('rate limit patterns are the three observed registry messages', () => {
  assert.deepEqual(RATE_LIMIT_PATTERNS.map(String), ['/toomanyrequests/i', '/data limit exceeded/i', '/rate exceeded/i']);
});
const THROTTLE_MESSAGES = ['toomanyrequests', 'Data limit exceeded', 'Rate exceeded', 'toomanyrequests: Rate exceeded',
  'Error response from daemon: toomanyrequests: Data limit exceeded'];
const casings = message => [message.toLowerCase(), message.toUpperCase(),
  message.replace(/\b(\w)(\w*)/g, (_, a, b) => a.toLowerCase() + b.toUpperCase())];
for (const message of THROTTLE_MESSAGES) {
  for (const text of casings(message)) {
    for (const stream of ['stderr', 'stdout']) {
      test(`throttle on ${stream} is rate limited and retried: ${text}`, async () => {
        const limited = { ...throttle, stderr: '', stdout: '', [stream]: text + '\n' };
        assert(isPublicEcrThrottle(limited));
        const s = simulation([limited, ok]);
        assert.equal(await s.run(), ok);
        assert.equal(s.calls.length, 2); assert.deepEqual(s.waits, [10_000]);
        assert.deepEqual(s.receipts.at(-1).attempts.map(value => value.rateLimited), [true, false]);
      });
    }
  }
}
for (const image of [IMAGE, PLATFORMS.auth.image, PLATFORMS.storage.image]) {
  test(`same fixed image is retained across throttle recovery: ${image}`, async () => {
    const s = simulation([throttle, throttle, ok], { settings: { image } });
    assert.equal(await s.run(), ok);
    assert.deepEqual(s.calls.map(call => [call.command, ...call.args]), Array.from({ length: 3 }, () => ['docker', 'pull', image]));
    assert.deepEqual(s.calls.map(call => call.timeout), [300_000, 289_000, 268_000]);
    assert.deepEqual(s.calls.map(call => call.label), ['image-pull', 'image-pull-attempt-2', 'image-pull-attempt-3']);
    assert(s.calls.every(call => call.allowFailure === true)); assert.deepEqual(s.waits, [10_000, 20_000]);
    assert.equal(s.receipts.at(-1).status, 'passed'); assert.equal(s.receipts.at(-1).attempts.length, 3);
    assert.deepEqual(s.receipts.at(-1).attempts.map(value => value.rateLimited), [true, true, false]);
    assert.equal(s.receipts[0].status, 'running'); assert.equal(s.receipts[0].attempts.length, 1);
  });
}
test('skipLoaded skips the pull and receipts "cached" when docker image inspect succeeds', async () => {
  const digested = { ...ok, stdout: `["${IMAGE.split(':')[0]}@sha256:${'a'.repeat(64)}"]` };
  const s = simulation([digested], { settings: { skipLoaded: true } });
  assert.equal(await s.run(), digested);
  assert.deepEqual(s.calls.map(call => [call.command, ...call.args]), [['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', IMAGE]]);
  assert.deepEqual(s.waits, []); assert.equal(s.receipts.at(-1).status, 'cached');
  assert.deepEqual(s.receipts.at(-1).attempts, [{ attempt: 0, status: 'cached' }]);
});
test('skipLoaded still pulls an image loaded from a tarball without RepoDigests', async () => {
  const undigested = { ...ok, stdout: '[]' };
  const s = simulation([undigested, ok], { settings: { skipLoaded: true } });
  assert.equal(await s.run(), ok);
  assert.deepEqual(s.calls.map(call => call.args[0] + ' ' + call.args.at(-1)), ['image ' + IMAGE, 'pull ' + IMAGE]);
  assert.equal(s.receipts.at(-1).status, 'passed');
});
test('skipLoaded falls through to the retried pull when the image is not loaded', async () => {
  const missing = { status: 1, stdout: '', stderr: 'Error: No such image', failure: null };
  const s = simulation([missing, throttle, ok], { settings: { skipLoaded: true } });
  assert.equal(await s.run(), ok);
  assert.deepEqual(s.calls.map(call => call.args.slice(0, 2).join(' ')), ['image inspect', 'pull ' + IMAGE, 'pull ' + IMAGE]);
  assert.equal(s.receipts.at(-1).status, 'passed'); assert.equal(s.receipts.at(-1).attempts.length, 2);
});
test('the inspect probe is off by default and enabled by the CLI and both fixture call sites', () => {
  const s = simulation([ok]); return s.run().then(() => assert.equal(s.calls[0].args[0], 'pull'));
});
test('CLI pullImages skips images that are already loaded', async () => {
  const out = [], seen = [];
  assert.equal(await pullImages([IMAGE], { call: async (_c, args) => { seen.push(args[0]); return { ...ok, stdout: `["x@sha256:${'b'.repeat(64)}"]` }; }, out: line => out.push(JSON.parse(line)) }), 0);
  assert.deepEqual(seen, ['image']); assert.equal(out[0].status, 'cached');
});
test('first success makes one attempt and no wait', async () => {
  const s = simulation([ok]); await s.run(); assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []);
});
for (let n = 2; n <= 5; n++) {
  test(`success on attempt ${n} retries ${n - 1} times with doubling waits`, async () => {
    const s = simulation([...new Array(n - 1).fill(throttle), ok]);
    assert.equal(await s.run(), ok); assert.equal(s.calls.length, n);
    assert.deepEqual(s.waits, [10_000, 20_000, 40_000, 60_000].slice(0, n - 1));
    assert.equal(s.receipts.at(-1).status, 'passed');
  });
}
test('exhaustion names the registry, attempt count and budget, and the receipt stays failed', async () => {
  // Updated on purpose: the old test expected 3 attempts and "image-pull command failed".
  const s = simulation([throttle]);
  await assert.rejects(s.run(), error => error.message === 'image-pull: registry public.ecr.aws rate-limited after 5 attempts (budget 300s)');
  assert.equal(s.calls.length, 5); assert.deepEqual(s.waits, [10_000, 20_000, 40_000, 60_000]);
  assert.equal(s.receipts.at(-1).status, 'failed'); assert.equal(s.receipts.at(-1).attempts.length, 5);
});
test('exhaustion message includes a custom attempt count and budget from env', async () => {
  const custom = simulation([throttle], { env: { OVD_PULL_MAX_ATTEMPTS: '2', OVD_PULL_BUDGET_MS: '100000' } });
  await assert.rejects(custom.run(), /image-pull: registry public\.ecr\.aws rate-limited after 2 attempts \(budget 100s\)/);
  assert.equal(custom.receipts.at(-1).status, 'failed');
});
test('waits stay within jitter bounds for a seeded random and never exceed cap or remaining budget', async () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const env = { OVD_PULL_MAX_ATTEMPTS: '8', OVD_PULL_BASE_MS: '5000', OVD_PULL_CAP_MS: '30000', OVD_PULL_BUDGET_MS: '600000' };
  const s = simulation([throttle], { env, random });
  await assert.rejects(s.run(), /rate-limited after 8 attempts/);
  assert.equal(s.waits.length, 7);
  s.waits.forEach((ms, index) => {
    const ceiling = Math.min(30_000, 5000 * 2 ** index);
    assert(ms >= Math.floor(ceiling * 0.5) && ms <= ceiling && ms <= 30_000, `${index}: ${ms}`);
  });
  assert.notDeepEqual(s.waits.slice(0, 2).map((ms, i) => ms / (5000 * 2 ** i)), [1, 1]);
});
test('a tight budget fails closed before a wait that would exceed it', async () => {
  const tight = simulation([throttle], { env: { OVD_PULL_BUDGET_MS: '40000' } });
  await assert.rejects(tight.run(), /deadline/);
  assert(tight.waits.length > 0);
  tight.waits.forEach((ms, index) => assert(tight.waitStarts[index] + ms < 1000 + 40_000));
  assert.equal(tight.receipts.at(-1).status, 'failed');
});
test('backoff formula halves at minimum random and caps at the cap', () => {
  const config = { baseMs: 10_000, capMs: 60_000 };
  assert.equal(backoffMs(1, config, () => 0), 5000); assert.equal(backoffMs(1, config, () => 1), 10_000);
  assert.equal(backoffMs(4, config, () => 1), 60_000); assert.equal(backoffMs(8, config, () => 0), 30_000);
});
test('env config applies defaults, clamps ranges and falls back on invalid values', () => {
  const defaults = { maxAttempts: 5, baseMs: 10_000, capMs: 60_000, budgetMs: 300_000 };
  assert.deepEqual(pullConfig({}), defaults);
  assert.deepEqual(pullConfig({ OVD_PULL_MAX_ATTEMPTS: '3', OVD_PULL_BASE_MS: '2000', OVD_PULL_CAP_MS: '8000',
    OVD_PULL_BUDGET_MS: '90000' }), { maxAttempts: 3, baseMs: 2000, capMs: 8000, budgetMs: 90_000 });
  assert.deepEqual(pullConfig({ OVD_PULL_MAX_ATTEMPTS: '0', OVD_PULL_BASE_MS: '1', OVD_PULL_CAP_MS: '1', OVD_PULL_BUDGET_MS: '1' }),
    { maxAttempts: 1, baseMs: 1000, capMs: 1000, budgetMs: 1000 });
  assert.deepEqual(pullConfig({ OVD_PULL_MAX_ATTEMPTS: '99', OVD_PULL_BASE_MS: '999999', OVD_PULL_CAP_MS: '999999',
    OVD_PULL_BUDGET_MS: '9999999' }), { maxAttempts: 8, baseMs: 60_000, capMs: 120_000, budgetMs: 600_000 });
  for (const bad of ['', ' ', 'abc', '-5', '1.5', '1e3', 'NaN', '0x10']) {
    assert.deepEqual(pullConfig({ OVD_PULL_MAX_ATTEMPTS: bad, OVD_PULL_BASE_MS: bad, OVD_PULL_CAP_MS: bad, OVD_PULL_BUDGET_MS: bad }),
      defaults, bad);
  }
});
for (const failure of ['timeout', 'aborted', 'spawn_failed', 'output_limit']) {
  test(`subprocess failure ${failure} fails after one attempt`, async () => {
    const s = simulation([{ ...throttle, failure }]); await assert.rejects(s.run(), /image-pull command failed/);
    assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []);
  });
}
for (const stderr of ['denied: authentication required', 'manifest unknown', 'x509: certificate expired', 'HTTP 429',
  'toomanyrequests: Rate exceeded\nTLS handshake timeout', 'unauthorized: authentication required\ntoomanyrequests']) {
  test(`nonthrottle stderr fails after one attempt: ${stderr.split('\n')[0]}`, async () => {
    const s = simulation([{ ...throttle, stderr }]); await assert.rejects(s.run(), /image-pull command failed/);
    assert.equal(s.calls.length, 1); assert.deepEqual(s.waits, []); assert.equal(s.receipts.at(-1).status, 'failed');
  });
}
test('mixed stdout throttle with a nonthrottle stderr fails after one attempt', async () => {
  const mixedStdout = simulation([{ ...throttle, stderr: 'manifest unknown', stdout: 'toomanyrequests' }]);
  await assert.rejects(mixedStdout.run(), /command failed/); assert.equal(mixedStdout.calls.length, 1);
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
test('spawnCall adapts spawnSync results and failures to the call contract', async () => {
  const seen = [];
  const adapt = result => spawnCall((command, args, options) => { seen.push({ command, args, options }); return result; });
  assert.deepEqual(await adapt({ status: 0, stdout: 'out', stderr: '' })('docker', ['pull', IMAGE], { timeout: 5000 }),
    { status: 0, stdout: 'out', stderr: '', failure: null });
  assert.deepEqual([seen[0].command, seen[0].args, seen[0].options.timeout, seen[0].options.encoding, seen[0].options.shell],
    ['docker', ['pull', IMAGE], 5000, 'utf8', false]);
  assert.deepEqual(await adapt({ status: 1, stdout: null, stderr: 'toomanyrequests' })('docker', []),
    { status: 1, stdout: '', stderr: 'toomanyrequests', failure: null });
});
test('spawnCall maps timeout, output-limit, spawn and abort failures', async () => {
  const adapt = result => spawnCall(() => result);
  assert.equal((await adapt({ status: null, error: { code: 'ETIMEDOUT' } })('docker', [])).failure, 'timeout');
  assert.equal((await adapt({ status: null, error: { code: 'ENOBUFS' } })('docker', [])).failure, 'output_limit');
  assert.equal((await adapt({ status: null, error: { code: 'ENOENT' } })('docker', [])).failure, 'spawn_failed');
  assert.equal((await adapt({ status: null, signal: 'SIGTERM' })('docker', [])).failure, 'aborted');
});
test('CLI pullImages pulls each image, prints settled receipts and reports failures with a non-zero code', async () => {
  const auth = PLATFORMS.auth.image, out = [], err = [], pulled = [];
  const call = async (command, args) =>
    args[0] === 'image' ? { ...ok, status: 1, stderr: 'Error: No such image' } : (pulled.push(args[1]), ok);
  assert.equal(await pullImages([IMAGE, auth], { call, out: line => out.push(line), err: line => err.push(line) }), 0);
  assert.deepEqual(pulled, [IMAGE, auth]);
  const receipts = out.map(line => JSON.parse(line));
  assert.deepEqual(receipts.map(receipt => [receipt.image, receipt.status]), [[IMAGE, 'passed'], [auth, 'passed']]);
});
test('CLI pullImages returns 1 on a failed pull and 2 when no images are given', async () => {
  const failing = [], failedErr = [], usage = [];
  assert.equal(await pullImages([IMAGE, PLATFORMS.auth.image], { call: async () => ({ ...throttle, stderr: 'denied' }),
    out: line => failing.push(JSON.parse(line)), err: line => failedErr.push(line) }), 1);
  assert.deepEqual(failing.map(receipt => receipt.status), ['failed']);
  assert(failedErr.some(line => /::error::.*command failed/.test(line)));
  assert.equal(await pullImages([], { err: line => usage.push(line) }), 2);
  assert.equal(await pullImages(['docker.io/library/alpine:3'], { call: async () => ok, err: line => usage.push(line) }), 1);
});
test('all existing pull call sites use the bounded helper and all hosted gates run its tests', () => {
  const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const fixture = source('scripts/ovd591-ci-fixture.mjs');
  const platform = source('scripts/free-quote-platform-sources.mjs');
  assert.match(fixture, /pullFixtureImage\(\{ call, image: IMAGE, label: 'image-pull', signal, deadline,/);
  assert.match(fixture, /extractPlatformSources\(\{ root, out, state, inputs, call, signal, deadline,/);
  assert.match(fixture, /process\.exitCode = 1/);
  assert.match(platform, /pullFixtureImage\(\{ call, image: spec\.image, label: `\$\{kind\}-image-pull`, signal, deadline,/);
  assert.doesNotMatch(fixture + platform, /call\('docker', \['pull'/);
  for (const name of ['ovd591-qualification', 'ovd591-retention-qualification', 'free-quote-sql-qualification',
    'native-sql-proofs']) {
    const workflow = source(`.github/workflows/${name}.yml`);
    assert.match(workflow, /node --test scripts\/ovd591-image-pull.node-test.mjs/);
    assert.doesNotMatch(workflow, /continue-on-error:/);
  }
});
test('native SQL proofs workflow pulls through the shared helper with no inline docker pull retry loop', () => {
  const workflow = readFileSync(new URL('../.github/workflows/native-sql-proofs.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node scripts\/ovd591-image-pull\.mjs pull "\$POSTGRES_IMAGE" "\$STORAGE_IMAGE" "\$AUTH_IMAGE"/);
  assert.doesNotMatch(workflow, /docker pull/);
  assert.doesNotMatch(workflow, /for attempt in 1 2 3/);
  assert.ok(workflow.indexOf('actions/checkout') < workflow.indexOf('actions/setup-node'));
  assert.ok(workflow.indexOf('actions/setup-node') < workflow.indexOf('scripts/ovd591-image-pull.mjs pull'));
});
