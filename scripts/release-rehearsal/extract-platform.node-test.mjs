import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CANDIDATE, BASE_RUNNER, LIMITS, configBinding, planExtraction, parsePlatformArchive,
  createPlatformExtractor, createPlatformExtractorForTests, executeBinary } from './extract-platform.mjs';

const digest = b => createHash('sha256').update(b).digest('hex');
const self = fileURLToPath(new URL('./extract-platform.mjs', import.meta.url));
function checksum(h) { h.fill(32, 148, 156); let n = 0; for (const b of h) n += b; h.write(n.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii'); return h; }
function entry(name, body = Buffer.alloc(0), type = '0', change = () => {}) {
  const h = Buffer.alloc(512); h.write(name); h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write(type, 156); h.write('ustar\0' + '00', 257, 'latin1'); change(h); checksum(h);
  return Buffer.concat([h, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);
function pax(record) { let n = Buffer.byteLength(record) + 3; while (Buffer.byteLength(n + ' ' + record + '\n') !== n) n = Buffer.byteLength(n + ' ' + record + '\n'); return Buffer.from(n + ' ' + record + '\n'); }
const sql = Buffer.from('select 1;\r\n');
const one = [{ name: '1_test.up.sql', sha256: digest(sql) }];
const parse = bytes => parsePlatformArchive({ kind: 'auth', archive: bytes, expected: one });

test('parser preserves raw bytes and accepts bounded local PAX path and timestamps', () => {
  const body = Buffer.concat([pax('path=migrations/1_test.up.sql'), pax('mtime=1.123456789'), pax('atime=-0.1'), pax('ctime=0')]);
  const got = parse(tar(entry('migrations/', Buffer.alloc(0), '5'), entry('PaxHeaders/file', body, 'x'), entry('migrations/fallback.sql', sql)));
  assert.deepEqual(got.files.get(one[0].name), sql); assert.equal(got.paxBytes, body.length);
});
test('basic GNU ustar, optional ./ prefix and ignored regular auxiliary file', () => {
  const got = parse(tar(entry('./migrations/README', Buffer.from('metadata')), entry('./migrations/1_test.up.sql', sql, '0', h => h.write('ustar ' + ' \0', 257, 'latin1'))));
  assert.equal(got.files.size, 1);
});
test('parser accepts non-UTF8 SQL as bytes, never as decoded text', () => {
  const bytes = Buffer.from([255, 0, 254, 13, 10]); const expected = [{ ...one[0], sha256: digest(bytes) }];
  assert.deepEqual(parsePlatformArchive({ kind: 'auth', archive: tar(entry('migrations/1_test.up.sql', bytes)), expected }).files.get(one[0].name), bytes);
});
for (const [label, bytes] of [
  ['absolute', tar(entry('/migrations/1_test.up.sql', sql))], ['dotdot', tar(entry('migrations/../1_test.up.sql', sql))],
  ['nested', tar(entry('migrations/nested/1_test.up.sql', sql))], ['backslash', tar(entry('migrations\\1_test.up.sql', sql))],
  ['wrong root', tar(entry('tenant/1_test.up.sql', sql))], ['directory suffix', tar(entry('migrations/1_test.up.sql/', sql))],
  ['duplicate', tar(entry('migrations/1_test.up.sql', sql), entry('migrations/1_test.up.sql', sql))],
  ['extra selected', tar(entry('migrations/1_test.up.sql', sql), entry('migrations/2_extra.up.sql', sql))],
  ['missing', tar(entry('migrations/README', sql))], ['hash drift', tar(entry('migrations/1_test.up.sql', Buffer.from('select 2;')))],
  ['body padding', (() => { const b = tar(entry('migrations/1_test.up.sql', sql)); b[512 + sql.length] = 1; return b; })()],
  ['checksum', (() => { const b = tar(entry('migrations/1_test.up.sql', sql)); b[3] ^= 1; return b; })()],
  ['truncated', tar(entry('migrations/1_test.up.sql', sql)).subarray(0, 1025)],
  ['one end block', tar(entry('migrations/1_test.up.sql', sql)).subarray(0, -512)],
  ['trailer', Buffer.concat([tar(entry('migrations/1_test.up.sql', sql)), Buffer.alloc(512, 1)])],
  ['directory data', tar(entry('migrations/', sql, '5'), entry('migrations/1_test.up.sql', sql))],
  ['base256', tar(entry('migrations/1_test.up.sql', sql, '0', h => { h[124] = 128; }))],
  ['bad octal', tar(entry('migrations/1_test.up.sql', sql, '0', h => { h[125] = 57; }))],
  ['unsupported format', tar(entry('migrations/1_test.up.sql', sql, '0', h => h.fill(0, 257, 265)))],
  ['invalid UTF8 name', tar(entry('migrations/1_test.up.sql', sql, '0', h => { h[11] = 255; }))],
]) test('rejects ' + label, () => assert.throws(() => parse(bytes)));
for (const type of ['1', '2', '3', '4', '6', 'S', 'L', 'K', 'g']) test('rejects unsupported tar type ' + type, () => assert.throws(() => parse(tar(entry('migrations/1_test.up.sql', sql, type)))));
for (const [label, body] of [
  ['size override', pax('size=1')], ['link override', pax('linkpath=other')], ['global-like key', pax('SCHILY.xattr.security.capability=x')],
  ['duplicate key', Buffer.concat([pax('mtime=0'), pax('mtime=1')])], ['traversal', pax('path=../escape')],
  ['timestamp precision', pax('mtime=0.1234567890')], ['incorrect record length', Buffer.from('99 path=migrations/1_test.up.sql\n')],
  ['high-bit length byte', (() => { const b = pax('mtime=0'); b[0] |= 128; return b; })()],
  ['invalid UTF8 value', Buffer.concat([Buffer.from('10 path='), Buffer.from([255]), Buffer.from('\n')])],
]) test('rejects PAX ' + label, () => assert.throws(() => parse(tar(entry('PaxHeaders/x', body, 'x'), entry('migrations/1_test.up.sql', sql)))));
test('PAX cannot stack, remain pending, or precede a link', () => {
  const x = entry('PaxHeaders/x', pax('mtime=0'), 'x');
  for (const b of [tar(x), tar(x, x, entry('migrations/1_test.up.sql', sql)), tar(x, entry('migrations/1_test.up.sql', sql, '2'))]) assert.throws(() => parse(b));
});
test('archive/member/PAX bounds reject oversized declarations and inputs', () => {
  assert.throws(() => parse(Buffer.alloc(LIMITS.archive + 512)), /archive_size/);
  assert.throws(() => parse(tar(entry('migrations/1_test.up.sql', sql, '0', h => h.write((LIMITS.member + 1).toString(8).padStart(11, '0') + '\0', 124)))), /member_size/);
  assert.throws(() => parse(tar(entry('PaxHeaders/x', Buffer.alloc(LIMITS.paxBody + 1), 'x'))), /member_size/);
});
test('storage selection uses numeric ordinal order and duplicate ordinals fail', () => {
  const expected = [{ name: '2-a.sql', sha256: digest(sql) }, { name: '10-b.sql', sha256: digest(sql) }];
  assert.equal(parsePlatformArchive({ kind: 'storage', archive: tar(entry('tenant/10-b.sql', sql), entry('tenant/2-a.sql', sql)), expected }).files.size, 2);
  assert.throws(() => parsePlatformArchive({ kind: 'storage', archive: Buffer.alloc(1024), expected: [...expected, { name: '02-other.sql', sha256: digest(sql) }] }), /duplicate/);
});

function harness(t, hook = () => {}) {
  const parent = fs.mkdtempSync(path.join(process.cwd(), '.ovd659-test-')); fs.chmodSync(parent, 0o700); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const fakeTool = path.join(parent, 'inert-tool'); fs.writeFileSync(fakeTool, 'never executed; fake transport only', { mode: 0o600 });
  const socket = path.join(parent, 'fake-socket'); fs.writeFileSync(socket, 'inert fixture path', { mode: 0o600 });
  const files = {}, manifest = {}, archives = {};
  for (const [kind, count, root] of [['auth', 68, 'migrations'], ['storage', 56, 'tenant']]) {
    files[kind] = new Map(Array.from({ length: count }, (_, i) => [kind === 'auth' ? String(i + 1).padStart(3, '0') + '_fixture.up.sql' : (i + 1) + '-fixture.sql', Buffer.from(`synthetic ${kind} ${i}\r\n`)]));
    manifest[kind] = [...files[kind]].map(([name, body]) => ({ name, sha256: digest(body) }));
    archives[kind] = tar(entry(root + '/', Buffer.alloc(0), '5'), ...[...files[kind]].map(([name, body]) => entry(root + '/' + name, body)));
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  const lease = { schema: 'overdrafter.local-fixture-exclusive-lease.v1', ownerUnit: 'extraction659runtime', host: 'saved-cloud-20261008', socket, token: 'a'.repeat(32), expiresAt: new Date(Date.now() + 3600000).toISOString(), exclusive: true };
  const leasePath = path.join(parent, 'lease.json'); fs.writeFileSync(leasePath, JSON.stringify(lease), { mode: 0o600 });
  const config = { schema: 'overdrafter.platform-extraction-config.v1', tools: { docker: { path: fakeTool, sha256: digest(fs.readFileSync(fakeTool)) }, socket },
    images: { auth: { id: 'sha256:' + 'a'.repeat(64), digest: 'public.ecr.aws/supabase/gotrue@sha256:' + 'c'.repeat(64), entrypoint: ['/never-start'], cmd: null }, storage: { id: 'sha256:' + 'b'.repeat(64), digest: 'public.ecr.aws/supabase/storage-api@sha256:' + 'd'.repeat(64), entrypoint: null, cmd: ['/never-start'] } },
    parentDirectory: parent, lease: { path: leasePath, sha256: digest(fs.readFileSync(leasePath)) } };
  config.admission = { schema: 'overdrafter.platform-extraction-admission.v1', qualification: 'authentic-platform-source-only', candidateCommit: CANDIDATE, baseRunnerCommit: BASE_RUNNER, extractorCommit: 'e'.repeat(40), extractorSha256: digest(fs.readFileSync(self)), configBindingSha256: configBinding(config), platformManifestSha256: digest(bytes), leaseSha256: config.lease.sha256, expiresAt: lease.expiresAt };
  let elapsed = 0, resource = null, index = 0; const calls = [];
  const ok = data => ({ status: 0, signal: null, failure: null, stdout: Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), stderr: Buffer.alloc(0), elapsedMs: 1 });
  const state = { get resource() { return resource; }, set resource(v) { resource = v; }, get time() { return elapsed; }, set time(v) { elapsed = v; }, config, parent, files, archives, manifest, calls, ok };
  async function transport(binary, full, opts) {
    assert.equal(binary, fakeTool); assert.deepEqual(full.slice(0, 2), ['--host', 'unix://' + socket]);
    const args = full.slice(2); calls.push(args); elapsed += 1;
    assert.equal(opts.env.HOME.startsWith(parent + '/ovd659-'), true); assert.equal(fs.readdirSync(opts.env.DOCKER_CONFIG).length, 0);
    assert.deepEqual(Object.keys(opts.env).sort(), ['DOCKER_CONFIG', 'HOME', 'LANG', 'LC_ALL', 'PATH']);
    assert(!args.includes('--force')); assert(!['start', 'exec', 'run', 'pull', 'login', 'build'].includes(args[0]));
    if (args.includes('--format')) { assert(!args.join(' ').includes('Config.Env')); assert(!args.includes('{{json .}}')); }
    const override = await hook({ args, opts, state }); if (override !== undefined) return override;
    if (args[0] === 'network') { assert.equal(args[1], 'ls'); return ok(''); }
    if (args[0] === 'image') {
      const kind = args.at(-1) === config.images.auth.id ? 'auth' : 'storage', v = config.images[kind];
      return ok({ Id: v.id, Os: 'linux', Architecture: 'amd64', RepoDigests: [v.digest], Entrypoint: v.entrypoint, Cmd: v.cmd, VolumeCount: 0, ConflictingOwner: false });
    }
    if (args[0] === 'create') {
      assert.equal(resource, null); assert(args.includes('--pull=never')); assert(args.includes('--read-only')); assert(args.includes('--cap-drop'));
      const kind = args.at(-1) === config.images.auth.id ? 'auth' : 'storage', name = args[args.indexOf('--name') + 1];
      const intent = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'state.json'))).containers.at(-1); assert.equal(intent.name, name); assert.equal(intent.id, null); assert.equal(intent.uncertain, true);
      resource = { kind, name, id: (++index).toString(16).padStart(64, '0'), token: args.find(a => a.startsWith('ovd659.fixture=')).split('=')[1] }; return ok(resource.id + '\n');
    }
    if (args[0] === 'container' && args[1] === 'ls') return ok(resource ? resource.id + '\n' : '');
    if (args[0] === 'container' && args[1] === 'inspect') {
      assert(resource); const v = config.images[resource.kind];
      return ok({ Id: resource.id, Name: '/' + resource.name, Image: v.id, ConfigImage: v.id, Owner: 'platform-extraction', Source: CANDIDATE, Token: resource.token,
        Entrypoint: v.entrypoint, Cmd: v.cmd, VolumeCount: 0, Status: 'created', Running: false, StartedAt: '0001-01-01T00:00:00Z', RestartCount: 0, MountCount: 0, BindCount: 0, HostMountCount: 0,
        NetworkMode: 'none', Dns: ['127.0.0.1'], Privileged: false, ReadonlyRootfs: true, CapAdd: null, CapDrop: ['ALL'], Devices: [], DeviceRequests: null, PortBindings: {}, PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', NanoCpus: 1e9, Memory: 512 * 1024 ** 2, PidsLimit: 64, RestartPolicy: 'no', SecurityOpt: ['no-new-privileges'], Tmpfs: null, ...state.inspectOverride });
    }
    if (args[0] === 'cp') { assert(resource); assert.equal(args.at(-1), '-'); return ok(archives[resource.kind]); }
    if (args[0] === 'rm') { assert.equal(args[1], resource.id); resource = null; return ok(args[1] + '\n'); }
    throw new Error('unexpected fake command: ' + args.join(' '));
  }
  const options = { config, manifestBytes: bytes }, dependencies = { execute: transport, now: () => elapsed, manifestBytes: bytes };
  return { ...state, options, dependencies, state, run: () => createPlatformExtractorForTests(options, dependencies).execute() };
}
test('fake full extraction publishes exactly124 raw files only after sequential removals', async t => {
  const h = harness(t); const result = await h.run(); assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.qualification, 'fake-transport-only');
  assert.equal(result.files.length, 124); assert.equal(result.containers.length, 2); assert(result.containers.every(c => c.cleanup === 'removed_and_observed_absent'));
  for (const kind of ['auth', 'storage']) for (const [name, body] of h.files[kind]) assert.deepEqual(fs.readFileSync(path.join(result.publishedBundle, 'platform', kind, name)), body);
  assert.equal(h.calls.filter(c => c[0] === 'create').length, 2); assert.equal(h.calls.filter(c => c[0] === 'rm').length, 2); assert(h.calls.length < LIMITS.commands);
  const creates = h.calls.flatMap((c, i) => c[0] === 'create' ? [i] : []), removes = h.calls.flatMap((c, i) => c[0] === 'rm' ? [i] : []); assert(removes[0] < creates[1]);
});
test('production factory and plan reject synthetic manifest; import/factory do not execute', t => {
  const h = harness(t); assert.throws(() => createPlatformExtractor(h.options), /manifest_pin/); assert.throws(() => planExtraction(h.options), /manifest_pin/); assert.equal(h.calls.length, 0);
  createPlatformExtractorForTests(h.options, h.dependencies); assert.equal(h.calls.length, 0); assert.equal(fs.readdirSync(h.parent).filter(n => n.startsWith('ovd659-')).length, 0);
});
for (const [name, mutate] of [
  ['extra config', h => { h.options.config.extra = true; }], ['wrong candidate', h => { h.options.config.admission.candidateCommit = '0'.repeat(40); }],
  ['expired', h => { h.options.config.admission.expiresAt = '2000-01-01T00:00:00Z'; }], ['source hash', h => { h.options.config.admission.extractorSha256 = '0'.repeat(64); }],
  ['unknown dependency', h => { h.dependencies.extra = true; }], ['manifest hash', h => { h.options.manifestBytes = Buffer.from('{}'); }],
  ['lease drift', h => { fs.appendFileSync(h.options.config.lease.path, ' '); }], ['parent mode', h => { fs.chmodSync(h.parent, 0o755); }],
]) test('admission rejects ' + name + ' before commands', t => { const h = harness(t); mutate(h); assert.throws(() => createPlatformExtractorForTests(h.options, h.dependencies)); assert.equal(h.calls.length, 0); });
test('pre-existing container blocks with ID-only inventory; no inspect', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'container' && args[1] === 'ls' ? state.ok('f'.repeat(64)) : undefined);
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'preexisting_container'); assert.equal(h.calls.length, 1);
});
test('label-filtered network conflict blocks without image/container inspect', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'network' ? state.ok('f'.repeat(64)) : undefined); const r = await h.run(); assert.equal(r.error, 'fixture_network_conflict'); assert(!h.calls.some(a => a.includes('inspect')));
});
test('image policy refuses anonymous volume before create', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'image' ? state.ok({ Id: state.config.images.auth.id, Os: 'linux', Architecture: 'amd64', RepoDigests: [state.config.images.auth.digest], VolumeCount: 1 }) : undefined);
  const r = await h.run(); assert.equal(r.error, 'cached_image_policy'); assert(!h.calls.some(a => a[0] === 'create'));
});
test('corrupt archive fails; owned resource removed and no second extraction or bundle', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'cp' ? state.ok(Buffer.alloc(1024)) : undefined); const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1); assert.equal(h.calls.filter(a => a[0] === 'rm').length, 1);
});
for (const late of [false, true]) test('timed-out create remains unconfirmed with ' + (late ? 'late owned cleanup' : 'empty inventory'), async t => {
  const h = harness(t, ({ args, state }) => {
    if (args[0] !== 'create') return;
    if (late) state.resource = { kind: 'auth', id: '9'.repeat(64), name: args[args.indexOf('--name') + 1], token: args.find(a => a.startsWith('ovd659.fixture=')).split('=')[1] };
    return { ...state.ok(''), status: null, signal: 'SIGKILL', failure: 'timeout' };
  });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.reason, 'creation_unconfirmed'); assert.equal(r.cleanup.retainExclusiveLease, true); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1); assert.equal(h.calls.filter(a => a[0] === 'rm').length, late ? 1 : 0);
});
test('malformed successful create acknowledgment is never retried or accepted', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'create' ? state.ok('not-an-id') : undefined); const r = await h.run(); assert.equal(r.error, 'create_ack'); assert.equal(r.cleanup.reason, 'creation_unconfirmed'); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
});
test('failed rm stays failed even when its side effect is observed absent', async t => {
  const h = harness(t, ({ args, state }) => { if (args[0] === 'rm') { state.resource = null; return { ...state.ok(''), status: 1 }; } });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'removal_unconfirmed'); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
});
test('work deadline consumes one fixed cleanup reserve and forbids next phase', async t => {
  const h = harness(t, ({ args, state }) => { if (args[0] === 'cp') { state.time = LIMITS.totalMs - LIMITS.cleanupMs + 1; return state.ok(state.archives.auth); } });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'deadline_exhausted'); assert.equal(r.cleanup.status, 'removed_and_observed_absent'); assert.equal(r.deadlines.totalDeadline, LIMITS.totalMs); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
});
test('exhausted total deadline cannot obtain a fresh cleanup budget', async t => {
  const h = harness(t, ({ args, state }) => { if (args[0] === 'cp') { state.time = LIMITS.totalMs + 1; return state.ok(state.archives.auth); } }); const r = await h.run(); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.reason, 'deadline_or_command_limit'); assert.equal(h.calls.filter(a => a[0] === 'rm').length, 0);
});
test('lease drift during work blocks further commands and leaves cleanup uncertainty', async t => {
  const h = harness(t, ({ args, state }) => { if (args[0] === 'cp') fs.appendFileSync(state.config.lease.path, ' '); }); const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.publishedBundle, null);
});
test('publication destination collision never overwrites an existing directory', async t => {
  let removed = 0;
  const h = harness(t, ({ args, opts }) => { if (args[0] === 'rm' && ++removed === 2) fs.mkdirSync(path.join(opts.cwd, 'bundle'), { mode: 0o700 }); }); const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'publication_collision'); assert.equal(r.publishedBundle, null);
});
test('rename succeeds then fsync fails: publication unconfirmed with recoverable path', async t => {
  const original = fsDefault.fsyncSync; let renamed = false;
  const rename = fsDefault.renameSync;
  t.mock.method(fsDefault, 'renameSync', (from, to) => { rename(from, to); if (path.basename(to) === 'bundle') renamed = true; });
  t.mock.method(fsDefault, 'fsyncSync', fd => { if (renamed) throw new Error('inert injected fsync failure'); return original(fd); });
  // Namespace imports follow builtin named exports only after synchronization.
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const h = harness(t); const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.publication, 'publication_unconfirmed'); assert.equal(r.publishedBundle, null); assert(fs.existsSync(r.intendedBundle));
});
test('binary executor preserves bytes using inert Node only', async () => {
  const r = await executeBinary(process.execPath, ['-e', 'process.stdout.write(Buffer.from([255,0,254]));'], { cwd: os.tmpdir(), env: {}, timeoutMs: 1000, stdoutLimit: 100, stderrLimit: 100 });
  assert.equal(r.status, 0); assert.deepEqual(r.stdout, Buffer.from([255, 0, 254])); assert.equal(r.failure, null);
});
test('binary executor rejects excessive output, signals, nonzero and timeout', async () => {
  const opts = { cwd: os.tmpdir(), env: {}, timeoutMs: 300, stdoutLimit: 32, stderrLimit: 32 };
  const large = await executeBinary(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(100000));'], opts); assert.equal(large.failure, 'output_limit'); assert.equal(large.stdout.length, 32);
  const signal = await executeBinary(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM");'], opts); assert.equal(signal.failure, 'signalled');
  const failed = await executeBinary(process.execPath, ['-e', 'process.exit(7);'], opts); assert.equal(failed.status, 7);
  const timeout = await executeBinary(process.execPath, ['-e', 'setTimeout(()=>{},10000);'], { ...opts, timeoutMs: 30 }); assert.equal(timeout.failure, 'timeout');
});
for (const [name, change] of [
  ['owner drift', { Owner: 'someone-else' }], ['running', { Status: 'running', Running: true }],
  ['previously started', { StartedAt: '2026-10-09T00:00:00Z' }], ['volume', { MountCount: 1 }],
  ['privileged', { Privileged: true }], ['host networking', { NetworkMode: 'host' }],
  ['host namespace', { IpcMode: 'host' }], ['added capability', { CapAdd: ['SYS_ADMIN'] }],
  ['published port', { PortBindings: { '5432/tcp': [{}] } }], ['CPU limit', { NanoCpus: 0 }],
]) test('owned inspection rejects ' + name + ' and never forces cleanup', async t => {
  const h = harness(t, ({ args, state }) => { if (args[0] === 'container' && args[1] === 'inspect') state.inspectOverride = change; });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.publishedBundle, null); assert(!h.calls.some(a => a[0] === 'rm' || a[0] === 'cp'));
});
test('oversized metadata and nonzero successful-looking tar never publish', async t => {
  const h = harness(t, ({ args, state }) => args[0] === 'image' ? state.ok(Buffer.alloc(LIMITS.metadata + 1)) : undefined); const r = await h.run(); assert.equal(r.error, 'transport_output_limit'); assert(!h.calls.some(a => a[0] === 'create'));
  const h2 = harness(t, ({ args, state }) => args[0] === 'cp' ? { ...state.ok(state.archives.auth), status: 1 } : undefined); const r2 = await h2.run(); assert.equal(r2.error, 'command_failed'); assert.equal(r2.publishedBundle, null); assert.equal(h2.calls.filter(a => a[0] === 'create').length, 1);
});
test('aggregate selected-byte cap applies across both individually valid archives', async t => {
  const h = harness(t);
  for (const [kind, count, root] of [['auth', 5, 'migrations'], ['storage', 4, 'tenant']]) {
    const names = [...h.files[kind].keys()];
    for (const name of names.slice(0, count)) h.files[kind].set(name, Buffer.alloc(LIMITS.member, 65));
    h.manifest[kind] = [...h.files[kind]].map(([name, body]) => ({ name, sha256: digest(body) }));
    h.archives[kind] = tar(...[...h.files[kind]].map(([name, body]) => entry(root + '/' + name, body)));
  }
  const bytes = Buffer.from(JSON.stringify(h.manifest)); h.options.manifestBytes = bytes; h.dependencies.manifestBytes = bytes; h.options.config.admission.platformManifestSha256 = digest(bytes);
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'aggregate_selected_size'); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'rm').length, 2);
});
test('output staging symlink and parent replacement are rejected', async t => {
  let count = 0;
  const h = harness(t, ({ args, opts }) => { if (args[0] === 'rm' && ++count === 2) fs.symlinkSync(opts.cwd, path.join(opts.cwd, 'staging')); }); const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.publishedBundle, null);
  const h2 = harness(t); const extractor = createPlatformExtractorForTests(h2.options, h2.dependencies); const old = h2.parent + '-moved';
  fs.renameSync(h2.parent, old); fs.mkdirSync(h2.parent, { mode: 0o700 }); t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  const r2 = await extractor.execute(); assert.equal(r2.status, 'failed'); assert.match(r2.error, /parent_replaced/); assert.equal(h2.calls.length, 0);
});
test('abort and single-use prevent work without weakening cleanup identity', async t => {
  const h = harness(t); const x = createPlatformExtractorForTests(h.options, h.dependencies); x.abort(); const r = await x.execute(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'aborted'); assert.equal(h.calls.length, 0); await assert.rejects(x.execute(), /single_use/);
});
test('fake transport cannot substitute real transport or omit mock clock', t => {
  const h = harness(t); assert.throws(() => createPlatformExtractorForTests(h.options, { ...h.dependencies, execute: executeBinary }), /fake_dependencies/);
  const { now: _now, ...missing } = h.dependencies; assert.throws(() => createPlatformExtractorForTests(h.options, missing), /unexpected_fields/);
});
test('hardlinked and symlinked tool identity is rejected before any command', t => {
  const h = harness(t); fs.linkSync(h.options.config.tools.docker.path, path.join(h.parent, 'hardlink')); assert.throws(() => createPlatformExtractorForTests(h.options, h.dependencies), /unsafe_file/);
  const h2 = harness(t); const tool = h2.options.config.tools.docker.path; fs.renameSync(tool, tool + '-target'); fs.symlinkSync(tool + '-target', tool); assert.throws(() => createPlatformExtractorForTests(h2.options, h2.dependencies), /unsafe_file_path/);
});
test('publication includes synchronous work in checked deadline; successful rename cannot hide exhaustion', async t => {
  const h = harness(t); const original = fsDefault.renameSync;
  t.mock.method(fsDefault, 'renameSync', (from, to) => { original(from, to); if (path.basename(to) === 'bundle') h.state.time = LIMITS.totalMs; });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'publication_deadline'); assert.equal(r.publication, 'publication_unconfirmed'); assert.equal(r.publishedBundle, null); assert(fs.existsSync(r.intendedBundle));
});
test('Docker config contamination is refused without reading its contents', async t => {
  const h = harness(t, ({ args, opts }) => { if (args[0] === 'image') fs.writeFileSync(path.join(opts.env.DOCKER_CONFIG, 'config.json'), 'inert forbidden config'); });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.error, 'environment_not_empty'); assert(!h.calls.some(a => a[0] === 'create'));
});

