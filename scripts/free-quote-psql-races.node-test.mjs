import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOCKET_CLIENT_ENV } from './ovd591-libpq-environment.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PsqlSession, IDENTITY_SQL } from './ovd591-psql-concurrency.mjs';
import { loadFreeQuoteRacePackage, freeQuoteClientArgs, blockerSql, absenceSql, executeFreeQuoteRaces,
  PSQL_OPTIONS, RACE_MANIFEST_PATH } from './free-quote-psql-races.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const prefix = 'supabase/fixtures/free_quote_lifecycle_races/';
const source = JSON.parse(readFileSync(join(root, RACE_MANIFEST_PATH)));
function manifestForFixture() {
  const paths = new Set([RACE_MANIFEST_PATH, source.raceSetupSql]);
  for (const race of source.races) for (const path of [race.setupSql, race.acquireSql, ...race.contenders,
    race.releaseSql, race.verifySql, ...(race.lockProbeSql ? [race.lockProbeSql] : [])]) paths.add(path);
  return { ...source, files: Object.fromEntries([...paths].map(path => [path, sha(readFileSync(join(root, path)))])) };
}

test('source loading binds all 18 ordered races and every exact SQL byte including six real probes', () => {
  const manifest = manifestForFixture(), pkg = loadFreeQuoteRacePackage({ root, manifest });
  assert.equal(pkg.races.length, 18); assert.equal(pkg.races.filter(race => race.lockProbeSql).length, 6);
  assert.deepEqual(pkg.races, source.races); assert.equal(pkg.manifestSha256, sha(JSON.stringify(manifest)));
  for (const [path, value] of Object.entries(pkg.sql)) {
    assert.equal(value, readFileSync(join(root, path), 'utf8'));
    assert.equal(pkg.inputs[path].sha256, sha(value));
  }
});
test('manifest tampering, omitted hashes and SQL drift fail before transport construction', () => {
  for (const mutate of [
    m => { delete m.files[source.raceSetupSql]; },
    m => { m.files[source.races[0].acquireSql] = '0'.repeat(64); },
    m => { m.races.reverse(); },
    m => { m.races[0].contenders = []; },
    m => { delete m.files[RACE_MANIFEST_PATH]; },
    m => { m.raceSetupSql = '../outside.sql'; },
  ]) {
    const manifest = structuredClone(manifestForFixture()); mutate(manifest);
    assert.throws(() => loadFreeQuoteRacePackage({ root, manifest }));
  }
});
test('even hash-bound symlinks cannot substitute a fixture source file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'free-races-source-'));
  try {
    const manifest = manifestForFixture();
    for (const path of Object.keys(manifest.files)) {
      const destination = join(temp, path); mkdirSync(dirname(destination), { recursive: true });
      if (path === source.raceSetupSql) symlinkSync(join(root, path), destination);
      else writeFileSync(destination, readFileSync(join(root, path)));
    }
    assert.throws(() => loadFreeQuoteRacePackage({ root: temp, manifest }), /regular fixture file/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('fixed argv admits only owned container names, fixed options and local Unix socket', () => {
  const args = freeQuoteClientArgs('ovd591-synthetic-free-quote');
  assert.deepEqual(args.slice(0, 3), ['exec', '-i', '-e']);
  assert(args.some(arg => arg.startsWith(`PGOPTIONS=${PSQL_OPTIONS} `)));
  for (const expected of [...SOCKET_CLIENT_ENV, 'VERBOSITY=verbose']) assert(args.includes(expected));
  assert.deepEqual(args.slice(args.indexOf('ovd591-synthetic-free-quote') + 1, args.indexOf('psql')), SOCKET_CLIENT_ENV);
  assert(!args.includes('PGSERVICE=') && !args.includes('PGPASSFILE=/dev/null'));
  assert(!args.includes('sh')); assert(!args.includes('bash')); assert(!args.includes('-h'));
  assert.deepEqual(args.slice(-12), ['psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']);
  for (const invalid of ['prod', 'ovd591-fixture;rm', 'ovd591-../x', 'ovd591-x\n']) assert.throws(() => freeQuoteClientArgs(invalid));
});
test('observer statements are catalog-only exact-PID blocker/absence queries with no injectable identifiers', () => {
  const query = blockerSql([12, 13], 11);
  assert(query.includes('pg_blocking_pids(a.pid)')); assert(query.includes("a.wait_event_type='Lock'"));
  assert(query.includes('11=any(pg_blocking_pids(a.pid))')); assert(query.includes('a.pid in (12,13)'));
  assert(!/dblink|pg_sleep|pg_terminate_backend|pg_advisory/i.test(query));
  assert(absenceSql([12, 13]).includes('pid in (12,13)'));
  for (const [actors, coordinator] of [[[12,12],11],[[11],11],[[0],11],[['12);commit;'],11],[[12],0],[[],11]]) assert.throws(() => blockerSql(actors, coordinator));
});

const identity = pid => ({ pid, database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres',
  serverAddress: null, clientAddress: null, backendStart: '2026-10-03T00:00:00+00:00' });
const tap = 'ok 1 - synthetic assertion\n1..1\n';
function syntheticPackage({ complete = false, count = 1, cases = 1 } = {}) {
  const sql = { common: 'common\n' }, races = [];
  for (let index = 0; index < cases; index++) {
    const name = `case-${index + 1}`;
    const race = { name, setupSql: `${name}-setup`, acquireSql: `${name}-acquire`,
      contenders: Array.from({ length: count }, (_, i) => `${name}-contender-${i + 1}`),
      releaseSql: `${name}-release`, verifySql: `${name}-verify` };
    if (complete) { race.mode = 'complete-before-release'; race.lockProbeSql = `${name}-probe`; }
    for (const path of [race.setupSql, race.acquireSql, ...race.contenders, race.releaseSql, race.verifySql,
      ...(race.lockProbeSql ? [race.lockProbeSql] : [])]) sql[path] = `${path}\n`;
    races.push(race);
  }
  return { raceSetupSql: 'common', races, sql, inputs: {}, manifestSha256: 'synthetic' };
}
function topology(pkg, options = {}) {
  const events = [], records = {}, sessions = new Map(), pending = new Map();
  let nextPid = 10, locked = false, current = -1, observationCount = 0, actorCompleted = false;
  const event = (kind, details = {}) => events.push({ kind, ...details });
  const make = (name, record) => {
    records[name] = record; Object.assign(record, { stdout: '', stderr: '', submissions: [], exit: null });
    const actualIdentity = identity(options.duplicatePid ? 10 : nextPid++);
    const session = {
      record, failed: null, child: { kill: () => event('kill', { name }) },
      fail(error) { this.failed ??= error; const work = pending.get(name); if (work) { pending.delete(name); work.reject(error); } },
      async close() {
        event('close', { name });
        if (options.shutdownHangs && name !== 'setup') return new Promise(() => {});
        if (options.noExitReceipt && name.endsWith('contender-1')) return;
        record.exit = { code: options.exitCode && name.endsWith('contender-1') ? 7 : 0, signal: null };
      },
      async request(sql) {
        if (this.failed) throw this.failed;
        event('request', { name, sql }); record.submissions.push({ sql });
        if (sql === IDENTITY_SQL) return JSON.stringify(actualIdentity);
        if (sql === pkg.sql.common) return '';
        if (name === 'observer') {
          if (sql.startsWith("select jsonb_build_object('remaining'")) return JSON.stringify({
            remaining: options.remaining ? [Number(sql.match(/pid in \((\d+)/)[1])] : [], observedAt: '2026-10-03T00:00:01Z',
          });
          assert(sql.startsWith('select coalesce(jsonb_agg'));
          observationCount++; event('observe', { observationCount, actorCompleted });
          if (options.observerHangs) return new Promise(() => {});
          if (options.earlyExit) {
            const actor = [...sessions.keys()].find(value => value.endsWith('contender-1'));
            records[actor].exit = { code: 0, signal: null };
          }
          if (options.absentBlockers || (options.loseProbeAfterComplete && actorCompleted)) return '[]';
          const actorPids = sql.match(/a.pid in \(([^)]+)\)/)[1].split(',').map(Number);
          const coordinatorPid = Number(sql.match(/c.pid=(\d+)/)[1]);
          if (options.firstObservationEmpty && observationCount === 1) return '[]';
          const rows = actorPids.map(pid => ({ pid: options.wrongPid ? 999 : pid,
            blockers: [options.wrongBlocker ? 999 : coordinatorPid], waitEvent: 'transactionid', observedAt: '2026-10-03T00:00:01Z',
            backendStart: options.changedBackend ? '2026-10-03T00:00:02Z' : actualIdentity.backendStart,
            coordinatorBackendStart: actualIdentity.backendStart }));
          return JSON.stringify(options.duplicateOverlap ? [rows[0], rows[0]] : rows);
        }
        const item = pkg.races.find(race => name.startsWith(race.name + '-'));
        assert(item);
        if (sql === pkg.sql[item.setupSql]) { current++; assert.equal(pkg.races[current], item); return ''; }
        if (sql === pkg.sql[item.acquireSql]) { locked = true; actorCompleted = false; return ''; }
        if (sql === pkg.sql[item.releaseSql]) {
          assert(locked); locked = false; event('release', { name });
          for (const [actor, entry] of pending) {
            pending.delete(actor);
            if (options.actorError) entry.reject(new Error('synthetic actor transport failure'));
            else entry.resolve(options.badTap ? 'ok 1 - incomplete\n1..2\n' : tap);
          }
          return '';
        }
        if (sql === pkg.sql[item.verifySql]) { assert(!locked); event('verify', { name }); return options.badVerify ? 'not ok 1 - state mismatch\n1..1\n' : tap; }
        assert(locked, 'contender/probe must start under actual coordinator lock');
        if (item.contenders.some(path => sql === pkg.sql[path])) {
          event('contender-start', { name });
          if (item.mode === 'complete-before-release' || options.earlyComplete) {
            actorCompleted = true; event('contender-complete', { name });
            return options.badTap ? 'ok 1 - incomplete\n1..2\n' : tap;
          }
        } else { assert.equal(sql, pkg.sql[item.lockProbeSql]); event('probe-start', { name }); }
        return new Promise((resolve, reject) => pending.set(name, { resolve, reject }));
      },
    };
    sessions.set(name, session); return session;
  };
  return { make, events, records, pending };
}
const limits = { timeoutMs: 500, overlapMs: 25, shutdownMs: 25, absenceMs: 25 };
async function runSynthetic(configuration = {}, options = {}) {
  const pkg = syntheticPackage(configuration), t = topology(pkg, options), evidence = {};
  const result = executeFreeQuoteRaces(pkg, t.make, { ...limits, evidence });
  return { pkg, t, evidence, result };
}

test('ordinary race proves every contender exact PID behind coordinator before unchanged release and fresh verification', async () => {
  const { pkg, t, evidence, result } = await runSynthetic({ count: 2, cases: 2 }, { firstObservationEmpty: true });
  await result;
  assert.equal(evidence.races.length, 2); assert(evidence.races.every(race => race.status === 'passed'));
  assert.equal(evidence.backendCleanup, 'all-non-observer-backends-observed-absent');
  assert.equal(evidence.absences.length, 5); assert(evidence.shutdown.every(row => row.status === 'normal-exit'));
  assert.equal(t.events.filter(event => event.sql === pkg.sql.common).length, 1);
  for (const item of pkg.races) {
    const race = evidence.races.find(value => value.name === item.name), expected = item.contenders.map((_, i) => evidence.sessions[`${item.name}-contender-${i + 1}`].identity.pid);
    assert.deepEqual(race.overlaps[0].receipt.map(row => row.pid), expected);
    const released = t.events.findIndex(event => event.kind === 'release' && event.name.startsWith(item.name));
    const verified = t.events.findIndex(event => event.kind === 'verify' && event.name.startsWith(item.name));
    assert(released < verified); assert.equal(race.contenders.length, 2);
    for (const path of [item.setupSql, item.acquireSql, ...item.contenders, item.releaseSql, item.verifySql]) assert(t.events.some(event => event.sql === pkg.sql[path]));
  }
});
test('complete-before-release proves same real probe blocked before dispatch and after passing contender TAP', async () => {
  const { t, evidence, result } = await runSynthetic({ complete: true, count: 2 }); await result;
  const events = t.events.map(event => event.kind);
  const observed = t.events.filter(event => event.kind === 'observe');
  assert.equal(observed[0].actorCompleted, false); assert.equal(observed[1].actorCompleted, true);
  assert(events.indexOf('probe-start') < events.indexOf('observe'));
  assert(events.indexOf('observe') < events.indexOf('contender-start'));
  assert(events.lastIndexOf('observe') < events.indexOf('release'));
  const race = evidence.races[0]; assert.equal(race.overlaps.length, 2);
  assert.equal(race.overlaps[0].receipt[0].pid, race.overlaps[1].receipt[0].pid);
  assert.equal(race.probe.assertions, 1); assert.equal(race.verification.assertions, 1);
  assert(evidence.phases.filter(phase => phase.session !== 'observer' && (phase.label.includes('contender') || phase.label.endsWith('probe'))).every(phase => phase.assertions === 1));
});
for (const [name, options, error] of [
  ['duplicate PID', { duplicatePid: true }, /duplicate backend PID/],
  ['foreign overlap PID', { wrongPid: true }, /foreign blocker PID/],
  ['duplicate overlap PID', { duplicateOverlap: true }, /duplicate or excessive/],
  ['wrong blocker', { wrongBlocker: true }, /coordinator is not blocker/],
  ['recycled backend identity', { changedBackend: true }, /backend identity changed/],
  ['absent causal blocker', { absentBlockers: true }, /blocker observation deadline/],
  ['early contender completion', { earlyComplete: true }, /actor finished before release/],
  ['early process exit despite command promise', { earlyExit: true }, /early process exit/],
]) test(`${name} fails closed before coordinator release`, async () => {
  const { t, evidence, result } = await runSynthetic({}, options);
  await assert.rejects(result, error); assert(!t.events.some(event => event.kind === 'release'));
  assert(!evidence.races.some(race => race.status === 'passed'));
});
test('probe must remain blocked after completed contenders; old overlap receipt is insufficient', async () => {
  const { t, result } = await runSynthetic({ complete: true }, { loseProbeAfterComplete: true });
  await assert.rejects(result, /blocker observation deadline/); assert(!t.events.some(event => event.kind === 'release'));
});
test('incomplete completed-contender TAP forbids release even while probe is blocked', async () => {
  const { t, result } = await runSynthetic({ complete: true }, { badTap: true });
  await assert.rejects(result, /complete assertion accounting/); assert(!t.events.some(event => event.kind === 'release'));
});
for (const [name, options, error] of [
  ['incomplete post-release TAP', { badTap: true }, /complete assertion accounting/],
  ['actor transport error', { actorError: true }, /transport failure/],
  ['Promise close without real exit receipt', { noExitReceipt: true }, /real normal process exit/],
  ['nonzero actor process exit', { exitCode: true }, /real normal process exit/],
  ['remaining backend', { remaining: true }, /backends remain/],
  ['bad verification TAP', { badVerify: true }, /TAP failure/],
]) test(`${name} cannot produce a passing case`, async () => {
  const { evidence, result } = await runSynthetic({}, options);
  await assert.rejects(result, error); assert(!evidence.races.some(race => race.status === 'passed'));
});
test('outer deadline poisons pending sessions and containment never claims backend cleanup', async () => {
  const pkg = syntheticPackage(), t = topology(pkg, { observerHangs: true, shutdownHangs: true }), evidence = {};
  await assert.rejects(executeFreeQuoteRaces(pkg, t.make, { ...limits, timeoutMs: 30, evidence }), /suite deadline/);
  assert(!t.events.some(event => event.kind === 'release')); assert.equal(evidence.backendCleanup, 'unconfirmed');
  assert(evidence.shutdown.filter(row => row.name !== 'setup').every(row => row.status === 'unconfirmed' && row.containment.includes('termination unproven')));
  assert(t.events.some(event => event.kind === 'kill'));
});
test('pre-aborted request opens no processes and delayed cancellation cannot release a lock', async () => {
  const pkg = syntheticPackage(), cancelled = new AbortController(); cancelled.abort();
  const t = topology(pkg); await assert.rejects(executeFreeQuoteRaces(pkg, t.make, { ...limits, signal: cancelled.signal }), /cancelled/);
  assert.equal(t.events.length, 0);
  const next = new AbortController(), hanging = topology(pkg, { observerHangs: true });
  const timer = setTimeout(() => next.abort(), 20);
  try { await assert.rejects(executeFreeQuoteRaces(pkg, hanging.make, { ...limits, signal: next.signal }), /cancelled/); }
  finally { clearTimeout(timer); }
  assert(!hanging.events.some(event => event.kind === 'release'));
});
test('reviewed real process primitive distinguishes framed TAP completion from actual process exit', async () => {
  const code = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{
    if(line==='\\\\q')process.exit(0);if(line.startsWith('\\\\echo '))process.stdout.write('ok 1 - real IPC\\n1..1\\n'+line.slice(6)+'\\n');});`;
  const record = {}, child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const session = new PsqlSession(child, 'synthetic', record, { timeoutMs: 1_000 });
  try {
    assert.equal(await session.request('select synthetic_only;'), 'ok 1 - real IPC\n1..1\n');
    assert.equal(record.exit, null, 'framing does not mean backend/process exit');
    await session.close(); assert.deepEqual(record.exit, { code: 0, signal: null });
  } finally { child.kill('SIGKILL'); }
});
