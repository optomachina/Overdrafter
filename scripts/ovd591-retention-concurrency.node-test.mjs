import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY_SQL, resultCopy } from './ovd591-psql-concurrency.mjs';
import { acceptTap } from './ovd591-sql-qualification.mjs';
import { PHASE_PATH, GROUPS, ASSERTIONS, admitPhases, executeRetentionPhases } from './ovd591-retention-concurrency.mjs';
import { RETENTION_TABLES, RETENTION_RPCS, RETENTION_SUITES, admitRetentionCatalog,
  admitRetentionQualification } from './ovd591-retention-profile.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const phases = () => JSON.parse(readFileSync(resolve(root, PHASE_PATH)));
const ids = { coordinator: 901, a: 902, b: 903 };
const identity = name => ({ pid: ids[name], database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres',
  serverAddress: null, clientAddress: null, backendStart: '2026-10-02T00:00:00.000Z' });
const encoded = value => JSON.stringify(value) + '\n';

/** Only scheduling/framing simulation: it deliberately does not execute or claim to validate SQL. */
function transport({ fault, controller } = {}) {
  const events = [], pending = new Map(), sessions = {};
  let held = 'coordinator', assertions = 0;
  const resolveActors = () => {
    for (const [name, operation] of [...pending]) {
      if (name === 'coordinator') continue;
      pending.delete(name);
      operation.resolve(encoded({ result: { state: 'created', retained: { test: operation.sql } }, sqlstate: null }));
      if (sessions[name].transaction) { held = name; break; }
    }
  };
  const makeSession = (name, record) => {
    const session = {
      transaction: false, stopped: false, failure: null,
      child: { kill() { events.push(`${name}:kill-cli`); }, stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } },
      fail(error) {
        this.failure = error;
        const active = pending.get(name); if (active) { pending.delete(name); active.reject(error); }
      },
      async close() { events.push(`${name}:close`); this.stopped = true; if (this.failure) throw this.failure; },
      request(sql) {
        events.push({ name, sql }); record.submissions ??= []; record.submissions.push(sql);
        if (this.failure) return Promise.reject(this.failure);
        const changed = fault?.({ name, sql, events, pending, sessions });
        if (changed !== undefined) return Promise.resolve(changed);
        if (sql === IDENTITY_SQL) return Promise.resolve(encoded(identity(name)));
        if (sql === 'begin;') { this.transaction = true; return Promise.resolve(''); }
        if (name === 'coordinator' && sql === 'begin; select pg_advisory_xact_lock(591,1);') { held = name; return Promise.resolve(''); }
        if (sql.startsWith('select private.ovd591_retention_call')) {
          assert(!pending.has(name));
          return new Promise((resolveResult, reject) => pending.set(name, { sql, resolve: resolveResult, reject }));
        }
        if (sql.startsWith('select pg_temp.await_retention_overlap')) {
          const match = /array\[([0-9,]+)\]::integer\[\],([0-9]+)/.exec(sql);
          const actors = match[1].split(',').map(Number), blocker = Number(match[2]);
          assert.equal(blocker, ids[held]);
          for (const id of actors) assert(pending.has(Object.keys(ids).find(key => ids[key] === id)), 'observed actor must already be submitted');
          if (controller) controller.abort();
          return Promise.resolve(encoded(actors.map(pid => ({ pid, blockers: [blocker], waitEvent: 'advisory', observedAt: '2026-10-02T00:00:01Z' }))));
        }
        if (sql === 'commit;' || sql === 'rollback;') {
          assert.equal(name, held); this.transaction = false; held = null; resolveActors(); return Promise.resolve('');
        }
        if (sql.startsWith('select count(*) from pg_stat_activity')) {
          assert(sessions.a.stopped && sessions.b.stopped); return Promise.resolve('0\n');
        }
        if (sql === phases().finish) return Promise.resolve(`1..${assertions}\n`);
        const count = [...sql.matchAll(/^select (?:is|ok|throws_ok)\(/gm)].length;
        return Promise.resolve(Array.from({ length: count }, () => `ok ${++assertions} - synthetic scheduling assertion\n`).join(''));
      },
    };
    sessions[name] = session; return session;
  };
  return { makeSession, events, pending, sessions };
}

