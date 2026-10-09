import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCachedFixtureAdapter, inspectPrerequisites, executeOwnedCommand, executionQualification } from './adapter.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort((a, b) => { if (a < b) return -1; if (a > b) return 1; return 0; }).map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
const id = n => n.toString(16).padStart(64, '0');
const canonical = (version, text) => ({ path: `supabase/migrations/${version}_synthetic.sql`, version, sha256: hash(Buffer.from(text)) });
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ovd658-test-')); chmodSync(root, 0o700);
  const socket = path.join(root, 'fake.sock'); const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  for (const name of ['docker', 'supabase']) writeFileSync(path.join(root, name), `FAKE ${name}: never executed`, { mode: 0o600 });
  const entries = [canonical('20990101000001', 'BEGIN;\nSELECT 1;\nCOMMIT;\n'), canonical('20990101000002', 'SELECT 2;\n')];
  const sourceFiles = new Map(entries.map((e, i) => [e.path, Buffer.from(i ? 'SELECT 2;\n' : 'BEGIN;\nSELECT 1;\nCOMMIT;\n')]));
  const platformFiles = new Map([['auth/00_test.sql', Buffer.from('-- invented auth bytes, fake transport only')], ['storage/00-test.sql', Buffer.from('-- invented storage bytes, fake transport only')]]);
  const manifestBytes = Buffer.from(JSON.stringify({ auth: [{ name: '00_test.sql', sha256: hash(platformFiles.get('auth/00_test.sql')) }], storage: [{ name: '00-test.sql', sha256: hash(platformFiles.get('storage/00-test.sql')) }] }));
  const session = { schema: 'overdrafter.synthetic-postgres-session.v1', role: 'postgres', expected: { sessionUser: 'postgres', currentUser: 'postgres', isSuperuser: false, createRole: true, memberships: ['authenticator'] } };
  const tools = { docker: { path: path.join(root, 'docker'), sha256: hash(readFileSync(path.join(root, 'docker'))) }, cli: { path: path.join(root, 'supabase'), sha256: hash(readFileSync(path.join(root, 'supabase'))), version: '2.78.1' }, socket };
  const image = { id: 'sha256:' + id(99), digest: 'example.invalid/synthetic@sha256:' + id(100), entrypoint: ['docker-entrypoint.sh'], cmd: ['postgres'] };
  const catalog = { bytes: Buffer.from('SELECT synthetic_catalog;'), sha256: hash(Buffer.from('SELECT synthetic_catalog;')) };
  const plan = { qualification: 'synthetic-only', sourceCommit: 'a'.repeat(40), inputs: entries, canonical: entries };
  plan.planSha256 = hash(Buffer.from(canonicalJson(plan)));
  const options = { plan, sourceFiles, platform: { manifestBytes, files: platformFiles, profileBytes: Buffer.from('fake profile') }, tools, image, session, catalog, parentDirectory: root,
    admission: { schema: 'overdrafter.release-rehearsal-admission.v1', qualification: 'synthetic-only', sourceCommit: plan.sourceCommit, planSha256: plan.planSha256,
      platformManifestSha256: hash(manifestBytes), dockerSha256: tools.docker.sha256, cliSha256: tools.cli.sha256, imageId: image.id, imageDigest: image.digest,
      sessionSha256: hash(Buffer.from(JSON.stringify(session, null, 2) + '\n')), catalogSha256: catalog.sha256, expiresAt: new Date(Date.now() + 600000).toISOString() } };
  const state = { calls: [], containers: new Map(), network: null, pending: entries.map(e => path.basename(e.path)), next: 1, drift: false, failedApply: false, failRemoval: false, ledgerPresent: false, ledger: [] };
  const respond = (stdout = '', status = 0) => ({ status, stdout, stderr: '', failure: null, elapsedMs: 1 });
  const execute = async (binary, argv, callOptions) => {
    assert.equal(binary, tools.docker.path); assert.equal(argv[0], '--host'); assert.equal(argv[1], 'unix://' + socket);
    const args = argv.slice(4); state.calls.push({ args, options: callOptions });
    assert.equal(callOptions.env.SUPABASE_ACCESS_TOKEN, undefined); assert.equal(callOptions.env.PATH, undefined); assert.ok(callOptions.timeoutMs <= 60000);
    if (args[0] === 'container' && args[1] === 'ls') return respond([...state.containers.values()].map(c => args.includes('--format') ? c.Name.slice(1) : c.Id).join('\n'));
    if (args[0] === 'network' && args[1] === 'ls') return respond(state.network ? args.includes('--format') ? state.network.Name : state.network.Id : '');
    if (args[0] === 'image') return respond(JSON.stringify([{ Id: image.id, Os: 'linux', Architecture: 'amd64', RepoDigests: [image.digest], Config: { Entrypoint: image.entrypoint, Cmd: image.cmd, Env: ['PATH=/usr/bin:/bin'], Volumes: {} } }]));
    if (args[0] === 'network' && args[1] === 'create') {
      const labels = Object.fromEntries(args.flatMap((v, i) => v === '--label' ? [args[i + 1].split('=')] : []));
      state.network = { Id: id(80), Name: args.at(-1), Driver: 'bridge', Internal: true, Labels: labels, Containers: {} }; return respond(state.network.Id);
    }
    if (args[0] === 'network' && args[1] === 'inspect') return respond(JSON.stringify([state.network]));
    if (args[0] === 'network' && args[1] === 'rm') { state.network = null; return respond(); }
    if (args[0] === 'create') {
      assert.ok(args.includes('--pull=never')); assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('-p')); assert.ok(!args.includes('--publish'));
      const labels = Object.fromEntries(args.flatMap((v, i) => v === '--label' ? [args[i + 1].split('=')] : []));
      const source = args[args.indexOf('--mount') + 1].match(/src=([^,]+)/)[1]; const name = args[args.indexOf('--name') + 1];
      const c = { Id: id(state.next++), Name: '/' + name, Image: image.id, Config: { Image: image.id, Labels: labels, Entrypoint: image.entrypoint, Cmd: image.cmd }, HostConfig: { NetworkMode: state.network.Id, Privileged: false,
        NanoCpus: 2e9, Memory: 3221225472, PidsLimit: 256, RestartPolicy: { Name: 'no' }, Tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid,size=1536m', '/tmp': 'rw,nosuid,size=256m' }, Dns: ['127.0.0.1'], SecurityOpt: ['no-new-privileges'], PortBindings: {} },
        Mounts: [{ Type: 'bind', Source: source, Destination: '/opt/ovd658', RW: false }] };
      state.containers.set(c.Id, c); return respond(c.Id);
    }
    if (args[0] === 'inspect') { const c = state.containers.get(args[1]) ?? [...state.containers.values()].find(c => c.Name === '/' + args[1]);
      return respond(JSON.stringify([{ ...c, Config: { ...c.Config, Labels: state.drift ? {} : c.Config.Labels } }])); }
    if (args[0] === 'rm') { if (!state.failRemoval) state.containers.delete(args.at(-1)); return respond(); }
    if (args[0] === 'start' || args[0] === 'cp') return respond();
    if (args[0] === 'exec') {
      if (args.includes('cat')) return respond('1\n/var/lib/postgresql/data\n');
      if (args.includes('pg_isready') || args.includes('mkdir')) return respond();
      if (args.includes('/opt/ovd658/supabase')) {
        assert.ok(args.includes('-i')); assert.ok(args.some(v => v.startsWith('HOME=/tmp/')));
        if (args.includes('--version')) return respond('2.78.1\n');
        if (args.includes('--help')) return respond('--db-url --include-all --dry-run');
        assert.match(args[args.indexOf('--db-url') + 1], /^postgresql:\/\/postgres:[a-f0-9]+@127\.0\.0\.1:5432\/postgres\?sslmode=disable$/);
        if (args.includes('--dry-run')) return respond(state.pending.map(v => ' • ' + v).join('\n'));
        if (state.failedApply) return { ...respond('', 1), stderr: 'ERROR: OVD_REHEARSAL_FAULT_COMMIT_TO_LEDGER (SQLSTATE P0001)' };
        state.ledgerPresent = true; state.ledger = entries.map(e => ({ version: e.version, name: 'synthetic', statements: ['actual fake transport representation'] })); return respond('Finished');
      }
      if (args.includes('psql')) {
        const sql = String(callOptions.input);
        if (sql.includes("'authLegacyBaseline'")) return respond(JSON.stringify({ database: 'postgres', sessionUser: 'supabase_admin', currentUser: 'supabase_admin', serverAddress: null, clientAddress: null, isSuperuser: true, requiredRolesPresent: true, platformSchemasPresent: true, authLegacyBaseline: true, authUsersEmpty: true, storageBucketsAbsent: true, applicationAbsent: true }));
        if (sql.includes("'storageBucketsOwner'")) return respond(JSON.stringify({ authUsersPresent: true, storageBucketsPresent: true, authUsersOwner: 'supabase_auth_admin', storageBucketsOwner: 'supabase_storage_admin', storagePublicColumn: true, postgresIsAuthenticatorMember: true }));
        if (sql.includes("'applicationName'")) return respond(JSON.stringify({ remaining: state.backendResidue ? [{ pid: 999, backendStart: '2099-01-01', applicationName: 'ovd658-race' }] : [], observedAt: '2099-01-01T00:00:00Z' }));
        if (sql.includes("'memberships'")) return respond(JSON.stringify(session.expected));
        if (sql.includes("'present'")) return respond(JSON.stringify({ present: state.ledgerPresent }));
        if (sql.includes('from supabase_migrations.schema_migrations')) return respond(JSON.stringify(state.ledger));
        if (sql === catalog.bytes.toString()) return respond(JSON.stringify({ schema: 'overdrafter.release-rehearsal-catalog.v1', coverage: ['schemas'], records: [] }));
        return respond('');
      }
    }
    throw new Error('unhandled fake command: ' + args.join(' '));
  };
  const create = () => createCachedFixtureAdapter(options, { execute, validatePins: () => {} });
  const dispose = async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); };
  return { options, state, execute, create, dispose, entries };
}

