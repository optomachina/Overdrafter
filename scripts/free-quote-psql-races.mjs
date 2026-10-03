/** Free-quote fixture transport only. The caller admits/provisions one owned database
 * and retains responsibility for its final backend inventory and Docker cleanup. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PsqlSession, IDENTITY_SQL, clientArgs, oneJson, acceptIdentity, acceptOverlap } from './ovd591-psql-concurrency.mjs';
import { acceptTap } from './ovd591-sql-qualification.mjs';

export const PSQL_OPTIONS = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';
export const RACE_MANIFEST_PATH = 'supabase/fixtures/free_quote_lifecycle_races/races.json';
const PREFIX = 'supabase/fixtures/free_quote_lifecycle_races/';
const LIMIT = 8_000_000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const positivePid = value => assert(Number.isSafeInteger(value) && value > 0, 'positive backend PID required');
const timestamp = value => assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'database timestamp required');

/** Reads each referenced input once, verifies it, then retains precisely those bytes. */
export function loadFreeQuoteRacePackage({ root, manifest }) {
  assert(manifest && manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'manifest.files hash map required');
  const base = realpathSync(root), inputs = {}, sql = {};
  const read = path => {
    assert(typeof path === 'string' && path.startsWith(PREFIX) && /^[a-zA-Z0-9/_.-]+$/.test(path)
      && !path.split('/').some(part => part === '.' || part === '..'), 'closed fixture path required');
    assert.match(manifest.files[path] ?? '', /^[a-f0-9]{64}$/, `missing input hash: ${path}`);
    const target = resolve(base, path);
    assert(!lstatSync(target).isSymbolicLink() && lstatSync(target).isFile(), 'regular fixture file required');
    assert(realpathSync(target).startsWith(base + sep), 'fixture input escapes root');
    const bytes = readFileSync(target);
    assert(bytes.length > 0 && bytes.length < LIMIT, 'bounded nonempty fixture input required');
    assert.equal(sha(bytes), manifest.files[path], `fixture input hash mismatch: ${path}`);
    const text = bytes.toString('utf8');
    assert(Buffer.from(text).equals(bytes) && !text.includes('\0'), 'UTF-8 SQL required');
    inputs[path] = { sha256: sha(bytes), bytes: bytes.length };
    return text;
  };
  const source = JSON.parse(read(RACE_MANIFEST_PATH));
  assert.deepEqual(manifest.raceSetupSql, source.raceSetupSql, 'race setup manifest drift');
  assert.deepEqual(manifest.races, source.races, 'race order or definition drift');
  assert(Array.isArray(source.races) && source.races.length > 0 && source.races.length <= 32);
  assert.equal(new Set(source.races.map(race => race.name)).size, source.races.length, 'duplicate race name');
  const paths = new Set([source.raceSetupSql]);
  for (const race of source.races) {
    assert.match(race.name, /^[a-z][a-z0-9-]{0,79}$/);
    assert(race.mode === undefined || race.mode === 'complete-before-release', 'unknown race mode');
    assert(Array.isArray(race.contenders) && race.contenders.length >= 1 && race.contenders.length <= 2);
    if (race.mode === 'complete-before-release') assert.equal(typeof race.lockProbeSql, 'string', 'real lock probe required');
    else assert.equal(race.lockProbeSql, undefined, 'ordinary races cannot use a substitute probe');
    for (const path of [race.setupSql, race.acquireSql, ...race.contenders, race.releaseSql, race.verifySql,
      ...(race.lockProbeSql ? [race.lockProbeSql] : [])]) paths.add(path);
  }
  for (const path of paths) {
    assert(typeof path === 'string' && path.endsWith('.sql'), 'SQL file required');
    sql[path] = read(path);
  }
  return { raceSetupSql: source.raceSetupSql, races: source.races, sql, inputs,
    manifestSha256: sha(JSON.stringify(manifest)) };
}

