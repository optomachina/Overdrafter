import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stagePolicyTests, admitCi, admitPgProve, LEGACY, DEDICATED_RUNNERS } from './run-supabase-policy-tests.mjs';
import { acceptSameKeyRace, acceptLockTimeout, acceptBindingRace, acceptExpiryRace, acceptRollbackRace, acceptRollbackGuards,
  acceptRevokeThenRollback, acceptRollbackBehindRevoke,
  callResult, compareCodeUnits, readMigration, readRollback, resolveBinary, splitRollback, ITERATIONS, MIN_ITERATIONS } from './ovd462-lease-race.mjs';
const source = fileURLToPath(new URL('../supabase/tests', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ovd-policy-selector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(source, join(root, 'source'), { recursive: true });
  return { source: join(root, 'source'), target: join(root, 'staged') };
}
test('all SQL and include dependencies retained except exact dedicated-runner files', t => {
  const f = fixture(t), receipt = stagePolicyTests(f.source, f.target);
  assert.equal(receipt.routedToRequiredPsqlJob, LEGACY);
  assert(receipt.selectedSql.includes('free_quote_job_meter.sql'));
  assert(receipt.selectedSql.includes('free_quote_terminal_lifecycle.sql'));
  assert(receipt.files['fixtures/free_quote_meter_setup.inc']);
  assert(!receipt.selectedSql.includes(LEGACY));
  assert.deepEqual(receipt.dedicatedRunners, {
    'reconcile_claim_fence_followups_concurrency.sql': 'scripts/test-reconcile-claim-fence.mjs --ci-local',
    'reconcile_claim_fence_concurrency.sql': 'scripts/test-reconcile-claim-fence.mjs --ci-local',
  });
  assert(!receipt.selectedSql.includes('reconcile_claim_fence_concurrency.sql'));
  assert(!receipt.selectedSql.includes('reconcile_claim_fence_followups_concurrency.sql'));
  assert(receipt.selectedSql.includes('reconcile_claim_fence_followups.sql'));
  assert(receipt.selectedSql.includes('reconcile_claim_fence.sql'));
  assert(receipt.selectedSql.includes('provider_dispatch_preflight_concurrency.sql'));
  assert.deepEqual(readFileSync(join(f.target, 'fixtures/free_quote_meter_setup.inc')),
    readFileSync(join(f.source, 'fixtures/free_quote_meter_setup.inc')));
});
test('a missing dedicated-runner suite fails closed before staging', t => {
  const f = fixture(t);
  for (const suite of Object.keys(DEDICATED_RUNNERS)) rmSync(join(f.source, suite));
  assert.throws(() => stagePolicyTests(f.source, f.target), /reviewed dedicated-runner source missing/);
});
test('dedicated-runner exclusion cannot silently capture other concurrency suites', t => {
  const f = fixture(t), name = 'reconcile_claim_fence_new_concurrency.sql';
  writeFileSync(join(f.source, name), 'select 1;\n');
  assert(stagePolicyTests(f.source, f.target).selectedSql.includes(name));
});
test('new SQL tests remain selected automatically', t => {
  const f = fixture(t); writeFileSync(join(f.source, 'new-case.sql'), 'select 1;\n');
  assert(stagePolicyTests(f.source, f.target).selectedSql.includes('new-case.sql'));
});
test('changed legacy source fails closed before staging', t => {
  const f = fixture(t); writeFileSync(join(f.source, LEGACY), 'select 1;\n');
  assert.throws(() => stagePolicyTests(f.source, f.target));
});
test('weakened replacement assertions fail closed', t => {
  const f = fixture(t), path = join(f.source, 'capability_runtime_persistence_psql.phases.json');
  const phases = JSON.parse(readFileSync(path)); phases.races[0].after = '';
  writeFileSync(path, JSON.stringify(phases)); assert.throws(() => stagePolicyTests(f.source, f.target));
});
test('symlinked source is rejected', t => {
  const f = fixture(t); symlinkSync(join(f.source, LEGACY), join(f.source, 'link.sql'));
  assert.throws(() => stagePolicyTests(f.source, f.target), /symlinks/);
});
test('missing or failed prerequisite cannot run selected suite', () => {
  for (const status of [undefined, 'failure', 'skipped', 'cancelled']) {
    assert.throws(() => admitCi({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp', OVD591_PSQL_QUALIFIED: status }));
  }
  assert.doesNotThrow(() => admitCi({ GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp', OVD591_PSQL_QUALIFIED: 'success' }));
});
test('CI requires replacement success before the standard lane and final aggregate', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /  test:\n    needs: ovd591-qualification/);
  assert.match(ci, /OVD591_PSQL_QUALIFIED: \$\{\{ needs\.ovd591-qualification\.result \}\}/);
  assert.match(ci, /run: node scripts\/run-supabase-policy-tests.mjs/);
  assert.match(ci, /run: node scripts\/test-reconcile-claim-fence.mjs --ci-local "\$RUNNER_TEMP\/reconcile-claim-fence"/);
  assert(ci.indexOf('Test reconcile claim fence concurrency on local database') > ci.indexOf('Reset local database'));
  assert(ci.indexOf('Test reconcile claim fence concurrency on local database') < ci.indexOf('Seed local database'));
  assert.match(ci, /\[ "\$OVD591_SQL_RESULT" != "success" \]/);
});
test('the dedicated CI runner refuses non-CI execution before accessing Docker', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['scripts/test-reconcile-claim-fence.mjs', '--ci-local', f.target], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env: { GITHUB_ACTIONS: 'false' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local Supabase mode is CI-only/);
  assert(!result.stderr.includes('permission denied'), 'must refuse before contacting Docker');
});

test('OVD-762 pgTAP fixtures are byte copies of the Xometry fan out draft and its rollback', () => {
  // Draft only until a migration window promotes it; neither file may drop anything.
  const drafts = [['ovd762_xometry_fanout_scope.inc', 'ovd-762-xometry-fanout-scope.sql'],
    ['ovd762_xometry_fanout_scope_rollback.inc', 'ovd-762-xometry-fanout-scope.rollback.sql']];
  for (const [fixtureName, draftName] of drafts) {
    const draft = readFileSync(fileURLToPath(new URL(`../docs/migration-drafts/${draftName}`, import.meta.url)));
    assert.deepEqual(readFileSync(join(source, 'fixtures', fixtureName)), draft);
    const drops = draft.toString('utf8').split('\n').filter(line => line.trimStart().toLowerCase().startsWith('drop '));
    assert.deepEqual(drops, [], `${draftName} must not drop anything`);
  }
  const suite = readFileSync(join(source, 'ovd762_xometry_fanout_scope_draft.sql'), 'utf8');
  assert.match(suite, /\\ir fixtures\/ovd762_xometry_fanout_scope\.inc\n/);
  assert.match(suite, /\\ir fixtures\/ovd762_xometry_fanout_scope_rollback\.inc\n/);
});

test('OVD-684 pgTAP fixture is a byte copy of the migration it exercises', () => {
  const name = '20261011130000_ovd684_backfill_object_finish.sql';
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd684_backfill_object_finish.inc')),
    readFileSync(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url))));
});

test('OVD-736 pgTAP fixtures are byte copies of the migration draft and its rollback', () => {
  for (const [fixture, draft] of [
    ['ovd736_anon_definer_privileges.inc', 'ovd-736.sql'],
    ['ovd736_anon_definer_privileges_rollback.inc', 'ovd-736.rollback.sql'],
  ]) {
    assert.deepEqual(readFileSync(join(source, 'fixtures', fixture)),
      readFileSync(fileURLToPath(new URL(`../docs/migration-drafts/${draft}`, import.meta.url))));
  }
});

test('OVD-987 pgTAP fixture is a byte copy of the rollback it drills', () => {
  // The suite runs the copy twice in savepoints: restore without audit events, refusal with them.
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd987_controlled_beta_user_quantity_rollback.inc')),
    readFileSync(fileURLToPath(new URL('../docs/migration-drafts/ovd-987.rollback.sql', import.meta.url))));
  const suite = readFileSync(join(source, 'ovd987_controlled_beta_user_quantity.sql'), 'utf8');
  assert.equal(suite.match(/^\\ir fixtures\/ovd987_controlled_beta_user_quantity_rollback\.inc\n/gm)?.length, 2);
  // The throws_ok refusal drill embeds the rollback's guard block; it must stay a byte copy.
  const rollback = readFileSync(fileURLToPath(new URL('../docs/migration-drafts/ovd-987.rollback.sql', import.meta.url)), 'utf8');
  const start = rollback.indexOf('do $ovd987_rollback_guard$');
  const end = rollback.indexOf('$ovd987_rollback_guard$;', start) + '$ovd987_rollback_guard$'.length;
  assert(start >= 0 && end > start, 'rollback guard block not found');
  assert(suite.includes(`select throws_ok($ovd987_guard_drill$\n${rollback.slice(start, end)}\n$ovd987_guard_drill$,\n  '55000',`));
});

