/** Official image SQL extraction only. Containers are never started. */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from './free-quote-ci-profile.mjs';

export const PLATFORMS = Object.freeze({
  auth: { image: 'public.ecr.aws/supabase/gotrue:v2.187.0', path: '/usr/local/etc/auth/migrations', pattern: /^\d+_.+\.up\.sql$/ },
  storage: { image: 'public.ecr.aws/supabase/storage-api:v1.41.8', path: '/app/migrations/tenant', pattern: /^\d+-.+\.sql$/ },
});
export function admitPlatformImage(value) {
  assert.match(value.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.Os, 'linux'); assert.equal(value.Architecture, 'amd64');
  assert.equal(Object.keys(value.Config?.Volumes ?? {}).length, 0, 'platform image must not create anonymous volumes');
  assert(Array.isArray(value.RepoDigests) && value.RepoDigests.length > 0, 'registry digest receipt required');
  return { id: value.Id, os: value.Os, architecture: value.Architecture, repoDigests: value.RepoDigests };
}
export function platformCreateArgs(state, imageId) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  return ['create', '--name', state.containerName, '--network', 'none', '--dns', '127.0.0.1',
    '--label', 'ovd591.owner=ovd591-disposable', '--label', `ovd591.source=${state.source}`, '--label', `ovd591.fixture=${state.token}`,
    '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,size=64m', imageId];
}
export function admitPlatformContainer(value, state, imageId) {
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Id, state.containerId);
  assert.equal(value.Name, '/' + state.containerName); assert.equal(value.Image, imageId);
  assert.equal(value.Config.Image, imageId);
  assert.equal(value.Config.Labels?.['ovd591.owner'], 'ovd591-disposable');
  assert.equal(value.Config.Labels?.['ovd591.source'], state.source); assert.equal(value.Config.Labels?.['ovd591.fixture'], state.token);
  assert(!state.before.containers.includes(value.Id), 'preexisting extraction container');
  assert.equal(value.State.Running, false); assert.equal(value.State.Status, 'created');
  assert.equal(value.HostConfig.NetworkMode, 'none'); assert.deepEqual(value.HostConfig.Dns, ['127.0.0.1']);
  assert.equal(value.HostConfig.Privileged, false); assert.equal((value.HostConfig.CapAdd ?? []).length, 0);
  assert.equal((value.HostConfig.Devices ?? []).length, 0);
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode']) assert(!['host'].includes(value.HostConfig[key]), 'host namespace');
  assert.equal(Object.keys(value.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(value.HostConfig.NanoCpus, 1_000_000_000); assert.equal(value.HostConfig.Memory, 512 * 1024 ** 2);
  assert.equal(value.HostConfig.PidsLimit, 64); assert.equal(value.HostConfig.RestartPolicy?.Name, 'no');
  assert((value.HostConfig.SecurityOpt ?? []).some(option => option === 'no-new-privileges' || option === 'no-new-privileges:true'));
  assert.deepEqual(value.HostConfig.Tmpfs, { '/tmp': 'rw,nosuid,size=64m' });
  assert.equal((value.Mounts ?? []).filter(mount => mount.Type === 'bind' || mount.Type === 'volume').length, 0);
}
export function readPlatformSources(directory, kind, expected) {
  const spec = PLATFORMS[kind]; assert(spec);
  assert.equal(realpathSync(directory), resolve(directory), 'symlinked extraction directory');
  const names = readdirSync(directory, { withFileTypes: true }).filter(entry => spec.pattern.test(entry.name));
  assert(names.every(entry => entry.isFile() && !entry.isSymbolicLink()), 'platform SQL must be regular files');
  const sorted = names.map(entry => entry.name).sort(kind === 'auth' ? undefined : (a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
  assert.deepEqual(sorted, expected.map(entry => entry.name), 'official platform migration set/order drift');
  return Object.fromEntries(expected.map(entry => {
    const raw = readFileSync(join(directory, entry.name), 'utf8'); assert.equal(hash(raw), entry.sha256, `platform hash differs: ${entry.name}`);
    return [entry.name, raw];
  }));
}

/** Uses the existing owner-checked cleanup for every sequential extraction state. */
export async function extractPlatformSources({ root, out, state, inputs, call, inventory, cleanup, persist, evidence }) {
  state.platformSources = [];
  const result = {};
  for (const kind of ['auth', 'storage']) {
    const spec = PLATFORMS[kind];
    const directory = join(out, `${kind}-extraction`); mkdirSync(directory, { mode: 0o700 });
    const child = { schemaVersion: 1, profile: 'free-quote-platform', token: state.token, source: state.source,
      before: await inventory(), containerName: `${state.containerName}-${kind}`, containerId: null,
      networkName: `${state.containerName}-${kind}-unused`, networkId: null, containerAttempted: false, networkAttempted: false,
      out: directory, cleaned: false };
    state.platformSources.push(child); persist();
    try {
      await call('docker', ['pull', spec.image], { timeout: 300_000, label: `${kind}-image-pull` });
      const image = JSON.parse((await call('docker', ['image', 'inspect', spec.image], { private: true })).stdout)[0];
      const imageReceipt = admitPlatformImage(image);
      const names = (await call('docker', ['container', 'ls', '-a', '--format', '{{.Names}}'])).stdout.trim().split(/\r?\n/);
      assert(!names.includes(child.containerName), 'platform extraction name collision');
      child.containerAttempted = true; persist();
      child.containerId = (await call('docker', platformCreateArgs(child, image.Id), { label: `${kind}-source-create` })).stdout.trim();
      assert.match(child.containerId, /^[a-f0-9]{64}$/); persist();
      const info = JSON.parse((await call('docker', ['inspect', child.containerId], { private: true })).stdout)[0];
      admitPlatformContainer(info, child, image.Id);
      const files = join(directory, 'sql');
      await call('docker', ['cp', `${child.containerId}:${spec.path}`, files], { label: `${kind}-source-copy` });
      result[kind] = readPlatformSources(files, kind, inputs.platform[kind]);
      evidence.save(`${kind}-platform-source.json`, { image: spec.image, ...imageReceipt, files: inputs.platform[kind],
        containerId: child.containerId, started: false, network: 'none' });
    } finally {
      await cleanup({ root, out: directory, state: child });
      child.cleaned = true; persist();
    }
  }
  return result;
}