/** No host libpq values, password wrapper, TCP route or shell. */
export function freeQuoteClientArgs(container, actor = true) {
  const args = clientArgs(container, PSQL_OPTIONS, actor);
  // Explicit container-local Unix socket and empty libpq service/password overrides.
  args.splice(args.indexOf(container), 0, '-e', 'PGHOST=/var/run/postgresql', '-e', 'PGHOSTADDR=', '-e', 'PGPORT=5432',
    '-e', 'PGSERVICE=', '-e', 'PGSERVICEFILE=/dev/null', '-e', 'PGPASSFILE=/dev/null', '-e', 'PGPASSWORD=');
  return [...args, '-v', 'VERBOSITY=verbose'];
}

/** Only generated PostgreSQL catalog observation; never executes caller-supplied observer SQL. */
export function blockerSql(pids, coordinator) {
  assert(Array.isArray(pids) && pids.length > 0 && new Set(pids).size === pids.length);
  pids.forEach(positivePid); positivePid(coordinator); assert(!pids.includes(coordinator));
  return `select coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'blockers',pg_blocking_pids(a.pid),
'waitEvent',a.wait_event,'observedAt',clock_timestamp(),'backendStart',a.backend_start,
'coordinatorBackendStart',c.backend_start) order by a.pid),'[]'::jsonb)
from pg_stat_activity a join pg_stat_activity c on c.pid=${coordinator}
where a.pid in (${pids.join(',')}) and a.datname=current_database() and c.datname=current_database()
and a.state='active' and a.wait_event_type='Lock' and ${coordinator}=any(pg_blocking_pids(a.pid));`;
}
export function absenceSql(pids) {
  assert(Array.isArray(pids) && pids.length > 0 && new Set(pids).size === pids.length); pids.forEach(positivePid);
  return `select jsonb_build_object('remaining',coalesce(jsonb_agg(pid order by pid),'[]'::jsonb),
'observedAt',clock_timestamp()) from pg_stat_activity where pid in (${pids.join(',')});`;
}

