import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { FINAL_POSTMASTER_PROBE, readinessArguments, retainReadinessDiagnostics } from './ovd591-readiness.mjs';
import assert from 'node:assert/strict';
import { chmodSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, MIGRATIONS, RPCS, TABLES, BASELINE, PREFLIGHT_SQL, CATALOG_SQL,
  admitEnvironment, admitImage, admitPreflight, admitCatalog, baselineInputs,
  createArguments, cleanupFixture, evidenceStore, execute, runCiFixture } from './ovd591-ci-fixture.mjs';
import { IMAGE } from './ovd591-sql-qualification.mjs';
import { RETENTION_MIGRATION, RETENTION_BASELINE, RETENTION_CATALOG_SQL, RETENTION_TABLES,
  RETENTION_RPCS, RETENTION_SUITES } from './ovd591-retention-profile.mjs';
import { ASSERTIONS, GROUPS } from './ovd591-retention-concurrency.mjs';

const source = 'a'.repeat(40), containerId = 'b'.repeat(64), networkId = 'c'.repeat(64);
const imageId = 'sha256:' + 'd'.repeat(64);
const image = () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: {
  Env: ['PGDATA=/var/lib/postgresql/data'], Entrypoint: ['docker-entrypoint.sh'], Cmd: ['postgres'],
  Volumes: { '/var/lib/postgresql/data': {} } } });
const preflight = () => ({ database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres',
  serverAddress: null, clientAddress: null, version: '170006', extensionsSchema: true, pgtapAvailable: true, emptyBaseline: true,
  roles: ['anon', 'authenticated', 'postgres', 'service_role'].map(name => ({ name, super: false,
    bypass: name === 'service_role', createRole: false })) });
const catalog = () => ({ tables: TABLES.map(name => ({ name, owner: 'postgres', rls: true, forced: true, policies: 0, denied: true })),
  rpcs: [...RPCS].sort().map(signature => ({ signature, exists: true, owner: 'postgres', definer: true, fixedSearchPath: true, serviceOnly: true })),
  rpcCount: RPCS.length, privateHelpersDenied: true, emptyTables: true });
const retentionCatalog = () => ({ tables: [...RETENTION_TABLES].sort().map(name => ({ name, owner: 'postgres', rls: true, forced: true, policies: 0, denied: true })),
  rpcs: [...RETENTION_RPCS].sort().map(signature => ({ signature, exists: true, owner: 'postgres', definer: true, fixedSearchPath: true, serviceOnly: true })),
  rpcCount: 8, privateHelpersDenied: true, emptyTables: true, sequence: { cache: 1, cycle: false, owner: 'postgres', denied: true } });
const pass = stdout => ({ status: 0, failure: null, stdout: stdout ?? '', stderr: '' });
const fail = () => ({ status: 1, failure: null, stdout: '', stderr: 'synthetic failure' });
const json = value => JSON.stringify(value) + '\n';

