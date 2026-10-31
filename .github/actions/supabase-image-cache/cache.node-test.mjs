import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { admitImage, cacheKey, CLI_VERSION, imageRefs, platformManifest, pullCandidates, registryRepositories, resolvePlan, retryPull, warmImages } from './cache.mjs';

const digest = character => `sha256:${character.repeat(64)}`;
const ref = 'supabase/postgres:17.6.1.095';
const image = { ref, source: 'docker.io/supabase/postgres', digest: digest('a'), id: digest('b') };
const ok = stdout => ({ status: 0, stdout, stderr: '' });
const failed = { status: 1, stdout: '', stderr: 'unavailable' };
const manifest = architecture => ({
  Descriptor: { digest: image.digest, platform: { os: 'linux', architecture } },
  OCIManifest: { config: { digest: image.id } },
});

test('separate small database and tools entries; full stack and excludes match CLI service names', () => {
  assert.deepEqual(imageRefs('db'), [ref]);
  assert.equal(imageRefs('full').length, 13);
  assert.deepEqual(imageRefs('tools'), ['postgres:17', 'supabase/pg_prove:3.36']);
  assert.equal(imageRefs('full', 'ghcr.io', 'studio,postgres-meta').length, 11);
  assert(imageRefs('full', 'docker.io').includes('library/kong:2.8.1'));
  assert.throws(() => imageRefs('unknown'));
  assert.throws(() => imageRefs('full', 'untrusted.example'));
});

test('select only matching Linux platform, supporting Docker and OCI manifest shapes', () => {
  assert.deepEqual(platformManifest([manifest('arm64'), manifest('amd64')], 'amd64'), { digest: image.digest, id: image.id });
  const single = manifest('amd64');
  single.SchemaV2Manifest = single.OCIManifest;
  delete single.OCIManifest;
  assert.deepEqual(platformManifest(single, 'amd64'), { digest: image.digest, id: image.id });
  assert.throws(() => platformManifest([manifest('arm64')], 'amd64'));
  assert.throws(() => platformManifest([manifest('amd64'), manifest('amd64')], 'amd64'));
  assert.throws(() => platformManifest({ Descriptor: { digest: 'bad' } }, 'amd64'));
});

test('key is order independent and changes with digest, reference and runner platform', () => {
  const second = { ...image, ref: 'postgres:17' };
  const key = cacheKey([image, second], 'Linux', 'amd64');
  assert.equal(key, cacheKey([second, image], 'Linux', 'amd64'));
  for (const updated of [{ ...image, digest: digest('c') }, { ...image, ref: 'postgres:18' }]) {
    assert.notEqual(key, cacheKey([updated, second], 'Linux', 'amd64'));
  }
  assert.notEqual(key, cacheKey([image, second], 'Linux', 'arm64'));
  assert.throws(() => cacheKey([], 'Linux', 'amd64'));
});

test('unresolved or malformed registry response cannot produce a partial cache plan', () => {
  assert.throws(() => resolvePlan([ref], 'amd64', () => failed));
  assert.throws(() => resolvePlan([ref], 'amd64', () => ok('{}')));
  let n = 0;
  assert.throws(() => resolvePlan([ref, 'postgres:17'], 'amd64', () => ++n === 1 ? ok(JSON.stringify(manifest('amd64'))) : failed));
});

test('loaded image must match registry config digest; remove wrong tags before falling back', () => {
  const calls = [];
  const call = args => {
    calls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') return ok(args.at(-1) === ref ? digest('c') : image.id);
    return ok('');
  };
  assert.equal(admitImage(image, call), true);
  assert(calls.some(args => args[1] === 'rm' && args.at(-1) === ref));
  assert.deepEqual(calls.at(-1), ['tag', image.id, ref]);
  assert.throws(() => admitImage(image, args => args[1] === 'inspect' ? ok(digest('c')) : failed));
});

test('verified cache hit performs no registry pulls', async () => {
  const pull = () => assert.fail('cache hit must not pull');
  assert.equal(await warmImages({ images: [image] }, { call: () => ok(image.id), pull }), true);
});

test('cache miss pulls immutable manifest and retags the exact CLI name after verification', async () => {
  let pulled = false;
  const calls = [];
  const call = args => {
    calls.push(args);
    if (args[0] === 'tag') return ok('');
    return pulled && args.at(-1) === image.id ? ok(image.id) : failed;
  };
  const pull = async exact => {
    assert.equal(exact, `docker.io/supabase/postgres@${image.digest}`);
    pulled = true;
    return true;
  };
  assert.equal(await warmImages({ images: [image] }, { call, pull }), true);
  assert.deepEqual(calls.at(-1), ['tag', image.id, ref]);
});

