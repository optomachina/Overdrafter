/** Cached-only synthetic fixture transport. Import/inspection never starts a process.
 * Runtime requires a controller receipt binding all tools, SQL and source identities.
 * Platform bootstrap algorithms derive from free-quote-ci-profile.mjs at bbd78c0.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const OWNER = 'ovd658-synthetic';
const LIMITS = Object.freeze({ containers: 2, networks: 1, cpus: 2, memory: 3221225472, pids: 256,
  commandMs: 60000, runnerMs: 1800000, cleanupMs: 60000, terminationGraceMs: 2000, outputBytes: 8000000 });
const TMPFS = Object.freeze({ '/var/lib/postgresql/data': 'rw,nosuid,size=1536m', '/tmp': 'rw,nosuid,size=256m' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sorted = values => [...values].sort((a, b) => { if (a < b) return -1; if (a > b) return 1; return 0; });
// Same object-key canonicalization as the independent plan producer; arrays keep order.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + sorted(Object.keys(value)).map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
const check = (condition, code) => { if (!condition) throw new Error(code); };
function exact(value, keys) { check(value && Object.getPrototypeOf(value) === Object.prototype && sorted(Object.keys(value)).join('|') === sorted(keys).join('|'), 'unexpected_input_fields'); }
function regular(file, max = 128 * 1024 ** 2) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file && realpathSync(file) === file, 'unsafe_file_path');
  const stat = lstatSync(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max, 'unsafe_regular_file');
  return readFileSync(file);
}
function privateDirectory(directory) {
  check(path.isAbsolute(directory) && path.resolve(directory) === directory && realpathSync(directory) === directory, 'unsafe_directory');
  const s = lstatSync(directory); check(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'unowned_directory');
  return { dev: s.dev, ino: s.ino };
}
function sourcePath(p) {
  check(typeof p === 'string' && /^(supabase|scripts)\/[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').some(v => ['', '.', '..'].includes(v)), 'unsafe_source_path');
}
function copiedSources(entries, files) {
  check(files instanceof Map && Array.isArray(entries), 'invalid_source_map');
  const result = new Map();
  for (const entry of entries) {
    sourcePath(entry.path); check(!result.has(entry.path) && SHA.test(entry.sha256), 'duplicate_or_invalid_source');
    const bytes = files.get(entry.path); check(Buffer.isBuffer(bytes) && bytes.length <= 8_000_000 && digest(bytes) === entry.sha256, 'source_hash_mismatch');
    result.set(entry.path, Buffer.from(bytes));
  }
  return result;
}
function admitted(options) {
  exact(options, ['plan', 'sourceFiles', 'platform', 'tools', 'image', 'session', 'catalog', 'parentDirectory', 'admission', ...(Object.hasOwn(options, 'races') ? ['races'] : [])]);
  const { plan, admission: a, tools, image, platform, session, catalog } = options;
  const planContents = { ...plan }; delete planContents.planSha256;
  check(digest(Buffer.from(canonicalJson(planContents))) === plan.planSha256, 'plan_content_hash_mismatch');
  check(plan?.qualification === 'synthetic-only' && /^[a-f0-9]{40}$/.test(plan.sourceCommit) && SHA.test(plan.planSha256), 'invalid_plan');
  exact(a, ['schema', 'qualification', 'sourceCommit', 'planSha256', 'platformManifestSha256', 'dockerSha256', 'cliSha256', 'imageId', 'imageDigest', 'sessionSha256', 'catalogSha256', 'expiresAt']);
  check(a.schema === 'overdrafter.release-rehearsal-admission.v1' && a.qualification === 'synthetic-only' && a.sourceCommit === plan.sourceCommit && a.planSha256 === plan.planSha256, 'admission_identity_mismatch');
  check(Number.isFinite(Date.parse(a.expiresAt)) && Date.parse(a.expiresAt) > Date.now(), 'admission_expired');
  exact(tools, ['docker', 'cli', 'socket']); exact(tools.docker, ['path', 'sha256']); exact(tools.cli, ['path', 'sha256', 'version']);
  check(tools.cli.version === '2.78.1' && a.dockerSha256 === tools.docker.sha256 && a.cliSha256 === tools.cli.sha256, 'tool_identity_mismatch');
  check(digest(regular(tools.docker.path)) === a.dockerSha256 && digest(regular(tools.cli.path)) === a.cliSha256, 'tool_bytes_mismatch');
  check(path.isAbsolute(tools.socket) && realpathSync(tools.socket) === tools.socket && lstatSync(tools.socket).isSocket(), 'local_docker_socket_required');
  exact(image, ['id', 'digest', 'entrypoint', 'cmd']); check(IMAGE.test(image.id) && image.id === a.imageId && typeof image.digest === 'string' && /@sha256:[a-f0-9]{64}$/.test(image.digest) && image.digest === a.imageDigest, 'image_identity_mismatch');
  check(Array.isArray(image.entrypoint) && image.entrypoint.every(v => typeof v === 'string') && Array.isArray(image.cmd) && image.cmd.every(v => typeof v === 'string'), 'invalid_image_command');
  exact(platform, ['manifestBytes', 'files', 'profileBytes']); check(Buffer.isBuffer(platform.manifestBytes) && digest(platform.manifestBytes) === a.platformManifestSha256, 'platform_manifest_mismatch');
  const manifest = JSON.parse(platform.manifestBytes); exact(manifest, ['auth', 'storage']);
  check(platform.files instanceof Map, 'authentic_platform_sources_required');
  const platformFiles = new Map();
  for (const kind of ['auth', 'storage']) {
    check(Array.isArray(manifest[kind]) && manifest[kind].length > 0, 'platform_source_set_empty');
    for (const entry of manifest[kind]) {
      exact(entry, ['name', 'sha256']); check(/^[A-Za-z0-9_.-]+\.sql$/.test(entry.name) && SHA.test(entry.sha256), 'platform_name_invalid');
      const key = kind + '/' + entry.name, bytes = platform.files.get(key);
      check(!platformFiles.has(key) && Buffer.isBuffer(bytes) && bytes.length <= 8_000_000 && digest(bytes) === entry.sha256, 'platform_source_mismatch');
      platformFiles.set(key, Buffer.from(bytes));
    }
  }
  check(platform.files.size === platformFiles.size, 'extra_platform_sources');
  exact(session, ['schema', 'role', 'expected']); check(session.schema === 'overdrafter.synthetic-postgres-session.v1' && session.role === 'postgres' && digest(Buffer.from(json(session))) === a.sessionSha256, 'session_contract_mismatch');
  check(session.expected?.sessionUser === 'postgres' && session.expected?.currentUser === 'postgres' && session.expected?.isSuperuser === false && typeof session.expected?.createRole === 'boolean' && Array.isArray(session.expected?.memberships), 'invalid_synthetic_session');
  exact(catalog, ['bytes', 'sha256']); check(Buffer.isBuffer(catalog.bytes) && catalog.bytes.length <= 8_000_000 && catalog.sha256 === a.catalogSha256 && digest(catalog.bytes) === a.catalogSha256, 'catalog_query_mismatch');
  privateDirectory(options.parentDirectory);
  let races = null;
  if (options.races) {
    exact(options.races, ['profileManifestBytes', 'helperFiles']);
    check(Buffer.isBuffer(options.races.profileManifestBytes) && options.races.helperFiles instanceof Map, 'race_prerequisites_invalid');
    races = { profileManifestBytes: Buffer.from(options.races.profileManifestBytes), helperFiles: new Map([...options.races.helperFiles].map(([key, value]) => { check(Buffer.isBuffer(value) && value.length <= 8_000_000, 'race_helper_bytes_invalid'); return [key, Buffer.from(value)]; })) };
  }
  const socketStat = lstatSync(tools.socket);
  const files = copiedSources(plan.inputs, options.sourceFiles);
  check(Array.isArray(plan.canonical) && plan.canonical.length > 0, 'missing_canonical_files');
  for (const e of plan.canonical) { check(files.has(e.path) && digest(files.get(e.path)) === e.sha256 && /^\d{14}$/.test(e.version) && path.basename(e.path).startsWith(e.version + '_'), 'canonical_identity_mismatch'); }
  return { ...options, plan: structuredClone(plan), admission: structuredClone(a), image: structuredClone(image), session: structuredClone(session),
    races, tools: structuredClone(tools), socketIdentity: { dev: socketStat.dev, ino: socketStat.ino }, sourceFiles: files, manifest, platformFiles, catalog: Buffer.from(catalog.bytes) };
}

/** Pure filesystem/content preflight, no Docker/tool invocation or directory creation. */
const RACE_HELPER_PINS = Object.freeze({
  "scripts/free-quote-psql-races.mjs": "61d8bc30649e71d2159a265401b4aeb7917a0ebb74c747d6e4c6f32cb2071ef4",
  "scripts/ovd591-psql-concurrency.mjs": "8437eaec9bb2158cd1049b34cec2eeb5f6ba77d54838c15f0ff4587f23d45e28",
  "scripts/ovd591-sql-qualification.mjs": "38c0369381bf153506bef9d4be76d0260566da0a42f722120fa451ae72809945",
  "scripts/ovd591-libpq-environment.mjs": "c03bb3b721aca0c68bd1af9f20fae20eb5233cc8caa45728d56ceb089bf25005",
  "scripts/ovd591-qualification-paths.mjs": "ef453ac2cd4ca672f5c293a8502d1262e1c1ff1d670d32eb36ad697054638412"
});
function productionPins(o) {
  check(process.platform === 'linux' && process.arch === 'x64', 'linux_amd64_host_required');
  check(o.plan.sourceCommit === 'bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b', 'candidate_not_admitted');
  check(o.admission.platformManifestSha256 === '5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78', 'platform_pin_mismatch');
  check(Buffer.isBuffer(o.platform.profileBytes) && digest(o.platform.profileBytes) === '3e91b9e2dc4ff47c0531a0a3c54b5f8e41cb6b5458f08b68824fc8f5565c89c6', 'profile_pin_mismatch');
  check(o.races && digest(o.races.profileManifestBytes) === '58404b1a4747e141df1a18e4615b5e52027815d3bc1a5e288e61eef2bb440713' && o.races.helperFiles.size === 5, 'pinned_race_helper_bundle_required');
  for (const [key, expected] of Object.entries(RACE_HELPER_PINS)) check(o.races.helperFiles.has(key) && digest(o.races.helperFiles.get(key)) === expected, 'race_helper_pin_mismatch');
  check(o.plan.canonical.length === 139 && o.plan.inputs.length === 174 && o.manifest.auth.length === 68 && o.manifest.storage.length === 56, 'closed_profile_count_mismatch');
}
export function inspectPrerequisites(options) {
  try { const o = admitted(options); productionPins(o); return { status: 'ready-for-runtime-preflight', qualification: 'synthetic-only', sourceCommit: o.plan.sourceCommit,
    planSha256: o.plan.planSha256, limits: LIMITS, runtimeVerified: false, commandsRun: 0 }; }
  catch (error) { return { status: 'blocked', qualification: 'synthetic-only', reason: error.message, runtimeVerified: false, commandsRun: 0 }; }
}