test('pure preflight refuses synthetic pins without commands and override cannot reach default executor', async () => {
  const f = await fixture(); try {
    assert.equal(inspectPrerequisites(f.options).reason, 'candidate_not_admitted'); assert.equal(f.state.calls.length, 0);
    assert.throws(() => createCachedFixtureAdapter(f.options, { validatePins: () => {} }), /fake_transport/);
    assert.throws(() => createCachedFixtureAdapter(f.options), /candidate_not_admitted/);
    assert.throws(() => createCachedFixtureAdapter(f.options, { execute: f.execute }), /candidate_not_admitted/);
    assert.equal(executionQualification({ execute: f.execute }), 'fake-transport-only');
    assert.equal(executionQualification({ execute: executeOwnedCommand }), 'fake-transport-only');
    assert.equal(executionQualification(), 'synthetic-only');
    assert.equal(f.state.calls.length, 0);
  } finally { await f.dispose(); }
});

test('admission rejects input URL, secret env, wrong tool/source/platform bytes and expired receipt', async () => {
  const f = await fixture(); try {
    for (const options of [{ ...f.options, connectionUrl: 'postgres://external' }, { ...f.options, env: { SUPABASE_ACCESS_TOKEN: 'forbidden' } },
      { ...f.options, admission: { ...f.options.admission, expiresAt: '2000-01-01' } },
      { ...f.options, tools: { ...f.options.tools, cli: { ...f.options.tools.cli, version: '2.99.0' } } },
      { ...f.options, sourceFiles: new Map([[f.entries[0].path, Buffer.from('drift')]]) },
      { ...f.options, platform: { ...f.options.platform, files: new Map() } }]) {
      assert.throws(() => createCachedFixtureAdapter(options, { execute: f.execute, validatePins: () => {} }));
    }
    assert.equal(f.state.calls.length, 0);
  } finally { await f.dispose(); }
});