test('OVD-1007 pgTAP fixture is a byte copy of the quantity-grant rollback', () => {
  // The OVD-1007 suite drills it twice (empty and with history); the OVD-987 suite applies it
  // once first, so it tests the OVD-987 bodies that OVD-1007 restates.
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd1007_xometry_beta_quantity_grant_rollback.inc')),
    readFileSync(fileURLToPath(new URL('../docs/migration-drafts/ovd-1007.rollback.sql', import.meta.url))));
  const own = readFileSync(join(source, 'ovd1007_xometry_beta_quantity_grant.sql'), 'utf8');
  assert.equal(own.match(/^\\ir fixtures\/ovd1007_xometry_beta_quantity_grant_rollback\.inc\n/gm)?.length, 2);
  const ovd987 = readFileSync(join(source, 'ovd987_controlled_beta_user_quantity.sql'), 'utf8');
  assert.equal(ovd987.match(/^\\ir fixtures\/ovd1007_xometry_beta_quantity_grant_rollback\.inc\n/gm)?.length, 1);
});

test('OVD-1018 pgTAP fixtures are byte copies of the promoted migration and its rollback', () => {
  // The suite installs the migration copy in its rolled back transaction only while
  // authenticated still holds INSERT, and applies the rollback copy twice.
  for (const [fixture, file] of [
    ['project_jobs_write_path.inc', 'supabase/migrations/20261030204050_ovd1018_restrict_project_jobs_writes.sql'],
    ['project_jobs_write_path_rollback.inc', 'docs/migration-drafts/ovd-1018.rollback.sql'],
  ]) {
    assert.deepEqual(readFileSync(join(source, 'fixtures', fixture)),
      readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url))));
  }
  const suite = readFileSync(join(source, 'project_jobs_write_path.sql'), 'utf8');
  assert.match(suite, /\\ir fixtures\/project_jobs_write_path\.inc\n/);
  assert.match(suite, /\\ir fixtures\/project_jobs_write_path_rollback\.inc\n/);
});

