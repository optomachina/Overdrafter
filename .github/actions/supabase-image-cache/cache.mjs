/** Optional CI image warming. Registry manifests, never cache receipts, authorize image IDs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backoffMs, isPublicEcrThrottle, pullConfig } from '../../../scripts/ovd591-image-pull.mjs';
import { isEntryPoint } from '../../../scripts/lib/entry-point.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TIMEOUT = 600_000;
const PLAN = 'plan.json';
const ARCHIVE = 'images.tar.gz';
export const CLI_VERSION = '2.78.1';
const source = new URL('./cli-2.78.1-images.txt', import.meta.url);
const warn = message => console.error(`::warning::Supabase image cache: ${message}`);

export function imageRefs(group, registry = 'docker.io', excluded = '') {
  assert(['public.ecr.aws', 'ghcr.io', 'docker.io'].includes(registry), 'unsupported image registry');
  assert(['full', 'db', 'tools'].includes(group), 'unsupported image group');
  const omit = new Set(excluded.split(','));
  const entries = [...readFileSync(source, 'utf8').matchAll(/^FROM (\S+) AS (\S+)$/gm)];
  const selected = entries.filter(([, ref, alias]) => {
    const name = ref.split('/').at(-1).split(':')[0];
    if (group === 'db') return alias === 'pg';
    if (group === 'tools') return alias === 'pgprove';
    return !['supavisor', 'differ', 'migra', 'pgprove'].includes(alias) && !omit.has(name);
  }).map(([, ref]) => registry === 'docker.io' ? ref : `${registry}/supabase/${ref.split('/').at(-1)}`);
  if (group === 'tools') selected.push('postgres:17');
  return selected.sort();
}

export function docker(args) {
  // Never forward raw command output: registry/daemon diagnostics can contain credentials.
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 });
  return { ...result, failure: result.error || result.signal };
}
const passed = result => result.status === 0 && !result.failure;
const repository = ref => ref.slice(0, ref.lastIndexOf(':'));

/** docker manifest inspect -v supports both single manifests and multi-platform indexes. */
export function platformManifest(value, architecture) {
  const entries = Array.isArray(value) ? value : [value];
  const candidates = entries.filter(entry => {
    const platform = entry.Descriptor?.platform;
    return !platform || (platform.os === 'linux' && platform.architecture === architecture &&
      (!platform.variant || platform.variant === 'v8'));
  });
  assert.equal(candidates.length, 1, 'one matching platform manifest required');
  const entry = candidates[0];
  const manifest = entry.SchemaV2Manifest ?? entry.OCIManifest;
  const digest = entry.Descriptor?.digest;
  const id = manifest?.config?.digest;
  assert.match(digest ?? '', DIGEST);
  assert.match(id ?? '', DIGEST);
  return { digest, id };
}

export function cacheKey(images, os, arch) {
  assert(images.length > 0, 'empty cache plan');
  const sorted = [...images].sort((a, b) => a.ref.localeCompare(b.ref));
  const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  return `supabase-images-v2-cli-${CLI_VERSION}-${os}-${arch}-${hash}`;
}

export async function retryPull(ref, { call = docker, wait = delay, config = { ...pullConfig(), maxAttempts: 3, baseMs: 1000, capMs: 5000, budgetMs: 30_000 } } = {}) {
  const deadline = Date.now() + config.budgetMs;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const result = call(['pull', ref]);
    if (passed(result)) return true;
    if (!isPublicEcrThrottle(result) || attempt === config.maxAttempts) return false;
    const ms = backoffMs(attempt, config);
    if (Date.now() + ms >= deadline) return false;
    await wait(ms);
  }
  return false;
}

export function registryRepositories(ref) {
  const repo = repository(ref);
  const name = repo.split('/').at(-1);
  // postgres:17 is the official client image, not a Supabase mirror.
  if (repo === 'postgres') return ['docker.io/library/postgres'];
  return [`docker.io/${repo}`, `ghcr.io/supabase/${name}`, `public.ecr.aws/supabase/${name}`];
}

function resolveImage(ref, architecture, call) {
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  for (const source of registryRepositories(ref)) {
    const result = call(['manifest', 'inspect', '-v', `${source}:${tag}`]);
    if (!passed(result)) continue;
    try {
      return { ref, source, ...platformManifest(JSON.parse(result.stdout), architecture) };
    } catch { /* An unavailable platform or malformed response cannot authorize a key. */ }
  }
  throw new Error('registry manifest unavailable');
}

