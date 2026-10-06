/** Closed fresh-full-head SQL profile. No URL, credential, provider or deployment input. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { acceptTap } from './ovd591-sql-qualification.mjs';
import { runFreeQuotePsqlRaces } from './free-quote-psql-races.mjs';

export const SOURCE_PATH = 'scripts/fixtures/free-quote-ci-source.json';
export const PLATFORM_PATH = 'scripts/fixtures/free-quote-platform-manifest.json';
export const PLATFORM_SHA256 = '5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78';
export const FREE_BASELINE = 'fresh-full-head139-v1: authentic auth/storage bootstrap, all139 ordered migrations '
  + '(contract133 plus reviewed OVD-536 audit-writer grant, OVD-458 generic provider permit, OVD-459 provider preflight '
  + 'OVD-598 legacy admission lock, OVD-601 empty job-file upload rejection and OVD-628 generic admission lock appends), '
  + 'baseline126 actual old-worker contracts, atomicity after132/before133, candidate ten-RPC and three free suites,18 independent-session races. '
  + 'Expected archived-worker incompatibilities remain blocking; not a live112 upgrade, PostgREST, provider, deployment or production-readiness verdict.';
export const hash = value => createHash('sha256').update(value).digest('hex');
const WORKER = 'supabase/fixtures/worker-compatibility/';
const FREE = 'supabase/fixtures/free-quote-qualification/';
// Each migration after the 133-file worker source contract is appended only by
// review: its exact path, owning issue and bytes are pinned here and in the manifest.
export const REVIEWED_APPENDED_MIGRATIONS = Object.freeze([
  Object.freeze({ path: 'supabase/migrations/20261003150000_ovd536_restrict_audit_event_writer.sql', issue: 'OVD-536',
    sha256: 'a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5' }),
  Object.freeze({ path: 'supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql', issue: 'OVD-458',
    sha256: 'a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc' }),
  Object.freeze({ path: 'supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql', issue: 'OVD-459',
    sha256: '83e0b5f10dc020c140b686d235b8d8ab11ae830f9016ab346766353ff81d21a7' }),
  Object.freeze({ path: 'supabase/migrations/20261004100000_ovd598_serialize_legacy_xometry_admission.sql', issue: 'OVD-598',
    sha256: '666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd' }),
  Object.freeze({ path: 'supabase/migrations/20261004110000_reject_empty_job_file_uploads.sql', issue: 'OVD-601',
    sha256: '4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277' }),
  Object.freeze({ path: 'supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql', issue: 'OVD-628',
    sha256: '441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5' }),
]);

export function sourceBytes(root, path) {
  assert(typeof path === 'string' && /^(supabase|scripts)\/[A-Za-z0-9_./-]+$/.test(path));
  assert(!path.split('/').some(part => ['.', '..', ''].includes(part)), 'invalid source path');
  const absolute = resolve(root, path);
  assert(absolute.startsWith(realpathSync(root) + sep) && realpathSync(absolute) === absolute, 'symlinked source');
  assert(lstatSync(absolute).isFile(), 'regular source file required');
  return readFileSync(absolute);
}

export function loadFreeQuoteInputs(root) {
  const bytes = sourceBytes(root, SOURCE_PATH), manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 'free-quote-ci-source.v1');
  assert.equal(manifest.migrationCount, 139); assert.equal(manifest.baselineCount, 126);
  assert.equal(manifest.contractMigrationCount, 133);
  assert.deepEqual(manifest.reviewedAppendedMigrations, REVIEWED_APPENDED_MIGRATIONS, 'unreviewed appended migration');
  const current = readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql'))
    .sort().map(name => `supabase/migrations/${name}`);
  assert.equal(current.length, 139, 'closed full139 profile must be reviewed for a new migration');
  assert.deepEqual(manifest.migrations, current, 'full migration tree/order mismatch');
  assert.equal(current[125], 'supabase/migrations/20260928081534_seed_rmfg_disabled_admission.sql');
  assert.equal(current[132], 'supabase/migrations/20261003011148_reconcile_free_quote_job_reservations.sql');
  assert.deepEqual(current.slice(133), REVIEWED_APPENDED_MIGRATIONS.map(entry => entry.path), 'reviewed append order mismatch');
  for (const entry of REVIEWED_APPENDED_MIGRATIONS) assert.equal(manifest.files[entry.path], entry.sha256, `reviewed append bytes differ: ${entry.path}`);
  assert.deepEqual(manifest.baselineSuites, ['catalog', 'service_role', 'old_scope', 'publication_source_baseline'].map(name => WORKER + name + '.sql'));
  assert.deepEqual(manifest.candidateSuites, ['catalog', 'service_role', 'old_scope', 'publication_source_candidate'].map(name => WORKER + name + '.sql'));
  assert.deepEqual(manifest.tapSuites, ['free-quote-job-meter', 'free-confirmed-quote-access', 'free-quote-terminal-lifecycle'].map(name => FREE + name + '.expanded.sql'));
  assert.deepEqual(manifest.migrationProbes, [{ name: 'lifecycle-atomicity', afterMigration: 132, sql: FREE + 'lifecycle-atomicity.sql' }]);
  const referenced = new Set([...current, ...manifest.baselineSuites, ...manifest.candidateSuites, ...manifest.tapSuites,
    manifest.migrationProbes[0].sql, manifest.raceSetupSql, 'supabase/fixtures/free_quote_lifecycle_races/races.json', WORKER + 'source-contract.json']);
  assert.equal(manifest.races.length, 18);
  for (const race of manifest.races) {
    for (const key of ['setupSql', 'acquireSql', 'releaseSql', 'verifySql', ...(race.mode === 'complete-before-release' ? ['lockProbeSql'] : [])]) referenced.add(race[key]);
    for (const path of race.contenders) referenced.add(path);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), [...referenced].sort(), 'unbound or surplus source inputs');
  const sql = {};
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.match(expected, /^[a-f0-9]{64}$/);
    const content = sourceBytes(root, path);
    assert.equal(hash(content), expected, `source bytes differ: ${path}`);
    sql[path] = content.toString('utf8');
    if (path.endsWith('.sql')) assert(!/^\s*\\(?:i|ir|include|include_relative)\s/m.test(sql[path]), 'unexpanded stdin include');
  }
  const races = JSON.parse(sql['supabase/fixtures/free_quote_lifecycle_races/races.json']);
  assert.deepEqual(manifest.races, races.races); assert.equal(manifest.raceSetupSql, races.raceSetupSql);
  const contract = JSON.parse(sql[WORKER + 'source-contract.json']);
  assert.equal(contract.sourceBaselineMigrationCount, 126); assert.equal(contract.sourceCandidateMigrationCount, 133);
  assert.deepEqual(contract.addedMigrations, current.slice(126, manifest.contractMigrationCount).map(path => ({ path, sha256: manifest.files[path] })));
  assert.deepEqual(contract.caller.userSubject, null);
  const platformBytes = sourceBytes(root, PLATFORM_PATH);
  assert.equal(hash(platformBytes), PLATFORM_SHA256);
  const platform = JSON.parse(platformBytes);
  assert.equal(platform.auth.length, 68); assert.equal(platform.storage.length, 56);
  return { manifest, sql, platform, sourceManifestSha256: hash(bytes), platformManifestSha256: hash(platformBytes) };
}

// The pinned image preseeds gotrue's legacy bootstrap (five auth tables owned by
// supabase_auth_admin); the replayed gotrue migrations are IF NOT EXISTS over it,
// exactly as gotrue boots. Admit only that empty baseline, never other auth state.
export const PLATFORM_PREFLIGHT = `select jsonb_build_object(
 'database',current_database(),'sessionUser',session_user,'currentUser',current_user,
 'serverAddress',inet_server_addr(),'clientAddress',inet_client_addr(),
 'isSuperuser',(select rolsuper from pg_roles where rolname=current_user),
 'requiredRolesPresent',(select count(*)=8 from pg_roles where rolname in
 ('postgres','supabase_admin','supabase_auth_admin','supabase_storage_admin','anon','authenticated','service_role','authenticator')),
 'platformSchemasPresent',(select count(*)=2 from pg_namespace where nspname in ('auth','storage')),
 'authLegacyBaseline',(select coalesce(array_agg(c.relname::text||':'||pg_get_userbyid(c.relowner) order by c.relname),'{}')
 =array['audit_log_entries:supabase_auth_admin','instances:supabase_auth_admin','refresh_tokens:supabase_auth_admin',
 'schema_migrations:supabase_auth_admin','users:supabase_auth_admin']
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relkind in ('r','p')),
 'authUsersEmpty',case when to_regclass('auth.users') is null then false
 else (xpath('/row/c/text()',query_to_xml('select count(*) as c from auth.users',false,true,'')))[1]::text='0' end,
 'storageBucketsAbsent',to_regclass('storage.buckets') is null,
 'applicationAbsent',to_regclass('public.organizations') is null);`;
export const PLATFORM_POSTCHECK = `select jsonb_build_object(
 'authUsersPresent',to_regclass('auth.users') is not null,
 'storageBucketsPresent',to_regclass('storage.buckets') is not null,
 'authUsersOwner',(select pg_get_userbyid(relowner) from pg_class where oid=to_regclass('auth.users')),
 'storageBucketsOwner',(select pg_get_userbyid(relowner) from pg_class where oid=to_regclass('storage.buckets')),
 'storagePublicColumn',exists(select 1 from information_schema.columns where table_schema='storage' and table_name='buckets' and column_name='public'),
 'postgresIsAuthenticatorMember',pg_has_role('postgres','authenticator','MEMBER'));`;
export const QUALIFICATION_PRECHECK = `select jsonb_build_object(
 'database',current_database(),'role',current_user,
 'emptyPolicies',not exists(select 1 from private.free_quote_policies),
 'emptyReceipts',not exists(select 1 from private.quote_access_admissions),
 'reconcilerPresent',to_regprocedure('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)') is not null,
 'deleteFencePresent',exists(select 1 from pg_trigger where tgname='fence_reserved_free_quote_job_delete' and tgrelid='public.jobs'::regclass and not tgisinternal),
 'pgtapPresent',exists(select 1 from pg_extension where extname='pgtap'));`;
export function admitPlatformPreflight(value) {
  for (const [key, expected] of Object.entries({ database: 'postgres', sessionUser: 'supabase_admin', currentUser: 'supabase_admin',
    serverAddress: null, clientAddress: null, isSuperuser: true, requiredRolesPresent: true, platformSchemasPresent: true,
    authLegacyBaseline: true, authUsersEmpty: true, storageBucketsAbsent: true, applicationAbsent: true })) assert.equal(value[key], expected, key);
}
export function admitPlatformPostcheck(value) {
  for (const [key, expected] of Object.entries({ authUsersPresent: true, storageBucketsPresent: true,
    authUsersOwner: 'supabase_auth_admin', storageBucketsOwner: 'supabase_storage_admin', storagePublicColumn: true,
    postgresIsAuthenticatorMember: true })) assert.equal(value[key], expected, key);
}
export function platformSql(kind, raw) {
  if (kind === 'auth') {
    const expanded = raw.replaceAll(/\{\{\s*index \.Options "Namespace"\s*\}\}/g, 'auth');
    assert(!expanded.includes('{{'), 'unresolved auth template');
    return `set role supabase_auth_admin;\nset search_path=auth,public,extensions;\n${expanded}`;
  }
  assert.equal(kind, 'storage');
  return `set role supabase_storage_admin;\nset search_path=storage,public,extensions;
set storage.install_roles='false';
set storage.multitenant='false';
set storage.anon_role='anon';
set storage.authenticated_role='authenticated';
set storage.service_role='service_role';
set storage.super_user='postgres';
set storage.iceberg_default_shard='';
set storage.iceberg_shards='{}';
${raw}`;
}

/** The provisioner supplies the sole owned DB and recorded command transport. */
export async function qualifyFreeQuote({ root, out, container, source, inputs, platformSources, psql, evidence, signal },
  { runRaces = runFreeQuotePsqlRaces } = {}) {
  const result = { status: 'running', scope: FREE_BASELINE, source, cases: [], migrations: [], platform: [],
    sourceManifestSha256: inputs.sourceManifestSha256, platformManifestSha256: inputs.platformManifestSha256,
    workerCompatibility: 'not-qualified', productionReadiness: false };
  const save = () => evidence.save('free-quote-result.json', result);
  const tap = async (path, stage) => {
    const output = await psql(inputs.sql[path], `${stage}-${path.split('/').at(-1)}`);
    const assertions = acceptTap(output.stdout);
    result.cases.push({ stage, path, sha256: inputs.manifest.files[path], assertions }); save();
  };
  try {
    result.stage = 'platform-preflight'; save();
    admitPlatformPreflight(JSON.parse((await psql(PLATFORM_PREFLIGHT, 'full-platform-preflight', 'supabase_admin')).stdout));
    for (const kind of ['auth', 'storage']) for (const entry of inputs.platform[kind]) {
      result.stage = `platform-${kind}`; save();
      const raw = platformSources[kind][entry.name];
      assert.equal(hash(raw), entry.sha256, 'extracted platform bytes differ');
      const sql = platformSql(kind, raw);
      await psql(sql, `platform-${kind}-${entry.name}`, 'supabase_admin');
      result.platform.push({ kind, ...entry, submittedSha256: hash(sql) });
    }
    admitPlatformPostcheck(JSON.parse((await psql(PLATFORM_POSTCHECK, 'full-platform-postcheck', 'supabase_admin')).stdout));
    // pgTAP must be available before the baseline126 and atomicity132 probes.
    await psql('create extension if not exists pgtap with schema extensions;', 'qualification-extension');
    for (const [index, path] of inputs.manifest.migrations.entries()) {
      result.stage = `migration-${index + 1}`; save();
      await psql(inputs.sql[path], `full-migration-${index + 1}`);
      result.migrations.push({ ordinal: index + 1, path, sha256: inputs.manifest.files[path] });
      if (index + 1 === inputs.manifest.baselineCount) for (const path of inputs.manifest.baselineSuites) await tap(path, 'baseline126');
      for (const probe of inputs.manifest.migrationProbes.filter(probe => probe.afterMigration === index + 1)) await tap(probe.sql, probe.name);
    }
    result.stage = 'candidate-precheck'; save();
    const precheck = JSON.parse((await psql(QUALIFICATION_PRECHECK, 'candidate-precheck')).stdout);
    assert.equal(precheck.database, 'postgres'); assert.equal(precheck.role, 'postgres');
    for (const key of ['emptyPolicies', 'emptyReceipts', 'reconcilerPresent', 'deleteFencePresent', 'pgtapPresent']) assert.equal(precheck[key], true, key);
    for (const path of inputs.manifest.candidateSuites) await tap(path, 'candidate139');
    // Expected error assertions qualify regression expectations, never old-worker compatibility.
    result.workerCompatibility = 'incompatible: pre-existing no-subject publication and archived scope';
    for (const path of inputs.manifest.tapSuites) await tap(path, 'free139');
    result.stage = 'independent-session-races'; save();
    const raceEvidence = {};
    await runRaces({ root, out, container, manifest: inputs.manifest, signal, evidence: raceEvidence });
    assert.equal(raceEvidence.status, 'completed');
    assert.deepEqual(raceEvidence.races.map(race => race.name), inputs.manifest.races.map(race => race.name));
    assert(raceEvidence.races.every(race => race.status === 'passed'));
    assert.equal(raceEvidence.backendCleanup, 'all-non-observer-backends-observed-absent');
    result.races = raceEvidence.races.map(race => ({ name: race.name, status: race.status, overlaps: race.overlaps,
      contenders: race.contenders, ...(race.probe ? { probe: race.probe } : {}), verification: race.verification }));
    result.status = 'passed'; result.stage = 'complete';
    return result;
  } catch (error) { result.status = 'failed'; result.failure = error.message; throw error; }
  finally { save(); }
}