/** Session injection exists only for offline transport tests. Production always uses PsqlSession. */
export async function executeFreeQuoteRaces(pkg, makeSession, {
  evidence = {}, timeoutMs = 240_000, overlapMs = 4_000, shutdownMs = 25_000, absenceMs = 2_000, signal,
} = {}) {
  for (const [name, value] of Object.entries({ timeoutMs, overlapMs, shutdownMs, absenceMs })) {
    assert(Number.isSafeInteger(value) && value > 0 && value <= 300_000, `invalid ${name}`);
  }
  evidence.transport = 'free-quote-independent-psql-unix-socket-v1';
  evidence.inputs = pkg.inputs; evidence.manifestSha256 = pkg.manifestSha256;
  evidence.sessions = {}; evidence.races = []; evidence.phases = []; evidence.absences = [];
  evidence.backendCleanup = 'unconfirmed'; evidence.shutdown = [];
  const sessions = new Map(), closed = new Set(), pids = new Set();
  let stopped, timer, interrupt, output = '';
  const interrupted = new Promise((_, reject) => { interrupt = reject; });
  const stop = error => {
    stopped ??= error;
    for (const [name, session] of sessions) if (!closed.has(name)) session.fail(stopped);
    interrupt(stopped);
  };
  const active = () => {
    if (stopped) throw stopped;
    assert(!signal?.aborted, 'free-quote race qualification cancelled');
    for (const [name, session] of sessions) if (!closed.has(name)) {
      if (session.failed) throw session.failed;
      assert.equal(evidence.sessions[name].exit, null, `${name}: early process exit`);
    }
  };
  const request = async (name, sql, label) => {
    active();
    const phase = { session: name, label, inputSha256: sha(sql), status: 'pending' };
    evidence.phases.push(phase);
    try {
      const value = await sessions.get(name).request(sql); active();
      Object.assign(phase, { status: 'framed-completion', output: value, outputSha256: sha(value) });
      assert(!value.split(/\r?\n/).some(line => /^(not ok\b|Bail out!)/i.test(line.trim())), 'free-quote TAP failure');
      return value;
    } catch (error) { phase.status = 'failed'; phase.error = error.message; throw error; }
  };
  const open = async name => {
    active(); assert(!sessions.has(name));
    const record = evidence.sessions[name] = {};
    const session = makeSession(name, record); sessions.set(name, session);
    assert.equal(record.exit, null, 'session factory must expose actual process exit receipt');
    const identity = acceptIdentity(oneJson(await request(name, IDENTITY_SQL, 'identity')));
    assert(!pids.has(identity.pid), 'duplicate backend PID'); pids.add(identity.pid); record.identity = identity;
    return name;
  };
  const pid = name => evidence.sessions[name].identity.pid;
  const sql = path => { assert.equal(typeof pkg.sql[path], 'string', `missing admitted SQL: ${path}`); return pkg.sql[path]; };
  const run = (name, path) => request(name, sql(path), path);
  const runTap = async (name, path) => {
    const value = await run(name, path), assertions = acceptTap(value);
    evidence.phases.findLast(phase => phase.session === name && phase.label === path).assertions = assertions; output += value;
    return { session: name, path, assertions, outputSha256: sha(value) };
  };
  const start = (name, path) => {
    const pending = { name, settled: false, error: null };
    pending.promise = runTap(name, path).then(value => { pending.settled = true; return value; }, error => {
      pending.settled = true; pending.error = error; throw error;
    });
    pending.promise.catch(() => {}); return pending;
  };
  const unsettled = actors => {
    active();
    for (const actor of actors) { if (actor.error) throw actor.error; assert(!actor.settled, `${actor.name}: actor finished before release`); }
  };
  const observe = async (race, actors, coordinator, label) => {
    const until = Date.now() + overlapMs, actorPids = actors.map(actor => pid(actor.name));
    do {
      unsettled(actors);
      const receipt = oneJson(await request('observer', blockerSql(actorPids, pid(coordinator)), `${race.name}:${label}`));
      unsettled(actors);
      assert(Array.isArray(receipt), 'blocker array required');
      assert(receipt.length <= actorPids.length && new Set(receipt.map(row => row.pid)).size === receipt.length, 'duplicate or excessive blocker rows');
      for (const row of receipt) {
        assert(actorPids.includes(row.pid), 'foreign blocker PID');
        const actor = actors.find(value => pid(value.name) === row.pid);
        assert.equal(row.backendStart, evidence.sessions[actor.name].identity.backendStart, 'actor backend identity changed');
        assert.equal(row.coordinatorBackendStart, evidence.sessions[coordinator].identity.backendStart, 'coordinator backend identity changed');
      }
      if (receipt.length === actorPids.length) {
        acceptOverlap(receipt, actorPids, pid(coordinator));
        race.overlaps.push({ label, observerPid: pid('observer'), coordinatorPid: pid(coordinator), receipt }); return;
      }
      // Poll pacing only. A delay never counts as evidence of a blocked backend.
      if (Date.now() < until) await delay(10);
    } while (Date.now() < until);
    throw new Error(`${race.name}: exact backend blocker observation deadline`);
  };
  const close = async name => {
    const session = sessions.get(name); if (closed.has(name)) return;
    let deadline;
    try {
      await Promise.race([session.close(), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`${name}: shutdown deadline`)), shutdownMs);
      })]);
      assert.deepEqual(evidence.sessions[name].exit, { code: 0, signal: null }, `${name}: real normal process exit required`);
      closed.add(name); evidence.shutdown.push({ name, status: 'normal-exit', exit: evidence.sessions[name].exit });
    } finally { clearTimeout(deadline); }
  };
  const absent = async names => {
    const checked = names.map(pid), until = Date.now() + absenceMs;
    do {
      const receipt = oneJson(await request('observer', absenceSql(checked), 'backend-absence'));
      timestamp(receipt.observedAt); assert(Array.isArray(receipt.remaining), 'absence rows required');
      assert(receipt.remaining.every(value => checked.includes(value)), 'foreign absence PID');
      if (receipt.remaining.length === 0) {
        evidence.absences.push({ pids: checked, observerPid: pid('observer'), ...receipt }); return;
      }
      if (Date.now() < until) await delay(10);
    } while (Date.now() < until);
    throw new Error('closed fixture backends remain visible');
  };
  const work = async () => {
    await open('observer'); await open('setup');
    await run('setup', pkg.raceSetupSql); await close('setup'); await absent(['setup']);
    for (const item of pkg.races) {
      active();
      const race = { name: item.name, mode: item.mode ?? 'blocked-until-release', overlaps: [], contenders: [] };
      evidence.races.push(race);
      const coordinator = await open(`${item.name}-coordinator`);
      const actors = await Promise.all(item.contenders.map((_, index) => open(`${item.name}-contender-${index + 1}`)));
      const probeName = item.mode === 'complete-before-release' ? await open(`${item.name}-probe`) : null;
      await run(coordinator, item.setupSql); await run(coordinator, item.acquireSql);
      let pending, probe;
      if (probeName) {
        probe = start(probeName, item.lockProbeSql);
        await observe(race, [probe], coordinator, 'probe-blocked-before-contenders');
        pending = actors.map((name, index) => start(name, item.contenders[index]));
        race.contenders = await Promise.all(pending.map(actor => actor.promise));
        await observe(race, [probe], coordinator, 'probe-blocked-after-passing-contenders');
      } else {
        pending = actors.map((name, index) => start(name, item.contenders[index]));
        await observe(race, pending, coordinator, 'all-contenders-blocked');
      }
      unsettled(probe ? [probe] : pending);
      await run(coordinator, item.releaseSql);
      if (!probe) race.contenders = await Promise.all(pending.map(actor => actor.promise));
      else race.probe = await probe.promise;
      active();
      const participants = [coordinator, ...actors, ...(probeName ? [probeName] : [])];
      await Promise.all(participants.map(close)); await absent(participants);
      const verify = await open(`${item.name}-verify`);
      race.verification = await runTap(verify, item.verifySql);
      await close(verify); await absent([verify]); race.status = 'passed';
    }
    evidence.backendCleanup = 'all-non-observer-backends-observed-absent';
    await close('observer');
    evidence.observerExit = 'normal-psql-exit; final backend inventory remains fixture-owner responsibility';
    return output;
  };
  const cancelled = () => stop(new Error('free-quote race qualification cancelled'));
  signal?.addEventListener('abort', cancelled, { once: true });
  try {
    timer = setTimeout(() => stop(new Error('free-quote race suite deadline')), timeoutMs);
    return await Promise.race([work(), interrupted]);
  } catch (error) { stop(error); throw error; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancelled); evidence.stdout = output;
    await Promise.all([...sessions].map(async ([name, session]) => {
      if (closed.has(name)) return;
      try { await close(name); }
      catch (error) {
        session.child.kill('SIGKILL'); session.child.stdin?.destroy(); session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref?.();
        evidence.shutdown.push({ name, status: 'unconfirmed', exit: evidence.sessions[name].exit,
          containment: 'own-cli-only; backend termination unproven', error: error.message });
      }
    }));
  }
}