test('two independent clusters use internal network, readonly owned CLI and verified removal frees capacity', async () => {
  const f = await fixture(); try {
    const a = f.create(); const started = await a.startTarget('reference');
    assert.equal(started.session.qualification, 'fake-transport-only'); assert.equal(started.session.receipt.qualification, 'fake-transport-only');
    const first = started.target; const second = (await a.startTarget('failed')).target;
    assert.notEqual(first.id, second.id); assert.equal(f.state.containers.size, 2); assert.equal(f.state.network.Internal, true);
    await assert.rejects(a.startTarget('third'), /limit/);
    assert.equal((await a.stopTarget(first)).status, 'removed_and_observed_absent');
    const third = (await a.startTarget('rebuild')).target; assert.notEqual(third.id, first.id); assert.equal(f.state.containers.size, 2);
    assert.equal((await a.cleanup()).status, 'removed_and_observed_absent'); assert.equal(f.state.containers.size, 0); assert.equal(f.state.network, null);
    assert.ok(a.receipts.every(r => !r.argv.some(v => /postgres:[a-f0-9]{64}@/.test(v))));
    assert.ok(f.state.calls.every(c => !['pull', 'run'].includes(c.args[0])));
  } finally { await f.dispose(); }
});

test('ownership drift and unconfirmed deletion never authorize cleanup or a third cluster', async () => {
  const f = await fixture(); try {
    const a = f.create(); const one = (await a.startTarget('one')).target; await a.startTarget('two');
    f.state.drift = true; await assert.rejects(a.stopTarget(one), /owner_mismatch/); assert.equal(f.state.containers.size, 2);
    assert.ok(!f.state.calls.some(c => c.args[0] === 'rm'));
    f.state.drift = false; f.state.failRemoval = true; await assert.rejects(a.stopTarget(one), /removal_unconfirmed/); await assert.rejects(a.startTarget('three'), /limit/);
    f.state.failRemoval = false; await a.cleanup();
  } finally { await f.dispose(); }
});

test('CLI apply admits actual pending order, snapshots real transport rows and preserves failed-target freeze', async () => {
  const f = await fixture(); try {
    const a = f.create(); const h = (await a.startTarget('apply')).target;
    const empty = await a.snapshot(h); assert.equal(empty.ledgerPresent, false); assert.deepEqual(empty.ledger, []); assert.equal(empty.session.directCliSessionObserved, false);
    assert.equal((await a.apply(h, { files: f.entries, expectedPending: f.entries })).status, 'passed');
    const observed = await a.snapshot(h); assert.deepEqual(observed.ledger, f.state.ledger); assert.equal(observed.retryAuthorized, false);
    f.state.failedApply = true;
    assert.equal((await a.apply(h, { files: f.entries, expectedPending: f.entries })).status, 'failed');
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries }), /frozen/);
    assert.equal((await a.snapshot(h)).frozen, true); await a.cleanup();
  } finally { await f.dispose(); }
});

test('wrong dry-run order blocks apply and unknown targets/check kinds cannot execute', async () => {
  const f = await fixture(); try {
    const a = f.create(); const h = (await a.startTarget('order')).target; f.state.pending.reverse();
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries }), /pending_order/);
    assert.equal(f.state.calls.filter(c => c.args.includes('push') && !c.args.includes('--help') && !c.args.includes('--dry-run')).length, 0);
    await assert.rejects(a.snapshot({ ...h }), /unknown/); await a.cleanup();
  } finally { await f.dispose(); }
});

test('SQL checks require hash-bound input and independent-session races remain explicitly blocked', async () => {
  const f = await fixture(); try {
    const a = f.create(); const h = (await a.startTarget('checks')).target;
    await assert.rejects(a.runChecks(h, [{ kind: 'shell', command: 'anything' }]), /not_frozen/);
    await assert.rejects(a.runChecks(h, [{ kind: 'sql', path: f.entries[0].path, sha256: id(44) }]), /not_frozen/);
    const r = await a.runChecks(h, [{ kind: 'race' }]); assert.equal(r.status, 'blocked'); assert.equal(r.checks[0].runtime, 'not_run');
    assert.equal((await a.runChecks(h, [{ kind: 'sql', ...f.entries[0] }])).checks[0].status, 'executed'); await a.cleanup();
  } finally { await f.dispose(); }
});

test('bounded process transport records missing binary, timeout and output overflow using only inert Node children', async () => {
  const env = { LANG: 'C' }, cwd = process.cwd();
  const missing = await executeOwnedCommand('/nonexistent/ovd658-test', [], { cwd, env, timeoutMs: 100 }); assert.equal(missing.failure, 'spawn_error');
  const timeout = await executeOwnedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, env, timeoutMs: 50 }); assert.equal(timeout.failure, 'timeout');
  const noisy = await executeOwnedCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)"], { cwd, env, timeoutMs: 1000, maxBytes: 100 });
  assert.equal(noisy.failure, 'output_limit'); assert.equal(noisy.stdout.length, 100);
});

test('fault staging preserves original bytes and admits only the fixed hashed terminal-COMMIT delta', async () => {
  const f = await fixture(); try {
    const a = f.create(); const h = (await a.startTarget('fault')).target;
    const original = Buffer.from(f.options.sourceFiles.get(f.entries[0].path)); const anchor = { text: 'COMMIT;\n', offset: original.length - 8 };
    const marker = 'OVD_REHEARSAL_FAULT_COMMIT_TO_LEDGER'; const insertedSql = `\nDO $ovd_rehearsal_fault$ BEGIN RAISE EXCEPTION '${marker}'; END $ovd_rehearsal_fault$;\n`;
    const bytes = Buffer.concat([original, Buffer.from(insertedSql)]);
    const fault = { schema: 'overdrafter.release-rehearsal-fault.v1', mode: 'commit-to-ledger', originalSha256: f.entries[0].sha256,
      faultSha256: hash(bytes), bytesBase64: bytes.toString('base64'), byteLength: bytes.length, anchor, insertionOffset: original.length,
      insertedSql, marker, qualification: 'placement-only', runtimeBoundary: 'not-run' };
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries, fault: { ...fault, insertedSql: 'DROP SCHEMA public CASCADE;' } }), /fault_delta/);
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries, fault: { ...fault, insertionOffset: anchor.offset } }), /side_mismatch/);
    f.state.failedApply = true; const r = await a.apply(h, { files: f.entries, expectedPending: f.entries, fault });
    assert.equal(r.status, 'failed'); assert.equal(r.fault.faultSha256, hash(bytes));
    assert.match(r.execution.stderr, /P0001/); assert.match(r.execution.stderr, /OVD_REHEARSAL_FAULT_COMMIT_TO_LEDGER/);
    const cp = f.state.calls.findLast(c => c.args[0] === 'cp');
    assert.deepEqual(readFileSync(path.join(cp.args[1], 'supabase', 'migrations', path.basename(f.entries[0].path))), bytes);
    assert.deepEqual(f.options.sourceFiles.get(f.entries[0].path), original);
    await assert.rejects(a.runChecks(h, [{ kind: 'ensure-pgtap' }]), /failed_target_checks_blocked/);
    await a.cleanup();
  } finally { await f.dispose(); }
});