test('R659-1 early failure has one60s terminal cleanup budget including close grace', async t => {
  let cleanupEntry = null; const trace = [];
  const h = harness(t, ({ args, opts, state }) => {
    if (args[0] === 'cp') { cleanupEntry = state.time; return state.ok(Buffer.alloc(1024)); }
    if (cleanupEntry === null) return;
    const start = state.time - 1; trace.push({ command: args.slice(0, 2), start, timeoutMs: opts.timeoutMs });
    if (opts.timeoutMs < 20000) {
      state.time = start + opts.timeoutMs + LIMITS.graceMs;
      return { ...state.ok(''), status: null, signal: 'SIGKILL', failure: 'timeout' };
    }
    state.time = start + 20000;
  });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.retainExclusiveLease, true);
  assert.equal(r.deadlines.cleanupStart, cleanupEntry); assert.equal(r.deadlines.cleanupDeadline, cleanupEntry + LIMITS.cleanupMs);
  assert(h.state.time - cleanupEntry <= LIMITS.cleanupMs); assert.equal(trace.length, 3);
  assert(trace.every(c => c.start + c.timeoutMs + LIMITS.graceMs <= r.deadlines.cleanupDeadline));
  assert.equal(trace.at(-1).timeoutMs, 18000); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1); assert.equal(r.publishedBundle, null);
});
test('R659-1 cleanup entry near total deadline cannot extend original total bound', async t => {
  let cleanupEntry = null; const trace = [];
  const h = harness(t, ({ args, opts, state }) => {
    if (args[0] === 'cp') { state.time = LIMITS.totalMs - 10000; cleanupEntry = state.time; return state.ok(Buffer.alloc(1024)); }
    if (cleanupEntry === null) return;
    const start = state.time - 1; trace.push({ start, timeoutMs: opts.timeoutMs }); state.time = start + opts.timeoutMs + LIMITS.graceMs;
    return { ...state.ok(''), status: null, signal: 'SIGKILL', failure: 'timeout' };
  });
  const r = await h.run(); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.deadlines.cleanupStart, cleanupEntry); assert.equal(r.deadlines.cleanupDeadline, LIMITS.totalMs);
  assert.equal(trace.length, 1); assert.equal(trace[0].timeoutMs, 8000); assert.equal(h.state.time, LIMITS.totalMs); assert.equal(r.publishedBundle, null);
});
test('R659-1 successful early cleanup shares a fixed deadline across all four commands', async t => {
  let cleanupEntry = null; const trace = [];
  const h = harness(t, ({ args, opts, state }) => {
    if (args[0] === 'cp') { cleanupEntry = state.time; return state.ok(Buffer.alloc(1024)); }
    if (cleanupEntry === null) return;
    const start = state.time - 1; trace.push({ start, timeoutMs: opts.timeoutMs }); state.time = start + 10000;
  });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'removed_and_observed_absent');
  assert.equal(r.deadlines.cleanupDeadline, cleanupEntry + LIMITS.cleanupMs); assert.equal(trace.length, 4); assert.equal(h.state.time - cleanupEntry, 40000);
  assert(trace.every(c => c.start + c.timeoutMs + LIMITS.graceMs <= r.deadlines.cleanupDeadline)); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
});
for (const ownExists of [true, false]) test('R659-2 wrong valid create ID remains unconfirmed with ' + (ownExists ? 'actual own container' : 'no own container'), async t => {
  const wrong = '8'.repeat(64), actual = '9'.repeat(64);
  const h = harness(t, ({ args, state }) => {
    if (args[0] === 'create') {
      if (ownExists) state.resource = { kind: 'auth', id: actual, name: args[args.indexOf('--name') + 1], token: args.find(a => a.startsWith('ovd659.fixture=')).split('=')[1] };
      return state.ok(wrong);
    }
    if (!ownExists && args[0] === 'container' && args[1] === 'inspect') return { ...state.ok(''), status: 1 };
  });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.reason, 'creation_unconfirmed'); assert.equal(r.cleanup.retainExclusiveLease, true);
  assert.equal(r.containers[0].acknowledgedId, wrong); assert.equal(r.containers[0].uncertain, true); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
  const removals = h.calls.filter(a => a[0] === 'rm'); assert.deepEqual(removals.map(a => a[1]), ownExists ? [actual] : []); assert.equal(h.state.resource, null);
  if (ownExists) { assert.equal(r.containers[0].id, actual); assert(h.calls.some(a => a[0] === 'container' && a[1] === 'inspect' && a.at(-1) === r.containers[0].name)); }
  else assert.equal(r.containers[0].id, null);
});
for (const [condition, override] of [['foreign', { Owner: 'someone-else' }], ['started', { Status: 'running', Running: true }]]) test('R659-2 unknown acknowledgement cannot remove a ' + condition + ' name match', async t => {
  const actual = '9'.repeat(64);
  const h = harness(t, ({ args, state }) => {
    if (args[0] === 'create') { state.resource = { kind: 'auth', id: actual, name: args[args.indexOf('--name') + 1], token: args.find(a => a.startsWith('ovd659.fixture=')).split('=')[1] }; return state.ok('8'.repeat(64)); }
    if (args[0] === 'container' && args[1] === 'inspect' && args.at(-1).startsWith('ovd659-')) state.inspectOverride = override;
  });
  const r = await h.run(); assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.retainExclusiveLease, true); assert.equal(r.containers[0].uncertain, true);
  assert.equal(h.state.resource.id, actual); assert(!h.calls.some(a => a[0] === 'rm')); assert.equal(r.publishedBundle, null); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1);
});