test('pull failure and wrong content prohibit archive creation', async () => {
  for (const pulled of [false, true]) {
    assert.equal(await warmImages({ images: [image] }, { call: () => failed, pull: async () => pulled }), false);
  }
});

test('throttling retries with bounded exponential backoff; permanent errors stop immediately', async () => {
  let attempts = 0;
  const waits = [];
  const config = { maxAttempts: 3, baseMs: 1000, capMs: 2000, budgetMs: 10000 };
  const call = () => ++attempts === 3 ? ok('') : { status: 1, stderr: 'toomanyrequests: Data limit exceeded' };
  assert.equal(await retryPull(ref, { call, wait: async ms => waits.push(ms), config }), true);
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.equal(await retryPull(ref, { call: () => failed, wait: () => assert.fail(), config }), false);
});

test('all consumers use the cache, pinned external actions and explicit read permissions', () => {
  const workflows = ['ci', 'verify', 'ephemeral-db', ...[707, 797, 829, 831].map(n => `ovd${n}-pending-pgtap`)];
  for (const file of workflows) {
    const text = readFileSync(new URL(`../../workflows/${file}.yml`, import.meta.url), 'utf8');
    assert(text.includes('/supabase-image-cache'));
    assert(!text.includes('pull_request_target'));
    for (const use of text.matchAll(/uses: ([^\n]+)/g)) {
      if (use[1].startsWith('./')) continue;
      assert.match(use[1], /@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
    }
    assert.match(text, /^permissions:\n {2}contents: read/m);
  }
});

test('checked-in image versions agree with the actual pinned CLI (optional local binary)', { skip: !process.env.SUPABASE_CACHE_CLI }, t => {
  const cli = process.env.SUPABASE_CACHE_CLI;
  const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  assert.equal(version.stdout.trim(), CLI_VERSION);
  const binaryPath = cli.includes('/') ? cli : spawnSync('/usr/bin/which', [cli], { encoding: 'utf8' }).stdout.trim();
  const definitions = readFileSync(new URL('./cli-2.78.1-images.txt', import.meta.url));
  assert(readFileSync(binaryPath).includes(definitions), 'full embedded CLI image definitions must match the source fixture');
  const dir = mkdtempSync(join(tmpdir(), 'supabase-image-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'supabase'));
  writeFileSync(join(dir, 'supabase/config.toml'), 'project_id = "cache-source-check"\n');
  const result = spawnSync(cli, ['services', '--workdir', dir, '-o', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const refs = imageRefs('full', 'docker.io');
  for (const service of JSON.parse(result.stdout)) {
    if (service.name.endsWith('/supavisor')) continue; // Pooler defaults off in these jobs.
    assert(refs.includes(`${service.name}:${service.local}`), 'CLI service version drift; refresh source fixture');
  }
});


test('mirror attempts preserve the resolved digest and use the original Docker Hub repository', () => {
  const mirrored = { ...image, ref: 'library/kong:2.8.1', source: 'docker.io/library/kong' };
  assert.deepEqual(pullCandidates(mirrored), [
    `docker.io/library/kong@${image.digest}`,
    `ghcr.io/supabase/kong@${image.digest}`,
    `public.ecr.aws/supabase/kong@${image.digest}`,
  ]);
});

test('authenticated ECR is the primary source; Docker Hub and GHCR follow only as fallbacks', () => {
  assert.deepEqual(registryRepositories('public.ecr.aws/supabase/kong:2.8.1', 'public.ecr.aws'),
    ['public.ecr.aws/supabase/kong', 'docker.io/library/kong', 'ghcr.io/supabase/kong']);
  assert.deepEqual(registryRepositories('postgres:17', 'public.ecr.aws'),
    ['public.ecr.aws/docker/library/postgres', 'docker.io/library/postgres']);
  assert.deepEqual(registryRepositories('supabase/postgres:17.6.1.095'),
    ['docker.io/supabase/postgres', 'ghcr.io/supabase/postgres', 'public.ecr.aws/supabase/postgres']);
  assert.throws(() => registryRepositories('supabase/postgres:17.6.1.095', 'ghcr.io'));
  const calls = [];
  const plan = resolvePlan(imageRefs('tools', 'public.ecr.aws'), 'amd64', args => {
    calls.push(args.at(-1));
    return ok(JSON.stringify(manifest('amd64')));
  }, 'public.ecr.aws');
  assert.deepEqual(calls, ['public.ecr.aws/docker/library/postgres:17', 'public.ecr.aws/supabase/pg_prove:3.36']);
  assert.deepEqual(pullCandidates(plan.images[1]), [
    `public.ecr.aws/supabase/pg_prove@${image.digest}`,
    `docker.io/supabase/pg_prove@${image.digest}`,
    `ghcr.io/supabase/pg_prove@${image.digest}`,
  ]);
});

test('a fallback is admitted only at the primary digest; a mismatched fallback fails closed', async () => {
  const ecr = { ref: 'public.ecr.aws/supabase/postgres:17.6.1.095', source: 'public.ecr.aws/supabase/postgres', digest: image.digest, id: image.id };
  const attempts = [];
  for (const fallbackId of [image.id, digest('c')]) {
    let loaded = null;
    const call = args => {
      if (args[0] === 'tag') return ok('');
      if (args[0] === 'image' && args[1] === 'inspect') return loaded && args.at(-1) === loaded ? ok(loaded) : failed;
      return failed;
    };
    const pull = async exact => {
      attempts.push(exact);
      if (exact.startsWith('public.ecr.aws/')) return false; // primary unavailable
      assert(exact.endsWith(`@${image.digest}`), 'fallback must pull by the primary digest');
      loaded = fallbackId;
      return true;
    };
    assert.equal(await warmImages({ images: [ecr] }, { call, pull }), fallbackId === image.id);
  }
  assert.deepEqual(attempts.slice(0, 2), [`public.ecr.aws/supabase/postgres@${image.digest}`, `docker.io/supabase/postgres@${image.digest}`]);
});


for (const mode of ['unresolved', 'corrupt-load', 'warm-hit', 'ecr-primary']) {
  test(`CLI ${mode} keeps fresh resolution outside the archive and fails over safely`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'image-cache-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'docker');
    writeFileSync(fake, String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.CACHE_TEST_ROOT;
const mode = process.env.CACHE_TEST_MODE;
const state = path.join(root, 'pulled');
fs.appendFileSync(path.join(root, 'calls'), args.join(' ') + '\n');
if (args[0] === 'manifest') {
  if (mode === 'unresolved') process.exit(1);
  console.log(JSON.stringify({ Descriptor: {digest: '${image.digest}', platform: {os: 'linux', architecture: 'amd64'}}, OCIManifest: {config: {digest: '${image.id}'}}}));
} else if (args[0] === 'load') process.exit(1);
else if (args[0] === 'pull') fs.writeFileSync(state, 'yes');
else if (args[0] === 'image' && args[1] === 'inspect') {
  if (mode === 'warm-hit' || fs.existsSync(state)) console.log('${image.id}');
  else process.exit(1);
} else if (args[0] === 'save') fs.writeFileSync(args[2], 'synthetic archive');
`);
    chmodSync(fake, 0o700);
    const outputFile = join(dir, 'output');
    const envFile = join(dir, 'job-env');
    writeFileSync(outputFile, '');
    const env = { PATH: `${dir}:/usr/bin:/bin`, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      GITHUB_OUTPUT: outputFile, GITHUB_ENV: envFile, CACHE_TEST_ROOT: dir, CACHE_TEST_MODE: mode,
      CACHE_HIT: mode === 'warm-hit' ? 'true' : 'false' };
    const script = fileURLToPath(new URL('./cache.mjs', import.meta.url));
    const cacheDir = join(dir, 'cache');
    const registry = mode === 'ecr-primary' ? ['public.ecr.aws'] : [];
    for (const args of [['prepare', cacheDir, 'db', ...registry], ['warm', cacheDir]]) {
      const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, 'cache CLI must retain the normal start path');
      assert.equal(result.stdout, '', 'helper must not print environment values');
    }
    const outputs = readFileSync(outputFile, 'utf8');
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    assert.equal(readFileSync(envFile, 'utf8'), `SUPABASE_INTERNAL_IMAGE_REGISTRY=${registry[0] ?? 'docker.io'}\n`);
    if (mode === 'ecr-primary') {
      assert.match(calls, /^manifest inspect -v public\.ecr\.aws\/supabase\/postgres:17\.6\.1\.095$/m);
      assert.equal(calls.match(/^manifest /gm).length, 1, 'fallback registries never resolve the digest');
      assert.match(calls, new RegExp(String.raw`^pull public\.ecr\.aws/supabase/postgres@${image.digest}$`, 'm'));
      assert(!/^pull (docker\.io|ghcr\.io)/m.test(calls), 'primary succeeded; no fallback pull');
      assert.match(calls, /^image inspect --format \{\{\.Id\}\} public\.ecr\.aws\/supabase\/postgres:17\.6\.1\.095$/m);
      assert(outputs.includes('save=true'));
    } else if (mode === 'unresolved') {
      assert(!outputs.includes('key='));
      assert(!outputs.includes('save=true'));
      assert(!calls.includes('load'));
      assert(!calls.includes('save'));
    } else if (mode === 'corrupt-load') {
      assert(outputs.includes('key=supabase-images-v2-cli-'));
      assert(outputs.includes('save=true'));
      assert(calls.includes('pull'));
      assert(calls.includes('save'));
    } else {
      assert(!outputs.includes('save=true'));
      assert(!calls.includes('pull'));
      assert(!calls.includes('save'));
    }
  });
}

test('action restores only exact digest keys and saves only a verified miss', () => {
  const text = readFileSync(new URL('../../actions/supabase-image-cache/action.yml', import.meta.url), 'utf8');
  assert(!text.includes('restore-keys:'));
  assert(!text.includes('secrets.'));
  assert.equal([...text.matchAll(/key: \$\{\{ steps.plan.outputs.key \}\}/g)].length, 2);
  assert(text.includes("steps.restore.outputs.cache-hit != 'true' && steps.warm.outputs.save == 'true'"));
  for (const use of text.matchAll(/uses: ([^\n]+)/g)) assert.match(use[1], /@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
});

test('only the primary registry resolves the expected digest; fallbacks cannot define it', () => {
  const calls = [];
  const fallbackOnly = args => {
    calls.push(args.at(-1));
    return args.at(-1).startsWith('public.ecr.aws/') ? failed : ok(JSON.stringify(manifest('amd64')));
  };
  assert.throws(() => resolvePlan(['public.ecr.aws/supabase/postgres:17.6.1.095'], 'amd64', fallbackOnly, 'public.ecr.aws'));
  assert.deepEqual(calls, ['public.ecr.aws/supabase/postgres:17.6.1.095']);
  const plan = resolvePlan([ref], 'amd64', () => ok(JSON.stringify(manifest('amd64'))));
  assert.equal(plan.images[0].source, 'docker.io/supabase/postgres');
  assert.match(cacheKey(plan.images, 'Linux', 'amd64'), new RegExp(`cli-${CLI_VERSION}-`));
});

test('CI selects authenticated ECR only after a successful login', () => {
  const text = readFileSync(new URL('../../workflows/ci.yml', import.meta.url), 'utf8');
  const selector = "registry: ${{ steps.ecr-login.outcome == 'success' && 'public.ecr.aws' || 'docker.io' }}";
  assert.equal(text.split(selector).length - 1, 2);
  assert.match(text, /- name: Log in to ECR Public\n {8}id: ecr-login\n {8}if: \$\{\{ steps\.ecr-oidc\.outcome == 'success' \}\}/);
});

test('fork PRs cannot save image archives or dependency archives through shared actions', () => {
  for (const action of ['supabase-image-cache', 'save-apt-archives', 'setup-root-dependencies']) {
    const text = readFileSync(new URL(`../../actions/${action}/action.yml`, import.meta.url), 'utf8');
    assert(text.includes("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"));
  }
  for (const workflow of ['ci', 'verify']) {
    const text = readFileSync(new URL(`../../workflows/${workflow}.yml`, import.meta.url), 'utf8');
    for (const step of text.split(/\n {6}- name: /).filter(part => part.startsWith('Cache Playwright browsers'))) {
      assert(step.includes("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository"));
    }
  }
});

test('OVD-828 rollback preserves the current kill-switch authorization body exactly', () => {
  const definition = text => text.match(/create or replace function public\.api_admin_set_provider_kill_switch\([\s\S]*?\n\$\$;/i)?.[0];
  const baseline = readFileSync(new URL('../../../supabase/migrations/20261016000156_ovd767_admin_write_aal2_guards.sql', import.meta.url), 'utf8');
  const rollback = readFileSync(new URL('../../../docs/migration-drafts/ovd-828-s1.rollback.sql', import.meta.url), 'utf8');
  assert(definition(baseline));
  assert.equal(definition(rollback), definition(baseline));
});