test('tampered plan and CLI bundle fail before migration execution', async () => {
  const f = await fixture(); try {
    assert.throws(() => createCachedFixtureAdapter({ ...f.options, plan: { ...f.options.plan, canonical: [] } }, { execute: f.execute, validatePins: () => {} }), /plan_content_hash/);
    const a = f.create(); const h = (await a.startTarget('bundle')).target;
    const create = f.state.calls.find(c => c.args[0] === 'create'); const source = create.args[create.args.indexOf('--mount') + 1].match(/src=([^,]+)/)[1];
    chmodSync(path.join(source, 'supabase'), 0o600); writeFileSync(path.join(source, 'supabase'), 'changed');
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries }), /cli_bundle_changed/);
    assert.ok(!f.state.calls.some(c => c.args.includes('--db-url'))); await a.cleanup();
  } finally { await f.dispose(); }
});

test('foreign cached image receipt cannot be adopted', async () => {
  const f = await fixture(); try {
    const execute = async (bin, args, opts) => {
      const r = await f.execute(bin, args, opts);
      if (args[4] === 'image') { const image = JSON.parse(r.stdout); image[0].Id = 'sha256:' + id(999); r.stdout = JSON.stringify(image); }
      return r;
    };
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} }); await assert.rejects(a.startTarget('bad-image'), /cached_image_identity/);
    assert.equal(f.state.containers.size, 0); assert.equal(f.state.network, null); await a.cleanup();
  } finally { await f.dispose(); }
});

test('unsafe mounts and weakened caps are rejected before starting a created container', async () => {
  for (const change of [c => c.Mounts.push({ Type: 'bind', Source: '/sensitive', Destination: '/escape', RW: true }), c => { c.HostConfig.Privileged = true; }, c => { c.HostConfig.Memory = 0; }]) {
    const f = await fixture(); try {
      const execute = async (bin, args, opts) => { const r = await f.execute(bin, args, opts);
        if (args[4] === 'inspect') { const values = JSON.parse(r.stdout); change(values[0]); r.stdout = JSON.stringify(values); } return r; };
      const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} });
      await assert.rejects(a.startTarget('bad-container'));
      assert.ok(!f.state.calls.some(c => c.args[0] === 'start'));
      await assert.rejects(a.cleanup()); // Drift cannot be reinterpreted as safe ownership.
      assert.ok(!f.state.calls.some(c => c.args[0] === 'rm'));
    } finally { await f.dispose(); }
  }
});

test('eighteen named race specs execute one owned engine call and require final backend absence', async () => {
  const f = await fixture(); try {
    const races = Array.from({ length: 18 }, (_, i) => ({ name: 'synthetic-' + i }));
    f.options.races = { profileManifestBytes: Buffer.from(JSON.stringify({ races })), helperFiles: new Map() };
    let calls = 0;
    const runRaces = async ({ processSpec, evidence, deadlineMs, signal }) => {
      calls++; assert.equal(processSpec.binary, f.options.tools.docker.path); assert.equal(processSpec.sha256, f.options.tools.docker.sha256);
      assert.ok(processSpec.args.includes('PGHOST=/var/run/postgresql')); assert.ok(!processSpec.args.some(v => v.startsWith('PGPASSWORD=')));
      assert.equal(processSpec.env.SUPABASE_ACCESS_TOKEN, undefined); assert.ok(deadlineMs <= 240000); assert.equal(signal.aborted, false);
      evidence.races = races.map(r => ({ ...r, status: 'passed' })); return { status: 'passed', raceEvidence: evidence };
    };
    const a = createCachedFixtureAdapter(f.options, { execute: f.execute, validatePins: () => {}, runRaces });
    const h = (await a.startTarget('races')).target; const specs = races.map(r => ({ kind: 'race', name: r.name }));
    await assert.rejects(a.runChecks(h, specs.slice(1)), /race_request_names/);
    await assert.rejects(a.runChecks(h, [...specs.slice(0, 17), specs[0]]), /race_request_names/);
    await assert.rejects(a.runChecks(h, [...specs, { kind: 'ensure-pgtap' }]), /mixed_race/); assert.equal(calls, 0);
    const result = await a.runChecks(h, specs); assert.equal(calls, 1); assert.equal(result.checks.length, 18);
    assert.equal(result.raceEvidence.qualification, 'fake-transport-only');
    assert.equal(result.raceEvidence.ownerFinalBackendInventory.status, 'all-other-client-backends-observed-absent');
    f.state.backendResidue = true; assert.equal((await a.runChecks(h, specs)).status, 'failed'); assert.equal(calls, 2);
    await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries }), /frozen/); await a.cleanup();
  } finally { await f.dispose(); }
});

test('abort refuses new commands while owner-checked cleanup remains available', async () => {
  const f = await fixture(); try {
    const a = f.create(); const h = (await a.startTarget('abort')).target; a.abort();
    await assert.rejects(a.snapshot(h), /aborted/); assert.equal((await a.cleanup()).status, 'removed_and_observed_absent');
    assert.equal(f.state.containers.size, 0); assert.equal(f.state.network, null);
  } finally { await f.dispose(); }
});

test('lost create acknowledgment resolves cleanup only by fresh exact name and owner labels', async () => {
  const f = await fixture(); try {
    const execute = async (bin, args, opts) => { const r = await f.execute(bin, args, opts); return args[4] === 'create' ? { ...r, stdout: '', status: 1 } : r; };
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} });
    await assert.rejects(a.startTarget('lost'), /command_failed/); assert.equal(f.state.containers.size, 1);
    assert.equal((await a.cleanup()).status, 'removed_and_observed_absent'); assert.equal(f.state.containers.size, 0);
  } finally { await f.dispose(); }
});

