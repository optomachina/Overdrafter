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
export const CONTRACT_MIGRATION_COUNT = 133;
export const BASELINE_COUNT = 126;
export const hash = value => createHash('sha256').update(value).digest('hex');
const WORKER = 'supabase/fixtures/worker-compatibility/';
const FREE = 'supabase/fixtures/free-quote-qualification/';
// Each migration after the 133-file worker source contract is appended only by
// review: its exact path, owning issue and bytes are pinned here and in the manifest.
const reviewedMigration = (path, issue, sha256) => Object.freeze({ path, issue, sha256 });
export const REVIEWED_APPENDED_MIGRATIONS = Object.freeze([
  reviewedMigration('supabase/migrations/20261003150000_ovd536_restrict_audit_event_writer.sql', 'OVD-536', 'a625b16028242489c5e86e723815f1ee2d7e49f9c8d885d4cf6de12c1308bfa5'),
  reviewedMigration('supabase/migrations/20261003160000_ovd458_generic_provider_dispatch_permits.sql', 'OVD-458', 'a991e6560d784c9f27516e1cba554ffcf1df440891d4ab22e523827752f472fc'),
  reviewedMigration('supabase/migrations/20261003170000_ovd459_provider_dispatch_preflight.sql', 'OVD-459', '7e6d7ce55d2badd3bedc745ab5fe6adb51413160965d49db15ddf3e6fe1bcb10'),
  reviewedMigration('supabase/migrations/20261004100000_ovd598_serialize_legacy_xometry_admission.sql', 'OVD-598', '666863ee3aada933945fcb14caa6821e711c5d16651d1781f66f6d0415dcbebd'),
  reviewedMigration('supabase/migrations/20261004110000_reject_empty_job_file_uploads.sql', 'OVD-601', '4029cba9743f4b80cba4f058345636e1d8f41264a26cad9efc49f89b38384277'),
  reviewedMigration('supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql', 'OVD-628', '441494e77b7e09d9e931ed2f458dfff719ece8fc45fb2cc3a886466b93374da5'),
  reviewedMigration('supabase/migrations/20261008055500_ovd641_allow_owner_approved_permission_basis.sql', 'OVD-641', 'd8076199f865a4ddf1eac5ac8c8c3c68479de1d14cfcb4e364f0fd24719d4fe6'),
  reviewedMigration('supabase/migrations/20261010100000_ovd631_fix_archived_job_delete_canonical_blob_constraint.sql', 'OVD-631', '4d4e7874ecf1e66b81f1f6932e5f1ca4169431629e5aeace65d2ffd85ffeab41'),
  reviewedMigration('supabase/migrations/20261010230000_ovd679_member_sourcing_destination.sql', 'OVD-679', 'dd68e7f139050495d5206de065df89c9eb4da8e623b7b279ab91df3e0c7ed200'),
  reviewedMigration('supabase/migrations/20261011130000_ovd684_backfill_object_finish.sql', 'OVD-684', 'cdd03e721aa424055caf90e7ef801a6a51e482ddeabdbf73205e6fb259c40f86'),
  reviewedMigration('supabase/migrations/20261011140000_ovd685_revoke_anon_archived_job_delete.sql', 'OVD-685', 'd9cca91f8fc55e498a01bf3c3d74358460d373be118d06609ba1a63b0867b206'),
  reviewedMigration('supabase/migrations/20261011170000_fix_no_drawing_lifecycle.sql', 'OVD-670', 'd69a7aef3a175f18ca16e789799feb18ce6328ecb110439a8fa59e8a37cfbce9'),
  reviewedMigration('supabase/migrations/20261011180000_ovd673_fictiv_reviewed_dispatch_envelope.sql', 'OVD-673', '57c3eed9cdb23c9b071ab5eab7bf9436333d2fc04933beb1c813fe92276bf44e'),
  reviewedMigration('supabase/migrations/20261011190000_ovd674_quickparts_reviewed_dispatch_envelope.sql', 'OVD-674', '3ed95f8466d75fe41054f202b625bd23476b07c29d38c06f78c35c37bc8abd08'),
  reviewedMigration('supabase/migrations/20261011200000_ovd675_weerg_reviewed_dispatch_envelope.sql', 'OVD-675', '9b61bd0d78ab9f868c3f316a423dd1ef892b947f9e5f15bf3acd093adf71c2b0'),
  reviewedMigration('supabase/migrations/20261012212325_ovd462_provider_session_lease.sql', 'OVD-462', '9a95f7e38063dd56d50101b1d87efd3e6d70e445c70576eaf0fc7e0b026bf360'),
  reviewedMigration('supabase/migrations/20261013043000_ovd723_export_control_upload_block.sql', 'OVD-723', 'ed1a2f17e7471a3b32c3e0927421b74191f5aff5fa72477ae959a8b4e7120118'),
  reviewedMigration('supabase/migrations/20261013043100_ovd722_provider_kill_switch.sql', 'OVD-722', '7acf12f06963220d917e65c2a738dfe4a6092be15aff4fc38ceff41ea7a48c13'),
  reviewedMigration('supabase/migrations/20261014191541_ovd414_xometry_admission_read.sql', 'OVD-414', 'ca051bd5f275517e57ed395fefa568f868276e4227e7e472148a4893762e54c8'),
  reviewedMigration('supabase/migrations/20261015214135_ovd768_admin_list_guards.sql', 'OVD-768', 'a58fd72e4a25ecebbea815d5a13233f27c68ec1c264068491a03da6934d72b58'),
  reviewedMigration('supabase/migrations/20261015221725_ovd771_service_kill_switch.sql', 'OVD-771', 'de2dd5fc7fe2583d79c27b0613a73442999758acedf8aa304743b57c117b6882'),
  reviewedMigration('supabase/migrations/20261016000156_ovd767_admin_write_aal2_guards.sql', 'OVD-767', '0dc63ded2bde449514624e7b4e6d0643eee2abaac9969ae9743c9c938b1d6721'),
  reviewedMigration('supabase/migrations/20261016002932_ovd769_reconcile_job_parts_guard.sql', 'OVD-769', 'c20052fc842f1377be330118d5da2e474eddfef42e1d6cf406839c0b55c73b47'),
  reviewedMigration('supabase/migrations/20261016004826_ovd770_quote_select_editor_guard.sql', 'OVD-770', 'e1ccedb3bc0b5655c2f63533330561377d4a5f5587cae7eea290e23f8e3e127b'),
  reviewedMigration('supabase/migrations/20261016013742_ovd736_revoke_anon_definer_execute.sql', 'OVD-736', 'b4ffdcced815f4ea877c177e9f41cec198530f078f0dec20be540e17cd1b351c'),
  reviewedMigration('supabase/migrations/20261016013832_ovd766e_job_editor_scope.sql', 'OVD-766', '73c33b06c2f7325f380076a7f7b70e724b56d5254bd7d6f93152172254d1b68f'),
  reviewedMigration('supabase/migrations/20261025194414_ovd1097_refresh_job_extraction_status.sql', 'OVD-1097', '68bff7415c8e5a930f99021e587bc44b0515b7cfb9b98477005f0687ea8895ef'),
  reviewedMigration('supabase/migrations/20261029165751_reconcile_claim_fence.sql', 'OVD-1073', '67343518f02276127bbdfd2b9ed52dee35a0b4af72bab53d61de54bf6b8cb7ac'),
  reviewedMigration('supabase/migrations/20261030204050_ovd1018_restrict_project_jobs_writes.sql', 'OVD-1018', '18bea12e4b6719143d46d219a0569e9fced25ebe4cc3df178051c3a67654e4f6'),
  reviewedMigration('supabase/migrations/20261031052436_ovd746_client_rpc_auth_gate.sql', 'OVD-746', 'd4a7adf61ca5bb4fa6001d1617a1e1db8b27637a61366f14e7a8cde736bd6f9f'),
  reviewedMigration('supabase/migrations/20261031184522_worker_wake_throttle.sql', 'OVD-1127', 'e77fd771ba363970069c96178e3e0d74e6ec4ecb69e3211ba1a2857c8ae6799e'),
  reviewedMigration('supabase/migrations/20261101110559_reconcile_claim_fence_followups.sql', 'OVD-1073', 'f12dca6fbe11cd29b7f6c753192f8b92cdc44fc558895ab62ded01cb35ca62aa'),
  reviewedMigration('supabase/migrations/20261101115900_ovd979u2_canonical_requirement_lock_order.sql', 'OVD-979', '572066174ddb087f2c20149759f339be12e6408bc3d44ca4e3eb8dadbb59906f'),
  reviewedMigration('supabase/migrations/20261101120000_ovd979u3_extraction_attempt_identity.sql', 'OVD-979', '7f767f268129cf32872f87491e3f56f1e409ebde0b59ab8e35abaaf6f472a16d'),
  reviewedMigration('supabase/migrations/20261101120100_ovd979u4_attempt_bound_auto_approval.sql', 'OVD-979', '3c46872db181f81badc96e2565c21398541b9fbac492a34a97ac54adba764652'),
  reviewedMigration('supabase/migrations/20261101120200_ovd979u5_drawing_extraction_dedupe.sql', 'OVD-979', '2c28901ddfa9ff89253cd4fd056a2b7d85ad20116cb7e35fed25e58d28a2d643'),
]);