// Bootstrap must run in the already trusted adapter, before importing diagnostic JS.
// These fixed artifact digests are source-owned and cross-checked by valid-route tests.
function admitDiagnosticImport(a, rehearsalAdmission) {
  exact(a, ['schema', 'qualification', 'purpose', 'parentSourceCommit', 'rehearsalAdmissionSha256', 'files', 'hashes', 'limits', 'expiresAt']);
  check(a.schema === 'overdrafter.cli-session-diagnostic-admission.v1' && a.qualification === 'synthetic-only' && a.purpose === 'direct-cli-session-only', 'diagnostic_admission_identity');
  check(a.parentSourceCommit === '2ba2839186dbadc6301d7ad84fd267d40f2cfb4c', 'diagnostic_parent_identity');
  check(a.rehearsalAdmissionSha256 === digest(json(rehearsalAdmission)), 'diagnostic_rehearsal_binding');
  check(Number.isFinite(Date.parse(a.expiresAt)) && Date.parse(a.expiresAt) > Date.now(), 'diagnostic_admission_expired');
  assert.deepEqual(a.limits, LIMITS, 'diagnostic resource caps drift');
  const names = ['adapter.mjs', 'catalog.sql', 'cli-session.mjs', 'cli-session.sql', 'core.mjs', 'races.mjs', 'run.mjs'];
  const files = names.map(name => ({ path: name, sha256: digest(regular(fileURLToPath(new URL(name, import.meta.url)))) }));
  assert.deepEqual(a.files, files, 'diagnostic source closure drift');
  const hashes = {
    sql: 'd92fd2cc30c7f56581957a12cf8937aa2f3c000d243744cef5ab62e1e711780e',
    config: '20375502fd9a428522f83c5564de58053b58be0cb95ea657ac36aa4adefff4bb',
    emptyQuery: '9ab49c3a14e235e25927c1218996802d847a79ad14a037191d5c6ba3c3837563',
    readQuery: '138b5fba63ed2f373371a1b8e14a5696d651d0ac419e5395e9d9c87e2d3a578c',
    ledgerQuery: '64588627d55e781342b81bce78e927d05aca9725cc8ae676f5626171f25fb817',
    backendsQuery: '33f838e767622b6d7c18a577e4f6c82b2f94dc9ce42eddd18943e0eefd732264'
  };
  assert.deepEqual(a.hashes, hashes, 'diagnostic artifact drift');
  check(digest(regular(fileURLToPath(new URL('./cli-session.sql', import.meta.url)))) === hashes.sql, 'diagnostic_sql_drift');
}