test('slow successful cleanup commands consume one aggregate window including termination grace', async () => {
  const f = await fixture(); try {
    let time = 0, slow = false; const timeouts = [];
    const execute = async (bin, args, opts) => {
      const r = await f.execute(bin, args, opts);
      if (slow) { timeouts.push(opts.timeoutMs); time += Math.min(19000, opts.timeoutMs); }
      return r;
    };
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {}, now: () => time });
    const h = (await a.startTarget('budget')).target; slow = true;
    await assert.rejects(a.cleanup(), /cleanup_deadline_exhausted_unconfirmed/);
    assert.deepEqual(timeouts, [58000, 39000, 20000, 1000]); assert.equal(time, 58000);
    // Removal exited successfully, but no budget remains for actual absence proof.
    assert.equal(f.state.containers.size, 0);
    const ownedState = JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json')));
    assert.equal(ownedState.containers[0].stopped, false);
    assert.equal(ownedState.cleanupStatus, 'unconfirmed_deadline_exhausted');
    assert.equal(ownedState.deadlines.cleanupDeadline, 60000); assert.equal(ownedState.deadlines.totalDeadline, 1800000);
    const calls = f.state.calls.length;
    await assert.rejects(a.cleanup(), /cleanup_deadline_exhausted_unconfirmed/);
    await assert.rejects(a.stopTarget(h), /cleanup_already_started/);
    assert.equal(f.state.calls.length, calls); assert.ok(a.receipts.every(r => r.qualification === 'fake-transport-only'));
  } finally { await f.dispose(); }
});

test('normal work cannot spend cleanup reserve and late cleanup never extends the total deadline', async () => {
  const f = await fixture(); try {
    let time = 0, slow = false; const timeouts = [];
    const execute = async (bin, args, opts) => { const r = await f.execute(bin, args, opts);
      if (slow) { timeouts.push(opts.timeoutMs); time += 1000; } return r; };
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {}, now: () => time });
    const h = (await a.startTarget('late')).target; time = 1739000;
    const calls = f.state.calls.length;
    await assert.rejects(a.snapshot(h), /runner_work_deadline/); assert.equal(f.state.calls.length, calls);
    time = 1795000; slow = true;
    await assert.rejects(a.cleanup(), /cleanup_deadline_exhausted_unconfirmed/);
    assert.deepEqual(timeouts, [3000, 2000, 1000]); assert.equal(time, 1798000);
    const ownedState = JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json')));
    assert.equal(ownedState.deadlines.workDeadline, 1740000); assert.equal(ownedState.deadlines.cleanupDeadline, 1800000);
    assert.equal(ownedState.containers[0].stopped, false); assert.equal(f.state.containers.size, 1);
    assert.ok(!f.state.calls.some(c => c.args[0] === 'rm'));
  } finally { await f.dispose(); }
});

test('intermediate owned removal uses normal-work budget and does not start final cleanup clock', async () => {
  const f = await fixture(); try {
    let time = 0;
    const a = createCachedFixtureAdapter(f.options, { execute: f.execute, validatePins: () => {}, now: () => time });
    const reference = (await a.startTarget('reference')).target; await a.startTarget('failed');
    time = 1000; await a.stopTarget(reference); time = 200000; await a.startTarget('rebuild');
    assert.equal((await a.cleanup()).status, 'removed_and_observed_absent');
    const state = JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json')));
    assert.equal(state.deadlines.cleanupDeadline, 260000); assert.equal(f.state.containers.size, 0);
  } finally { await f.dispose(); }
});

test('expired or overrun cleanup stays unconfirmed and clock override cannot reach real executor', async () => {
  for (const overrun of [false, true]) {
    const f = await fixture(); try {
      let time = 0, slow = false;
      assert.throws(() => createCachedFixtureAdapter(f.options, { now: () => time }), /clock_override_requires_fake_transport/);
      const execute = async (bin, args, opts) => { const r = await f.execute(bin, args, opts); if (slow) time += 60000; return r; };
      const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {}, now: () => time });
      await a.startTarget('exhausted'); const calls = f.state.calls.length;
      if (overrun) slow = true; else time = 1800001;
      await assert.rejects(a.cleanup(), /cleanup_deadline_exhausted_unconfirmed/);
      assert.equal(f.state.calls.length, calls + (overrun ? 1 : 0)); assert.equal(f.state.containers.size, 1);
      assert.ok(!f.state.calls.some(c => c.args[0] === 'rm'));
      if (overrun) assert.equal(a.receipts.at(-1).failure, 'absolute_deadline_exhausted');
      assert.equal(JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json'))).cleanupStatus, 'unconfirmed_deadline_exhausted');
    } finally { await f.dispose(); }
  }
});

test('a refused target does not prevent healthy sibling cleanup or authorize network deletion or retry', async () => {
  for (const fault of ['owner-drift', 'removal-failure']) {
    const f = await fixture(); try {
      let refused;
      const execute = async (bin, args, opts) => {
        if (args[4] === 'rm' && args.at(-1) === refused && fault === 'removal-failure') {
          f.state.calls.push({ args: args.slice(4), options: opts });
          return { status: 1, stdout: '', stderr: 'synthetic removal refusal', failure: null, elapsedMs: 1 };
        }
        const r = await f.execute(bin, args, opts);
        if (args[4] === 'inspect' && args[5] === refused && fault === 'owner-drift') {
          const value = JSON.parse(r.stdout); value[0].Config.Labels = {}; r.stdout = JSON.stringify(value);
        }
        if (args[4] === 'network' && args[5] === 'inspect' && refused) {
          const value = JSON.parse(r.stdout); value[0].Containers = Object.fromEntries([...f.state.containers.keys()].map(id => [id, {}])); r.stdout = JSON.stringify(value);
        }
        return r;
      };
      const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} });
      refused = (await a.startTarget('refused')).target.id; const sibling = (await a.startTarget('healthy')).target.id;
      let failure; await assert.rejects(a.cleanup(), error => { failure = error; return /fixture_cleanup_failed/.test(error.message); });
      assert.equal(f.state.containers.has(refused), true); assert.equal(f.state.containers.has(sibling), false);
      assert.equal(failure.cleanupOutcome.status, 'failed');
      assert.deepEqual(failure.cleanupOutcome.containers.map(c => c.status), ['failed', 'removed_and_observed_absent']);
      assert.equal(failure.cleanupOutcome.network.status, 'retained_targets_unconfirmed');
      assert.deepEqual(failure.cleanupOutcome.network.observedAttachedIds, [refused]); assert.ok(f.state.network);
      assert.ok(!f.state.calls.some(c => c.args[0] === 'network' && c.args[1] === 'rm'));
      const refusedRemovals = f.state.calls.filter(c => c.args[0] === 'rm' && c.args.at(-1) === refused);
      assert.equal(refusedRemovals.length, fault === 'owner-drift' ? 0 : 1);
      const persisted = JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json')));
      assert.equal(persisted.cleanupStatus, 'unconfirmed_target_or_network_failure');
      assert.deepEqual(persisted.containers.map(c => c.stopped), [false, true]);
      const calls = f.state.calls.length; await assert.rejects(a.cleanup(), /fixture_cleanup_failed/); assert.equal(f.state.calls.length, calls);
    } finally { await f.dispose(); }
  }
});

