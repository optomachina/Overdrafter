import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RACE_HELPER_SHA256, RACE_NAMES, loadPinnedRaceEngine, prepareRacePackage,
  validateRaceProcessSpec, createOfflineRaceSession, acceptRaceCompletion, runOfflineRaceEngine, runOwnedRaces,
} from './races.mjs';

// Optional explicit test-source root supplies the exact pinned JS bytes when an
// isolated source lane lacks the complete release checkout. Hash checks still
// apply. No helper is fetched and no database is started by this test file.
const helperRoot = process.env.OVD_RACE_HELPER_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const helpers = () => new Map(Object.keys(RACE_HELPER_SHA256).map((name) => [name, readFileSync(path.join(helperRoot, name))]));
const copy = (value) => JSON.parse(JSON.stringify(value));
function spec() {
  return { binary: '/usr/bin/docker', sha256: 'a'.repeat(64), cwd: '/tmp/invented-owned',
    env: { HOME: '/tmp/invented-owned/home', DOCKER_CONFIG: '/tmp/invented-owned/docker', LANG: 'C', LC_ALL: 'C' },
    args: ['--host', 'unix:///var/run/docker.sock', '--config', '/tmp/invented-owned/docker', 'exec', '-i', 'b'.repeat(64),
      'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/tmp/ovd658-home', 'LANG=C', 'LC_ALL=C',
      'PGHOST=/var/run/postgresql', 'PGPORT=5432', 'PGPASSFILE=/dev/null/ovd658-disabled',
      'PGOPTIONS=-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000 -cclient_min_messages=warning',
      'PGAPPNAME=ovd658-race', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'] };
}

test('actual pinned five-helper closure imports without invoking a legacy wrapper', async () => {
  const engine = await loadPinnedRaceEngine(helpers());
  assert.equal(typeof engine.executeFreeQuoteRaces, 'function');
  assert.equal(typeof engine.blockerSql, 'function');
});

test('helper loading rejects missing, surplus, changed and arbitrary executable modules', async () => {
  for (const mutate of [
    (m) => m.delete('scripts/ovd591-qualification-paths.mjs'),
    (m) => m.set('scripts/extra.mjs', Buffer.from('throw new Error("must not execute")')),
    (m) => m.set('scripts/free-quote-psql-races.mjs', Buffer.from('globalThis.unsafeRaceHelperExecuted = true;')),
    (m) => m.set('scripts/ovd591-sql-qualification.mjs', Buffer.concat([m.get('scripts/ovd591-sql-qualification.mjs'), Buffer.from('\n')])),
  ]) {
    const input = helpers(); mutate(input); await assert.rejects(loadPinnedRaceEngine(input));
  }
  assert.equal(globalThis.unsafeRaceHelperExecuted, undefined);
});

test('owned transport allows only the exact socket/env/psql command shape', () => {
  const original = spec(); const result = validateRaceProcessSpec(original);
  assert.deepEqual(result, original); original.args[0] = 'changed'; assert.equal(result.args[0], '--host');
  for (const mutate of [
    (s) => { s.binary = 'docker'; }, (s) => { s.binary = '/usr/bin/node'; },
    (s) => { s.args[1] = 'tcp://example.test:2375'; }, (s) => { s.args[6] = 'friendly-name'; },
    (s) => s.args.push('--privileged'), (s) => { s.args[8] = '-u'; },
    (s) => { s.args[13] = 'PGHOST=external'; }, (s) => { s.args[15] = 'PGPASSWORD=not-allowed'; },
    (s) => { s.args[19] = '-c'; }, (s) => { s.args[20] = 'arbitrary SQL'; },
    (s) => { s.env.PGPASSWORD = 'not-allowed'; }, (s) => { s.env.DOCKER_HOST = 'tcp://external'; },
    (s) => { s.env.HOME = 'relative'; }, (s) => { s.sha256 = ''; },
  ]) { const input = spec(); mutate(input); assert.throws(() => validateRaceProcessSpec(input)); }
});

test('real entry refuses unpinned profile/helper inputs before any executable can launch', async () => {
  const evidence = {};
  await assert.rejects(runOwnedRaces({ processSpec: spec(), sourceFiles: new Map(), profileManifestBytes: Buffer.from('{}'), helperFiles: helpers(), evidence, deadlineMs: 30_000 }), /pinned race profile/);
  assert.equal(evidence.status, undefined);
  assert.throws(() => prepareRacePackage({ sourceFiles: new Map(), profileManifestBytes: Buffer.from('{}') }));
});

test('exact source package is hash-closed before preparing the eighteen SQL races', () => {
  const sourceRoot = process.env.OVD_RACE_SOURCE_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
  const profileManifestBytes = readFileSync(path.join(sourceRoot, 'scripts/fixtures/free-quote-ci-source.json'));
  const profile = JSON.parse(profileManifestBytes);
  const sourceFiles = new Map(Object.keys(profile.files).map((name) => [name, readFileSync(path.join(sourceRoot, name))]));
  const pkg = prepareRacePackage({ sourceFiles, profileManifestBytes });
  assert.deepEqual(pkg.races.map((race) => race.name), RACE_NAMES);
  const name = pkg.raceSetupSql; const original = sourceFiles.get(name);
  sourceFiles.set(name, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => prepareRacePackage({ sourceFiles, profileManifestBytes }), /race source mismatch/);
  sourceFiles.set(name, original); sourceFiles.set('extra.sql', Buffer.from('extra'));
  assert.throws(() => prepareRacePackage({ sourceFiles, profileManifestBytes }), /closed source map/);
  assert.equal(pkg.sql[name], original.toString());
});

const echoProgram = String.raw`
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  if (line === '\\q') { input.close(); process.stdin.pause(); process.exit(0); }
  else if (line.startsWith('\\echo ')) {
    process.stdout.write('value\n' + line.slice(6) + '\n');
  }
});`;

async function cleanup(session) {
  try { await session.close(); } catch { session.contain(); }
  await Promise.race([session.closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

test('real fake Node process frames exact sequential requests and records normal exit', async () => {
  const { session, record, qualification } = createOfflineRaceSession({ args: ['-e', echoProgram], timeoutMs: 500 });
  try {
    assert.equal(await session.request('invented first request'), 'value\n');
    assert.equal(await session.request('invented second request'), 'value\n');
    assert.notEqual(record.submissions[0].marker, record.submissions[1].marker);
    await session.close(); assert.deepEqual(record.exit, { code: 0, signal: null });
    assert.equal(record.timeoutMs, 500); assert.equal(record.maxOutputBytes, 65_536);
    assert(record.stdoutBytes > 12); assert.match(record.stdoutSha256, /^[a-f0-9]{64}$/);
    assert.equal(qualification, 'offline-test-only'); assert.equal(record.qualification, 'offline-test-only');
  } finally { await cleanup(session); }
});

test('early exit or incomplete stdout never completes a phase, and split UTF-8 remains exact', async () => {
  for (const program of ["process.stdin.once('data',()=>process.exit(0));", "process.stdin.once('data',()=>{process.stdout.write('partial');process.exit(0);});"]) {
    const { session } = createOfflineRaceSession({ args: ['-e', program], timeoutMs: 200 });
    try { await assert.rejects(session.request('invented'), /incomplete or failed process exit/); }
    finally { await cleanup(session); }
  }
  const split = echoProgram.replace("process.stdout.write('value\\n' + line.slice(6) + '\\n');",
    "process.stdout.write(Buffer.from([0xce])); setTimeout(()=>process.stdout.write(Buffer.concat([Buffer.from([0xbb]),Buffer.from('\\n'+line.slice(6)+'\\n')])),5);");
  const { session } = createOfflineRaceSession({ args: ['-e', split], timeoutMs: 500 });
  try { assert.equal(await session.request('invented'), 'λ\n'); await session.close(); }
  finally { await cleanup(session); }
});

test('framing refuses concurrent requests, stale acknowledgments, stderr and invalid UTF-8', async () => {
  const programs = [
    [`process.stdin.once('data',()=>process.stdout.write(${JSON.stringify('ovd591-frame-stale\n')}));`, /stale or foreign/],
    [`process.stdin.once('data',()=>process.stderr.write('unexpected error'));`, /unexpected stderr/],
    [`process.stdin.once('data',()=>process.stdout.write(Buffer.from([255])));`, /encoded data|encoding/i],
  ];
  for (const [program, refusal] of programs) {
    const { session } = createOfflineRaceSession({ args: ['-e', program], timeoutMs: 150 });
    try { await assert.rejects(session.request('invented'), refusal); } finally { await cleanup(session); }
  }
  const { session } = createOfflineRaceSession({ args: ['-e', 'process.stdin.resume();'], timeoutMs: 80 });
  try {
    const pending = session.request('first'); assert.throws(() => session.request('concurrent'), /concurrent/);
    await assert.rejects(pending, /phase deadline/);
  } finally { await cleanup(session); }
});

test('phase and shutdown deadlines contain a nonterminating fake process without claiming backend cleanup', async () => {
  const { session, record } = createOfflineRaceSession({ args: ['-e', 'setInterval(()=>{},1000);process.stdin.resume();'], timeoutMs: 75 });
  const started = Date.now();
  try {
    await assert.rejects(session.request('invented'), /phase deadline/);
    await assert.rejects(session.close(), /shutdown unconfirmed/);
    await session.closed; assert(Date.now() - started < 2_000);
    assert.equal(record.exit.signal, 'SIGKILL'); assert.equal(record.qualification, 'offline-test-only');
    assert.notEqual(record.backendCleanup, 'confirmed');
  } finally { await cleanup(session); }
});

test('session and aggregate output limits fail before accumulating unbounded evidence', async () => {
  for (const aggregate of [false, true]) {
    let observed = 0;
    const { session, record } = createOfflineRaceSession({ args: ['-e', "process.stdin.once('data',()=>process.stdout.write('x'.repeat(10000)));"],
      timeoutMs: 150, limit: aggregate ? 20_000 : 100,
      consume: (count) => { observed += count; if (aggregate && observed > 100) throw new Error('aggregate output limit'); } });
    try { await assert.rejects(session.request('invented'), /output limit/); assert(record.stdout.length <= 100); }
    finally { await cleanup(session); }
  }
});

function simulatedPackage() {
  const races = RACE_NAMES.map((name, i) => ({ name, setupSql: `${name}/setup`, acquireSql: `${name}/acquire`,
    contenders: [`${name}/actor`], releaseSql: `${name}/release`, verifySql: `${name}/verify`,
    ...(i === 17 ? { mode: 'complete-before-release', lockProbeSql: `${name}/probe` } : {}) }));
  const sql = { setup: 'setup' };
  for (const race of races) for (const value of [race.setupSql, race.acquireSql, ...race.contenders, race.releaseSql, race.verifySql, race.lockProbeSql].filter(Boolean)) sql[value] = value;
  return { raceSetupSql: 'setup', races, sql, inputs: {}, manifestSha256: 'synthetic-only' };
}

function simulation({ duplicatePid = false, wrongBlocker = false, leaveBackend = false } = {}) {
  const sessions = new Map(); let nextPid = 100;
  const stamp = '2099-01-01T00:00:00.000Z'; const tap = '1..1\nok 1 invented offline assertion\n';
  const json = (x) => JSON.stringify(x) + '\n';
  return (name, record) => {
    const pid = duplicatePid ? 100 : nextPid++;
    Object.assign(record, { exit: null, stdout: '', stderr: '', submissions: [], qualification: 'offline-test-only' });
    const session = { pid, record, failed: null, pending: null, child: { kill() {}, stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} }, unref() {} },
      fail(error) { this.failed ??= error; this.pending?.reject(error); this.pending = null; },
      async close() { record.exit = { code: 0, signal: null }; if (this.failed) throw this.failed; },
      async request(sql) {
        if (this.failed) throw this.failed;
        if (sql.includes("'sessionUser'")) return json({ pid, database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres', serverAddress: null, clientAddress: null, backendStart: stamp });
        if (sql.includes("'remaining'")) return json({ remaining: leaveBackend ? [Number(sql.match(/pid in \((\d+)/)[1])] : [], observedAt: stamp });
        if (sql.includes('pg_blocking_pids')) {
          const coordinator = Number(sql.match(/c.pid=(\d+)/)[1]); const pids = sql.match(/a.pid in \(([^)]+)\)/)[1].split(',').map(Number);
          return json(pids.map((actorPid) => ({ pid: actorPid, blockers: [wrongBlocker ? 999999 : coordinator], waitEvent: 'transactionid', observedAt: stamp, backendStart: stamp, coordinatorBackendStart: stamp })));
        }
        if (sql.endsWith('/release')) { for (const active of sessions.values()) { active.pending?.resolve(tap); active.pending = null; } return ''; }
        if (sql.endsWith('/verify') || (sql.endsWith('/actor') && sql.startsWith(RACE_NAMES[17]))) return tap;
        if (sql.endsWith('/actor') || sql.endsWith('/probe')) return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
        return '';
      },
    };
    sessions.set(name, session); return session;
  };
}

test('actual pinned engine runs all18 races with synthetic sessions but cannot yield admitted runtime evidence', async () => {
  const evidence = {}; const pkg = simulatedPackage();
  const result = await runOfflineRaceEngine({ helperFiles: helpers(), pkg, makeSession: simulation(), evidence,
    options: { timeoutMs: 1_000, overlapMs: 100, shutdownMs: 100, absenceMs: 100 } });
  assert.equal(result.status, 'simulated-completed'); assert.equal(result.qualification, 'offline-test-only');
  assert.deepEqual(evidence.races.map((r) => r.name), RACE_NAMES); assert.equal(evidence.races.length, 18);
  assert.equal(evidence.backendCleanup, 'all-non-observer-backends-observed-absent');
  assert(evidence.absences.length > 18); assert.equal(evidence.qualification, 'offline-test-only');
  for (const mutate of [
    (e) => e.races.pop(), (e) => e.races.reverse(), (e) => { e.races[0].status = 'skipped'; },
    (e) => { e.races[0].name = 'unknown'; }, (e) => { e.races[0].mode = 'unknown'; },
    (e) => { e.backendCleanup = 'unconfirmed'; }, (e) => { e.sessions.observer.exit = null; },
    (e) => { e.shutdown[0].status = 'unconfirmed'; },
    (e) => { e.shutdown[0].name = e.shutdown[1].name; },
  ]) { const changed = copy(evidence); mutate(changed); assert.throws(() => acceptRaceCompletion(changed, pkg.races)); }
});

test('pinned engine rejects duplicate backend identity, false blocking and surviving backends', async () => {
  for (const options of [{ duplicatePid: true }, { wrongBlocker: true }, { leaveBackend: true }]) {
    const evidence = {};
    await assert.rejects(runOfflineRaceEngine({ helperFiles: helpers(), pkg: simulatedPackage(), makeSession: simulation(options), evidence,
      options: { timeoutMs: 500, overlapMs: 30, shutdownMs: 30, absenceMs: 30 } }));
    assert.equal(evidence.status, 'simulation-failed'); assert.equal(evidence.qualification, 'offline-test-only');
  }
});