/** Only internally constructed argv enters this bounded, non-shell executor. */
export function executeOwnedCommand(binary, args, { cwd, env, input, timeoutMs, signal, maxBytes = LIMITS.outputBytes }) {
  return new Promise(resolve => {
    const started = performance.now(); let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure = null, done = false;
    if (signal?.aborted) return resolve({ status: null, signal: null, failure: 'aborted', stdout: '', stderr: '', elapsedMs: 0 });
    const child = spawn(binary, args, { cwd, env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let killTimer;
    const finish = (status, childSignal) => { if (done) return;
      if (childSignal != null) failure ??= 'signalled_termination';
      else if (status === null) failure ??= 'exit_unconfirmed';
      try { new TextDecoder('utf-8', { fatal: true }).decode(stdout); new TextDecoder('utf-8', { fatal: true }).decode(stderr); } catch { failure ??= 'invalid_utf8'; }
      done = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      resolve({ status, signal: childSignal, failure, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), elapsedMs: Math.round(performance.now() - started) }); };
    const stop = reason => { if (failure) return; failure = reason; try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* close still required */ }
      killTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, 'unconfirmed'); }, LIMITS.terminationGraceMs); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs); const abort = () => stop('aborted'); signal?.addEventListener('abort', abort, { once: true });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
      const prior = stream === 'stdout' ? stdout : stderr; const next = Buffer.concat([prior, bytes.subarray(0, Math.max(0, maxBytes - prior.length))]);
      if (stream === 'stdout') stdout = next; else stderr = next;
      if (prior.length + bytes.length > maxBytes) stop('output_limit');
    });
    child.on('error', () => { failure = 'spawn_error'; finish(null, null); }); child.on('close', finish);
    child.stdin.on('error', () => { /* close/exit decides command failure */ }); child.stdin.end(input);
  });
}

// Verbatim platform checks/role expansion from the pinned release profile.
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


export const QUALIFICATION_PRECHECK = `select jsonb_build_object(
 'database',current_database(),'role',current_user,
 'emptyPolicies',not exists(select 1 from private.free_quote_policies),
 'emptyReceipts',not exists(select 1 from private.quote_access_admissions),
 'reconcilerPresent',to_regprocedure('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)') is not null,
 'deleteFencePresent',exists(select 1 from pg_trigger where tgname='fence_reserved_free_quote_job_delete' and tgrelid='public.jobs'::regclass and not tgisinternal),
 'pgtapPresent',exists(select 1 from pg_extension where extname='pgtap'));`;

const SESSION_SQL = `select jsonb_build_object('sessionUser',session_user,'currentUser',current_user,
 'isSuperuser',(select rolsuper from pg_roles where rolname=current_user),
 'createRole',(select rolcreaterole from pg_roles where rolname=current_user),
 'memberships',(select coalesce(jsonb_agg(r.rolname order by r.rolname),'[]') from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=current_user)));`;
const LEDGER_SQL = `select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statements',statements) order by version),'[]') from supabase_migrations.schema_migrations;`;
const PGOPTIONS = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';

export function executionQualification(dependencies = {}) {
  return Object.keys(dependencies).length > 0 ? 'fake-transport-only' : 'synthetic-only';
}