test('refused first target cannot renew the cleanup budget for its healthy sibling', async () => {
  const f = await fixture(); try {
    let time = 0, refused, cleanup = false; const timeouts = [];
    const execute = async (bin, args, opts) => {
      const r = await f.execute(bin, args, opts);
      if (cleanup) { timeouts.push(opts.timeoutMs); time += Math.min(10000, opts.timeoutMs); }
      if (cleanup && args[4] === 'inspect' && args[5] === refused) {
        const value = JSON.parse(r.stdout); value[0].Config.Labels = {}; r.stdout = JSON.stringify(value);
      }
      return r;
    };
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {}, now: () => time });
    refused = (await a.startTarget('refused')).target.id; const sibling = (await a.startTarget('healthy')).target.id; cleanup = true;
    let failure; await assert.rejects(a.cleanup(), error => { failure = error; return /deadline_exhausted/.test(error.message); });
    assert.deepEqual(timeouts, [58000, 48000, 38000, 28000, 18000, 8000]); assert.equal(time, 58000);
    assert.equal(f.state.containers.has(refused), true); assert.equal(f.state.containers.has(sibling), true);
    assert.ok(f.state.calls.some(c => c.args[0] === 'inspect' && c.args[1] === sibling));
    assert.ok(!f.state.calls.some(c => c.args[0] === 'rm'));
    assert.deepEqual(failure.cleanupOutcome.containers.map(c => c.status), ['failed', 'failed']);
    assert.equal(failure.cleanupOutcome.network.status, 'unconfirmed');
    const persisted = JSON.parse(readFileSync(path.join(f.state.calls[0].options.cwd, 'state.json')));
    assert.equal(persisted.deadlines.cleanupDeadline, 60000); assert.equal(persisted.cleanupStatus, 'unconfirmed_deadline_exhausted');
    const calls = f.state.calls.length; await assert.rejects(a.cleanup(), /deadline_exhausted/); assert.equal(f.state.calls.length, calls);
  } finally { await f.dispose(); }
});

test('inert Node child signal close retains signal and cannot resemble a normal nonzero exit', async () => {
  const common = { cwd: process.cwd(), env: {}, timeoutMs: 2000 };
  const signalled = await executeOwnedCommand(process.execPath, ['-e', "process.stdout.write('fault diagnostic arrived\\n', () => process.kill(process.pid, 'SIGTERM'))"], common);
  assert.equal(signalled.status, null); assert.equal(signalled.signal, 'SIGTERM');
  assert.equal(signalled.failure, 'signalled_termination'); assert.match(signalled.stdout, /fault diagnostic arrived/);
  const normal = await executeOwnedCommand(process.execPath, ['-e', "process.stderr.write('ordinary SQL error\\n', () => { process.exitCode = 1; })"], common);
  assert.equal(normal.status, 1); assert.equal(normal.signal, null); assert.equal(normal.failure, null);
});

test('marker-bearing apply receipts preserve signals and distinguish normal SQL exit from transport failure', async () => {
  for (const termination of [
    { status: null, signal: 'SIGKILL', expected: 'signalled_termination' },
    { status: 0, signal: 'SIGTERM', expected: 'signalled_termination' },
    { status: null, signal: null, expected: 'exit_unconfirmed' },
    { status: 1, signal: null, expected: null },
  ]) {
    const f = await fixture(); try {
      const execute = async (bin, args, opts) => {
        const r = await f.execute(bin, args, opts);
        if (args.includes('/opt/ovd658/supabase') && args.includes('push') && !args.includes('--dry-run') && !args.includes('--help')) {
          return { ...r, status: termination.status, signal: termination.signal, stderr: 'ERROR: OVD_REHEARSAL_FAULT_COMMIT_TO_LEDGER (SQLSTATE P0001)' };
        }
        return r;
      };
      const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} }); const h = (await a.startTarget('signal')).target;
      const result = await a.apply(h, { files: f.entries, expectedPending: f.entries });
      assert.equal(result.status, 'failed'); assert.equal(result.frozen, true);
      assert.equal(result.execution.signal, termination.signal); assert.equal(result.execution.status, termination.status);
      assert.equal(result.execution.failure, termination.expected); assert.equal(result.execution.qualification, 'fake-transport-only');
      assert.match(result.execution.stderr, /OVD_REHEARSAL_FAULT_COMMIT_TO_LEDGER/);
      await assert.rejects(a.apply(h, { files: f.entries, expectedPending: f.entries }), /frozen/); await a.cleanup();
    } finally { await f.dispose(); }
  }
});

test('normal required command rejects signalled zero-status transport before resource creation', async () => {
  const f = await fixture(); try {
    const execute = async (bin, args, opts) => ({ ...await f.execute(bin, args, opts), signal: 'SIGTERM' });
    const a = createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} });
    await assert.rejects(a.startTarget('no-credit'), /fixture_command_failed/);
    assert.equal(a.receipts[0].status, 0); assert.equal(a.receipts[0].signal, 'SIGTERM');
    assert.equal(a.receipts[0].failure, 'signalled_termination'); assert.equal(f.state.containers.size, 0); assert.equal(f.state.network, null);
    await a.cleanup();
  } finally { await f.dispose(); }
});

