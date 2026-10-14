/** Retry only the public ECR throttle, without changing image or registry.
 * Docker 29 daemons report it without the legacy "Error response from daemon: " prefix.
 * CLI: node scripts/ovd591-image-pull.mjs pull <image>... */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const RATE_LIMIT_PATTERNS = Object.freeze([/toomanyrequests/i, /data limit exceeded/i, /rate exceeded/i]);
const REGISTRY = 'public.ecr.aws';
const DAEMON_PREFIX = /^Error response from daemon: /i;
const SETTINGS = Object.freeze({
  OVD_PULL_MAX_ATTEMPTS: { key: 'maxAttempts', fallback: 5, min: 1, max: 8 },
  OVD_PULL_BASE_MS: { key: 'baseMs', fallback: 10_000, min: 1000, max: 60_000 },
  OVD_PULL_CAP_MS: { key: 'capMs', fallback: 60_000, min: 1000, max: 120_000 },
  OVD_PULL_BUDGET_MS: { key: 'budgetMs', fallback: 300_000, min: 1000, max: 600_000 },
});

/** Clamp valid non-negative integers into range; anything else falls back to the default. */
export function pullConfig(env = process.env) {
  const config = {};
  for (const [name, { key, fallback, min, max }] of Object.entries(SETTINGS)) {
    const raw = env[name]?.trim();
    config[key] = raw && /^\d+$/.test(raw) ? Math.min(max, Math.max(min, Number(raw))) : fallback;
  }
  return config;
}

/** min(cap, base * 2^(n-1)) * jitter, jitter in [0.5, 1.0]. */
export function backoffMs(attempt, { baseMs, capMs }, random = Math.random) {
  return Math.floor(Math.min(capMs, baseMs * 2 ** (attempt - 1)) * (0.5 + random() / 2));
}

const lines = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
/** Rate limited only when every non-empty stderr line (stdout if stderr is empty) is a throttle message. */
export function isPublicEcrThrottle(result) {
  if (!Number.isInteger(result.status) || result.status <= 0 || result.failure) return false;
  const stderr = lines(result.stderr), found = stderr.length ? stderr : lines(result.stdout);
  return found.length > 0 && found.every(line => {
    const text = line.replace(DAEMON_PREFIX, '');
    return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
  });
}

/** call retains each raw result; save retains classification and bounded retry decisions.
 * skipLoaded: an image already present locally (`docker image inspect` succeeds) is receipted as "cached", not pulled. */
export async function pullFixtureImage({ call, image, label, signal, deadline = Infinity, save, skipLoaded = false },
  { now = Date.now, wait = delay, random = Math.random, env = process.env } = {}) {
  assert.match(image, /^public\.ecr\.aws\/supabase\/[a-z-]+:[a-zA-Z0-9.-]+$/);
  assert.match(label, /^[a-z-]+$/);
  const config = pullConfig(env);
  const expires = Math.min(deadline, now() + config.budgetMs);
  const receipt = { image, status: 'running', budgetMs: config.budgetMs, maxAttempts: config.maxAttempts, attempts: [] };
  const check = () => {
    assert(!signal?.aborted, `${label} cancelled`);
    assert(now() < expires, `${label} deadline exceeded`);
  };
  try {
    if (skipLoaded) {
      const loaded = await call('docker', ['image', 'inspect', image], { timeout: expires - now(), allowFailure: true,
        label: `${label}-inspect` });
      check();
      if (!loaded.failure && loaded.status === 0) {
        receipt.status = 'cached'; receipt.attempts.push({ attempt: 0, status: 'cached' });
        return loaded;
      }
    }
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      check();
      const timeout = expires - now();
      const result = await call('docker', ['pull', image], { timeout, allowFailure: true,
        label: attempt === 1 ? label : `${label}-attempt-${attempt}` });
      const entry = { attempt, timeoutMs: timeout, status: result.status, failure: result.failure ?? null,
        rateLimited: isPublicEcrThrottle(result) };
      receipt.attempts.push(entry); save(receipt);
      check();
      if (!result.failure && result.status === 0) { receipt.status = 'passed'; return result; }
      assert(entry.rateLimited, `${label} command failed`);
      assert(attempt < config.maxAttempts,
        `${label}: registry ${REGISTRY} rate-limited after ${attempt} attempts (budget ${config.budgetMs / 1000}s)`);
      const waitMs = backoffMs(attempt, config, random);
      assert(now() + waitMs < expires, `${label} deadline exceeded`);
      entry.backoffMs = waitMs; save(receipt);
      await wait(waitMs, undefined, { signal });
    }
  } finally {
    if (receipt.status !== 'passed' && receipt.status !== 'cached') receipt.status = 'failed';
    save(receipt);
  }
}

function spawnFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result.error?.code === 'ENOBUFS') return 'output_limit';
  if (result.error) return 'spawn_failed';
  if (result.signal) return 'aborted';
  return null;
}

/** Adapts spawnSync to the {status, stdout, stderr, failure} contract used by pullFixtureImage. */
export function spawnCall(spawn = spawnSync) {
  return async (command, args, { timeout } = {}) => {
    const result = spawn(command, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, shell: false });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', failure: spawnFailure(result) };
  };
}

/** Pulls each image in order; receipts go to `out` as JSON lines once settled. Returns an exit code. */
export async function pullImages(images, { call = spawnCall(), out = console.log, err = console.error, ...options } = {}) {
  if (!images.length) { err('usage: ovd591-image-pull.mjs pull <image>...'); return 2; }
  for (const image of images) {
    const name = /^public\.ecr\.aws\/supabase\/([a-z-]+):/.exec(image)?.[1];
    try {
      assert(name, `unsupported image reference: ${image}`);
      await pullFixtureImage({ call: async (...args) => {
        const result = await call(...args);
        if (result.status !== 0 && result.stderr) err(result.stderr.trimEnd());
        return result;
      }, image, label: `${name}-image-pull`, skipLoaded: true, save: receipt => {
        if (receipt.status !== 'running') out(JSON.stringify(receipt));
      } }, options);
    } catch (error) {
      err(`::error::${error.message}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...images] = process.argv.slice(2);
  if (command === 'pull') process.exitCode = await pullImages(images);
  else {
    console.error('usage: ovd591-image-pull.mjs pull <image>...');
    process.exitCode = 2;
  }
}
