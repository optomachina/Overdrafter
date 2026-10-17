/** Retry only the public ECR throttle, without changing image or registry.
 * Docker 29 daemons report it without the legacy "Error response from daemon: " prefix.
 * CLI: node scripts/ovd591-image-pull.mjs pull <image>...
 *      node scripts/ovd591-image-pull.mjs save <cache-dir> <image>...   (registry-pulled images -> tarball + ID receipt)
 *      node scripts/ovd591-image-pull.mjs load <cache-dir> */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const RATE_LIMIT_PATTERNS = Object.freeze([/toomanyrequests/i, /data limit exceeded/i, /rate exceeded/i]);
const REGISTRY = 'public.ecr.aws';
const IMAGE_REF = /^public\.ecr\.aws\/supabase\/[a-z-]+:[a-zA-Z0-9.-]+$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
/** Directory holding images.tar and receipt.json; set only for fixture runs after the cache restore. */
export const IMAGE_CACHE_ENV = 'OVD591_IMAGE_CACHE';
const INSPECT_FORMAT = '{{json .Id}} {{json .RepoDigests}}';
const CACHE_TIMEOUT_MS = 600_000;
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

/** Parses `docker image inspect --format INSPECT_FORMAT`; null when malformed. */
function parseInspect(stdout) {
  const [id, digests, ...rest] = String(stdout ?? '').trim().split(' ');
  if (rest.length) return null;
  try { return { id: JSON.parse(id), repoDigests: JSON.parse(digests) ?? [] }; } catch { return null; }
}
/** Every digest names this image's repository at an exact sha256 manifest digest. */
const registryDigests = (image, digests) => Array.isArray(digests) && digests.length > 0 && digests.every(digest =>
  typeof digest === 'string' && digest.startsWith(`${image.slice(0, image.lastIndexOf(':'))}@sha256:`) && /@sha256:[a-f0-9]{64}$/.test(digest));

/** Receipt written by saveImageCache; null when the cache is unset, absent or unreadable. */
export function readImageCache(env = process.env, read = readFileSync) {
  const dir = env[IMAGE_CACHE_ENV];
  if (!dir) return null;
  try { return JSON.parse(read(join(dir, 'receipt.json'), 'utf8')); } catch { return null; }
}

/** Registry provenance for a local image, or null. A pulled image carries RepoDigests. `docker load` drops them, so a loaded
 * copy is admitted only when its content-addressed image ID equals the ID receipted when that exact reference was pulled. */
export function loadedProvenance(image, local, cache) {
  if (!local || !IMAGE_ID.test(String(local.id))) return null;
  if (Array.isArray(local.repoDigests) && local.repoDigests.some(digest => /@sha256:[a-f0-9]{64}$/.test(String(digest)))) {
    return { source: 'registry', id: local.id, repoDigests: local.repoDigests };
  }
  const entry = cache?.schemaVersion === 1 && Array.isArray(cache.images) ? cache.images.find(value => value?.image === image) : null;
  if (!entry || entry.id !== local.id || !registryDigests(image, entry.repoDigests)) return null;
  return { source: 'image-cache', id: local.id, repoDigests: entry.repoDigests };
}

/** call retains each raw result; save retains classification and bounded retry decisions.
 * skipLoaded: an image already present locally with registry provenance (see loadedProvenance) is receipted as "cached",
 * not pulled, and the result carries that provenance. */
export async function pullFixtureImage({ call, image, label, signal, deadline = Infinity, save, skipLoaded = false },
  { now = Date.now, wait = delay, random = Math.random, env = process.env, readCache = readImageCache } = {}) {
  assert.match(image, IMAGE_REF);
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
      const loaded = await call('docker', ['image', 'inspect', '--format', INSPECT_FORMAT, image], { timeout: expires - now(), allowFailure: true,
        label: `${label}-inspect` });
      check();
      const provenance = !loaded.failure && loaded.status === 0 ? loadedProvenance(image, parseInspect(loaded.stdout), readCache(env)) : null;
      if (provenance) {
        Object.assign(receipt, { status: 'cached', ...provenance }); receipt.attempts.push({ attempt: 0, status: 'cached' });
        return { ...loaded, provenance };
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

/** Saves registry-pulled images with an image-ID receipt. Refuses images without registry digests, including loaded copies,
 * so a cache entry is only ever created from a real pull. Failure warns and returns 1; it never alters the local images. */
export async function saveImageCache(dir, images, { call = spawnCall(), err = console.error } = {}) {
  try {
    assert(dir && images.length, 'usage: ovd591-image-pull.mjs save <cache-dir> <image>...');
    const entries = [];
    for (const image of images) {
      assert.match(image, IMAGE_REF, `unsupported image reference: ${image}`);
      const result = await call('docker', ['image', 'inspect', '--format', INSPECT_FORMAT, image], { timeout: 60_000 });
      const local = result.status === 0 && !result.failure ? parseInspect(result.stdout) : null;
      assert(local && IMAGE_ID.test(String(local.id)) && registryDigests(image, local.repoDigests), `${image} is not a registry-pulled local image`);
      entries.push({ image, id: local.id, repoDigests: local.repoDigests });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saved = await call('docker', ['save', '-o', join(dir, 'images.tar'), ...images], { timeout: CACHE_TIMEOUT_MS });
    assert(saved.status === 0 && !saved.failure, `docker save failed: ${String(saved.stderr ?? '').trim()}`);
    writeFileSync(join(dir, 'receipt.json'), `${JSON.stringify({ schemaVersion: 1, images: entries }, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(`::warning::image cache not saved: ${error.message}`);
    return 1;
  }
}

/** Loads a restored cache and reports which receipted images will be admitted. Never fails the job: anything the fixture
 * does not admit via loadedProvenance is pulled as usual. */
export async function loadImageCache(dir, { call = spawnCall(), out = console.log, err = console.error, read = readFileSync } = {}) {
  const cache = readImageCache({ [IMAGE_CACHE_ENV]: dir }, read);
  if (!Array.isArray(cache?.images)) { err('::warning::image cache receipt missing or malformed; images will be pulled'); return 0; }
  const loaded = await call('docker', ['load', '-i', join(dir, 'images.tar')], { timeout: CACHE_TIMEOUT_MS });
  if (loaded.status !== 0 || loaded.failure) {
    err(`::warning::docker load failed; images will be pulled\n${String(loaded.stderr ?? '').trim()}`.trimEnd());
    return 0;
  }
  for (const { image } of cache.images) {
    const result = await call('docker', ['image', 'inspect', '--format', INSPECT_FORMAT, image], { timeout: 60_000 });
    const provenance = result.status === 0 && !result.failure ? loadedProvenance(image, parseInspect(result.stdout), cache) : null;
    out(JSON.stringify({ image, admitted: Boolean(provenance), ...provenance }));
    if (!provenance) err(`::warning::cached ${image} does not match its receipt; it will be pulled`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'pull') process.exitCode = await pullImages(rest);
  else if (command === 'save') process.exitCode = await saveImageCache(rest[0], rest.slice(1));
  else if (command === 'load' && rest.length === 1) process.exitCode = await loadImageCache(rest[0]);
  else {
    console.error('usage: ovd591-image-pull.mjs pull <image>... | save <cache-dir> <image>... | load <cache-dir>');
    process.exitCode = 2;
  }
}