// OVD-660: diagnostic cases reuse the bounded fake transport, never SQL or Docker.
import { diagnosticArtifacts, diagnosticHash, DIAGNOSTIC_PARENT, DIAGNOSTIC_FILE, DIAGNOSTIC_VERSION, DIAGNOSTIC_NAME,
  DIAGNOSTIC_EMPTY_SQL, DIAGNOSTIC_READ_SQL, DIAGNOSTIC_LEDGER_SQL, DIAGNOSTIC_BACKENDS_SQL, validateCaptureBinding } from './cli-session.mjs';
function diagnosticCaptured() {
  const owners = { ovd660_cli_session: 'postgres', 'ovd660_cli_session.observation': 'postgres' };
  const attributes = { name: 'postgres', superuser: false, inherit: true, createRole: true, createDatabase: true, canLogin: true, replication: false, bypassRls: true };
  return { rows: [{ schema: 'overdrafter.cli-session-observation.v1', sessionUser: 'postgres', currentUser: 'postgres', database: 'postgres',
    serverAddress: '127.0.0.1', clientAddress: '127.0.0.1', serverPort: 5432, clientPort: 12345, backendPid: 101,
    backendStart: '2099-01-01T00:00:00Z', observedAt: '2099-01-01T00:00:01Z', settings: { role: 'none', searchPath: 'public,extensions,pg_catalog', statementTimeout: '20s' },
    roles: ['current', 'session'].map(kind => ({ kind, ...attributes })), directMemberships: ['authenticator'],
    membershipEdges: ['current', 'session'].map(root => ({ root, member: 'postgres', role: 'authenticator', grantor: 'supabase_admin', admin: false, inherit: true, set: true })),
    reachableRoles: ['current', 'session'].flatMap(root => ['authenticator', 'postgres'].map(name => ({ root, name, member: true, usable: true }))), owners }], owners,
    observer: { method: 'tcp-psql-readback', sessionUser: 'postgres', currentUser: 'postgres', backendPid: 102, backendStart: '2099-01-01T00:00:02Z', observedAt: '2099-01-01T00:00:03Z' } };
}
async function diagnosticFixture(change = () => {}) {
  const f = await fixture(); f.state.pending = [DIAGNOSTIC_FILE];
  f.state.capture = diagnosticCaptured(); f.state.diagnosticLedger = [{ version: DIAGNOSTIC_VERSION, name: DIAGNOSTIC_NAME, statements: ['actual fake BEGIN', 'actual fake INSERT', 'actual fake COMMIT'] }];
  const artifacts = diagnosticArtifacts();
  const diagnosticAdmission = { schema: 'overdrafter.cli-session-diagnostic-admission.v1', qualification: 'synthetic-only', purpose: 'direct-cli-session-only', parentSourceCommit: DIAGNOSTIC_PARENT,
    rehearsalAdmissionSha256: diagnosticHash(JSON.stringify(f.options.admission, null, 2) + '\n'), files: artifacts.files, hashes: artifacts.hashes,
    limits: { containers: 2, networks: 1, cpus: 2, memory: 3221225472, pids: 256, commandMs: 60000, runnerMs: 1800000, cleanupMs: 60000, terminationGraceMs: 2000, outputBytes: 8000000 },
    expiresAt: new Date(Date.now() + 600000).toISOString() };
  const execute = async (binary, args, opts) => {
    const result = await f.execute(binary, args, opts);
    if (opts.input === DIAGNOSTIC_EMPTY_SQL) result.stdout = JSON.stringify({ diagnosticAbsent: !f.state.diagnosticPresent, ledgerAbsent: !f.state.ledgerPresent });
    if (opts.input === DIAGNOSTIC_READ_SQL) result.stdout = JSON.stringify(f.state.capture);
    if (opts.input === DIAGNOSTIC_LEDGER_SQL) result.stdout = JSON.stringify(f.state.diagnosticLedger);
    if (opts.input === DIAGNOSTIC_BACKENDS_SQL) result.stdout = JSON.stringify({ remaining: f.state.backendResidue ? [{ pid: 99 }] : [], observedAt: '2099-01-01T00:00:04Z' });
    await change(f, args, opts, result);
    return result;
  };
  return { ...f, execute, diagnosticAdmission, create: () => createCachedFixtureAdapter(f.options, { execute, validatePins: () => {} }) };
}

test('fixed direct diagnostic stages one separate file, records actual fake evidence, cleans and seals its instance', async () => {
  const f = await diagnosticFixture(); try {
    const before = [...f.options.sourceFiles].map(([p, b]) => [p, hash(b)]), a = f.create();
    const result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission });
    assert.equal(result.status, 'simulated-completed'); assert.equal(result.qualification, 'fake-transport-only'); assert.equal(result.directCliSessionObserved, false);
    assert.deepEqual(result.directObservation.row, f.state.capture.rows[0]); assert.deepEqual(result.observerObservation, f.state.capture.observer);
    assert.deepEqual(result.ledger.rows, f.state.diagnosticLedger); assert.equal(result.cleanup.status, 'removed_and_observed_absent');
    assert.doesNotThrow(() => validateCaptureBinding(result, f.options.session.expected));
    for (const change of [r => { r.target.id = id(999); }, r => { r.directObservation.row = r.observerObservation; },
      r => { r.directObservation.readbackReceipt.stdout = '{}'; }, r => { r.captureBinding.sqlSha256 = id(99); },
      r => { r.admission.hashes.config = id(9); }, r => { r.captureBinding.readbackReceiptSequence = 1; }]) {
      const changed = structuredClone(result); change(changed); assert.throws(() => validateCaptureBinding(changed, f.options.session.expected));
    }
    assert.equal(f.state.containers.size, 0); assert.equal(f.state.network, null);
    const cp = f.state.calls.find(c => c.args[0] === 'cp');
    assert.deepEqual(readFileSync(path.join(cp.args[1], 'supabase/migrations', DIAGNOSTIC_FILE)), diagnosticArtifacts().sql);
    assert.equal(f.state.calls.filter(c => c.args.includes('push') && !c.args.includes('--help') && !c.args.includes('--dry-run')).length, 1);
    assert.deepEqual([...f.options.sourceFiles].map(([p, b]) => [p, hash(b)]), before);
    assert(!JSON.stringify(result).match(/postgres:[a-f0-9]{64}@|PGPASSWORD=[a-f0-9]{64}/));
    await assert.rejects(a.startTarget('after-diagnostic'), /sealed/);
    await assert.rejects(a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission }), /unused_adapter/);
  } finally { await f.dispose(); }
});

