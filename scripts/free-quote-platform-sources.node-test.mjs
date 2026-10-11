/** Offline image/extraction contracts, not Docker or SQL acceptance. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash } from './free-quote-ci-profile.mjs';
import { PLATFORMS, admitPlatformImage, platformCreateArgs, admitPlatformContainer, readPlatformSources, extractPlatformSources } from './free-quote-platform-sources.mjs';
const id = 'a'.repeat(64), source = 'b'.repeat(40), imageId = 'sha256:' + 'c'.repeat(64);
const state = () => ({ token: 'synthetic-token', source, containerId: id, containerName: 'ovd591-inert-auth', before: { containers: [] } });
const image = () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { Volumes: {} }, RepoDigests: ['official@sha256:' + 'd'.repeat(64)] });
const container = () => ({ Id: id, Name: '/ovd591-inert-auth', Image: imageId,
  Config: { Image: imageId, Labels: { 'ovd591.owner': 'ovd591-disposable', 'ovd591.source': source, 'ovd591.fixture': 'synthetic-token' } },
  State: { Running: false, Status: 'created' }, Mounts: [],
  HostConfig: { NetworkMode: 'none', Dns: ['127.0.0.1'], Privileged: false, CapAdd: [], Devices: [],
    PortBindings: {}, NanoCpus: 1_000_000_000, Memory: 512 * 1024 ** 2, PidsLimit: 64,
    RestartPolicy: { Name: 'no' }, SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': 'rw,nosuid,size=64m' } } });
const temp = t => { const path = mkdtempSync(join(tmpdir(), 'free-platform-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };

test('official platform image rejects volumes, foreign architecture and absent registry digest', () => {
  admitPlatformImage(image());
  for (const patch of [{ Config: { Volumes: { '/data': {} } } }, { Architecture: 'arm64' }, { Os: 'windows' }, { RepoDigests: [] }]) assert.throws(() => admitPlatformImage({ ...image(), ...patch }));
});
test('extraction has fixed network-none containment and never receives a command to start', () => {
  const args = platformCreateArgs(state(), imageId);
  assert.equal(args[0], 'create'); assert.equal(args.at(-1), imageId);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert(!args.some(arg => /--publish|--volume|--mount|--privileged|--env|password/.test(arg)));
  admitPlatformContainer(container(), state(), imageId);
  for (const mutate of [v => v.State.Running = true, v => v.State.Status = 'exited', v => v.Config.Labels['ovd591.source'] = 'foreign',
    v => v.HostConfig.NetworkMode = 'bridge', v => v.HostConfig.PidMode = 'host', v => v.HostConfig.Dns = [],
    v => v.HostConfig.CapAdd = ['SYS_ADMIN'], v => v.HostConfig.Devices = ['/dev/kvm'], v => v.HostConfig.Privileged = true,
    v => v.HostConfig.PortBindings = { '5432/tcp': [] }, v => v.HostConfig.NanoCpus = 0, v => v.HostConfig.Memory = 0,
    v => v.HostConfig.PidsLimit = 0, v => v.HostConfig.Tmpfs = {}, v => v.Mounts = [{ Type: 'volume' }],
    v => v.HostConfig.RestartPolicy.Name = 'always']) { const v = container(); mutate(v); assert.throws(() => admitPlatformContainer(v, state(), imageId)); }
});
test('extracted platform filenames/order and every byte must match reviewed manifest', t => {
  const directory = temp(t), raw = '-- inert', expected = [{ name: '2-inert.sql', sha256: hash(raw) }, { name: '10-inert.sql', sha256: hash(raw) }];
  for (const entry of expected) writeFileSync(join(directory, entry.name), raw);
  assert.equal(Object.keys(readPlatformSources(directory, 'storage', expected)).length, 2);
  assert.throws(() => readPlatformSources(directory, 'storage', [...expected].reverse()));
  writeFileSync(join(directory, '10-inert.sql'), '-- changed'); assert.throws(() => readPlatformSources(directory, 'storage', expected));
});
test('symlinked or extra selected platform SQL cannot enter bootstrap', t => {
  const directory = temp(t); writeFileSync(join(directory, 'source'), 'select 1;'); symlinkSync('source', join(directory, '1-linked.sql'));
  assert.throws(() => readPlatformSources(directory, 'storage', [{ name: '1-linked.sql', sha256: hash('select 1;') }]));
});

function simulation(t, fault) {
  const out = temp(t), parent = { containerName: 'ovd591-inert', source, token: 'synthetic-token' }, events = [];
  const spec = { auth: [{ name: '00_inert.up.sql', sha256: hash('-- inert') }], storage: [{ name: '1-inert.sql', sha256: hash('-- inert') }] };
  let live = null;
  const call = async (_command, args) => {
    events.push(args);
    if (fault) fault(args);
    if (args[0] === 'pull') return { status: 0, stdout: '', stderr: '', failure: null };
    if (args[0] === 'image') return { stdout: JSON.stringify([image()]) };
    if (args[0] === 'container') return { stdout: '' };
    if (args[0] === 'create') { live = args[args.indexOf('--name') + 1]; return { stdout: id }; }
    if (args[0] === 'inspect') { const v = container(); v.Name = '/' + live; return { stdout: JSON.stringify([v]) }; }
    if (args[0] === 'cp') {
      mkdirSync(args[2]); const kind = args[1].includes(PLATFORMS.auth.path) ? 'auth' : 'storage';
      writeFileSync(join(args[2], spec[kind][0].name), '-- inert'); return { stdout: '' };
    }
    throw Error('unexpected simulated command');
  };
  const cleanup = async ({ state }) => { events.push(['cleanup', state.containerName]); live = null; };
  return { parent, events, run: () => extractPlatformSources({ root: '/inert', out, state: parent, inputs: { platform: spec }, call,
    inventory: async () => ({ containers: ['database-id'], networks: [], volumes: [] }), cleanup, persist: () => {}, evidence: { save: () => {} } }) };
}
test('sequential extraction is fully recorded before create and cleans auth before storage; no start', async t => {
  const s = simulation(t), result = await s.run(); assert.deepEqual(Object.keys(result), ['auth', 'storage']);
  assert.equal(s.events.filter(args => args[0] === 'create').length, 2); assert(!s.events.some(args => args[0] === 'start'));
  assert(s.events.findIndex(args => args[0] === 'cleanup') < s.events.findIndex(args => args.includes(PLATFORMS.storage.image)));
  assert(s.parent.platformSources.every(child => child.cleaned && child.containerAttempted && child.containerId === id));
});
for (const phase of ['pull', 'create', 'inspect', 'cp']) test(`extraction ${phase} failure still calls owner cleanup and stops second image`, async t => {
  const s = simulation(t, args => { if (args[0] === phase) throw new Error('inert failure'); });
  await assert.rejects(s.run(), /inert failure/); assert.equal(s.events.filter(args => args[0] === 'cleanup').length, 1);
  assert(!s.events.some(args => args.includes(PLATFORMS.storage.image)));
});
