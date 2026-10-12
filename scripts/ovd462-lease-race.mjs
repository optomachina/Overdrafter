/**
 * OVD-462 two-connection race test for docs/migration-drafts/ovd-462.sql.
 *
 * pgTAP runs in one session, so it cannot prove that the advisory locks serialize
 * independent connections. This drives two real psql sessions (plus a postgres
 * coordinator) against a scratch database that holds only the draft, releases
 * both racers from one advisory-lock gate, and checks the outcome and the stored
 * rows after every iteration. The scratch database is dropped afterwards.
 *
 * Targets:
 *   --target supabase  the running local Supabase stack (CI `test` job, via
 *                      scripts/run-supabase-policy-tests.mjs); credentials come from
 *                      `supabase status`, never from arguments.
 *   --target docker    a disposable postgres container on an internal network with
 *                      no published port, removed afterwards (synthetic fixture lane).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PsqlSession, oneJson } from './ovd591-psql-concurrency.mjs';

export const DRAFT_PATH = 'docs/migration-drafts/ovd-462.sql';
export const FIXTURE_PATH = 'supabase/tests/fixtures/ovd462_provider_session_leases.inc';
export const ROLLBACK_PATH = 'docs/migration-drafts/ovd-462.rollback.sql';
export const ROLLBACK_FIXTURE_PATH = 'supabase/tests/fixtures/ovd462_provider_session_leases_rollback.inc';
export const DOCKER_IMAGE = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
export const ITERATIONS = Object.freeze({
  sameKey: 30, lockTimeout: 20, binding: 30, expiry: 30, rollback: 20, revokeThenRollback: 20, rollbackBehindRevoke: 20,
});
export const MIN_ITERATIONS = 20;
const LOCK_TIMEOUT_MS = 2000;
const TTL_SECONDS = 5;

const hex = bytes => randomBytes(bytes).toString('hex');
const acct = () => `acct_${hex(16)}`;
const sb = () => `sb_${hex(16)}`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

/** Scratch-database setup: roles exist on Supabase; the docker target creates them. */
export const RACE_HELPERS_SQL = `
create schema if not exists private;
create schema race;
-- Runs one RPC call and reports either its jsonb result or the SQLSTATE it raised,
-- with the database-measured duration, so lock timeouts are data, not psql errors.
create function race.try_json(p_sql text) returns jsonb language plpgsql as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  execute p_sql into v_result;
  return jsonb_build_object('result', v_result, 'sqlstate', null,
    'elapsed_ms', floor(extract(epoch from (pg_catalog.clock_timestamp() - v_start)) * 1000));
exception when others then
  return jsonb_build_object('result', null, 'sqlstate', sqlstate,
    'elapsed_ms', floor(extract(epoch from (pg_catalog.clock_timestamp() - v_start)) * 1000));
end;
$$;
-- Same for statements that return nothing (the rollback guard), keeping the message.
create function race.try_exec(p_sql text) returns jsonb language plpgsql as $$
begin
  execute p_sql;
  return jsonb_build_object('sqlstate', null, 'message', null);
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;
grant usage on schema race to service_role, authenticated;
grant execute on function race.try_json(text), race.try_exec(text) to service_role, authenticated;
`;

export function acquireSql(key, taskRef, holderToken, { ttl = 60, renewals = 5, duration = 600 } = {}) {
  return `select public.acquire_provider_session_lease(${quote(key.provider)}, ${quote(key.account)}, ${quote(key.environment)}, `
    + `${quote(key.binding)}, ${quote(taskRef)}, ${quote(holderToken)}::uuid, ${ttl}, ${renewals}, ${duration})`;
}
export function ownedSql(fn, key, taskRef, holderToken, generation) {
  assert(['renew', 'release'].includes(fn));
  return `select public.${fn}_provider_session_lease(${quote(key.provider)}, ${quote(key.account)}, ${quote(key.environment)}, `
    + `${quote(key.binding)}, ${quote(taskRef)}, ${quote(holderToken)}::uuid, ${Number(generation)})`;
}
const tryCall = (sql, gate) => gate === undefined
  ? `select race.try_json(${quote(sql)});`
  // The gate subquery runs first: both racers wait on the coordinator's lock and start together.
  : `select race.try_json(${quote(sql)}) from (select pg_catalog.pg_advisory_xact_lock_shared(${gate})) gate;`;