export function createCachedFixtureAdapter(options, dependencies = {}) {
  exact(dependencies, Object.keys(dependencies));
  check(Object.keys(dependencies).every(key => ['execute', 'validatePins', 'runRaces', 'now'].includes(key)), 'unknown_dependency');
  const execute = dependencies.execute ?? executeOwnedCommand;
  check(!Object.hasOwn(dependencies, 'now') || (typeof dependencies.now === 'function' && typeof dependencies.execute === 'function' && execute !== executeOwnedCommand), 'clock_override_requires_fake_transport');
  const clock = dependencies.now ?? (() => performance.now());
  let previousTime = -Infinity;
  const now = () => { const value = clock(); check(Number.isFinite(value) && value >= previousTime, 'invalid_monotonic_clock'); previousTime = value; return value; };
  check(!dependencies.runRaces || (typeof dependencies.runRaces === 'function' && typeof dependencies.execute === 'function' && execute !== executeOwnedCommand), 'race_override_requires_fake_transport');
  // The only synthetic override is an in-memory function paired with an injected
  // process transport. Neither is expressible through execution/config JSON.
  check(!dependencies.validatePins || (typeof dependencies.validatePins === 'function' && typeof dependencies.execute === 'function' && execute !== executeOwnedCommand), 'pin_override_requires_fake_transport');
  const o = admitted(options); (dependencies.validatePins ?? productionPins)(o);
  const simulation = executionQualification(dependencies) === 'fake-transport-only';
  const controller = new AbortController();
  let root, rootIdentity, network, networkAttempted = false, before, totalDeadline, workDeadline, cleanupDeadline, cleanupStatus = 'not_started', cleanupOutcome, cleaned = false, busy = false, sequence = 0;
  const token = randomBytes(16).toString('hex'), name = 'ovd658-' + token;
  let diagnosticClaimed = false;
  const targets = new Map(), handles = new WeakMap(), receipts = [], secrets = [];
  const labels = { 'ovd658.owner': OWNER, 'ovd658.source': o.plan.sourceCommit, 'ovd658.fixture': token };
  const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[fixture-secret]'), String(text));
  const labelArgs = () => Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const persist = () => { if (root) writeFileSync(path.join(root, 'state.json'), json({ schema: 'ovd658-owned-state.v1', token, network, networkAttempted,
    deadlines: { totalDeadline, workDeadline, cleanupDeadline, terminationGraceMs: LIMITS.terminationGraceMs }, cleanupStatus, cleanupOutcome,
    containers: [...targets.values()].map(t => ({ name: t.name, id: t.id, attempted: t.attempted, stopped: t.stopped, frozen: t.frozen })), receipts }), { mode: 0o600 }); };
  function ownRoot() { const current = privateDirectory(root); check(current.dev === rootIdentity.dev && current.ino === rootIdentity.ino, 'owned_root_replaced'); }
  function commandBudget(cleanup) {
    const time = now();
    if (cleanup && cleanupDeadline === undefined) { cleanupDeadline = Math.min(time + LIMITS.cleanupMs, totalDeadline); cleanupStatus = 'running'; persist(); }
    check(cleanup || cleanupDeadline === undefined, 'cleanup_already_started');
    const end = cleanup ? cleanupDeadline : workDeadline;
    const remaining = end - time - LIMITS.terminationGraceMs;
    if (remaining <= 0) {
      if (cleanup) { cleanupStatus = 'unconfirmed_deadline_exhausted'; persist(); }
      throw new Error(cleanup ? 'cleanup_deadline_exhausted_unconfirmed' : 'runner_work_deadline');
    }
    return { end, remaining };
  }
  async function call(args, { input, timeoutMs = LIMITS.commandMs, allowFailure = false, cleanup = false, password } = {}) {
    ownRoot(); check(cleanup || !cleaned, 'adapter_cleaned');
    check(cleanup || !controller.signal.aborted, 'adapter_aborted');
    check(cleanup || Date.parse(o.admission.expiresAt) > Date.now(), 'admission_expired');
    const socketStat = lstatSync(o.tools.socket); check(socketStat.isSocket() && socketStat.dev === o.socketIdentity.dev && socketStat.ino === o.socketIdentity.ino && realpathSync(o.tools.socket) === o.tools.socket, 'docker_socket_changed');
    check(digest(regular(o.tools.docker.path)) === o.admission.dockerSha256, 'docker_binary_changed');
    const env = { HOME: path.join(root, 'home'), DOCKER_CONFIG: path.join(root, 'docker-config'), LANG: 'C', LC_ALL: 'C', ...(password ? { PGPASSWORD: password } : {}) };
    const argv = ['--host', `unix://${o.tools.socket}`, '--config', env.DOCKER_CONFIG, ...args];
    const budget = commandBudget(cleanup);
    const r = await execute(o.tools.docker.path, argv, { cwd: root, env, input, timeoutMs: Math.min(timeoutMs, budget.remaining), signal: cleanup ? undefined : controller.signal, maxBytes: LIMITS.outputBytes });
    check(r && typeof r.stdout === 'string' && typeof r.stderr === 'string' && (r.status === null || Number.isInteger(r.status)), 'invalid_process_receipt');
    check(r.signal == null || (typeof r.signal === 'string' && r.signal.length > 0), 'invalid_process_signal');
    check(Buffer.byteLength(r.stdout) <= LIMITS.outputBytes && Buffer.byteLength(r.stderr) <= LIMITS.outputBytes, 'transport_output_limit');
    const exhausted = now() >= budget.end;
    const receipt = { sequence: ++sequence, qualification: simulation ? 'fake-transport-only' : 'synthetic-only', argv: argv.map(redact), inputSha256: input === undefined ? null : digest(input),
      status: r.status, signal: r.signal ?? null, failure: exhausted ? 'absolute_deadline_exhausted' : r.failure ?? (r.signal != null ? 'signalled_termination' : r.status === null ? 'exit_unconfirmed' : null), stdout: redact(r.stdout), stderr: redact(r.stderr), elapsedMs: r.elapsedMs ?? null };
    if (exhausted && cleanup) cleanupStatus = 'unconfirmed_deadline_exhausted';
    receipts.push(receipt); persist();
    check(!exhausted, cleanup ? 'cleanup_deadline_exhausted_unconfirmed' : 'runner_work_deadline');
    if (!allowFailure) check(receipt.status === 0 && !receipt.failure, 'fixture_command_failed');
    return receipt;
  }
  async function inventory(cleanup = false) {
    const result = {};
    for (const [key, args] of Object.entries({ containers: ['container', 'ls', '-aq', '--no-trunc'], networks: ['network', 'ls', '-q', '--no-trunc'] })) {
      result[key] = (await call(args, { cleanup })).stdout.trim().split(/\r?\n/).filter(Boolean);
      check(result[key].every(value => ID.test(value)), 'invalid_inventory');
    }
    return result;
  }
  function owned(info, target, kind) {
    check(ID.test(info?.Id) && info.Name === (kind === 'container' ? '/' : '') + target.name, 'resource_identity_mismatch');
    check(target.id === null || info.Id === target.id, 'resource_id_changed');
    check(!before[kind === 'container' ? 'containers' : 'networks'].includes(info.Id), 'preexisting_resource');
    for (const [key, value] of Object.entries(labels)) check((kind === 'container' ? info.Config?.Labels : info.Labels)?.[key] === value, 'resource_owner_mismatch');
    if (kind === 'network') { check(info.Internal === true && info.Driver === 'bridge', 'network_isolation_mismatch'); return; }
    check(info.Image === o.image.id && info.Config?.Image === o.image.id, 'container_image_changed');
    assert.deepEqual(info.Config.Entrypoint, o.image.entrypoint); assert.deepEqual(info.Config.Cmd, o.image.cmd);
    const h = info.HostConfig;
    check(h?.NetworkMode === network && h.Privileged === false && (h.CapAdd ?? []).length === 0 && (h.Devices ?? []).length === 0, 'container_privilege_mismatch');
    check(['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode'].every(key => h[key] !== 'host') && Object.keys(h.PortBindings ?? {}).length === 0, 'host_exposure');
    check(h.NanoCpus === LIMITS.cpus * 1e9 && h.Memory === LIMITS.memory && h.PidsLimit === LIMITS.pids && h.RestartPolicy?.Name === 'no', 'container_caps_mismatch');
    assert.deepEqual(h.Tmpfs, TMPFS); assert.deepEqual(h.Dns, ['127.0.0.1']);
    check((h.SecurityOpt ?? []).some(v => ['no-new-privileges', 'no-new-privileges:true'].includes(v)), 'container_security_mismatch');
    const mounts = info.Mounts ?? [];
    check(mounts.every(m => m.Type === 'tmpfs' || (m.Type === 'bind' && m.Source === path.join(root, 'bundle') && m.Destination === '/opt/ovd658' && m.RW === false)), 'unexpected_mount');
    check(mounts.filter(m => m.Type === 'bind').length === 1, 'bundle_mount_missing');
  }
  async function inspectTarget(t, cleanup = false) {
    const response = await call(['inspect', t.id ?? t.name], { cleanup }); const info = JSON.parse(response.stdout)[0]; owned(info, t, 'container'); return info;
  }
  function target(handle) { const t = handles.get(handle); check(t && !t.stopped && t.id, 'unknown_or_stopped_target'); return t; }
  async function exclusive(fn, diagnosticOrCleanup = false) { check(!diagnosticClaimed || diagnosticOrCleanup, 'diagnostic_instance_sealed'); check(!busy, 'concurrent_adapter_operation'); busy = true; try { return await fn(); } finally { busy = false; } }
  async function initialize() {
    if (root) return;
    totalDeadline = now() + LIMITS.runnerMs; workDeadline = totalDeadline - LIMITS.cleanupMs;
    root = mkdtempSync(path.join(o.parentDirectory, name + '-')); chmodSync(root, 0o700); rootIdentity = privateDirectory(root);
    for (const dir of ['home', 'docker-config', 'bundle', 'projects']) mkdirSync(path.join(root, dir), { mode: 0o700 });
    copyFileSync(o.tools.cli.path, path.join(root, 'bundle', 'supabase')); chmodSync(path.join(root, 'bundle', 'supabase'), 0o555);
    check(digest(regular(path.join(root, 'bundle', 'supabase'))) === o.admission.cliSha256, 'cli_copy_mismatch');
    before = await inventory();
    const image = JSON.parse((await call(['image', 'inspect', o.image.id])).stdout)[0];
    check(image?.Id === o.image.id && image.Os === 'linux' && image.Architecture === 'amd64' && image.RepoDigests?.includes(o.image.digest), 'cached_image_identity_mismatch');
    assert.deepEqual(image.Config.Entrypoint, o.image.entrypoint); assert.deepEqual(image.Config.Cmd, o.image.cmd);
    check(Object.keys(image.Config.Volumes ?? {}).length === 0, 'anonymous_image_volume');
    const imagePath = (image.Config.Env ?? []).find(v => v.startsWith('PATH='))?.slice(5);
    check(typeof imagePath === 'string' && imagePath.split(':').every(p => p.startsWith('/') && !p.includes('..')), 'image_path_missing');
    o.imagePath = imagePath;
    const names = (await call(['network', 'ls', '--format', '{{.Name}}'])).stdout.trim().split(/\r?\n/);
    check(!names.includes(name), 'network_name_collision'); networkAttempted = true; persist();
    network = (await call(['network', 'create', '--driver', 'bridge', '--internal', ...labelArgs(), name])).stdout.trim(); check(ID.test(network), 'network_creation_unconfirmed'); persist();
    const n = JSON.parse((await call(['network', 'inspect', network])).stdout)[0]; owned(n, { id: network, name }, 'network'); check(Object.keys(n.Containers ?? {}).length === 0, 'network_not_empty');
  }
  const cleanEnv = t => ['env', '-i', `PATH=${o.imagePath}`, 'HOME=/tmp/ovd658-home', 'XDG_CONFIG_HOME=/tmp/ovd658-home', 'LANG=C', 'LC_ALL=C', 'NO_COLOR=1', 'TERM=dumb',
    'PGPASSFILE=/dev/null/ovd658-disabled', `PGPASSWORD=${t.secret}`, `PGOPTIONS=${PGOPTIONS}`];
  async function psql(t, sql, { role = 'postgres', tcp = false, allowFailure = false } = {}) {
    check(['postgres', 'supabase_admin'].includes(role), 'invalid_fixture_role');
    return call(['exec', '-i', t.id, ...cleanEnv(t), 'psql', '-h', tcp ? '127.0.0.1' : '/var/run/postgresql', '-p', '5432', '-U', role, '-d', 'postgres', '-w', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure });
  }
  async function measuredSession(t) {
    const r = await psql(t, SESSION_SQL, { tcp: true }); const observation = JSON.parse(r.stdout); assert.deepEqual(observation, o.session.expected);
    return { qualification: simulation ? 'fake-transport-only' : 'synthetic-only', measured: { method: 'tcp-psql', observation }, inferred: { method: 'CLI2.78.1 connect.go source + generated postgres loopback URL', login: 'postgres', role: 'postgres' }, directCliSessionObserved: false, receipt: r };
  }
  async function startOwnedTarget(label) {
    check(typeof label === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(label), 'invalid_target_label');
    check([...targets.values()].filter(t => !t.stopped).length < LIMITS.containers && !targets.has(label), 'target_limit_or_duplicate');
    await initialize(); const t = { name: name + '-' + label, id: null, secret: randomBytes(32).toString('hex'), attempted: false, stopped: false, frozen: false, applied: false };
    secrets.push(t.secret); targets.set(label, t);
    const names = (await call(['container', 'ls', '-a', '--format', '{{.Names}}'])).stdout.trim().split(/\r?\n/); check(!names.includes(t.name), 'container_name_collision');
    const envFile = path.join(root, t.name + '.env'); writeFileSync(envFile, `POSTGRES_PASSWORD=${t.secret}\n`, { mode: 0o600, flag: 'wx' });
    t.attempted = true; persist();
    try {
      t.id = (await call(['create', '--pull=never', '--name', t.name, '--network', network, '--dns', '127.0.0.1', ...labelArgs(), '--cpus', '2', '--memory', '3g', '--pids-limit', '256', '--security-opt', 'no-new-privileges',
        ...Object.entries(TMPFS).flatMap(([p, v]) => ['--tmpfs', `${p}:${v}`]), '--mount', `type=bind,src=${path.join(root, 'bundle')},dst=/opt/ovd658,readonly`, '--env-file', envFile, o.image.id])).stdout.trim();
      check(ID.test(t.id), 'container_creation_unconfirmed'); persist(); await inspectTarget(t);
      await call(['start', t.id]); await inspectTarget(t);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const pid = await call(['exec', '--user', 'postgres', t.id, 'cat', '/var/lib/postgresql/data/postmaster.pid'], { timeoutMs: 3000, allowFailure: true });
        const fields = pid.stdout.split(/\r?\n/);
        if (pid.status === 0 && !pid.failure && fields[0] === '1' && fields[1] === '/var/lib/postgresql/data') {
          const r = await call(['exec', t.id, ...cleanEnv(t), 'pg_isready', '-h', '/var/run/postgresql', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q'], { timeoutMs: 3000, allowFailure: true });
          if (r.status === 0 && !r.failure) { ready = true; break; }
        }
      }
      check(ready, 'postmaster_not_ready');
      admitPlatformPreflight(JSON.parse((await psql(t, PLATFORM_PREFLIGHT, { role: 'supabase_admin' })).stdout));
      for (const kind of ['auth', 'storage']) for (const e of o.manifest[kind]) await psql(t, platformSql(kind, o.platformFiles.get(kind + '/' + e.name).toString('utf8')), { role: 'supabase_admin' });
      admitPlatformPostcheck(JSON.parse((await psql(t, PLATFORM_POSTCHECK, { role: 'supabase_admin' })).stdout));
      await call(['exec', t.id, 'mkdir', '-m', '700', '/tmp/ovd658-home']);
      const version = await call(['exec', t.id, ...cleanEnv(t), '/opt/ovd658/supabase', '--version']); check(version.stdout.trim() === '2.78.1', 'cli_version_mismatch');
      const help = await call(['exec', t.id, ...cleanEnv(t), '/opt/ovd658/supabase', 'db', 'push', '--help']);
      for (const flag of ['--db-url', '--include-all', '--dry-run']) check(help.stdout.includes(flag), 'cli_help_mismatch');
      t.session = await measuredSession(t);
      const handle = Object.freeze({ label, id: t.id, qualification: simulation ? 'fake-transport-only' : 'synthetic-only' }); handles.set(handle, t); return { target: handle, session: t.session, receipts: [...receipts] };
    } catch (error) { t.frozen = true; persist(); throw error; }
    finally { ownRoot(); const info = lstatSync(envFile); check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && info.nlink === 1, 'secret_file_replaced'); rmSync(envFile); }
  }
  async function startTarget(label) { return exclusive(() => startOwnedTarget(label)); }
  function cliArguments(t, destination) {
    const connection = `postgresql://postgres:${t.secret}@127.0.0.1:5432/postgres?sslmode=disable`;
    return ['exec', t.id, ...cleanEnv(t), '/opt/ovd658/supabase', 'db', 'push', '--db-url', connection, '--include-all', '--workdir', destination, '--yes'];
  }
  function stageProject(t, files, fault) {
    check(Array.isArray(files) && files.length > 0, 'empty_staged_history');
    const unique = new Set(), entries = new Map(o.plan.canonical.map(e => [e.path, e]));
    const project = path.join(root, 'projects', 'batch-' + String(sequence + 1)); mkdirSync(project, { mode: 0o700 });
    mkdirSync(path.join(project, 'supabase'), { mode: 0o700 }); mkdirSync(path.join(project, 'supabase', 'migrations'), { mode: 0o700 });
    writeFileSync(path.join(project, 'supabase', 'config.toml'), 'project_id = "ovd658-synthetic"\n[db]\nport = 5432\nmajor_version = 17\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n', { mode: 0o600, flag: 'wx' });
    let faultApplied = false;
    for (const entry of files) {
      const canonical = entries.get(entry.path); check(canonical && !unique.has(entry.path) && canonical.version === entry.version && canonical.sha256 === entry.sha256, 'staged_source_identity_mismatch'); unique.add(entry.path);
      let bytes = o.sourceFiles.get(entry.path);
      if (fault && fault.originalSha256 === entry.sha256) {
        check(!faultApplied, 'ambiguous_fault_original'); faultApplied = true;
        check(fault.schema === 'overdrafter.release-rehearsal-fault.v1' && ['committed-prefix', 'in-file', 'commit-to-ledger'].includes(fault.mode), 'invalid_fault_mode');
        const marker = 'OVD_REHEARSAL_FAULT_' + fault.mode.replaceAll('-', '_').toUpperCase();
        const inserted = `\nDO $ovd_rehearsal_fault$ BEGIN RAISE EXCEPTION '${marker}'; END $ovd_rehearsal_fault$;\n`;
        check(fault.marker === marker && fault.insertedSql === inserted && fault.qualification === 'placement-only' && fault.runtimeBoundary === 'not-run', 'fault_delta_not_admitted');
        const anchor = Buffer.from(fault.anchor.text), offset = fault.anchor.offset;
        check(Number.isSafeInteger(offset) && offset >= 0 && bytes.subarray(offset, offset + anchor.length).equals(anchor) && bytes.indexOf(anchor) === offset && bytes.lastIndexOf(anchor) === offset, 'fault_anchor_mismatch');
        if (fault.mode === 'committed-prefix') check(offset === 0 && fault.insertionOffset === 0, 'prefix_fault_position');
        else {
          check(/^\s*COMMIT;\s*$/i.test(fault.anchor.text) && offset + anchor.length === bytes.length, 'terminal_commit_required');
          check(fault.insertionOffset === (fault.mode === 'in-file' ? offset : bytes.length), 'fault_commit_side_mismatch');
        }
        check(!bytes.includes('OVD_REHEARSAL_FAULT_') && !bytes.includes('$ovd_rehearsal_fault$'), 'preexisting_fault_marker');
        const changed = Buffer.concat([bytes.subarray(0, fault.insertionOffset), Buffer.from(inserted), bytes.subarray(fault.insertionOffset)]);
        check(changed.toString('base64') === fault.bytesBase64 && changed.length === fault.byteLength && digest(changed) === fault.faultSha256, 'fault_bytes_mismatch'); bytes = changed;
      }
      writeFileSync(path.join(project, 'supabase', 'migrations', path.basename(entry.path)), bytes, { mode: 0o600, flag: 'wx' });
    }
    check(!fault || faultApplied, 'fault_original_not_staged');
    return project;
  }
  async function apply(handle, { files, expectedPending, cliMode = 'apply', fault = null }) { return exclusive(async () => {
    const t = target(handle); check(!t.frozen, 'failed_target_frozen'); check(['apply', 'dry-run'].includes(cliMode), 'unsupported_cli_mode');
    check(Array.isArray(expectedPending) && expectedPending.every(e => files.some(f => f.path === e.path && f.sha256 === e.sha256 && f.version === e.version)), 'pending_not_staged');
    const expected = expectedPending.map(e => path.basename(e.path)); check(new Set(expected).size === expected.length, 'duplicate_pending');
    await inspectTarget(t); check(digest(regular(path.join(root, 'bundle', 'supabase'))) === o.admission.cliSha256, 'cli_bundle_changed'); const project = stageProject(t, files, fault), destination = '/tmp/ovd658-project-' + String(sequence + 1);
    await call(['cp', project, t.id + ':' + destination]);
    const cli = cliArguments(t, destination);
    const dryRun = await call([...cli, '--dry-run'], { allowFailure: true });
    if (dryRun.status !== 0 || dryRun.failure) { t.frozen = true; persist(); return { status: 'failed', phase: 'dry-run', dryRun, frozen: true }; }
    const output = (dryRun.stdout + '\n' + dryRun.stderr).replace(/\u001b\[[0-9;]*m/g, '');
    const observed = [...output.matchAll(/^\s*•\s+(\d{14}_[A-Za-z0-9_.-]+\.sql)\s*$/gm)].map(m => m[1]);
    try { assert.deepEqual(observed, expected, 'CLI pending order differs from frozen expectation'); }
    catch { t.frozen = true; persist(); throw new Error('cli_pending_order_mismatch'); }
    if (cliMode === 'dry-run') return { status: 'passed', dryRun, expectedPending: expected, frozen: false };
    const execution = await call(cli, { allowFailure: true }); t.applied = true; t.frozen = execution.status !== 0 || Boolean(execution.failure); persist();
    return { status: t.frozen ? 'failed' : 'passed', phase: 'apply', dryRun, execution, frozen: t.frozen,
      fault: fault ? { mode: fault.mode, marker: fault.marker, originalSha256: fault.originalSha256, faultSha256: fault.faultSha256, boundary: 'requires_actual_catalog_and_ledger_observation' } : null };
  }); }
  async function snapshot(handle) { return exclusive(async () => {
    const t = target(handle); await inspectTarget(t);
    const presence = await psql(t, "select jsonb_build_object('present',to_regclass('supabase_migrations.schema_migrations') is not null);");
    const ledgerPresent = JSON.parse(presence.stdout).present; check(typeof ledgerPresent === 'boolean', 'ledger_presence_unreadable');
    const ledgerReceipt = ledgerPresent ? await psql(t, LEDGER_SQL) : null;
    const ledger = ledgerPresent ? JSON.parse(ledgerReceipt.stdout) : []; check(Array.isArray(ledger), 'ledger_not_rows');
    const catalogReceipt = await psql(t, o.catalog); const catalog = JSON.parse(catalogReceipt.stdout);
    const sessionReceipt = await psql(t, SESSION_SQL, { tcp: true }); const measured = JSON.parse(sessionReceipt.stdout);
    return { status: 'observed', qualification: simulation ? 'fake-transport-only' : 'synthetic-only', target: handle, frozen: t.frozen,
      ledgerPresent, ledger, catalog, session: { measured: { method: 'tcp-psql', observation: measured },
        inferred: { method: 'CLI2.78.1 connect.go source + generated postgres loopback URL', login: 'postgres', role: 'postgres' }, directCliSessionObserved: false },
      receipts: { presence, ledger: ledgerReceipt, catalog: catalogReceipt, session: sessionReceipt }, retryAuthorized: false };
  }); }
  async function runChecks(handle, checks) { return exclusive(async () => {
    const t = target(handle); check(Array.isArray(checks) && checks.length <= 64, 'invalid_checks'); await inspectTarget(t);
    const results = []; let raceEvidence;
    const raceRequests = checks.filter(c => c.kind === 'race'); let raceNames;
    if (raceRequests.length) {
      check(raceRequests.length === checks.length, 'mixed_race_batch');
      if (o.races) {
        raceNames = JSON.parse(o.races.profileManifestBytes).races.map(r => r.name);
        check(raceNames.length === 18 && new Set(raceNames).size === 18, 'race_profile_count_mismatch');
        assert.deepEqual(raceRequests.map(r => r.name), raceNames, 'race_request_names_mismatch');
      }
    }
    // Eighteen requested races are one engine run, never eighteen full runs.
    for (const c of raceRequests.length ? [raceRequests[0]] : checks) {
      if (c.kind === 'race') {
        check(!t.frozen, 'failed_target_checks_blocked');
        if (!o.races) { results.push(...raceRequests.map(r => ({ ...r, status: 'blocked', reason: 'pinned_race_helper_bundle_missing', runtime: 'not_run' }))); continue; }
        raceEvidence = { qualification: simulation ? 'fake-transport-only' : 'synthetic-only' };
        try {
          // The imported module admits its fixed helper closure; it must never
          // select JS from arbitrary paths or use the old PATH-Docker wrapper.
          const runRaces = dependencies.runRaces ?? (await import('./races.mjs')).runOwnedRaces;
          const processSpec = Object.freeze({ binary: o.tools.docker.path, sha256: o.admission.dockerSha256, cwd: root,
            args: ['--host', `unix://${o.tools.socket}`, '--config', path.join(root, 'docker-config'), 'exec', '-i', t.id,
              'env', '-i', `PATH=${o.imagePath}`, 'HOME=/tmp/ovd658-home', 'LANG=C', 'LC_ALL=C',
              'PGHOST=/var/run/postgresql', 'PGPORT=5432', 'PGPASSFILE=/dev/null/ovd658-disabled',
              `PGOPTIONS=${PGOPTIONS} -cclient_min_messages=warning`, 'PGAPPNAME=ovd658-race',
              'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
            env: { HOME: path.join(root, 'home'), DOCKER_CONFIG: path.join(root, 'docker-config'), LANG: 'C', LC_ALL: 'C' } });
          const result = await runRaces({ sourceFiles: o.sourceFiles, profileManifestBytes: o.races.profileManifestBytes, helperFiles: o.races.helperFiles,
            processSpec, evidence: raceEvidence, signal: controller.signal, deadlineMs: Math.max(0, Math.min(240000, commandBudget(false).remaining)) });
          check(result.status === 'passed', 'race_engine_failed'); raceEvidence = result.raceEvidence;
          check(Array.isArray(raceEvidence.races) && raceEvidence.races.length === 18 && raceEvidence.races.every(r => r.status === 'passed'), 'race_results_incomplete');
          assert.deepEqual(raceEvidence.races.map(r => r.name), raceNames, 'race_result_names_mismatch');
          raceEvidence.qualification = simulation ? 'fake-transport-only' : 'synthetic-only';
          const finalInventory = await psql(t, "select jsonb_build_object('remaining',coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start,'applicationName',application_name) order by pid),'[]'),'observedAt',clock_timestamp()) from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid();");
          const observed = JSON.parse(finalInventory.stdout); check(Array.isArray(observed.remaining) && observed.remaining.length === 0 && typeof observed.observedAt === 'string', 'race_backends_remain');
          raceEvidence.ownerFinalBackendInventory = { status: 'all-other-client-backends-observed-absent', observation: observed, receipt: finalInventory };
          results.push(...raceEvidence.races.map(r => ({ kind: 'race', name: r.name, status: r.status })));
          await inspectTarget(t);
        } catch { t.frozen = true; results.push({ kind: 'race', status: 'failed', reason: 'race_execution_or_cleanup_unconfirmed' }); }
        ownRoot(); writeFileSync(path.join(root, `race-evidence-${++sequence}.json`), json(raceEvidence), { mode: 0o600, flag: 'wx' });
        if (t.frozen) break;
        continue;
      }
      let sql;
      if (c.kind === 'ensure-pgtap') sql = 'create extension if not exists pgtap with schema extensions;';
      else if (c.kind === 'candidate-precheck') sql = QUALIFICATION_PRECHECK;
      else { check(c.kind === 'sql' && o.sourceFiles.has(c.path) && digest(o.sourceFiles.get(c.path)) === c.sha256 && c.path.endsWith('.sql'), 'check_not_frozen_source'); sql = o.sourceFiles.get(c.path); }
      // After a failed apply only snapshot/cleanup are admitted, never check SQL that
      // might mutate catalog/state or conceal the failure boundary.
      check(!t.frozen, 'failed_target_checks_blocked');
      const receipt = await psql(t, sql, { allowFailure: true }); let status = receipt.status === 0 && !receipt.failure ? 'executed' : 'failed';
      if (status === 'executed' && c.kind === 'candidate-precheck') {
        const value = JSON.parse(receipt.stdout); status = value.database === 'postgres' && value.role === 'postgres' && ['emptyPolicies', 'emptyReceipts', 'reconcilerPresent', 'deleteFencePresent', 'pgtapPresent'].every(k => value[k] === true) ? 'passed' : 'failed';
      }
      results.push({ ...c, status, receipt, acceptance: c.kind === 'sql' ? 'caller_must_validate_complete_unskipped_TAP_or_assertion_output' : status });
      if (status === 'failed') { t.frozen = true; break; }
    }
    persist(); return { status: results.some(r => r.status === 'failed') ? 'failed' : results.some(r => r.status === 'blocked') ? 'blocked' : 'executed', checks: results, raceEvidence, capabilities: { independentSessionRaces: Boolean(o.races) } };
  }); }
  async function removeTarget(t, cleanup = false) {
    if (t.stopped || !t.attempted) return { status: 'not_created_or_already_removed' };
    const ids = (await inventory(cleanup)).containers;
    if (t.id && !ids.includes(t.id)) { t.stopped = true; persist(); return { status: 'observed_absent', id: t.id }; }
    const info = await inspectTarget(t, cleanup); t.id = info.Id; persist();
    await call(['rm', '--force', t.id], { cleanup });
    check(!(await inventory(cleanup)).containers.includes(t.id), 'owned_container_removal_unconfirmed');
    t.stopped = true; persist(); return { status: 'removed_and_observed_absent', id: t.id };
  }
  async function stopTarget(handle) { return exclusive(async () => removeTarget(target(handle))); }
  function cleanupFailure(result) {
    const failure = new Error('fixture_cleanup_failed: ' + result.errors.join('; '));
    failure.cleanupOutcome = structuredClone(result); return failure;
  }
  async function cleanupOwned() {
    if (!root) return { status: 'not_started', containers: [], network: null };
    if (cleaned) return { status: 'already_cleaned', root };
    if (cleanupOutcome?.status === 'failed') throw cleanupFailure(cleanupOutcome);
    const result = { status: 'running', containers: [], network: null, errors: [] };
    // Each independent target gets one attempt. A refusal does not authorize a
    // retry, prevent its healthy sibling's cleanup, or renew the shared budget.
    for (const t of targets.values()) {
      try { result.containers.push({ name: t.name, ...await removeTarget(t, true) }); }
      catch (error) {
        const reason = redact(error.message); result.errors.push(reason);
        result.containers.push({ name: t.name, id: t.id, status: 'failed', reason });
      }
    }
    if (networkAttempted) {
      try {
        const ids = (await inventory(true)).networks;
        if (!network || ids.includes(network)) {
          const info = JSON.parse((await call(['network', 'inspect', network ?? name], { cleanup: true })).stdout)[0];
          owned(info, { id: network ?? null, name }, 'network');
          const attachedIds = Object.keys(info.Containers ?? {});
          if (result.errors.length) result.network = { status: 'retained_targets_unconfirmed', id: info.Id, observedAttachedIds: attachedIds };
          else {
            check(attachedIds.length === 0, 'network_has_attached_resources');
            await call(['network', 'rm', info.Id], { cleanup: true }); check(!(await inventory(true)).networks.includes(info.Id), 'owned_network_removal_unconfirmed');
            result.network = 'removed_or_observed_absent';
          }
        } else result.network = 'removed_or_observed_absent';
      } catch (error) {
        const reason = redact(error.message); result.errors.push(reason);
        result.network = { status: 'unconfirmed', id: network, reason };
      }
    }
    result.root = root;
    if (result.errors.length) {
      result.status = 'failed'; cleanupOutcome = result;
      if (cleanupStatus !== 'unconfirmed_deadline_exhausted') cleanupStatus = 'unconfirmed_target_or_network_failure';
      persist(); throw cleanupFailure(result);
    }
    cleaned = true; cleanupStatus = 'removed_and_observed_absent'; result.status = 'removed_and_observed_absent'; cleanupOutcome = result; persist();
    // Evidence/project directories are retained; no recursive deletion of input or
    // unverified host paths. The readonly CLI bundle contains no real credential.
    return result;
  }
  // One fixed diagnostic on a new adapter. No handle or general SQL capability escapes.
  async function observeCliSession(request) { return exclusive(async () => {
    exact(request, ['diagnosticAdmission']);
    check(!root && targets.size === 0 && !diagnosticClaimed, 'diagnostic_requires_unused_adapter');
    const admission = structuredClone(request.diagnosticAdmission);
    admitDiagnosticImport(admission, o.admission);
    // Ordinary candidate execution retains its existing five-module closure.
    const { admitDiagnostic, diagnosticHash, parseDiagnosticJson, validateCaptureBinding, validateDiagnosticBackends, DIAGNOSTIC_FILE, DIAGNOSTIC_CONFIG, DIAGNOSTIC_EMPTY_SQL, DIAGNOSTIC_READ_SQL, DIAGNOSTIC_LEDGER_SQL, DIAGNOSTIC_BACKENDS_SQL, validateDirectObservation, validateDiagnosticLedger } = await import('./cli-session.mjs');
    const artifacts = admitDiagnostic(admission, o.admission, LIMITS);
    diagnosticClaimed = true;
    const report = { schema: 'overdrafter.cli-session-diagnostic-result.v1', qualification: simulation ? 'fake-transport-only' : 'synthetic-only',
      status: 'running', runtime: simulation ? 'fake-transport-only' : 'attempted', directCliSessionObserved: false,
      admission, rehearsalAdmission: structuredClone(o.admission), sourceHashes: artifacts.hashes,
      target: null, phases: [], directObservation: null, observerObservation: null, ledger: null,
      cleanup: { status: 'not_run' }, limitations: ['single synthetic CLI invocation only', 'no candidate R1/R2 or production qualification'] };
    let t;
    const phase = (name, value) => { report.phases.push({ name, ...value }); };
    try {
      const started = await startOwnedTarget('cli-session-diagnostic'); t = target(started.target);
      report.target = started.target; phase('fresh-target', { status: 'observed', precheck: started.session });
      const empty = await psql(t, DIAGNOSTIC_EMPTY_SQL, { tcp: true });
      assert.deepEqual(parseDiagnosticJson(empty.stdout), { diagnosticAbsent: true, ledgerAbsent: true }, 'diagnostic target is not empty');
      phase('empty-target', { status: 'observed', receipt: empty });
      // Revalidate source/admission after bootstrap, before staging or CLI invocation.
      const current = admitDiagnostic(admission, o.admission, LIMITS); check(current.sql.equals(artifacts.sql), 'diagnostic_sql_changed');
      const project = path.join(root, 'projects', 'cli-session'); mkdirSync(project, { mode: 0o700 });
      mkdirSync(path.join(project, 'supabase'), { mode: 0o700 }); mkdirSync(path.join(project, 'supabase', 'migrations'), { mode: 0o700 });
      writeFileSync(path.join(project, 'supabase', 'config.toml'), DIAGNOSTIC_CONFIG, { mode: 0o600, flag: 'wx' });
      writeFileSync(path.join(project, 'supabase', 'migrations', DIAGNOSTIC_FILE), artifacts.sql, { mode: 0o600, flag: 'wx' });
      await inspectTarget(t); check(digest(regular(path.join(root, 'bundle', 'supabase'))) === o.admission.cliSha256, 'cli_bundle_changed');
      const destination = '/tmp/ovd660-cli-session'; const copied = await call(['cp', project, t.id + ':' + destination]);
      phase('staged', { status: 'observed', filename: DIAGNOSTIC_FILE, sqlSha256: diagnosticHash(artifacts.sql), configSha256: diagnosticHash(DIAGNOSTIC_CONFIG), receipt: copied });
      const cli = cliArguments(t, destination);
      const dryRun = await call([...cli, '--dry-run'], { allowFailure: true });
      phase('dry-run', { status: dryRun.status === 0 && !dryRun.failure ? 'observed' : 'failed', receipt: dryRun });
      check(dryRun.status === 0 && !dryRun.failure, 'diagnostic_dry_run_failed');
      const output = (dryRun.stdout + '\n' + dryRun.stderr).replace(/\u001b\[[0-9;]*m/g, '');
      const pending = [...output.matchAll(/^\s*•\s+(\d{14}_[A-Za-z0-9_.-]+\.sql)\s*$/gm)].map(m => m[1]);
      assert.deepEqual(pending, [DIAGNOSTIC_FILE], 'diagnostic pending source mismatch');
      admitDiagnostic(admission, o.admission, LIMITS);
      const execution = await call(cli, { allowFailure: true }); t.applied = true;
      phase('apply', { status: execution.status === 0 && !execution.failure ? 'observed' : 'failed', receipt: execution });
      check(execution.status === 0 && !execution.failure, 'diagnostic_cli_apply_failed');
      const readback = await psql(t, DIAGNOSTIC_READ_SQL, { tcp: true });
      phase('readback', { status: 'observed', receipt: readback });
      const observed = parseDiagnosticJson(readback.stdout), row = validateDirectObservation(observed, o.session.expected);
      report.directObservation = { qualification: report.qualification, method: 'stored-top-level-cli-insert', row, readbackReceipt: readback };
      report.observerObservation = observed.observer;
      report.captureBinding = { targetId: t.id, applyReceiptSequence: execution.sequence, readbackReceiptSequence: readback.sequence,
        sqlSha256: artifacts.hashes.sql, configSha256: artifacts.hashes.config, diagnosticAdmissionSha256: diagnosticHash(json(admission)),
        rawReadbackSha256: diagnosticHash(readback.stdout), capturedRowSha256: diagnosticHash(json(row)) };
      validateCaptureBinding(report, o.session.expected);
      report.directCliSessionObserved = !simulation;
      const ledgerReceipt = await psql(t, DIAGNOSTIC_LEDGER_SQL, { tcp: true });
      phase('ledger', { status: 'observed', receipt: ledgerReceipt });
      report.ledger = { ...validateDiagnosticLedger(parseDiagnosticJson(ledgerReceipt.stdout)), receipt: ledgerReceipt };
      const backendReceipt = await psql(t, DIAGNOSTIC_BACKENDS_SQL, { tcp: true });
      phase('backends', { status: 'observed', receipt: backendReceipt });
      const backend = validateDiagnosticBackends(parseDiagnosticJson(backendReceipt.stdout));
      report.backendInventory = { observation: backend, receipt: backendReceipt };
      report.directCliSessionObserved = !simulation;
      report.status = simulation ? 'simulated-completed' : 'passed';
      report.runtime = simulation ? 'fake-transport-only' : 'synthetic-executed';
    } catch (error) {
      if (t) t.frozen = true;
      report.status = 'failed'; report.reason = redact(error.message); phase('failure', { status: 'failed', reason: report.reason });
    } finally {
      try { report.cleanup = await cleanupOwned(); }
      catch (error) { report.cleanup = error.cleanupOutcome ?? { status: 'failed', reason: redact(error.message) }; }
      if (report.cleanup.status !== 'removed_and_observed_absent') report.status = 'failed';
      report.receipts = structuredClone(receipts);
      report.evidenceSha256 = diagnosticHash(json(report));
    }
    return report;
  }, true); }
  async function cleanup() { return exclusive(cleanupOwned, true); }
  return Object.freeze({ observeCliSession, startTarget, apply, snapshot, runChecks, stopTarget, cleanup, abort: () => controller.abort(),
    capabilities: Object.freeze({ independentSessionRaces: Boolean(o.races), directCliSessionObservation: false, dirtyTargetRetry: false }),
    get receipts() { return structuredClone(receipts); } });
}
