/** Offline orchestration simulation, never SQL acceptance evidence. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SOURCE_PATH, PLATFORM_PATH, REVIEWED_APPENDED_MIGRATIONS, loadFreeQuoteInputs, admitPlatformPreflight, admitPlatformPostcheck,
  PLATFORM_PREFLIGHT, PLATFORM_POSTCHECK, QUALIFICATION_PRECHECK, platformSql, qualifyFreeQuote, hash } from './free-quote-ci-profile.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const inputs = () => loadFreeQuoteInputs(root);
const preflight = () => ({ database: 'postgres', sessionUser: 'supabase_admin', currentUser: 'supabase_admin',
  serverAddress: null, clientAddress: null, isSuperuser: true, requiredRolesPresent: true, platformSchemasPresent: true,
  authLegacyBaseline: true, authUsersEmpty: true, storageBucketsAbsent: true, applicationAbsent: true });
const postcheck = () => ({ authUsersPresent: true, storageBucketsPresent: true, authUsersOwner: 'supabase_auth_admin',
  storageBucketsOwner: 'supabase_storage_admin', storagePublicColumn: true, postgresIsAuthenticatorMember: true });
const precheck = () => ({ database: 'postgres', role: 'postgres', emptyPolicies: true, emptyReceipts: true,
  reconcilerPresent: true, deleteFencePresent: true, pgtapPresent: true });
function copy(t) {
  const target = mkdtempSync(join(tmpdir(), 'free-profile-')); t.after(() => rmSync(target, { recursive: true, force: true }));
  for (const path of [SOURCE_PATH, PLATFORM_PATH, ...Object.keys(inputs().manifest.files)]) {
    mkdirSync(dirname(join(target, path)), { recursive: true }); cpSync(join(root, path), join(target, path));
  }
  return target;
}

test('full139 closed manifest binds every migration, baseline126, atomicity132, actual ten-RPC and18-race source', () => {
  const value = inputs(); assert.equal(value.manifest.migrations.length, 139);
  assert.equal(value.manifest.files[value.manifest.migrations[132]], 'e2e940492e2c9bb3220cd31471a43fb8711db532311f225c794c245aced671ea');
  assert.deepEqual(value.manifest.migrations.slice(133), ['supabase/migrations/20261003150000_ovd536_restrict_audit_event_writer.sql',
    'supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql',
    'supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql',
    'supabase/migrations/20261004100000_ovd598_serialize_legacy_xometry_admission.sql',
    'supabase/migrations/20261004110000_reject_empty_job_file_uploads.sql',
    'supabase/migrations/20261004120000_ovd628_trusted_hash_lock_order.sql']);
  assert.equal(value.manifest.files[value.manifest.migrations[133]], 'a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5');
  assert.equal(value.manifest.files[value.manifest.migrations[134]], REVIEWED_APPENDED_MIGRATIONS[1].sha256);
  assert.equal(value.manifest.files[value.manifest.migrations[135]], REVIEWED_APPENDED_MIGRATIONS[2].sha256);
  assert.equal(value.manifest.files[value.manifest.migrations[136]], REVIEWED_APPENDED_MIGRATIONS[3].sha256);
  assert.equal(value.manifest.files[value.manifest.migrations[137]], REVIEWED_APPENDED_MIGRATIONS[4].sha256);
  assert.equal(value.manifest.files[value.manifest.migrations[138]], REVIEWED_APPENDED_MIGRATIONS[5].sha256);
  assert.equal(value.manifest.baselineSuites.length, 4); assert.equal(value.manifest.candidateSuites.length, 4);
  assert.equal(value.manifest.tapSuites.length, 3); assert.equal(value.manifest.races.length, 18);
});
for (const [name, change] of [
  ['changed SQL', cwd => writeFileSync(join(cwd, inputs().manifest.migrations[5]), '-- drift')],
  ['extra migration', cwd => writeFileSync(join(cwd, 'supabase/migrations/20271003010000_extra.sql'), 'select 1;')],
  ['wrong atomicity ordinal', cwd => { const path = join(cwd, SOURCE_PATH), m = JSON.parse(readFileSync(path)); m.migrationProbes[0].afterMigration = 130; writeFileSync(path, JSON.stringify(m)); }],
  ['changed platform manifest', cwd => writeFileSync(join(cwd, PLATFORM_PATH), '{}')],
  ['changed reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[0].path), '-- drift')],
  ['changed second reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[1].path), '-- drift')],
  ['changed third reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[2].path), '-- drift')],
  ['changed fourth reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[3].path), '-- drift')],
  ['changed fifth reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[4].path), '-- drift')],
  ['changed sixth reviewed append bytes', cwd => writeFileSync(join(cwd, REVIEWED_APPENDED_MIGRATIONS[5].path), '-- drift')],
  ['rehashed unreviewed append', cwd => { const path = join(cwd, SOURCE_PATH), m = JSON.parse(readFileSync(path)), target = REVIEWED_APPENDED_MIGRATIONS[0].path;
    writeFileSync(join(cwd, target), '-- unreviewed'); m.files[target] = hash('-- unreviewed'); m.reviewedAppendedMigrations[0].sha256 = m.files[target]; writeFileSync(path, JSON.stringify(m)); }],
  ['removed reviewed append', cwd => { const path = join(cwd, SOURCE_PATH), m = JSON.parse(readFileSync(path)), target = REVIEWED_APPENDED_MIGRATIONS[0].path;
    rmSync(join(cwd, target)); m.migrations = m.migrations.filter(entry => entry !== target); delete m.files[target]; m.reviewedAppendedMigrations = m.reviewedAppendedMigrations.slice(1); m.migrationCount = 138; writeFileSync(path, JSON.stringify(m)); }],
]) test(`admission rejects ${name} before execution`, t => { const cwd = copy(t); change(cwd); assert.throws(() => loadFreeQuoteInputs(cwd)); });

test('native platform identity, empty state and exact owners fail closed', () => {
  admitPlatformPreflight(preflight()); admitPlatformPostcheck(postcheck());
  for (const key of Object.keys(preflight())) assert.throws(() => admitPlatformPreflight({ ...preflight(), [key]: 'wrong' }));
  for (const key of Object.keys(postcheck())) assert.throws(() => admitPlatformPostcheck({ ...postcheck(), [key]: 'wrong' }));
});
test('bootstrap transforms only the established auth namespace and single-tenant storage session settings', () => {
  assert.match(platformSql('auth', '{{ index .Options "Namespace" }}.users'), /auth\.users/);
  assert.throws(() => platformSql('auth', '{{ unreviewed }}'));
  assert.match(platformSql('storage', 'select 1;'), /storage\.install_roles='false'/);
  assert.match(platformSql('storage', 'select 1;'), /storage\.iceberg_shards='\{\}'/);
  assert(!/alter role|password|pg_hba|dblink/i.test(platformSql('storage', 'select 1;')));
});

function simulation(fault) {
  const value = inputs(), calls = [], receipts = [];
  // The test substitutes inert platform text ONLY in this in-memory unit input.
  // This avoids claiming that any official SQL or Docker resource was executed.
  const sources = { auth: {}, storage: {} };
  for (const kind of ['auth', 'storage']) {
    value.platform[kind] = [{ name: 'inert-unit-input.sql', sha256: hash('-- inert simulated platform') }];
    sources[kind]['inert-unit-input.sql'] = '-- inert simulated platform';
  }
  const psql = async (sql, label, role = 'postgres') => {
    calls.push({ sql, label, role }); if (fault) fault({ sql, label, role });
    const object = sql === PLATFORM_PREFLIGHT ? preflight() : sql === PLATFORM_POSTCHECK ? postcheck() : sql === QUALIFICATION_PRECHECK ? precheck() : null;
    return { stdout: object ? JSON.stringify(object) : 'ok 1 - simulated protocol only\n1..1\n' };
  };
  const runRaces = async options => { calls.push({ label: 'races', options }); Object.assign(options.evidence, { status: 'completed',
    races: options.manifest.races.map(race => ({ name: race.name, status: 'passed' })),
    backendCleanup: 'all-non-observer-backends-observed-absent' }); }; // Inert unit protocol simulation only.
  return { calls, receipts, run: () => qualifyFreeQuote({ root, out: '/inert', container: 'ovd591-inert', source: 'a'.repeat(40),
    inputs: value, platformSources: sources, psql, evidence: { save: (_name, result) => receipts.push(JSON.parse(JSON.stringify(result))) } }, { runRaces }) };
}

test('stage simulation preserves exact SQL bytes, baseline before127, atomicity before133, same DB and explicit incompatible verdict', async () => {
  const s = simulation(), result = await s.run();
  const labels = s.calls.map(call => call.label);
  assert(labels.indexOf('qualification-extension') < labels.indexOf('full-migration-1'));
  assert(labels.indexOf('baseline126-catalog.sql') > labels.indexOf('full-migration-126'));
  assert(labels.indexOf('baseline126-publication_source_baseline.sql') < labels.indexOf('full-migration-127'));
  assert(labels.indexOf('lifecycle-atomicity-lifecycle-atomicity.sql') > labels.indexOf('full-migration-132'));
  assert(labels.indexOf('lifecycle-atomicity-lifecycle-atomicity.sql') < labels.indexOf('full-migration-133'));
  assert(labels.indexOf('candidate-precheck') > labels.indexOf('full-migration-139'));
  assert(labels.indexOf('candidate139-publication_source_candidate.sql') < labels.indexOf('free139-free-quote-job-meter.expanded.sql'));
  assert.equal(labels.at(-1), 'races'); assert.equal(s.calls.at(-1).options.container, 'ovd591-inert');
  assert.equal(result.cases.length, 12); assert.equal(result.migrations.length, 139);
  assert.match(result.workerCompatibility, /^incompatible:/); assert.equal(result.productionReadiness, false);
  for (const [i, path] of inputs().manifest.migrations.entries()) assert.equal(s.calls.find(call => call.label === `full-migration-${i + 1}`).sql, readFileSync(join(root, path), 'utf8'));
});
for (const blocked of ['full-migration-48', 'baseline126-service_role.sql', 'lifecycle-atomicity-lifecycle-atomicity.sql', 'full-migration-139', 'candidate139-old_scope.sql', 'free139-free-quote-terminal-lifecycle.expanded.sql']) {
  test(`${blocked} failure stops later stages and cannot run races`, async () => {
    const s = simulation(({ label }) => { if (label === blocked) throw new Error('simulated failure'); });
    await assert.rejects(s.run(), /simulated failure/); assert(!s.calls.some(call => call.label === 'races'));
    assert.equal(s.receipts.at(-1).status, 'failed');
  });
}