/** One racer result: exactly one of a jsonb result or a SQLSTATE. */
export function callResult(output) {
  const value = oneJson(output);
  assert.deepEqual(Object.keys(value).sort(), ['elapsed_ms', 'result', 'sqlstate']);
  assert(Number.isFinite(value.elapsed_ms) && value.elapsed_ms >= 0);
  if (value.sqlstate === null) assert(value.result && typeof value.result === 'object');
  else assert(/^[0-9A-Z]{5}$/.test(value.sqlstate) && value.result === null);
  return value;
}
const label = call => call.sqlstate ?? `${call.result.status}${call.result.reason ? `/${call.result.reason}` : ''}`;

/** (a) Same provider/account/environment: one grant; the other is contended or timed out. */
export function acceptSameKeyRace([a, b], rows) {
  const won = [a, b].filter(call => call.result?.status === 'acquired');
  assert.equal(won.length, 1, `exactly one acquired required, got ${label(a)} and ${label(b)}`);
  assert.equal(won[0].result.idempotent, false);
  const lost = won[0] === a ? b : a;
  assert(lost.sqlstate === '55P03' || lost.result?.status === 'contended', `loser must be contended or 55P03, got ${label(lost)}`);
  if (lost.result) assert(Number.isSafeInteger(lost.result.retry_after_ms) && lost.result.retry_after_ms > 0);
  assert.equal(rows.active, 1, 'exactly one active row for the key');
  assert.equal(rows.total, 1, 'the losing call wrote no row');
  return lost.sqlstate ?? 'contended';
}

/** (b) Holder keeps the key lock in an open transaction: the contender fails fast with 55P03. */
export function acceptLockTimeout(holder, contender, wallMs, observedWaiter, rows) {
  assert.equal(holder.result?.status, 'acquired', `holder must acquire, got ${label(holder)}`);
  assert.equal(contender.sqlstate, '55P03', `contender must hit lock_timeout, got ${label(contender)}`);
  assert(contender.elapsed_ms >= LOCK_TIMEOUT_MS - 100 && contender.elapsed_ms < LOCK_TIMEOUT_MS + 1500,
    `contender waited ${contender.elapsed_ms}ms, expected about ${LOCK_TIMEOUT_MS}ms`);
  assert(wallMs < LOCK_TIMEOUT_MS + 3000, `contender returned after ${wallMs}ms wall time`);
  assert.equal(observedWaiter, true, 'contender was not observed waiting on the holder\'s advisory lock');
  assert.equal(rows.active, 1, 'only the holder\'s row is active after commit');
  assert.equal(rows.total, 1);
  return contender.elapsed_ms;
}

/** (c) One session_binding_ref under two keys: one grant, the other binding_mismatch. */
export function acceptBindingRace([a, b], rows) {
  const won = [a, b].filter(call => call.result?.status === 'acquired');
  assert.equal(won.length, 1, `exactly one acquired required, got ${label(a)} and ${label(b)}`);
  const lost = won[0] === a ? b : a;
  assert(lost.sqlstate === '55P03' || (lost.result?.status === 'rejected' && lost.result.reason === 'binding_mismatch'),
    `loser must be binding_mismatch or 55P03, got ${label(lost)}`);
  assert.equal(rows.bindings, 1, 'the session binding is registered to exactly one key');
  assert.equal(rows.bindingOwnerIsWinner, true, 'the registered key is the winner\'s');
  assert.equal(rows.leases, 1, 'exactly one lease row names the session binding');
  assert.equal(rows.active, 1);
  return lost.sqlstate ?? 'binding_mismatch';
}

/** (d) Expired holder renews while a contender acquires: holder is fenced, generation advances. */
export function acceptExpiryRace(staleGeneration, renew, contender, after, rows) {
  assert(renew.result?.status === 'lost' || (renew.result?.status === 'rejected' && renew.result.reason === 'not_owner'),
    `stale holder must be lost or not_owner, got ${label(renew)}`);
  assert.equal(contender.result?.status, 'acquired', `contender must acquire, got ${label(contender)}`);
  assert(contender.result.generation > staleGeneration, 'generation must strictly increase');
  assert(['lost', 'rejected'].includes(after.renew.result?.status), 'stale holder stays fenced on a second renew');
  assert.equal(after.release.result?.status === 'released' ? after.release.result.changed : false, false,
    'stale release changes nothing');
  assert.equal(rows.active, 1, 'only the contender is active');
  assert.equal(rows.activeGeneration, contender.result.generation);
  assert.equal(rows.staleState, 'expired');
  return renew.result.status === 'lost' ? `lost/${renew.result.reason}` : 'not_owner';
}

