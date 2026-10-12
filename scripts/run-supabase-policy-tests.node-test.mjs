import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stagePolicyTests, admitCi, admitPgProve, LEGACY } from './run-supabase-policy-tests.mjs';
const source = fileURLToPath(new URL('../supabase/tests', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ovd-policy-selector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(source, join(root, 'source'), { recursive: true });
  return { source: join(root, 'source'), target: join(root, 'staged') };
}
test('all SQL and include dependencies retained except exact routed legacy file', t => {
  const f = fixture(t), receipt = stagePolicyTests(f.source, f.target);
  assert.equal(receipt.routedToRequiredPsqlJob, LEGACY);
  assert(receipt.selectedSql.includes('free_quote_job_meter.sql'));
  assert(receipt.selectedSql.includes('free_quote_terminal_lifecycle.sql'));
  assert(receipt.files['fixtures/free_quote_meter_setup.inc']);
  assert(!receipt.selectedSql.includes(LEGACY));
  assert.deepEqual(readFileSync(join(f.target, 'fixtures/free_quote_meter_setup.inc')),
    readFileSync(join(f.source, 'fixtures/free_quote_meter_setup.inc')));
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
  assert.match(ci, /\[ "\$OVD591_SQL_RESULT" != "success" \]/);
});

test('OVD-684 pgTAP fixture is a byte copy of the migration it exercises', () => {
  const name = '20261011130000_ovd684_backfill_object_finish.sql';
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd684_backfill_object_finish.inc')),
    readFileSync(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url))));
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

const draftUrl = name => new URL(`../docs/migration-drafts/${name}`, import.meta.url);
test('OVD-734 pgTAP fixtures are byte copies of the proposed migration draft and its rollback', () => {
  // The draft stays outside supabase/migrations until a migration window; the pgTAP
  // suites install these copies only while the consumption table is absent.
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd734_provider_dispatch_permit_consumption.inc')),
    readFileSync(draftUrl('ovd-734.sql')));
  assert.deepEqual(readFileSync(join(source, 'fixtures/ovd734_provider_dispatch_permit_consumption_rollback.inc')),
    readFileSync(draftUrl('ovd-734.rollback.sql')));
});
test('OVD-734 draft RPCs are definer, empty search_path, lock-timed and service_role only', () => {
  const draft = readFileSync(draftUrl('ovd-734.sql'), 'utf8');
  assert(!/^\s*(?:begin|commit)\s*;/im.test(draft), 'the runner owns the transaction');
  for (const rpc of [
    'public.api_consume_provider_dispatch_permit(uuid, uuid, uuid, text, text)',
    'public.api_mark_provider_dispatch_permit_side_effect_started(uuid, integer, text)',
    'public.api_record_provider_dispatch_permit_outcome(uuid, integer, text, text)',
  ]) {
    assert(draft.includes(`revoke all on function ${rpc}\n  from public, anon, authenticated, service_role;`), rpc);
    assert(draft.includes(`grant execute on function ${rpc}\n  to service_role;`), rpc);
  }
  const headers = [...draft.matchAll(/create function public\.api_[a-z_]+\([\s\S]*?\nas \$\$/g)].map(match => match[0]);
  assert.equal(headers.length, 3);
  for (const header of headers) {
    assert.match(header, /\nsecurity definer\nset search_path = ''\nset lock_timeout = '2s'\nas \$\$$/);
  }
  assert.doesNotMatch(draft, /search_path = pg_catalog/);
  assert.match(draft, /primary key \(permit_id, attempt\)/);
  assert.match(draft, /check \(attempt in \(1, 2\)\)/);
  assert.match(draft, /private\.provider_kill_switches provider_switch/);
  assert.match(draft, /private\.provider_global_kill_switch global_switch/);
  assert.doesNotMatch(draft, /grant (?:select|insert|update|delete|all)[^;]*provider_dispatch_permit_consumptions/i);
});
test('OVD-734 rollback refuses to drop live consumptions before any drop runs', () => {
  const rollback = readFileSync(draftUrl('ovd-734.rollback.sql'), 'utf8');
  const bypass = rollback.indexOf('(r.rolsuper or r.rolbypassrls)');
  const lock = rollback.indexOf('lock table private.provider_dispatch_permit_consumptions in access exclusive mode;');
  const live = rollback.indexOf('where permit.expires_at > pg_catalog.clock_timestamp()');
  const refusal = rollback.indexOf("raise exception 'OVD-734 rollback refused: unexpired permits have recorded consumptions'");
  assert(bypass > 0 && bypass < lock && lock < live && live < refusal && refusal < rollback.indexOf('\ndrop '),
    'bypass check, then table lock, then live-consumption check, then drops');
  assert.match(rollback, /current_setting\('ovd734\.rollback_discard_consumptions', true\), ''\) <> 'confirmed'/);
  assert(!/^\s*(?:begin|commit)\s*;/im.test(rollback), 'the runner owns the transaction');
});