function fixture(t, fault, profile = 'capability') {
  const temp = mkdtempSync(join(tmpdir(), 'ovd591-ci-unit-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const out = join(temp, 'evidence');
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: source, RUNNER_TEMP: temp };
  const calls = [], sql = [];
  let network = null, container = null, secret = null;
  const labels = args => Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
  const inventory = kind => kind === 'containers' ? (container ? [containerId] : [])
    : kind === 'networks' ? ['e'.repeat(64), ...(network ? [networkId] : [])] : [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, input: options.input, timeout: options.timeout });
    const failed = fault?.({ command, args, options, network, container, calls });
    if (failed) return failed;
    if (command === 'git') return pass(args[0] === 'rev-parse' ? source + '\n' : '');
    if (command === process.execPath) {
      assert.equal(args[0], profile === 'retention' ? 'scripts/ovd591-retention-qualification.mjs' : 'scripts/ovd591-sql-qualification.mjs');
      assert.equal(args.at(-1), '--concurrency=psql');
      mkdirSync(args[2]);
      const cases = profile === 'retention'
        ? RETENTION_SUITES.map(name => ({ name, assertions: 1 })) // orchestration simulation, not SQL evaluation
        : [
        { name: 'capability_observation_ledger', assertions: 41 },
        { name: 'capability_observation_rpcs', assertions: 34 },
        { name: 'capability_runtime_persistence', assertions: 129 },
        { name: 'capability_runtime_persistence_concurrency', assertions: 28, transport: 'persistent-psql-unix-socket-v1' },
      ];
      if (profile === 'retention') Object.assign(cases.at(-1), { assertions: ASSERTIONS, groups: GROUPS,
        subcases: 11, transport: 'persistent-psql-unix-socket-v1' });
      writeFileSync(join(args[2], 'result.json'), json({ status: 'passed', source, containerId, transport: 'psql', profile, cases }));
      return pass();
    }
    assert.equal(command, 'docker');
    if (args[0] === 'pull') { assert.equal(args[1], IMAGE); return pass('pinned pull receipt\n'); }
    if (args[0] === 'image') return pass(json([image()]));
    if (args[0] === 'container' && args[1] === 'ls') return pass(args.includes('--format')
      ? (container?.Name.slice(1) ?? '') : inventory('containers').join('\n'));
    if (args[0] === 'network' && args[1] === 'ls') return pass(args.includes('--format')
      ? 'bridge\n' + (network?.Name ?? '') : inventory('networks').join('\n'));
    if (args[0] === 'volume') return pass(inventory('volumes').join('\n'));
    if (args[0] === 'network' && args[1] === 'create') {
      network = { Id: networkId, Name: args.at(-1), Labels: labels(args), Internal: true, Containers: {} }; return pass(networkId);
    }
    if (args[0] === 'network' && args[1] === 'inspect') return network ? pass(json([network])) : fail();
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const envText = readFileSync(args[args.indexOf('--env-file') + 1], 'utf8'); secret = envText.trim().slice('POSTGRES_PASSWORD='.length);
      assert.match(secret, /^[a-f0-9]{64}$/); assert(!args.some(arg => arg.includes(secret)));
      container = { Id: containerId, Name: '/' + name, Image: imageId, Config: { Image: IMAGE, Labels: labels(args), Env: [envText.trim()] },
        State: { Running: false }, HostConfig: { NanoCpus: 2_000_000_000, Memory: 3 * 1024 ** 3, PidsLimit: 256,
          Privileged: false, NetworkMode: networkId, PortBindings: {}, Tmpfs: {
            '/var/lib/postgresql/data': 'rw,nosuid,size=1536m', '/tmp': 'rw,nosuid,size=256m' }, RestartPolicy: { Name: 'no' } },
        Mounts: [], NetworkSettings: { Networks: { fixture: { NetworkID: networkId } } } };
      network.Containers[containerId] = {};
      return pass(containerId);
    }
    if (args[0] === 'start') { container.State.Running = true; return pass(containerId); }
    if (args[0] === 'inspect') return container ? pass(json([container])) : fail();
    if (args[0] === 'exec') {
      if (args.includes('sh')) return pass('final-postmaster-ready\n');
      sql.push(options.input);
      if (options.input === PREFLIGHT_SQL) return pass(json(preflight()));
      if (options.input === CATALOG_SQL) return pass(json(catalog()));
      if (options.input === RETENTION_CATALOG_SQL) return pass(json(retentionCatalog()));
      if (String(options.input).includes("backend_type='client backend'")) return pass('[]\n');
      return pass('synthetic SQL completed\n');
    }
    if (args[0] === 'rm') { assert.deepEqual(args, ['rm', '--force', containerId]); container = null; delete network.Containers[containerId]; return pass(containerId); }
    if (args[0] === 'network' && args[1] === 'rm') { assert.equal(args[2], networkId); network = null; return pass(networkId); }
    throw new Error(`unhandled synthetic command ${args.join(' ')}`);
  };
  return { out, temp, env, exec, calls, sql, get secret() { return secret; } };
}
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]); }

test('selected baseline contains exact maintained prerequisite statements and unchanged migration bytes', () => {
  const inputs = baselineInputs(ROOT);
  assert.deepEqual(inputs.migrations.map(value => value.path), MIGRATIONS);
  assert.equal(inputs.prerequisites.length, 4);
  for (const entry of inputs.migrations) {
    assert.deepEqual(entry.bytes, readFileSync(join(ROOT, entry.path)));
    assert.equal(entry.sha256, createHash('sha256').update(entry.bytes).digest('hex'));
  }
  assert(BASELINE.includes('Not full-head')); assert(BASELINE.includes('retention'));
  assert(!/create role|alter role|pg_hba|trust|password/i.test(inputs.bootstrap));
});