/** Splits the rollback into its guard (which takes the table locks) and the drops after it. */
export function splitRollback(rollbackSql) {
  const at = rollbackSql.indexOf('\ndrop ');
  assert(at > 0, 'rollback drops missing');
  const guard = rollbackSql.slice(0, at + 1), drops = rollbackSql.slice(at + 1);
  assert.match(guard, /lock table public\.provider_session_(?:bindings|leases), public\.provider_session_(?:leases|bindings) in access exclusive mode;/);
  assert(!/\ndrop /.test(guard) && /^drop /.test(drops));
  return { guard, drops };
}

/** (e) A revoke racing an open rollback cannot commit a fence that the drops would destroy. */
export function acceptRollbackRace(revoke, observedWaiter, dropped) {
  assert.equal(revoke.sqlstate, '55P03', `revoke must wait on the rollback lock and time out, got ${label(revoke)}`);
  assert(revoke.elapsed_ms >= LOCK_TIMEOUT_MS - 100 && revoke.elapsed_ms < LOCK_TIMEOUT_MS + 1500, `revoke waited ${revoke.elapsed_ms}ms`);
  assert.equal(observedWaiter, true, 'revoke was not observed waiting on the rollback transaction');
  assert.equal(dropped, true, 'rollback did not drop both tables');
  return 'revoke_timed_out_rollback_committed';
}

const OCCUPANTS_REFUSAL = /provider_session_leases has active or blocked occupants/;
const RLS_REFUSAL = /must bypass RLS/;
const refusedWith = (result, pattern, what) => {
  assert.equal(result.sqlstate, 'P0001', `${what}: guard must refuse, got ${result.sqlstate ?? 'success'}`);
  assert.match(result.message, pattern, `${what}: wrong refusal`);
};

/**
 * (f) With occupants present the guard refuses a bypassing role without the
 * override, and refuses a table owner without BYPASSRLS (which would otherwise
 * see zero occupants through forced RLS) with or without the override.
 */
export function acceptRollbackGuards(occupantRefusal, ownerResults, tablesIntact) {
  refusedWith(occupantRefusal, OCCUPANTS_REFUSAL, 'occupants present');
  assert.equal(ownerResults.length, 2);
  for (const result of ownerResults) refusedWith(result, RLS_REFUSAL, 'owner without BYPASSRLS');
  assert.equal(tablesIntact, true);
  return 'refused';
}

/** (g) A revoke that committed before the rollback is seen as an occupant and refuses the rollback. */
export function acceptRevokeThenRollback(revoke, guard, tablesIntact) {
  assert.equal(revoke.result?.status, 'blocked', `revoke must commit a fence, got ${label(revoke)}`);
  refusedWith(guard, OCCUPANTS_REFUSAL, 'committed revoke');
  assert.equal(tablesIntact, true);
  return 'rollback_refused';
}

/**
 * (h) A revoke transaction that already holds the registry (the RPCs' own table
 * order) while the rollback queues behind it: no deadlock, the revoke commits,
 * and the rollback then sees its fence and refuses.
 */
export function acceptRollbackBehindRevoke(revoke, guard, observedWaiter, tablesIntact) {
  assert.equal(observedWaiter, true, 'rollback was not observed waiting behind the revoke transaction');
  assert.equal(revoke.result?.status, 'blocked', `revoke must not deadlock, got ${label(revoke)}`);
  refusedWith(guard, OCCUPANTS_REFUSAL, 'pending revoke');
  assert.equal(tablesIntact, true);
  return 'no_deadlock_rollback_refused';
}

const tally = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };

export async function runLeaseRaces(makeSession, draftSql, rollbackSql, { iterations = ITERATIONS, log = () => {} } = {}) {
  const rollback = splitRollback(rollbackSql);
  for (const count of Object.values(iterations)) assert(count >= MIN_ITERATIONS, `at least ${MIN_ITERATIONS} iterations required`);
  const sessions = {};
  const receipt = { iterations: { ...iterations }, scenarios: {} };
  try {
    for (const name of ['coordinator', 'a', 'b']) sessions[name] = makeSession(name);
    const { coordinator, a, b } = sessions;
    await coordinator.request(`${RACE_HELPERS_SQL}\n${draftSql}`);
    for (const racer of [a, b]) await racer.request('set role service_role;\nset statement_timeout = 15000;');
    const pids = {};
    for (const [name, session] of Object.entries(sessions)) pids[name] = Number((await session.request('select pg_backend_pid();')).trim());
    const one = async sql => oneJson(await coordinator.request(`select (${sql})::jsonb;`));
    const keyRows = key => one(`select jsonb_build_object(
        'active', count(*) filter (where state = 'active'), 'total', count(*),
        'activeGeneration', max(generation) filter (where state = 'active'))
      from public.provider_session_leases
      where provider = ${quote(key.provider)} and account_ref = ${quote(key.account)} and environment = ${quote(key.environment)}`);
    const noDoubleOwner = async () => assert.equal((await one(`select to_jsonb(count(*)) from (
        select 1 from public.provider_session_leases where state in ('active', 'blocked')
        group by provider, account_ref, environment having count(*) > 1) d`)), 0, 'two occupants for one key');

    let gate = 0;
    const gatedPair = async (sqlA, sqlB) => {
      gate += 1;
      await coordinator.request(`select pg_catalog.pg_advisory_lock(${gate});`);
      const pending = [a.request(tryCall(sqlA, gate)), b.request(tryCall(sqlB, gate))];
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = Number((await coordinator.request(`select count(*) from pg_catalog.pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${gate} and objsubid = 1 and not granted
            and pid in (${pids.a}, ${pids.b});`)).trim());
        if (waiting === 2) break;
        assert(Date.now() < deadline, 'racers never reached the start gate');
      }
      await coordinator.request(`select pg_catalog.pg_advisory_unlock(${gate});`);
      return (await Promise.all(pending)).map(callResult);
    };

    // (a) same provider/account/environment at the same instant
    let counts = {};
    for (let i = 0; i < iterations.sameKey; i += 1) {
      const key = { provider: 'xometry', account: acct(), environment: 'test', binding: sb() };
      const pair = await gatedPair(acquireSql(key, 'race-task-a', randomUUID()), acquireSql(key, 'race-task-b', randomUUID()));
      tally(counts, acceptSameKeyRace(pair, await keyRows(key)));
      tally(counts, pair[0].result?.status === 'acquired' ? 'winner:a' : 'winner:b');
    }
    await noDoubleOwner();
    receipt.scenarios.sameKey = counts;
    log(`(a) same key: ${JSON.stringify(counts)}`);

    // (b) holder keeps the advisory lock in an open transaction
    counts = { lockTimeout: 0 }; const waits = [];
    for (let i = 0; i < iterations.lockTimeout; i += 1) {
      const key = { provider: 'xometry', account: acct(), environment: 'test', binding: sb() };
      await a.request('begin;');
      const holder = callResult(await a.request(tryCall(acquireSql(key, 'race-holder', randomUUID()))));
      const started = Date.now();
      const contending = b.request(tryCall(acquireSql(key, 'race-contender', randomUUID())));
      let observedWaiter = false;
      while (!observedWaiter && Date.now() - started < LOCK_TIMEOUT_MS - 500) {
        observedWaiter = (await coordinator.request(`select exists (select 1 from pg_catalog.pg_locks l
          where l.pid = ${pids.b} and l.locktype = 'advisory' and not l.granted
            and ${pids.a} = any (pg_catalog.pg_blocking_pids(${pids.b})));`)).trim() === 't';
      }
      const contender = callResult(await contending);
      const wallMs = Date.now() - started;
      await a.request('commit;');
      waits.push(acceptLockTimeout(holder, contender, wallMs, observedWaiter, await keyRows(key)));
      counts.lockTimeout += 1;
    }
    waits.sort((x, y) => x - y);
    receipt.scenarios.lockTimeout = { ...counts, minWaitMs: waits[0], maxWaitMs: waits.at(-1) };
    log(`(b) lock timeout: ${JSON.stringify(receipt.scenarios.lockTimeout)}`);

    // (c) one session_binding_ref raced under two different keys
    counts = {};
    for (let i = 0; i < iterations.binding; i += 1) {
      const binding = sb();
      const keyA = { provider: 'xometry', account: acct(), environment: 'test', binding };
      const keyB = { ...keyA, account: acct() };
      const pair = await gatedPair(acquireSql(keyA, 'race-task-a', randomUUID()), acquireSql(keyB, 'race-task-b', randomUUID()));
      const winner = pair[0].result?.status === 'acquired' ? keyA : keyB;
      const rows = await one(`select jsonb_build_object(
          'bindings', (select count(*) from public.provider_session_bindings where session_binding_ref = ${quote(binding)}),
          'bindingOwnerIsWinner', coalesce((select bool_and(account_ref = ${quote(winner.account)}) from public.provider_session_bindings
            where session_binding_ref = ${quote(binding)}), false),
          'leases', (select count(*) from public.provider_session_leases where session_binding_ref = ${quote(binding)}),
          'active', (select count(*) from public.provider_session_leases where session_binding_ref = ${quote(binding)} and state = 'active'))`);
      tally(counts, acceptBindingRace(pair, rows));
    }
    receipt.scenarios.binding = counts;
    log(`(c) binding: ${JSON.stringify(counts)}`);

    // (d) expiry: every holder's lease lapses, then each stale renew races a new acquire
    counts = {};
    const holders = [];
    for (let i = 0; i < iterations.expiry; i += 1) {
      const key = { provider: 'xometry', account: acct(), environment: 'test', binding: sb() };
      const token = randomUUID();
      const granted = callResult(await a.request(tryCall(acquireSql(key, 'race-stale', token, { ttl: TTL_SECONDS, renewals: 3, duration: 60 }))));
      assert.equal(granted.result?.status, 'acquired');
      holders.push({ key, token, generation: granted.result.generation });
    }
    const expiryDeadline = Date.now() + (TTL_SECONDS + 10) * 1000;
    while ((await coordinator.request(`select bool_and(expires_at <= clock_timestamp()) from public.provider_session_leases
        where owner_task_ref = 'race-stale';`)).trim() !== 't') {
      assert(Date.now() < expiryDeadline, 'stale leases never expired');
      await new Promise(done => setTimeout(done, 250));
    }
    for (const holder of holders) {
      const [renew, contender] = await gatedPair(
        ownedSql('renew', holder.key, 'race-stale', holder.token, holder.generation),
        acquireSql(holder.key, 'race-contender', randomUUID()));
      const after = {
        renew: callResult(await a.request(tryCall(ownedSql('renew', holder.key, 'race-stale', holder.token, holder.generation)))),
        release: callResult(await a.request(tryCall(ownedSql('release', holder.key, 'race-stale', holder.token, holder.generation)))),
      };
      const rows = await one(`select jsonb_build_object(
          'active', count(*) filter (where state = 'active'),
          'activeGeneration', max(generation) filter (where state = 'active'),
          'staleState', max(state) filter (where generation = ${Number(holder.generation)}))
        from public.provider_session_leases
        where provider = ${quote(holder.key.provider)} and account_ref = ${quote(holder.key.account)} and environment = ${quote(holder.key.environment)}`);
      tally(counts, acceptExpiryRace(holder.generation, renew, contender, after, rows));
    }
    await noDoubleOwner();
    receipt.scenarios.expiry = counts;
    log(`(d) expiry: ${JSON.stringify(counts)}`);

    // (f) rollback guards while occupants from (a) to (d) are present
    const tablesExist = async () => (await coordinator.request(`select pg_catalog.to_regclass('public.provider_session_leases') is not null
        and pg_catalog.to_regclass('public.provider_session_bindings') is not null;`)).trim() === 't';
    const tryGuard = async session => oneJson(await session.request(`select race.try_exec(${quote(rollback.guard)});`));
    const setOverride = value => `select pg_catalog.set_config('ovd462.rollback_discard_occupants', ${quote(value)}, false);`;
    await a.request('reset role;');
    await a.request('begin;');
    const occupantRefusal = await tryGuard(a);
    await a.request('rollback;');
    // Make a role without BYPASSRLS the owner of both tables, as a mistaken migration owner would be.
    const owners = (owner) => `alter table public.provider_session_bindings owner to ${owner};
      alter table public.provider_session_leases owner to ${owner};`;
    await coordinator.request(`grant create on schema public to authenticated;\n${owners('authenticated')}`);
    await a.request('set role authenticated;');
    const ownerResults = [];
    for (const override of ['', 'confirmed']) {
      await a.request(setOverride(override));
      await a.request('begin;');
      ownerResults.push(await tryGuard(a));
      await a.request('rollback;');
    }
    await a.request(`reset role;\n${setOverride('')}`);
    await coordinator.request(`${owners('postgres')}\nrevoke create on schema public from authenticated;`);
    receipt.scenarios.rollbackGuards = acceptRollbackGuards(occupantRefusal, ownerResults, await tablesExist());
    log(`(f) rollback guards (occupants present; owner without BYPASSRLS): ${receipt.scenarios.rollbackGuards}`);

    // The rollback scenarios below start from a schema with no occupants.
    const reinstall = () => coordinator.request(
      `begin;\nset local ovd462.rollback_discard_occupants = 'confirmed';\n${rollbackSql}commit;\n${draftSql}`);
    await reinstall();
    const revokeSql = key => `select public.revoke_provider_session_binding(${quote(key.provider)}, ${quote(key.account)}, `
      + `${quote(key.environment)}, ${quote(key.binding)}, 'race-operator', 'race-reason')`;
    const freshKey = () => ({ provider: 'xometry', account: acct(), environment: 'test', binding: sb() });

    // (e) rollback holds its table locks from the guard to commit; a concurrent revoke cannot slip in
    counts = {};
    for (let i = 0; i < iterations.rollback; i += 1) {
      await a.request(`begin;\nset local ovd462.rollback_discard_occupants = 'confirmed';\n${rollback.guard}`);
      const started = Date.now();
      const revoking = b.request(tryCall(revokeSql(freshKey())));
      let observedWaiter = false;
      while (!observedWaiter && Date.now() - started < LOCK_TIMEOUT_MS - 500) {
        observedWaiter = (await coordinator.request(`select ${pids.a} = any (pg_catalog.pg_blocking_pids(${pids.b}));`)).trim() === 't';
      }
      const revoke = callResult(await revoking);
      await a.request(`${rollback.drops}commit;`);
      tally(counts, acceptRollbackRace(revoke, observedWaiter, !(await tablesExist())));
      await coordinator.request(draftSql);
    }
    receipt.scenarios.rollback = counts;
    log(`(e) rollback race: ${JSON.stringify(counts)}`);

    // (g) a revoke commits first, then the rollback runs without the override
    counts = {};
    for (let i = 0; i < iterations.revokeThenRollback; i += 1) {
      const revoke = callResult(await b.request(tryCall(revokeSql(freshKey()))));
      await a.request('begin;');
      const guard = await tryGuard(a);
      await a.request('rollback;');
      tally(counts, acceptRevokeThenRollback(revoke, guard, await tablesExist()));
      await reinstall();
    }
    receipt.scenarios.revokeThenRollback = counts;
    log(`(g) revoke then rollback: ${JSON.stringify(counts)}`);

    // (h) a revoke transaction holds the registry; the rollback queues behind it; the revoke then runs
    counts = {};
    await b.request('reset role;');
    for (let i = 0; i < iterations.rollbackBehindRevoke; i += 1) {
      await b.request('begin;\nselect count(*) from public.provider_session_bindings;');
      await a.request('begin;');
      const started = Date.now();
      const guarding = tryGuard(a);
      let observedWaiter = false;
      while (!observedWaiter) {
        observedWaiter = (await coordinator.request(`select ${pids.b} = any (pg_catalog.pg_blocking_pids(${pids.a}));`)).trim() === 't';
        assert(Date.now() - started < 10_000, 'rollback never queued behind the revoke transaction');
      }
      const revoke = callResult(await b.request(tryCall(revokeSql(freshKey()))));
      await b.request('commit;');
      const guard = await guarding;
      await a.request('rollback;');
      tally(counts, acceptRollbackBehindRevoke(revoke, guard, observedWaiter, await tablesExist()));
      await reinstall();
    }
    await b.request('set role service_role;');
    receipt.scenarios.rollbackBehindRevoke = counts;
    log(`(h) rollback behind a pending revoke: ${JSON.stringify(counts)}`);
    return receipt;
  } catch (error) {
    const stderr = Object.entries(sessions).filter(([, session]) => session.record.stderr)
      .map(([name, session]) => `${name}: ${session.record.stderr.trim().slice(0, 2000)}`);
    if (stderr.length) error.message += `\n${stderr.join('\n')}`;
    throw error;
  } finally {
    await Promise.allSettled(Object.values(sessions).map(session => session.close()));
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  assert(!result.error && result.status === 0, `${command} ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

/** psql inside the database container over its own loopback; the password is inherited, never on argv. */
function psqlFactory(container, database, password) {
  return name => {
    const args = ['exec', '-i', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS=-cclient_min_messages=warning -ctimezone=UTC',
      '-e', `PGAPPNAME=ovd462-race-${name}`, container,
      'psql', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', database, '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1'];
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: password } });
    return new PsqlSession(child, name, {}, { timeoutMs: 30_000 });
  };
}

async function withScratchDatabase(container, password, body) {
  const database = `ovd462_race_${hex(6)}`;
  const admin = psqlFactory(container, 'postgres', password);
  const session = admin('admin');
  try {
    await session.request(`create database ${database};`);
    return await body(psqlFactory(container, database, password), database);
  } finally {
    await session.request(`drop database if exists ${database} with (force);`).catch(() => {});
    await session.close().catch(() => {});
  }
}

export async function runAgainstSupabase(root, { log = console.log } = {}) {
  const output = run('supabase', ['status', '-o', 'json'], { cwd: root });
  const status = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  assert(typeof status.DB_URL === 'string', 'supabase status did not report DB_URL');
  const url = new URL(status.DB_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'only the local Supabase stack is admitted');
  const projectId = readFileSync(join(root, 'supabase/config.toml'), 'utf8').match(/^project_id = "([a-z0-9_-]+)"$/m)?.[1];
  assert(projectId, 'project_id missing from supabase/config.toml');
  const container = `supabase_db_${projectId}`;
  const draft = readDraft(root), rollback = readRollback(root);
  return withScratchDatabase(container, decodeURIComponent(url.password), (factory, database) => {
    log(`ovd462 race: local Supabase container ${container}, scratch database ${database}`);
    return runLeaseRaces(factory, draft, rollback, { log });
  });
}

export async function runAgainstDocker(root, { log = console.log } = {}) {
  const id = `ovd462-race-${hex(4)}`;
  const password = hex(24);
  const created = { network: null, container: null };
  try {
    run('docker', ['network', 'create', '--internal', id]); created.network = id;
    run('docker', ['run', '-d', '--name', id, '--network', id, '--cpus', '2', '--memory', '1g', '--pids-limit', '512',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m', '-e', 'POSTGRES_PASSWORD', DOCKER_IMAGE],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 300_000 });
    created.container = id;
    const ready = Date.now() + 60_000;
    // TCP only answers once the image's init server has stopped and the real one is up.
    while (spawnSync('docker', ['exec', '-e', 'PGPASSWORD', id, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atqc', 'select 1'],
      { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } }).stdout?.trim() !== '1') {
      assert(Date.now() < ready, 'fixture database never became ready');
      await new Promise(done => setTimeout(done, 500));
    }
    const setup = psqlFactory(id, 'postgres', password)('setup');
    await setup.request('create role anon nologin; create role authenticated nologin; create role service_role nologin;');
    await setup.close();
    const draft = readDraft(root), rollback = readRollback(root);
    return await withScratchDatabase(id, password, (factory, database) => {
      log(`ovd462 race: fixture container ${id} (${DOCKER_IMAGE}), scratch database ${database}`);
      return runLeaseRaces(factory, draft, rollback, { log });
    });
  } finally {
    if (created.container) spawnSync('docker', ['rm', '-f', created.container], { encoding: 'utf8' });
    if (created.network) spawnSync('docker', ['network', 'rm', created.network], { encoding: 'utf8' });
  }
}

export function readDraft(root) {
  const draft = readFileSync(join(root, DRAFT_PATH), 'utf8');
  assert.equal(readFileSync(join(root, FIXTURE_PATH), 'utf8'), draft, 'pgTAP fixture must be a byte copy of the draft');
  return draft;
}
export function readRollback(root) {
  const rollback = readFileSync(join(root, ROLLBACK_PATH), 'utf8');
  assert.equal(readFileSync(join(root, ROLLBACK_FIXTURE_PATH), 'utf8'), rollback, 'pgTAP fixture must be a byte copy of the rollback');
  return rollback;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 2 && args[0] === '--target' && ['supabase', 'docker'].includes(args[1]),
    'usage: node scripts/ovd462-lease-race.mjs --target supabase|docker');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const receipt = args[1] === 'supabase' ? await runAgainstSupabase(root) : await runAgainstDocker(root);
  console.log(JSON.stringify({ ovd462LeaseRace: 'PASS', ...receipt }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