export function reviewedMigrationCount(reviewed = REVIEWED_APPENDED_MIGRATIONS) {
  return CONTRACT_MIGRATION_COUNT + reviewed.length;
}

export function describeFreeQuoteBaseline(reviewed = REVIEWED_APPENDED_MIGRATIONS) {
  const count = reviewedMigrationCount(reviewed);
  return `fresh-full-head${count}-v1: authentic auth/storage bootstrap, all${count} ordered migrations `
    + `(contract${CONTRACT_MIGRATION_COUNT} plus reviewed ${reviewed.map(entry => entry.issue).join(', ')} appends), `
    + `baseline${BASELINE_COUNT} actual old-worker contracts, atomicity after132/before133, candidate ten-RPC and three free suites,18 independent-session races. `
    + 'Expected archived-worker incompatibilities remain blocking; not a live112 upgrade, PostgREST, provider, deployment or production-readiness verdict.';
}

export const FREE_BASELINE = describeFreeQuoteBaseline();

export function listOrderedMigrationPaths(root) {
  return readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql'))
    .sort().map(name => `supabase/migrations/${name}`);
}

export function deriveFreeQuoteMigrationPins(root, reviewed = REVIEWED_APPENDED_MIGRATIONS) {
  const migrations = listOrderedMigrationPaths(root);
  return {
    migrationCount: migrations.length,
    expectedCount: reviewedMigrationCount(reviewed),
    migrations,
    files: Object.fromEntries(migrations.map(path => [path, hash(sourceBytes(root, path))])),
    reviewedAppendedMigrations: reviewed,
  };
}