test('CI admission rejects missing, foreign or injected run identities before any Docker operation', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: source, RUNNER_TEMP: '/tmp' };
  assert.equal(admitEnvironment(env), 'ovd591-1-1');
  for (const patch of [{ GITHUB_ACTIONS: undefined }, { RUNNER_OS: 'macOS' }, { GITHUB_RUN_ID: '1;echo' },
    { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_SHA: 'main' }, { RUNNER_TEMP: 'relative' }]) assert.throws(() => admitEnvironment({ ...env, ...patch }));
});

test('image contract rejects anonymous-volume paths, alternate PGDATA and foreign platform', () => {
  admitImage(image());
  for (const mutate of [v => { v.Config.Volumes['/unbounded'] = {}; }, v => { v.Config.Env = ['PGDATA=/other']; },
    v => { v.Os = 'windows'; }, v => { v.Architecture = 'arm64'; }, v => { v.Config.Entrypoint = []; }]) {
    const changed = image(); mutate(changed); assert.throws(() => admitImage(changed));
  }
});

test('platform and catalog receipts require actual socket authority and closed private/public boundaries', () => {
  admitPreflight(preflight()); admitCatalog(catalog());
  for (const mutate of [v => { v.serverAddress = '127.0.0.1'; }, v => { v.currentUser = 'supabase_admin'; },
    v => { v.roles[2].super = true; }, v => { v.roles.pop(); }, v => { v.emptyBaseline = false; }, v => { v.pgtapAvailable = false; }]) {
    const value = preflight(); mutate(value); assert.throws(() => admitPreflight(value));
  }
  for (const mutate of [v => { v.tables[0].forced = false; }, v => { v.tables[0].policies = 1; }, v => { v.tables[0].denied = false; },
    v => { v.rpcs[0].serviceOnly = false; }, v => { v.rpcs[0].fixedSearchPath = false; }, v => { v.rpcCount++; },
    v => { v.privateHelpersDenied = false; }, v => { v.emptyTables = false; }]) {
    const value = catalog(); mutate(value); assert.throws(() => admitCatalog(value));
  }
});

test('creation uses only bounded tmpfs, explicit internal network, no ports/volumes or secret argv', () => {
  const args = createArguments({ containerName: 'ovd591-test', networkId, source, token: 'fixture-id' }, '/tmp/fixture.env');
  assert(args.includes('--env-file')); assert(args.includes('--pids-limit')); assert(args.includes('--security-opt'));
  for (const denied of ['--privileged', '--publish', '-p', '--volume', '-v', '--mount', '--network=host']) assert(!args.includes(denied));
  assert.equal(args.at(-1), IMAGE);
});

test('successful simulated orchestration submits real files, explicit psql mode, receipts and observed cleanup', async t => {
  const f = fixture(t);
  await runCiFixture({ out: f.out, env: f.env }, { exec: f.exec });
  assert.equal(f.sql.length, 7); // preflight + bootstrap + 3 migrations + catalog + final backend inventory
  for (let i = 0; i < MIGRATIONS.length; i++) assert.deepEqual(f.sql[i + 2], readFileSync(join(ROOT, MIGRATIONS[i])));
  const receipt = JSON.parse(readFileSync(join(f.out, 'provisioning.json')));
  assert.equal(receipt.containerId, containerId); assert.equal(receipt.imageId, imageId);
  assert.deepEqual(receipt.appliedInputs.map(value => value.path), MIGRATIONS);
  for (const evidence of Object.values(receipt.evidence)) assert.equal(createHash('sha256').update(readFileSync(evidence.path)).digest('hex'), evidence.sha256);
  const cleanup = JSON.parse(readFileSync(join(f.out, 'cleanup.json'))); assert.equal(cleanup.status, 'passed');
  assert.deepEqual(cleanup.before, cleanup.after);
  assert(files(f.out).every(file => !readFileSync(file, 'utf8').includes(f.secret)));
  assert(readdirSync(f.temp).every(name => !name.endsWith('.env')));
  assert(f.calls.filter(call => call.args[0] === 'rm').every(call => call.args.at(-1) === containerId));
});

