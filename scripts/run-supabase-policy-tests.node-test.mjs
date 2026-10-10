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