export function applyDerivedFreeQuoteMigrationPins(manifest, derived) {
  return {
    ...manifest,
    migrationCount: derived.migrationCount,
    migrations: derived.migrations,
    reviewedAppendedMigrations: derived.reviewedAppendedMigrations,
    files: { ...manifest.files, ...derived.files },
  };
}

export function sourceBytes(root, path) {
  assert(typeof path === 'string' && /^(supabase|scripts)\/[A-Za-z0-9_./-]+$/.test(path));
  assert(!path.split('/').some(part => ['.', '..', ''].includes(part)), 'invalid source path');
  const absolute = resolve(root, path);
  assert(absolute.startsWith(realpathSync(root) + sep) && realpathSync(absolute) === absolute, 'symlinked source');
  assert(lstatSync(absolute).isFile(), 'regular source file required');
  return readFileSync(absolute);
}

export function loadFreeQuoteInputs(root, { reviewedAppendedMigrations = REVIEWED_APPENDED_MIGRATIONS } = {}) {
  const bytes = sourceBytes(root, SOURCE_PATH), manifest = JSON.parse(bytes);
  const reviewed = reviewedAppendedMigrations;
  const derived = deriveFreeQuoteMigrationPins(root, reviewed);
  assert.equal(manifest.schema, 'free-quote-ci-source.v1');
  assert.equal(manifest.baselineCount, BASELINE_COUNT);
  assert.equal(manifest.contractMigrationCount, CONTRACT_MIGRATION_COUNT);
  const current = derived.migrations;
  assert.equal(current.length, derived.expectedCount);
  if (reviewed === REVIEWED_APPENDED_MIGRATIONS) {
    assert.deepEqual(manifest.reviewedAppendedMigrations, REVIEWED_APPENDED_MIGRATIONS, 'unreviewed appended migration');
  }
  assert.equal(current[125], 'supabase/migrations/20260928081534_seed_rmfg_disabled_admission.sql');
  assert.equal(current[132], 'supabase/migrations/20261003011148_reconcile_free_quote_job_reservations.sql');
  assert.deepEqual(current.slice(CONTRACT_MIGRATION_COUNT), reviewed.map(entry => entry.path), 'reviewed append order mismatch');
  for (const path of current.slice(0, CONTRACT_MIGRATION_COUNT)) {
    assert.equal(derived.files[path], manifest.files[path], `source bytes differ: ${path}`);
  }
  for (const entry of reviewed) {
    assert.equal(derived.files[entry.path], entry.sha256, `source bytes differ: ${entry.path}`);
  }
  Object.assign(manifest, applyDerivedFreeQuoteMigrationPins(manifest, derived));
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
    for (const path of inputs.manifest.candidateSuites) await tap(path, 'candidate142');
    // Expected error assertions qualify regression expectations, never old-worker compatibility.
    result.workerCompatibility = 'incompatible: pre-existing no-subject publication and archived scope';
    for (const path of inputs.manifest.tapSuites) await tap(path, 'free142');
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