test('closed retention profile uses a fresh identity, admits dependencies before the fourth migration and runs only its separate qualifier', async t => {
  const f = fixture(t, undefined, 'retention');
  await runCiFixture({ out: f.out, env: f.env, profile: 'retention' }, { exec: f.exec });
  assert.equal(f.sql.length, 9);
  assert.equal(f.sql[5], CATALOG_SQL);
  assert.deepEqual(f.sql[6], readFileSync(join(ROOT, RETENTION_MIGRATION)));
  assert.equal(f.sql[7], RETENTION_CATALOG_SQL);
  const receipt = JSON.parse(readFileSync(join(f.out, 'provisioning.json')));
  assert.equal(receipt.baselineSelection, RETENTION_BASELINE);
  assert.deepEqual(receipt.appliedInputs.map(value => value.path), [...MIGRATIONS, RETENTION_MIGRATION]);
  const state = JSON.parse(readFileSync(join(f.out, 'owned-state.json')));
  assert.equal(state.profile, 'retention'); assert.match(state.containerName, /^ovd591-123-2-retention-/);
  assert.equal(f.calls.filter(call => call.command === process.execPath).length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
  assert(files(f.out).every(file => !readFileSync(file, 'utf8').includes(f.secret)));
});

test('unknown fixture profile is rejected before creating output or invoking a command', async t => {
  const f = fixture(t);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env, profile: 'arbitrary-sql' }, { exec: f.exec }), /profile/);
  assert.equal(f.calls.length, 0); assert.deepEqual(readdirSync(f.temp), []);
});

for (const stage of ['retention-migration', 'retention-catalog', 'retention-qualification']) {
  test(`${stage} failure retains evidence and uses the same exact-owned cleanup`, async t => {
    const f = fixture(t, ({ command, options }) => {
      if (stage === 'retention-migration' && Buffer.isBuffer(options.input)
        && options.input.equals(readFileSync(join(ROOT, RETENTION_MIGRATION)))) return fail();
      if (stage === 'retention-catalog' && options.input === RETENTION_CATALOG_SQL) {
        const bad = retentionCatalog(); bad.sequence.cache = 32; return pass(json(bad));
      }
      if (stage === 'retention-qualification' && command === process.execPath) return fail();
    }, 'retention');
    await assert.rejects(runCiFixture({ out: f.out, env: f.env, profile: 'retention' }, { exec: f.exec }));
    assert.equal(JSON.parse(readFileSync(join(f.out, 'fixture-result.json'))).status, 'failed');
    assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
    if (stage !== 'retention-qualification') assert(!f.calls.some(call => call.command === process.execPath));
  });
}