test('successful pg_prove summary must cover every selected file with real assertions', () => {
  const pass = 'All tests successful.\nFiles=53, Tests=2245, 27 wallclock secs\nResult: PASS\n';
  assert.deepEqual(admitPgProve(pass, 53), { files: 53, assertions: 2245, result: 'PASS' });
  for (const invalid of ['', 'Result: NOTESTS\n', pass.replace('53', '52'),
    pass.replace('2245', '0'), pass.replace('PASS', 'FAIL'), pass + pass,
    pass.replace('Result: PASS\n', ''), pass + '# SKIP unavailable\n', pass + '# TODO pending\n', pass + 'ok 1 - unavailable # SKIP unavailable\n',
    pass + 'suite.sql ... skipped: missing prerequisite\n']) {
    assert.throws(() => admitPgProve(invalid, 53));
  }
});

test('OVD-462 pgTAP fixture is a byte copy of the promoted migration', () => {
  // Migration window 1 promoted the draft; the pgTAP suite installs this copy in its
  // rolled-back transaction only while the table is absent.
  const name = '20261012212325_ovd462_provider_session_lease.sql';
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd462_provider_session_leases.inc')),
    readFileSync(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url))));
});

test('OVD-462 rollback refuses to drop occupants before any drop runs', () => {
  const rollback = readFileSync(join(source, 'fixtures/ovd462_provider_session_leases_rollback.inc'), 'utf8');
  const guard = rollback.indexOf("raise exception 'OVD-462 rollback refused");
  assert(guard > 0, 'occupant guard missing');
  assert(rollback.indexOf('\ndrop ') > guard, 'every drop must follow the occupant guard');
  assert.match(rollback, /state in \('active', 'blocked'\)/);
  assert.match(rollback, /current_setting\('ovd462\.rollback_discard_occupants', true\), ''\) <> 'confirmed'/);
  const bypass = rollback.indexOf('(r.rolsuper or r.rolbypassrls)');
  const lock = rollback.indexOf('lock table public.provider_session_bindings, public.provider_session_leases in access exclusive mode;');
  const occupants = rollback.indexOf("select 1 from public.provider_session_leases where state in ('active', 'blocked')");
  const refusal = rollback.indexOf("raise exception 'OVD-462 rollback refused: provider_session_leases has active or blocked occupants'");
  assert(bypass > 0 && bypass < lock && lock < occupants && occupants < refusal && refusal < rollback.indexOf('\ndrop '),
    'bypass check, then table locks, then occupant check, then drops');
  assert(!/^\s*(?:begin|commit)\s*;/im.test(rollback), 'the runner owns the transaction');
});