export function resolvePlan(refs, architecture, call = docker) {
  return { images: refs.map(ref => resolveImage(ref, architecture, call)), architecture };
}

const inspectId = (ref, call) => {
  const result = call(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return passed(result) ? result.stdout.trim() : null;
};

/** Remove any unexpected loaded tag before fallback can let the CLI see it. */
export function admitImage(image, call = docker) {
  const current = inspectId(image.ref, call);
  if (current === image.id) return true;
  if (current) assert(passed(call(['image', 'rm', '--no-prune', image.ref])), 'cannot remove unverified image tag');
  if (inspectId(image.id, call) !== image.id) return false;
  return passed(call(['tag', image.id, image.ref]));
}

/** Mirrors are attempted only at the same manifest digest, never by a substitute tag. */
export function pullCandidates(image) {
  const repositories = [image.source, ...registryRepositories(image.ref)].filter(Boolean);
  return [...new Set(repositories)].map(candidate => `${candidate}@${image.digest}`);
}

async function pullFromMirrors(image, call, pull) {
  for (const exact of pullCandidates(image)) {
    if (await pull(exact, { call })) return true;
  }
  return false;
}

export async function warmImages(plan, { call = docker, pull = retryPull } = {}) {
  let complete = true;
  for (const image of plan.images) {
    if (admitImage(image, call)) continue;
    // Pull the resolved platform manifest so a tag moving mid-job cannot poison the cache.
    const pulled = await pullFromMirrors(image, call, pull);
    if (!pulled || !admitImage(image, call)) complete = false;
  }
  return complete;
}

export function saveArchive(plan, dir, call = docker) {
  assert(plan.images.every(image => inspectId(image.ref, call) === image.id), 'image verification failed');
  // Save by ID: archives carry no mutable tags. Docker verifies content-addressed layers on load.
  const saved = call(['save', '-o', join(dir, 'images.tar'), ...new Set(plan.images.map(image => image.id))]);
  assert(passed(saved), 'docker save failed');
  const compressed = spawnSync('gzip', ['-1', '-f', join(dir, 'images.tar')], { timeout: TIMEOUT });
  assert.equal(compressed.status, 0, 'gzip failed');
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function prepare(dir, group) {
  mkdirSync(dir, { recursive: true });
  // setup-cli overrides this registry. Write only to GITHUB_ENV, never stdout.
  appendFileSync(process.env.GITHUB_ENV, 'SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io\n');
  const arch = { X64: 'amd64', ARM64: 'arm64' }[process.env.RUNNER_ARCH];
  assert(arch, 'unsupported runner architecture');
  const refs = imageRefs(group);
  writeFileSync(join(dir, 'refs.json'), JSON.stringify(refs));
  try {
    const plan = resolvePlan(refs, arch);
    writeFileSync(join(dir, PLAN), JSON.stringify(plan));
    output('key', cacheKey(plan.images, process.env.RUNNER_OS, arch));
  } catch {
    // No partial key, restore prefix, or save: unverifiable images must be normally pulled.
    warn('digest resolution unavailable; using normal pulls without cache');
  }
}

async function warm(dir) {
  let plan;
  try { plan = JSON.parse(readFileSync(join(dir, PLAN), 'utf8')); } catch { /* resolution failed */ }
  if (!plan) {
    for (const ref of JSON.parse(readFileSync(join(dir, 'refs.json'), 'utf8'))) await retryPull(ref);
    return;
  }
  // Resolution state lives outside the restored directory. Never trust a cached plan/receipt.
  docker(['load', '-i', join(dir, 'archive', ARCHIVE)]);
  const complete = await warmImages(plan);
  if (!complete) { warn('some images unavailable; the normal start command will retry'); return; }
  const archiveDir = join(dir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  if (process.env.CACHE_HIT === 'true') return;
  try {
    saveArchive(plan, archiveDir);
    output('save', 'true');
  } catch { warn('archive save failed; continuing with verified local images'); }
}

if (isEntryPoint(import.meta.url)) {
  const [command, dir, group] = process.argv.slice(2);
  try {
    if (command === 'prepare') prepare(dir, group);
    else if (command === 'warm') await warm(dir);
    else throw new Error('unsupported command');
  } catch {
    // Fail closed if an unverified loaded image cannot be removed. Do not disclose subprocess output.
    console.error('Supabase image cache failed to establish safe local images');
    process.exitCode = 1;
  }
}