test('retention manifest is closed, source-bound, nine categories with eleven explicit SQL subcases', () => {
  const value = phases(); admitPhases(value);
  assert.equal(value.cases.length, 11); assert.equal(value.groups.length, 9);
  for (const [path, hash] of Object.entries(value.sourceReferences)) {
    assert.equal(createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), hash);
  }
  const count = value.cases.reduce((total, item) => total + ['before', 'whileHeld', 'after'].reduce((n, key) =>
    n + [...item[key].matchAll(/^select (?:is|ok|throws_ok)\(/gm)].length, 0) + (item.mode === 'race' ? 1 : 2), 0);
  assert.equal(count, ASSERTIONS); assert.equal(ASSERTIONS, 90);
  assert(value.setup.includes('pg_stat_clear_snapshot()')); assert(value.setup.includes('pg_blocking_pids(pid)'));
  assert(value.setup.includes('blocker=any(pg_blocking_pids(pid))'));
  assert(value.setup.includes("'sqlstate',SQLSTATE"));
  assert(!/dblink|alter role|pg_hba|password|pg_sleep\((?!0\.02)/i.test(JSON.stringify(value)));
});

test('all SQL acceptance obligations are represented independently of synthetic scheduling', () => {
  const byName = Object.fromEntries(phases().cases.map(value => [value.name, value]));
  assert(byName['changed-claim'].after.includes("result->>'sqlstate'='23505'"));
  assert(byName['shared-completion'].after.includes('completion_key='));
  assert(byName['duplicate-completion'].before.includes('public.api_claim_capability_window'));
  assert(byName['duplicate-completion'].after.includes('private.capability_observations'));
  assert(byName['changed-attention'].after.includes('23505'));
  assert(byName['numeric-order'].after.includes('9999999999999999'));
  assert(byName['numeric-order'].after.includes('10000000000000000'));
  for (const name of ['visible-claim', 'visible-attention']) {
    assert(byName[name].whileHeld.includes('neither actor visible before first commit'));
    assert(byName[name].whileHeld.includes('blocked second actor has not allocated a cursor'));
    assert(byName[name].after.includes('exhaustion has no hidden lower cursor'));
  }
  assert(byName['rollback-gap'].after.includes('permitted sequence gap'));
  assert(byName['replay-authority'].before.includes("deadline=clock_timestamp()-interval '1 second'"));
  assert(byName['replay-authority'].before.includes('public.api_complete_capability_window'));
  assert(byName['replay-authority'].after.includes('canonical stale-version CAS'));
  assert(byName['replay-authority'].after.includes('restores no canonical authority'));
});

test('malformed manifest, duplicated actors, unknown operations and missing categories are rejected before sessions', async () => {
  for (const mutate of [v => { v.schema = 'other'; }, v => { v.cases.pop(); }, v => { v.groups.pop(); },
    v => { v.cases[0].actors[1].session = 'a'; }, v => { v.cases[0].actors[0].operation = "x');select 1;--"; },
    v => { v.cases[0].mode = 'held-rollback'; }, v => { v.assertions--; }, v => { v.sourceReferences = {}; }]) {
    const value = phases(); mutate(value);
    let started = false;
    await assert.rejects(executeRetentionPhases(value, () => { started = true; })); assert.equal(started, false);
  }
});

test('protocol observes coordinator overlap and actor-held publication before commit/rollback, then checks backend absence', async () => {
  const fake = transport(), evidence = {};
  const output = await executeRetentionPhases(phases(), fake.makeSession, { evidence });
  assert.equal(acceptTap(output), ASSERTIONS);
  assert.deepEqual([...new Set(evidence.cases.map(value => value.group))], GROUPS);
  assert.equal(evidence.cases.flatMap(value => value.overlaps).length, 14);
  for (const record of evidence.cases.filter(value => value.mode !== 'race')) {
    assert.deepEqual(record.overlaps.map(value => value.blocker), [ids.coordinator, ids.a]);
    const held = fake.events.findIndex(value => value.sql === phases().cases.find(item => item.name === record.name).whileHeld);
    assert.equal(fake.events[held + 1].name, 'a');
    assert.equal(fake.events[held + 1].sql, record.mode === 'held-rollback' ? 'rollback;' : 'commit;');
  }
  assert.equal(evidence.backendCleanup, 'actors-observed-absent');
  assert(evidence.shutdown.every(value => value.status === 'normal-exit'));
  const finish = fake.events.findIndex(value => value.sql === phases().finish);
  assert(finish > fake.events.indexOf('a:close')); assert(finish > fake.events.indexOf('b:close'));
});

test('wrong, duplicated, TCP or foreign-role backend identity fails before setup', async () => {
  for (const patch of [{ pid: ids.coordinator }, { serverAddress: '127.0.0.1' }, { sessionUser: 'service_role' }, { backendStart: 'invalid' }]) {
    const fake = transport({ fault: ({ name, sql }) => name === 'a' && sql === IDENTITY_SQL ? encoded({ ...identity(name), ...patch }) : undefined });
    await assert.rejects(executeRetentionPhases(phases(), fake.makeSession));
    assert(!fake.events.some(value => value.sql === phases().setup));
  }
});

test('foreign PID, missing blocker or duplicate overlap receipt cannot release actors', async () => {
  for (const change of [rows => { rows[0].pid = 999; }, rows => { rows[0].blockers = []; }, rows => { rows[1] = rows[0]; }]) {
    const fake = transport({ fault: ({ sql }) => {
      if (!sql.startsWith('select pg_temp.await_retention_overlap')) return;
      const rows = ['a', 'b'].map(name => ({ pid: ids[name], blockers: [ids.coordinator], waitEvent: 'advisory', observedAt: '2026-10-02T00:00:00Z' }));
      change(rows); return encoded(rows);
    } });
    await assert.rejects(executeRetentionPhases(phases(), fake.makeSession));
    assert(!fake.events.some(value => value.sql === 'commit;'));
  }
});

test('malformed, duplicate or missing actor result is a harness failure, never a SQLSTATE', async () => {
  for (const output of ['', '{}\n', '{"result":{},"sqlstate":null}\n{}\n', '{"result":null,"sqlstate":"not-a-state"}\n']) {
    const fake = transport(); const original = fake.makeSession;
    const factory = (name, record) => {
      const session = original(name, record), request = session.request.bind(session);
      session.request = async sql => {
        const result = await request(sql);
        return name === 'a' && sql.startsWith('select private.ovd591_retention_call') ? output : result;
      };
      return session;
    };
    const evidence = {}; await assert.rejects(executeRetentionPhases(phases(), factory, { evidence }));
    assert.equal(evidence.cases[0].results, undefined); assert.notEqual(evidence.backendCleanup, 'actors-observed-absent');
  }
});

test('backend residue prevents helper removal and successful completion', async () => {
  const fake = transport({ fault: ({ sql }) => sql.startsWith('select count(*) from pg_stat_activity') ? '1\n' : undefined });
  await assert.rejects(executeRetentionPhases(phases(), fake.makeSession));
  assert(!fake.events.some(value => value.sql === phases().finish));
});

test('TAP failure is not swallowed and actor process failure does not become an expected conflict', async () => {
  const failedTap = transport({ fault: ({ sql }) => sql === phases().cases[0].after ? 'not ok 9 - failed\n' : undefined });
  await assert.rejects(executeRetentionPhases(phases(), failedTap.makeSession), /TAP/);
  const failedActor = transport({ fault: ({ name, sql }) => name === 'a' && sql.startsWith('select private.ovd591_retention_call')
    ? Promise.reject(new Error('synthetic denied transport')) : undefined });
  const evidence = {};
  await assert.rejects(executeRetentionPhases(phases(), failedActor.makeSession, { evidence }));
  assert.equal(evidence.cases[0].results, undefined);
});

test('cancellation blocks release and bounded suite timeout retains unconfirmed cleanup', async () => {
  const controller = new AbortController(), cancelled = transport({ controller });
  await assert.rejects(executeRetentionPhases(phases(), cancelled.makeSession, { signal: controller.signal }));
  assert(!cancelled.events.some(value => value.sql === 'commit;'));
  const stalled = transport(); const original = stalled.makeSession;
  const factory = (name, record) => {
    const session = original(name, record), request = session.request.bind(session);
    session.request = sql => sql.startsWith('select pg_temp.await_retention_overlap')
      ? new Promise((resolveResult, reject) => stalled.pending.set(name, { resolve: resolveResult, reject, sql })) : request(sql);
    return session;
  };
  const evidence = {};
  await assert.rejects(executeRetentionPhases(phases(), factory, { timeoutMs: 10, shutdownMs: 10, evidence }), /deadline/);
  assert.equal(evidence.backendCleanup, 'unconfirmed'); assert(evidence.shutdown.some(value => value.status === 'unconfirmed'));
});

test('COPY result storage continues to treat hostile text as data', () => {
  const copy = resultCopy([{ name: 'retention-a', value: { result: { value: "\\.\n');drop table private.capability_claim_preparations;--\t" }, sqlstate: null } }]);
  assert.equal(copy.split('\n').filter(line => line === '\\.').length, 1);
  assert(!copy.includes("\n');drop"));
});

test('cancellation at final coordinator exit cannot report successful qualification', async () => {
  const controller = new AbortController(), fake = transport();
  const factory = (name, record) => {
    const session = fake.makeSession(name, record), close = session.close.bind(session);
    session.close = async () => { await close(); if (name === 'coordinator') controller.abort(); };
    return session;
  };
  const evidence = {};
  await assert.rejects(executeRetentionPhases(phases(), factory, { signal: controller.signal, evidence }), /cancelled/);
  assert.equal(evidence.coordinatorExit, undefined);
});

test('retention catalog requires all exact APIs, forced RLS, sequence CACHE 1 and denied allocation', () => {
  const value = { tables: [...RETENTION_TABLES].sort().map(name => ({ name, owner: 'postgres', rls: true, forced: true, policies: 0, denied: true })),
    rpcs: [...RETENTION_RPCS].sort().map(signature => ({ signature, exists: true, owner: 'postgres', definer: true, fixedSearchPath: true, serviceOnly: true })),
    rpcCount: 8, sequence: { cache: 1, cycle: false, owner: 'postgres', denied: true }, privateHelpersDenied: true, emptyTables: true };
  admitRetentionCatalog(value);
  for (const mutate of [v => { v.sequence.cache = 2; }, v => { v.sequence.denied = false; }, v => { v.rpcCount = 9; },
    v => { v.tables[0].forced = false; }, v => { v.rpcs[0].serviceOnly = false; }, v => { v.emptyTables = false; },
    v => { v.privateHelpersDenied = false; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => admitRetentionCatalog(changed));
  }
});

test('retention acceptance cannot substitute the old six-race proof or omit a prerequisite suite', () => {
  const value = { status: 'passed', source: 'fixture-source', containerId: 'fixture-container', transport: 'psql', profile: 'retention',
    cases: RETENTION_SUITES.map(name => ({ name, assertions: 1 })) };
  Object.assign(value.cases.at(-1), { assertions: ASSERTIONS, subcases: 11, groups: GROUPS, transport: 'persistent-psql-unix-socket-v1' });
  admitRetentionQualification(value, 'fixture-source', 'fixture-container');
  for (const mutate of [v => { v.cases.at(-1).assertions = 28; }, v => { v.cases.at(-1).groups = GROUPS.slice(1); },
    v => { v.cases.splice(3, 1); }, v => { v.profile = 'capability'; }, v => { v.source = 'other'; },
    v => { v.containerId = 'other'; }, v => { v.status = 'running'; }, v => { v.cases[0].assertions = 0; }]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => admitRetentionQualification(changed, 'fixture-source', 'fixture-container'));
  }
});