for (const cleanup of [false, true]) test('R659X-3 identity-read latency prevents expired ' + (cleanup ? 'cleanup' : 'normal') + ' dispatch', async t => {
  let armed = !cleanup, cleanupEntry = null, jumped = false;
  const h = harness(t, ({ args, state }) => {
    if (cleanup && args[0] === 'cp') { armed = true; cleanupEntry = state.time; return state.ok(Buffer.alloc(1024)); }
  });
  const x = createPlatformExtractorForTests(h.options, h.dependencies), original = fsDefault.openSync;
  t.mock.method(fsDefault, 'openSync', (file, ...args) => {
    const fd = original(file, ...args);
    if (armed && !jumped && file === h.options.config.tools.docker.path) { jumped = true; h.state.time = cleanup ? cleanupEntry + LIMITS.cleanupMs + 1 : LIMITS.totalMs + 1; }
    return fd;
  });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = await x.execute(); assert.equal(jumped, true); assert.equal(r.status, 'failed'); assert.equal(r.publishedBundle, null);
  if (cleanup) {
    assert.equal(r.cleanup.status, 'unconfirmed'); assert.equal(r.cleanup.reason, 'deadline_or_command_limit'); assert.equal(r.cleanup.retainExclusiveLease, true);
    assert.equal(r.deadlines.cleanupDeadline, cleanupEntry + LIMITS.cleanupMs); assert.equal(h.calls.at(-1)[0], 'cp'); assert(!h.calls.some(a => a[0] === 'rm'));
  } else { assert.equal(r.error, 'deadline_or_command_limit'); assert.equal(h.calls.length, 0); }
});
for (const predicate of ['admission expiry', 'lease expiry', 'abort']) test('R659X-3 rechecks ' + predicate + ' after identity reads before normal dispatch', async t => {
  const h = harness(t);
  if (predicate === 'admission expiry') {
    h.options.config.admission.expiresAt = new Date(Date.now() + 30000).toISOString();
  } else if (predicate === 'lease expiry') {
    const lease = JSON.parse(fs.readFileSync(h.options.config.lease.path)); lease.expiresAt = new Date(Date.now() + 30000).toISOString(); fs.writeFileSync(h.options.config.lease.path, JSON.stringify(lease));
    h.options.config.lease.sha256 = digest(fs.readFileSync(h.options.config.lease.path)); h.options.config.admission.leaseSha256 = h.options.config.lease.sha256; h.options.config.admission.configBindingSha256 = configBinding(h.options.config);
  }
  const x = createPlatformExtractorForTests(h.options, h.dependencies), original = fsDefault.openSync; let changed = false;
  t.mock.method(fsDefault, 'openSync', (file, ...args) => {
    const fd = original(file, ...args);
    if (!changed && file === h.options.config.tools.docker.path) {
      changed = true;
      if (predicate === 'abort') x.abort();
      else {
        const expiry = predicate === 'admission expiry' ? h.options.config.admission.expiresAt : JSON.parse(fs.readFileSync(h.options.config.lease.path)).expiresAt;
        t.mock.method(Date, 'now', () => Date.parse(expiry) + 1);
      }
    }
    return fd;
  });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = await x.execute(); assert.equal(changed, true); assert.equal(r.status, 'failed'); assert.equal(r.error, predicate === 'abort' ? 'aborted' : 'expired'); assert.equal(h.calls.length, 0); assert.equal(r.publishedBundle, null);
});
test('R659X-3 owned cleanup ignores new expiry and abort but keeps its fixed deadline', async t => {
  let x, cleanupEntry = null;
  const h = harness(t, ({ args, state }) => {
    if (args[0] === 'cp') { cleanupEntry = state.time; x.abort(); t.mock.method(Date, 'now', () => Date.parse(h.options.config.admission.expiresAt) + 1); return state.ok(Buffer.alloc(1024)); }
  });
  x = createPlatformExtractorForTests(h.options, h.dependencies); const r = await x.execute();
  assert.equal(r.status, 'failed'); assert.equal(r.cleanup.status, 'removed_and_observed_absent'); assert.equal(r.deadlines.cleanupDeadline, cleanupEntry + LIMITS.cleanupMs);
  assert.equal(h.calls.filter(a => a[0] === 'rm').length, 1); assert.equal(h.calls.filter(a => a[0] === 'create').length, 1); assert.equal(r.publishedBundle, null);
});