test('OVD-462 race key order is UTF-16 code unit order, byte identical to the default sort', () => {
  const input = ['b', 'B', 'a', '_x', 'elapsed_ms', 'Z', '\u00e9'];
  assert.deepEqual([...input].sort(compareCodeUnits), ['B', 'Z', '_x', 'a', 'b', 'elapsed_ms', '\u00e9']);
});

test('OVD-462 race tools resolve to absolute executables or fail clearly', () => {
  assert(isAbsolute(resolveBinary('node')));
  assert.throws(() => resolveBinary('ovd462-no-such-binary'), /ovd462-no-such-binary not found on PATH/);
});

const ok = result => ({ result, sqlstate: null, elapsed_ms: 1 });
const err = (sqlstate, elapsed_ms = 1) => ({ result: null, sqlstate, elapsed_ms });
const acquired = (generation = 1) => ok({ status: 'acquired', generation, idempotent: false, expires_in_ms: 60000, renewals_remaining: 5 });
test('OVD-462 race test runs every scenario at least 20 times against the byte-identical migration', () => {
  for (const count of Object.values(ITERATIONS)) assert(count >= MIN_ITERATIONS);
  assert.deepEqual(Object.keys(ITERATIONS).sort(compareCodeUnits),
    ['binding', 'expiry', 'lockTimeout', 'revokeThenRollback', 'rollback', 'rollbackBehindRevoke', 'sameKey']);
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.match(readMigration(root), /create function public\.acquire_provider_session_lease/);
  const { guard, drops } = splitRollback(readRollback(root));
  assert.match(guard, /raise exception 'OVD-462 rollback refused: provider_session_leases has active or blocked occupants'/);
  assert.match(drops, /^drop function if exists public\.clear_provider_session_binding_block/);
  const main = readFileSync(new URL('./run-supabase-policy-tests.mjs', import.meta.url), 'utf8');
  assert.match(main, /await runAgainstSupabase\(root\)/, 'CI policy step must run the race test');
});
test('OVD-462 race result parsing admits exactly one of result or SQLSTATE', () => {
  assert.deepEqual(callResult('{"result":{"status":"acquired"},"sqlstate":null,"elapsed_ms":3}\n').result, { status: 'acquired' });
  assert.equal(callResult('{"result":null,"sqlstate":"55P03","elapsed_ms":2000}\n').sqlstate, '55P03');
  assert.throws(() => callResult('{"result":null,"sqlstate":null,"elapsed_ms":1}\n'));
  assert.throws(() => callResult('{"result":{},"sqlstate":"55P03","elapsed_ms":1}\n'));
  assert.throws(() => callResult('{"result":{"status":"acquired"},"sqlstate":null,"elapsed_ms":1}\n{}\n'));
});
test('OVD-462 same-key race rejects two grants, a leaked error, or a second active row', () => {
  const contended = ok({ status: 'contended', retry_after_ms: 1000 });
  assert.equal(acceptSameKeyRace([acquired(), contended], { active: 1, total: 1 }), 'contended');
  assert.equal(acceptSameKeyRace([err('55P03'), acquired()], { active: 1, total: 1 }), '55P03');
  assert.throws(() => acceptSameKeyRace([acquired(), acquired()], { active: 1, total: 1 }));
  assert.throws(() => acceptSameKeyRace([acquired(), err('23505')], { active: 1, total: 1 }));
  assert.throws(() => acceptSameKeyRace([acquired(), contended], { active: 2, total: 2 }));
});
test('OVD-462 lock-timeout race requires a bounded 55P03 while blocked by the holder', () => {
  assert.equal(acceptLockTimeout(acquired(), err('55P03', 2001), 2100, true, { active: 1, total: 1 }), 2001);
  assert.throws(() => acceptLockTimeout(acquired(), ok({ status: 'contended', retry_after_ms: 1 }), 10, true, { active: 1, total: 1 }));
  assert.throws(() => acceptLockTimeout(acquired(), err('55P03', 9000), 9100, true, { active: 1, total: 1 }));
  assert.throws(() => acceptLockTimeout(acquired(), err('55P03', 2001), 2100, false, { active: 1, total: 1 }));
});
test('OVD-462 binding race requires binding_mismatch and one registered key', () => {
  const mismatch = ok({ status: 'rejected', reason: 'binding_mismatch' });
  const rows = { bindings: 1, bindingOwnerIsWinner: true, leases: 1, active: 1 };
  assert.equal(acceptBindingRace([mismatch, acquired()], rows), 'binding_mismatch');
  assert.throws(() => acceptBindingRace([acquired(), acquired()], rows));
  assert.throws(() => acceptBindingRace([acquired(), mismatch], { ...rows, bindingOwnerIsWinner: false }));
  assert.throws(() => acceptBindingRace([acquired(), mismatch], { ...rows, leases: 2 }));
});
test('OVD-462 expiry race requires the stale holder fenced and the generation advanced', () => {
  const lost = ok({ status: 'lost', reason: 'expired', outcome: null });
  const after = { renew: lost, release: ok({ status: 'released', changed: false, final_state: 'expired' }) };
  const rows = { active: 1, activeGeneration: 2, staleState: 'expired' };
  assert.equal(acceptExpiryRace(1, lost, acquired(2), after, rows), 'lost/expired');
  assert.throws(() => acceptExpiryRace(1, ok({ status: 'renewed', expires_in_ms: 1, renewals_remaining: 1 }), acquired(2), after, rows));
  assert.throws(() => acceptExpiryRace(2, lost, acquired(2), after, rows));
  assert.throws(() => acceptExpiryRace(1, lost, acquired(2), { ...after, release: ok({ status: 'released', changed: true, final_state: 'released' }) }, rows));
  assert.throws(() => acceptExpiryRace(1, lost, acquired(2), after, { ...rows, active: 2 }));
});
test('OVD-462 rollback race requires the revoke to time out on the rollback lock and the drops to land', () => {
  assert.equal(acceptRollbackRace(err('55P03', 2001), true, true), 'revoke_timed_out_rollback_committed');
  assert.throws(() => acceptRollbackRace(ok({ status: 'blocked', outcome: 'owner_revoked', generation: 1 }), false, true));
  assert.throws(() => acceptRollbackRace(err('55P03', 2001), false, true));
  assert.throws(() => acceptRollbackRace(err('55P03', 2001), true, false));
});
const rlsRefusal = { sqlstate: 'P0001', message: 'OVD-462 rollback refused: the running role must bypass RLS to see occupants' };
const occupantRefusal = { sqlstate: 'P0001', message: 'OVD-462 rollback refused: provider_session_leases has active or blocked occupants' };
const fence = ok({ status: 'blocked', outcome: 'owner_revoked', generation: 1 });
test('OVD-462 rollback guards refuse occupants and an owner without BYPASSRLS even with the override', () => {
  assert.equal(acceptRollbackGuards(occupantRefusal, [rlsRefusal, rlsRefusal], true), 'refused');
  assert.throws(() => acceptRollbackGuards({ sqlstate: null, message: null }, [rlsRefusal, rlsRefusal], true));
  assert.throws(() => acceptRollbackGuards(occupantRefusal, [rlsRefusal, { sqlstate: null, message: null }], true));
  assert.throws(() => acceptRollbackGuards(occupantRefusal, [rlsRefusal, occupantRefusal], true));
  assert.throws(() => acceptRollbackGuards(occupantRefusal, [rlsRefusal, rlsRefusal], false));
});
test('OVD-462 a committed revoke refuses a later rollback', () => {
  assert.equal(acceptRevokeThenRollback(fence, occupantRefusal, true), 'rollback_refused');
  assert.throws(() => acceptRevokeThenRollback(fence, { sqlstate: null, message: null }, true));
  assert.throws(() => acceptRevokeThenRollback(err('55P03'), occupantRefusal, true));
});
test('OVD-462 a rollback queued behind a pending revoke neither deadlocks nor drops the fence', () => {
  assert.equal(acceptRollbackBehindRevoke(fence, occupantRefusal, true, true), 'no_deadlock_rollback_refused');
  assert.throws(() => acceptRollbackBehindRevoke(err('40P01'), occupantRefusal, true, true));
  assert.throws(() => acceptRollbackBehindRevoke(fence, { sqlstate: '40P01', message: 'deadlock detected' }, true, true));
  assert.throws(() => acceptRollbackBehindRevoke(fence, occupantRefusal, false, true));
  assert.throws(() => acceptRollbackBehindRevoke(fence, occupantRefusal, true, false));
});