test('retention migration/catalog notices use the accepted safe aggregate serializer and exact stored hashes', async t => {
  const f = fixture(t, undefined, 'retention');
  const exec = async (command, args, options) => {
    const result = await f.exec(command, args, options);
    if (options.input === RETENTION_CATALOG_SQL || (Buffer.isBuffer(options.input)
      && options.input.equals(readFileSync(join(ROOT, RETENTION_MIGRATION))))) result.stderr += `NOTICE: ${f.secret}\n`;
    return result;
  };
  await runCiFixture({ out: f.out, env: f.env, profile: 'retention' }, { exec });
  assert.deepEqual(files(f.out).filter(file => readFileSync(file, 'utf8').includes(f.secret)), []);
  const receipt = JSON.parse(readFileSync(join(f.out, 'provisioning.json')));
  for (const entry of Object.values(receipt.evidence)) {
    const bytes = readFileSync(entry.path); assert(bytes.includes('[redacted-fixture-secret]'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});

for (const stage of ['bootstrap', 'migration', 'catalog']) {
  test(`SQL ${stage} notices cannot leak the generated secret into aggregate, copied or hashed evidence`, async t => {
    const f = fixture(t);
    const exec = async (command, args, options) => {
      const result = await f.exec(command, args, options);
      const matches = stage === 'catalog' ? options.input === CATALOG_SQL
        : stage === 'migration' ? Buffer.isBuffer(options.input)
          : options.input === baselineInputs(ROOT).bootstrap;
      if (matches) result.stderr += `NOTICE: synthetic output contains ${f.secret}\n`;
      if (command === process.execPath) {
        const receipt = JSON.parse(readFileSync(args[3]));
        for (const [kind, entry] of Object.entries(receipt.evidence)) {
          // Match the unchanged qualifier's evidence copy after validating its hash.
          const bytes = readFileSync(entry.path);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
          writeFileSync(join(args[2], `${kind}-provisioning-evidence.log`), bytes);
        }
      }
      return result;
    };
    await runCiFixture({ out: f.out, env: f.env }, { exec });
    const leaking = files(f.out).filter(file => readFileSync(file, 'utf8').includes(f.secret));
    assert.deepEqual(leaking, [], 'only artifact paths are reported if a fixture secret leaks');
    const aggregate = readFileSync(join(f.out, stage === 'catalog' ? 'catalog.log' : 'migration.log'), 'utf8');
    assert(aggregate.includes('[redacted-fixture-secret]'));
  });
}

test('central evidence serializer redacts text and structured fields before computing artifact hashes', t => {
  const f = fixture(t); mkdirSync(f.out);
  const store = evidenceStore(f.out, 'test-generated-secret');
  for (const receipt of [store.text('text.log', Buffer.from('before test-generated-secret after')),
    store.save('structured.json', { nested: ['test-generated-secret'] })]) {
    const bytes = readFileSync(receipt.path);
    assert(!bytes.includes('test-generated-secret')); assert(bytes.includes('[redacted-fixture-secret]'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  }
});

test('migration failure cannot become a receipt or invoke qualification; exact owned resources are removed', async t => {
  const f = fixture(t, ({ args, options }) => args[0] === 'exec' && Buffer.isBuffer(options.input) ? fail() : null);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }), /migrations/);
  assert(!f.calls.some(call => call.command === process.execPath));
  assert(!readdirSync(f.out).includes('provisioning.json'));
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
  assert.equal(JSON.parse(readFileSync(join(f.out, 'fixture-result.json'))).status, 'failed');
});

test('catalog failure stops qualification and retains raw command output with cleanup', async t => {
  const f = fixture(t, ({ options }) => options.input === CATALOG_SQL ? pass(json({ ...catalog(), emptyTables: false })) : null);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }), /catalog/);
  assert(!f.calls.some(call => call.command === process.execPath));
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
});

test('nonzero qualification cannot pass even with successful cleanup', async t => {
  const f = fixture(t, ({ command }) => command === process.execPath ? fail() : null);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }), /qualification/);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'fixture-result.json'))).status, 'failed');
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
});

test('zero exit without the complete exact qualification receipt still fails', async t => {
  const f = fixture(t);
  const exec = async (command, args, options) => {
    const result = await f.exec(command, args, options);
    if (command === process.execPath) {
      const path = join(args[2], 'result.json'), receipt = JSON.parse(readFileSync(path));
      receipt.cases.at(-1).assertions = 27; writeFileSync(path, json(receipt));
    }
    return result;
  };
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec }), /qualification/);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
});

test('remaining real client-backend receipt fails acceptance even after a passing harness receipt', async t => {
  const f = fixture(t, ({ options }) => String(options.input).includes("backend_type='client backend'") ? pass('[999]\n') : null);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }), /backend-cleanup/);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
});

test('cleanup refuses foreign labels and never deletes that container or its network', async t => {
  let inspections = 0;
  const f = fixture(t, ({ args, container }) => {
    if (args[0] !== 'inspect' || !container) return null;
    if (++inspections < 2) return null;
    return pass(json([{ ...container, Config: { ...container.Config, Labels: { ...container.Config.Labels, 'ovd591.fixture': 'foreign' } } }]));
  });
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }), /failed/);
  assert(!f.calls.some(call => call.args[0] === 'rm' || (call.args[0] === 'network' && call.args[1] === 'rm')));
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'failed');
});

test('malformed private inspect output never leaks an environment fragment through cleanup errors', async t => {
  let inspections = 0;
  const fragment = 'forbidden-fixture-secret-fragment';
  const f = fixture(t, ({ args, container }) => args[0] === 'inspect' && container && ++inspections === 2
    ? pass(`{"Config":{"Env":["POSTGRES_PASSWORD=${fragment}"}}`) : null);
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }));
  assert(files(f.out).every(file => !readFileSync(file, 'utf8').includes(fragment)));
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).failure, 'owned_cleanup_or_inventory_unconfirmed');
});