test('diagnostic rejects arbitrary source, pin drift and prior targets before any diagnostic command', async () => {
  const f = await diagnosticFixture(); try {
    const a = f.create();
    await assert.rejects(a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission, sql: 'arbitrary' }), /unexpected_input/);
    const drift = structuredClone(f.diagnosticAdmission); drift.hashes.sql = 'a'.repeat(64);
    await assert.rejects(a.observeCliSession({ diagnosticAdmission: drift }), /artifact drift/);
    assert.equal(f.state.calls.length, 0);
    const h = (await a.startTarget('existing')).target;
    await assert.rejects(a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission }), /unused_adapter/);
    await assert.rejects(a.apply(h, { files: [{ path: 'supabase/migrations/' + DIAGNOSTIC_FILE, version: DIAGNOSTIC_VERSION, sha256: diagnosticArtifacts().hashes.sql }], expectedPending: [] }), /staged_source_identity/);
    await a.cleanup();
  } finally { await f.dispose(); }
});

test('diagnostic failure evidence survives missing row, membership/owner drift, wrong ledger or backend residue', async () => {
  for (const change of [f => { f.state.capture.rows = []; }, f => { f.state.capture.rows[0].currentUser = 'other'; },
    f => { f.state.capture.rows[0].membershipEdges = []; }, f => { f.state.capture.owners = { ...f.state.capture.owners, ovd660_cli_session: 'other' }; },
    f => { f.state.diagnosticLedger = []; }, f => { f.state.backendResidue = true; }]) {
    const f = await diagnosticFixture(); try {
      change(f); const a = f.create(), result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission });
      assert.equal(result.status, 'failed'); assert.equal(result.directCliSessionObserved, false); assert(result.reason);
      assert.equal(result.cleanup.status, 'removed_and_observed_absent'); assert(result.receipts.length > 0);
      assert(result.phases.some(p => p.name === 'failure'));
      await assert.rejects(a.startTarget('retry'), /sealed/);
    } finally { await f.dispose(); }
  }
});

test('diagnostic dry-run mismatch, CLI failure, nonempty target and cleanup failure cannot pass', async () => {
  for (const change of [f => { f.state.pending.push('20990101000001_other.sql'); }, f => { f.state.failedApply = true; },
    f => { f.state.diagnosticPresent = true; }, f => { f.state.ledgerPresent = true; }, f => { f.state.failRemoval = true; }]) {
    const f = await diagnosticFixture(); try {
      change(f); const a = f.create(), result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission }); assert.equal(result.status, 'failed');
      if (f.state.failRemoval) { assert.equal(result.cleanup.status, 'failed'); await assert.rejects(a.cleanup(), /cleanup_failed/); }
      else assert.equal(result.cleanup.status, 'removed_and_observed_absent');
      await assert.rejects(a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission }), /unused_adapter/);
    } finally { await f.dispose(); }
  }
});

test('diagnostic owns the entire operation and abort freezes the source operation while cleanup remains possible', async () => {
  let a, observed = false;
  const f = await diagnosticFixture(async (_f, args) => {
    if (!observed && args[4] === 'network' && args[5] === 'create') {
      observed = true; await assert.rejects(a.startTarget('overlap'), /sealed|concurrent/); a.abort();
    }
  });
  try {
    a = f.create(); const result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission });
    assert(observed); assert.equal(result.status, 'failed'); assert.match(result.reason, /aborted/);
    assert.equal(result.cleanup.status, 'removed_and_observed_absent'); await assert.rejects(a.startTarget('retry'), /sealed/);
  } finally { await f.dispose(); }
});

test('direct diagnostic rejects ambiguous JSON and abnormal apply transport while preserving redacted failures', async () => {
  for (const mode of ['duplicate-json', 'trailing-json', 'null-exit', 'signal', 'timeout', 'secret-error']) {
    const f = await diagnosticFixture((_f, args, opts, result) => {
      if (opts.input === DIAGNOSTIC_READ_SQL && mode === 'duplicate-json') result.stdout = result.stdout.replace('"rows":', '"rows":[],"rows":');
      if (opts.input === DIAGNOSTIC_READ_SQL && mode === 'trailing-json') result.stdout += '\n{}';
      if (args.includes('push') && !args.includes('--help') && !args.includes('--dry-run')) {
        if (mode === 'null-exit') result.status = null;
        if (mode === 'signal') result.signal = 'SIGTERM';
        if (mode === 'timeout') result.failure = 'timeout';
        if (mode === 'secret-error') { result.status = 1; result.stderr = 'failed at ' + args[args.indexOf('--db-url') + 1]; }
      }
    });
    try {
      const a = f.create(), result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission });
      assert.equal(result.status, 'failed', mode); assert.equal(result.directCliSessionObserved, false);
      assert.equal(result.cleanup.status, 'removed_and_observed_absent'); assert(!/postgres:[a-f0-9]{64}@/.test(JSON.stringify(result)));
      if (mode === 'secret-error') assert(result.receipts.some(r => r.stderr.includes('[fixture-secret]')));
      await assert.rejects(a.startTarget('retry'), /sealed/);
    } finally { await f.dispose(); }
  }
});

test('direct diagnostic shares the existing work deadline and cannot renew cleanup reserve', async () => {
  let elapsed = 0;
  const f = await diagnosticFixture((_f, args, opts) => { if (opts.input === DIAGNOSTIC_READ_SQL) elapsed = 1_740_001; });
  try {
    const a = createCachedFixtureAdapter(f.options, { execute: f.execute, validatePins: () => {}, now: () => elapsed });
    const result = await a.observeCliSession({ diagnosticAdmission: f.diagnosticAdmission });
    assert.equal(result.status, 'failed'); assert.match(result.reason, /work_deadline/);
    assert.equal(result.cleanup.status, 'removed_and_observed_absent');
    assert(!f.state.calls.some(c => c.options.input === DIAGNOSTIC_LEDGER_SQL));
    await assert.rejects(a.startTarget('new-budget'), /sealed/);
  } finally { await f.dispose(); }
});