export async function runFreeQuotePsqlRaces({ root, out, container, manifest, signal, evidence = {} }) {
  assert.match(container, /^ovd591-[a-z0-9-]+$/); // Caller already admitted exact ID/owner/source/network.
  const pkg = loadFreeQuoteRacePackage({ root, manifest });
  let bytes = 0;
  const consume = count => { bytes += count; assert(bytes <= LIMIT, 'free-quote aggregate session output limit'); };
  evidence.container = container; evidence.startedAt = new Date().toISOString();
  try {
    const output = await executeFreeQuoteRaces(pkg, (name, record) => {
      const args = freeQuoteClientArgs(container, !name.endsWith('-coordinator')); record.command = ['docker', ...args];
      return new PsqlSession(spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }), name, record,
        { timeoutMs: 25_000, consume });
    }, { evidence, signal });
    evidence.status = 'completed'; return output;
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
  finally {
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(resolve(out, 'free-quote-race-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    for (const [name, record] of Object.entries(evidence.sessions ?? {})) {
      writeFileSync(resolve(out, `free-quote-${name}.stdout`), record.stdout ?? '', { mode: 0o600 });
      writeFileSync(resolve(out, `free-quote-${name}.stderr`), record.stderr ?? '', { mode: 0o600 });
    }
  }
}