test('name collision stops before creation and leaves unrelated resources intact', async t => {
  const f = fixture(t, ({ args }) => {
    if (args[0] === 'container' && args.includes('--format')) {
      const state = JSON.parse(readFileSync(join(f.out, 'owned-state.json'))); return pass(state.containerName + '\n');
    }
    return null;
  });
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec: f.exec }));
  assert(!f.calls.some(call => call.args.includes('create') || call.args.includes('rm')));
});

test('lost container-create acknowledgment is resolved only with exact unique ownership before cleanup', async t => {
  const f = fixture(t);
  const exec = async (command, args, options) => {
    const result = await f.exec(command, args, options);
    return command === 'docker' && args[0] === 'create'
      ? { status: null, stdout: '', stderr: '', failure: 'timeout' } : result;
  };
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec }), /container/);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'owned-state.json'))).containerId, null);
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
  assert(f.calls.some(call => call.args[0] === 'rm' && call.args.at(-1) === containerId));
});

test('unrelated inventory drift fails cleanup without deleting the unfamiliar object', async t => {
  const f = fixture(t);
  let removed = false;
  const exec = async (command, args, options) => {
    const result = await f.exec(command, args, options);
    if (args[0] === 'rm') removed = true;
    if (removed && args[0] === 'volume') return pass('unrelated-volume\n');
    return result;
  };
  await assert.rejects(runCiFixture({ out: f.out, env: f.env }, { exec }), /failed/);
  const cleanup = JSON.parse(readFileSync(join(f.out, 'cleanup.json')));
  assert.equal(cleanup.status, 'failed'); assert(cleanup.after.volumes.includes('unrelated-volume'));
  assert(!f.calls.some(call => call.args.includes('unrelated-volume')));
});

test('cancellation stops subsequent stages while cleanup uses its separate bound', async t => {
  const controller = new AbortController();
  const f = fixture(t);
  const exec = async (command, args, options) => {
    if (options.signal?.aborted) return { status: null, stdout: '', stderr: '', failure: 'aborted' };
    const result = await f.exec(command, args, options);
    if (args[0] === 'start') controller.abort();
    return result;
  };
  await assert.rejects(runCiFixture({ out: f.out, env: f.env, signal: controller.signal }, { exec }));
  assert(!f.calls.some(call => call.command === process.execPath));
  assert.equal(JSON.parse(readFileSync(join(f.out, 'cleanup.json'))).status, 'passed');
});

test('second cleanup verifies absence and preserves each earlier cleanup receipt', async t => {
  const f = fixture(t); await runCiFixture({ out: f.out, env: f.env }, { exec: f.exec });
  const state = JSON.parse(readFileSync(join(f.out, 'owned-state.json')));
  await cleanupFixture({ root: ROOT, out: f.out, state, exec: f.exec });
  assert.equal(readdirSync(f.out).filter(name => name.startsWith('cleanup-')).length, 2);
  assert.equal(f.calls.filter(call => call.args[0] === 'rm').length, 1);
});

test('real inert subprocess timeout and output overflow fail with bounded retained output', async () => {
  const timed = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 });
  assert.equal(timed.failure, 'timeout'); assert.notEqual(timed.status, 0);
  const overflow = await execute(process.execPath, ['-e', 'require("node:fs").writeSync(1,"x".repeat(9000000))'], { timeout: 5000 });
  assert.equal(overflow.failure, 'output_limit'); assert(overflow.stdout.length <= 8_000_000);
});

test('workflow is reusable, secret-free, fixed psql entrypoint with always cleanup/artifact retention', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ovd591-qualification.yml'), 'utf8');
  for (const expected of ['workflow_call:', 'contents: read', 'persist-credentials: false', 'node-version: 20',
    'timeout-minutes: 30', 'ovd591-ci-fixture.mjs run', 'ovd591-ci-fixture.mjs cleanup', 'actions/upload-artifact@v4']) assert(workflow.includes(expected));
  assert.equal(workflow.match(/if: always\(\)/g).length, 2);
  assert(!/secrets\.|db reset|prune|sudo|continue-on-error/.test(workflow));
});