for (const predicate of ['expiry during identity', 'abort during identity', 'deadline during intent persistence']) test('R659X-4 prevents publication rename after ' + predicate, async t => {
  const h = harness(t), x = createPlatformExtractorForTests(h.options, h.dependencies);
  const originalOpen = fsDefault.openSync, originalRename = fsDefault.renameSync; let injected = false, publicationRenames = 0;
  t.mock.method(fsDefault, 'openSync', (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (!injected && predicate !== 'deadline during intent persistence' && file === h.options.config.tools.docker.path) {
      const runs = fs.readdirSync(h.parent).filter(name => name.startsWith('ovd659-'));
      if (runs.some(name => fs.existsSync(path.join(h.parent, name, 'staging', 'extraction-receipt.json')))) {
        injected = true;
        if (predicate === 'abort during identity') x.abort();
        else t.mock.method(Date, 'now', () => Date.parse(h.options.config.admission.expiresAt) + 1);
      }
    }
    return fd;
  });
  t.mock.method(fsDefault, 'renameSync', (from, to) => {
    if (!injected && predicate === 'deadline during intent persistence' && /^state-\d+\.tmp$/.test(path.basename(from)) && JSON.parse(fs.readFileSync(from)).publication === 'rename_attempted') {
      const result = originalRename(from, to); injected = true; h.state.time = LIMITS.totalMs - LIMITS.cleanupMs + 1; return result;
    }
    if (path.basename(from) === 'staging') publicationRenames++;
    return originalRename(from, to);
  });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = await x.execute(); assert.equal(injected, true); assert.equal(r.status, 'failed');
  assert.equal(r.error, predicate.startsWith('expiry') ? 'expired' : predicate.startsWith('abort') ? 'aborted' : 'publication_deadline');
  assert.equal(r.publication, 'publication_unconfirmed'); assert.equal(r.publishedBundle, null); assert.equal(publicationRenames, 0);
  assert.equal(fs.existsSync(r.intendedBundle), false); assert(fs.existsSync(path.join(r.runDirectory, 'staging', 'extraction-receipt.json')));
  assert.equal(h.calls.filter(args => args[0] === 'rm').length, 2); assert.equal(h.state.resource, null);
});