// Inert shell fixtures validate the readiness protocol, never PostgreSQL health.
function readinessFixture(t, { wrapped = true, pid = '1', dataMismatch = false, wrongExecutable = false, ready = true, version = '17' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ovd591-readiness-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'), bin = join(directory, 'bin'); mkdirSync(data); mkdirSync(bin);
  writeFileSync(join(data, 'PG_VERSION'), version + '\n');
  writeFileSync(join(data, 'postmaster.pid'), `${pid}\n${dataMismatch ? '/wrong' : data}\n`);
  writeFileSync(join(bin, 'postgres'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'postgres'), 0o700);
  if (wrapped) { writeFileSync(join(bin, '.postgres-wrapped'), 'inert executable fixture'); chmodSync(join(bin, '.postgres-wrapped'), 0o700); }
  symlinkSync(wrongExecutable ? '/bin/sh' : join(bin, wrapped ? '.postgres-wrapped' : 'postgres'), join(directory, 'pid1-exe'));
  writeFileSync(join(bin, 'pg_isready'), `#!/bin/sh\nprintf '%s\n' "$@" > '${directory}/socket-arguments'\nexit ${ready ? 0 : 1}\n`);
  chmodSync(join(bin, 'pg_isready'), 0o700);
  const script = FINAL_POSTMASTER_PROBE.replaceAll('/var/lib/postgresql/data', data).replace('/proc/1/exe', join(directory, 'pid1-exe'));
  const result = spawnSync('/bin/sh', ['-ceu', script], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, PGDATA: data, PATH: bin + ':' + process.env.PATH, PGHOST: 'untrusted.example', PGHOSTADDR: '203.0.113.10' } });
  return { result, directory };
}

test('final PID1 packaged Nix executable passes without depending on truncated comm; explicit Unix socket is required', t => {
  const { result, directory } = readinessFixture(t);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'final-postmaster-ready\n');
  assert.deepEqual(readFileSync(join(directory, 'socket-arguments'), 'utf8').trim().split('\n'),
    ['-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q']);
  assert(!FINAL_POSTMASTER_PROBE.includes('/proc/1/comm'));
});

test('direct packaged postgres executable also requires exact PID1 executable identity', t => {
  const { result } = readinessFixture(t, { wrapped: false }); assert.equal(result.status, 0, result.stderr);
});
for (const [name, options, failure] of [
  ['temporary bootstrap postmaster', { pid: '52' }, 'final-postmaster-pid'],
  ['wrong data directory', { dataMismatch: true }, 'postmaster-data-path'],
  ['unrelated PID1 executable', { wrongExecutable: true }, 'final-postmaster-executable'],
  ['wrong major version', { version: '16' }, 'pg-version'],
  ['unready final socket', { ready: false }, 'socket-not-ready'],
]) test(`readiness rejects ${name} with a named predicate, never a false ready marker`, t => {
  const { result } = readinessFixture(t, options); assert.equal(result.status, 1);
  assert.equal(result.stdout, `readiness-not-ready:${failure}\n`);
});

test('readiness diagnostics are exact-ID, bounded read-only calls and remain best-effort before cleanup', async () => {
  const calls = [];
  await retainReadinessDiagnostics(async (command, args, options) => {
    calls.push({ command, args, options }); if (calls.length === 1) throw new Error('inert diagnostic failure');
  }, containerId);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, 'docker'); assert(call.args.includes(containerId));
    assert.equal(call.options.timeout, 3000); assert.equal(call.options.cleanup, true); assert.equal(call.options.allowFailure, true);
    assert(!call.args.some(arg => /^(rm|stop|kill|start)$/.test(arg)));
  }
  assert.deepEqual(calls[1].args, ['logs', '--tail', '120', containerId]);
  await assert.rejects(retainReadinessDiagnostics(async () => assert.fail('must not run'), 'foreign-name'));
});


test('readiness and process diagnostics use the final PostgreSQL OS identity without extra capabilities', async () => {
  assert.deepEqual(readinessArguments(containerId), ['exec', '--user', 'postgres', containerId, 'sh', '-ceu', FINAL_POSTMASTER_PROBE]);
  assert.throws(() => readinessArguments('arbitrary-name'));
  const calls = []; await retainReadinessDiagnostics(async (_command, args) => calls.push(args), containerId);
  assert.deepEqual(calls[2].slice(0, 4), ['exec', '--user', 'postgres', containerId]);
  assert(!readinessArguments(containerId).includes('--privileged'));
});
