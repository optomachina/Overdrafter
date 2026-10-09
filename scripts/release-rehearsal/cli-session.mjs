/** Fixed synthetic CLI diagnostic. Import/default planning never starts a process. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease, PROFILE_SHA256, PLATFORM_SHA256, PROFILE_MODULE_SHA256, RACE_HELPER_PINS } from './run.mjs';

export const DIAGNOSTIC_LIMITS = Object.freeze({ containers: 2, networks: 1, cpus: 2, memory: 3221225472, pids: 256,
  commandMs: 60000, runnerMs: 1800000, cleanupMs: 60000, terminationGraceMs: 2000, outputBytes: 8000000 });
export const DIAGNOSTIC_PARENT = '2ba2839186dbadc6301d7ad84fd267d40f2cfb4c';
export const DIAGNOSTIC_VERSION = '20990101000660';
export const DIAGNOSTIC_NAME = 'ovd660_cli_session';
export const DIAGNOSTIC_FILE = DIAGNOSTIC_VERSION + '_' + DIAGNOSTIC_NAME + '.sql';
export const DIAGNOSTIC_FILES = Object.freeze(['adapter.mjs', 'catalog.sql', 'cli-session.mjs', 'cli-session.sql', 'core.mjs', 'races.mjs', 'run.mjs']);
export const DIAGNOSTIC_CONFIG = 'project_id = "ovd660-cli-session"\n[db]\nport = 5432\nmajor_version = 17\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n';
export const DIAGNOSTIC_EMPTY_SQL = "select jsonb_build_object('diagnosticAbsent',not exists(select 1 from pg_namespace where nspname='ovd660_cli_session'),'ledgerAbsent',to_regclass('supabase_migrations.schema_migrations') is null);";
export const DIAGNOSTIC_READ_SQL = `select jsonb_build_object(
 'rows',(select coalesce(jsonb_agg(evidence),'[]') from ovd660_cli_session.observation),
 'owners',jsonb_build_object('ovd660_cli_session',(select pg_get_userbyid(nspowner) from pg_namespace where nspname='ovd660_cli_session'),
 'ovd660_cli_session.observation',(select pg_get_userbyid(relowner) from pg_class where oid='ovd660_cli_session.observation'::regclass)),
 'observer',jsonb_build_object('method','tcp-psql-readback','sessionUser',session_user,'currentUser',current_user,
 'backendPid',pg_backend_pid(),'backendStart',(select backend_start from pg_stat_activity where pid=pg_backend_pid()),'observedAt',clock_timestamp()));`;
export const DIAGNOSTIC_LEDGER_SQL = "select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'statements',statements) order by version),'[]') from supabase_migrations.schema_migrations;";
export const DIAGNOSTIC_BACKENDS_SQL = "select jsonb_build_object('remaining',coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backendStart',backend_start) order by pid),'[]'),'observedAt',clock_timestamp()) from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid();";
export const diagnosticHash = bytes => createHash('sha256').update(bytes).digest('hex');
const serial = value => JSON.stringify(value, null, 2) + '\n';
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const exact = (value, keys) => { assert(value && Object.getPrototypeOf(value) === Object.prototype, 'object required'); assert.deepEqual(Object.keys(value).sort(lexical), [...keys].sort(lexical), 'unexpected fields'); };
const nonempty = value => assert(typeof value === 'string' && value.length > 0 && value.length <= 4096, 'nonempty bounded string required');
const timestamp = value => { nonempty(value); assert(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value) && Number.isFinite(Date.parse(value)), 'timestamp required'); };
const integer = value => assert(Number.isSafeInteger(value) && value > 0, 'positive integer required');
const bools = (value, names) => names.forEach(key => assert.equal(typeof value[key], 'boolean', key));
const utf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const tupleOrder = (a, b) => { for (let i = 0; i < a.length; i++) { const order = utf8(a[i], b[i]); if (order) return order; } return 0; };
const orderedUnique = (values, key) => { let previous; for (const value of values) { const next = key(value); assert(previous === undefined || tupleOrder(previous, next) < 0, 'duplicate or unordered identity'); previous = next; } };

/** JSON.parse rejects trailing data; this scan also rejects duplicate decoded keys. */
export function parseDiagnosticJson(text) {
  assert.equal(typeof text, 'string'); assert(Buffer.byteLength(text) <= 8_000_000, 'diagnostic JSON exceeds bound');
  const parsed = JSON.parse(text), stack = [];
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); assert(stack.length <= 128, 'diagnostic JSON depth'); }
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1); assert(keys && !keys.has(key), 'duplicate JSON key'); keys.add(key);
    }
  }
  return parsed;
}
export function validateDiagnosticBackends(value) {
  exact(value, ['remaining', 'observedAt']); assert(Array.isArray(value.remaining) && value.remaining.length === 0, 'diagnostic backend absence unconfirmed');
  timestamp(value.observedAt); return structuredClone(value);
}

export function diagnosticArtifacts() {
  const sql = readFileSync(new URL('./cli-session.sql', import.meta.url));
  return { sql, files: DIAGNOSTIC_FILES.map(file => ({ path: file, sha256: diagnosticHash(readFileSync(new URL(file, import.meta.url))) })),
    hashes: { sql: diagnosticHash(sql), config: diagnosticHash(DIAGNOSTIC_CONFIG), emptyQuery: diagnosticHash(DIAGNOSTIC_EMPTY_SQL),
      readQuery: diagnosticHash(DIAGNOSTIC_READ_SQL), ledgerQuery: diagnosticHash(DIAGNOSTIC_LEDGER_SQL), backendsQuery: diagnosticHash(DIAGNOSTIC_BACKENDS_SQL) } };
}
export function admitDiagnostic(admission, rehearsalAdmission, limits) {
  exact(admission, ['schema', 'qualification', 'purpose', 'parentSourceCommit', 'rehearsalAdmissionSha256', 'files', 'hashes', 'limits', 'expiresAt']);
  assert.equal(admission.schema, 'overdrafter.cli-session-diagnostic-admission.v1');
  assert.equal(admission.qualification, 'synthetic-only'); assert.equal(admission.purpose, 'direct-cli-session-only');
  assert.equal(admission.parentSourceCommit, DIAGNOSTIC_PARENT);
  assert.equal(admission.rehearsalAdmissionSha256, diagnosticHash(serial(rehearsalAdmission)), 'rehearsal admission drift');
  assert(Number.isFinite(Date.parse(admission.expiresAt)) && Date.parse(admission.expiresAt) > Date.now(), 'diagnostic admission expired');
  assert.deepEqual(admission.limits, limits, 'diagnostic resource caps drift');
  const artifacts = diagnosticArtifacts();
  assert.deepEqual(admission.files, artifacts.files, 'diagnostic source closure drift');
  assert.deepEqual(admission.hashes, artifacts.hashes, 'diagnostic artifact drift');
  return artifacts;
}

/** Validate stored CLI values; observer identity can never replace this row. */
export function validateDirectObservation(readback, expected) {
  exact(readback, ['rows', 'owners', 'observer']);
  assert(Array.isArray(readback.rows) && readback.rows.length === 1, 'exactly one captured row required');
  const row = readback.rows[0];
  exact(row, ['schema', 'sessionUser', 'currentUser', 'database', 'serverAddress', 'clientAddress', 'serverPort', 'clientPort', 'backendPid', 'backendStart', 'observedAt', 'settings', 'roles', 'directMemberships', 'membershipEdges', 'reachableRoles', 'owners']);
  assert.equal(row.schema, 'overdrafter.cli-session-observation.v1');
  assert.equal(row.sessionUser, expected.sessionUser); assert.equal(row.currentUser, expected.currentUser);
  assert.equal(row.database, 'postgres'); assert.equal(row.serverAddress, '127.0.0.1'); assert.equal(row.clientAddress, '127.0.0.1');
  assert.equal(row.serverPort, 5432); integer(row.clientPort); assert(row.clientPort <= 65535); integer(row.backendPid);
  timestamp(row.backendStart); timestamp(row.observedAt); assert(Date.parse(row.observedAt) >= Date.parse(row.backendStart));
  exact(row.settings, ['role', 'searchPath', 'statementTimeout']); Object.values(row.settings).forEach(nonempty);
  assert(Array.isArray(row.roles) && row.roles.length === 2, 'both role observations required');
  const attributes = ['superuser', 'inherit', 'createRole', 'createDatabase', 'canLogin', 'replication', 'bypassRls'];
  for (const [i, kind] of ['current', 'session'].entries()) {
    const role = row.roles[i]; exact(role, ['kind', 'name', ...attributes]);
    assert.equal(role.kind, kind); assert.equal(role.name, kind === 'current' ? row.currentUser : row.sessionUser);
    bools(role, attributes); assert.equal(role.superuser, expected.isSuperuser); assert.equal(role.createRole, expected.createRole);
  }
  // Same role must have exactly the same non-secret attributes in both records.
  if (row.currentUser === row.sessionUser) for (const key of attributes) assert.equal(row.roles[0][key], row.roles[1][key]);
  assert(Array.isArray(row.directMemberships)); row.directMemberships.forEach(nonempty);
  assert.deepEqual(row.directMemberships, expected.memberships, 'direct membership contract drift');
  assert(Array.isArray(row.membershipEdges) && row.membershipEdges.length <= 4096, 'bounded membership edges required');
  const edgeKey = e => [e.root, e.member, e.role, e.grantor];
  for (const edge of row.membershipEdges) {
    exact(edge, ['root', 'member', 'role', 'grantor', 'admin', 'inherit', 'set']); assert(['current', 'session'].includes(edge.root));
    [edge.member, edge.role, edge.grantor].forEach(nonempty); bools(edge, ['admin', 'inherit', 'set']);
  }
  orderedUnique(row.membershipEdges, edgeKey);
  assert.deepEqual(row.membershipEdges.filter(e => e.root === 'current' && e.member === row.currentUser).map(e => e.role).sort(utf8), [...row.directMemberships].sort(utf8), 'membership capture inconsistent');
  assert(Array.isArray(row.reachableRoles) && row.reachableRoles.length >= 2 && row.reachableRoles.length <= 4096);
  for (const role of row.reachableRoles) {
    exact(role, ['root', 'name', 'member', 'usable']); assert(['current', 'session'].includes(role.root)); nonempty(role.name); bools(role, ['member', 'usable']);
  }
  orderedUnique(row.reachableRoles, r => [r.root, r.name]);
  for (const kind of ['current', 'session']) {
    const names = new Set([kind === 'current' ? row.currentUser : row.sessionUser]);
    let changed = true;
    while (changed) { changed = false; for (const e of row.membershipEdges.filter(e => e.root === kind)) if (names.has(e.member) && !names.has(e.role)) { names.add(e.role); changed = true; } }
    assert(row.membershipEdges.filter(e => e.root === kind).every(e => names.has(e.member)), 'unreachable membership edge');
    assert.deepEqual(row.reachableRoles.filter(r => r.root === kind).map(r => r.name), [...names].sort(utf8), 'membership closure incomplete');
  }
  const owners = ['ovd660_cli_session', 'ovd660_cli_session.observation'];
  exact(row.owners, owners); exact(readback.owners, owners);
  for (const owner of owners) { assert.equal(row.owners[owner], row.currentUser, 'captured owner mismatch'); assert.equal(readback.owners[owner], row.owners[owner], 'observer owner mismatch'); }
  const observer = readback.observer;
  exact(observer, ['method', 'sessionUser', 'currentUser', 'backendPid', 'backendStart', 'observedAt']);
  assert.equal(observer.method, 'tcp-psql-readback'); assert.equal(observer.sessionUser, expected.sessionUser); assert.equal(observer.currentUser, expected.currentUser);
  integer(observer.backendPid); timestamp(observer.backendStart); timestamp(observer.observedAt);
  assert(observer.backendPid !== row.backendPid || observer.backendStart !== row.backendStart, 'observer cannot be CLI backend');
  assert(Date.parse(observer.observedAt) >= Date.parse(row.observedAt), 'observer predates capture');
  return structuredClone(row);
}
/** Cross-bind stored row, raw observer output, exact target and actual invocation. */
export function validateCaptureBinding(report, expected) {
  const apply = report.phases.find(p => p.name === 'apply')?.receipt;
  const readback = report.directObservation?.readbackReceipt;
  assert(apply && readback && report.target && report.captureBinding, 'capture receipts missing');
  assert(/^[a-f0-9]{64}$/.test(report.target.id), 'capture target identity');
  for (const receipt of [apply, readback]) {
    assert.equal(receipt.status, 0); assert.equal(receipt.signal, null); assert.equal(receipt.failure, null);
    assert.equal(receipt.qualification, report.qualification); integer(receipt.sequence);
  }
  assert(apply.sequence < readback.sequence, 'capture receipt order');
  assert.equal(apply.argv[4], 'exec'); assert.equal(apply.argv[5], report.target.id);
  assert.equal(readback.argv[4], 'exec'); assert.equal(readback.argv[5], '-i'); assert.equal(readback.argv[6], report.target.id);
  assert.equal(readback.inputSha256, diagnosticHash(DIAGNOSTIC_READ_SQL), 'capture query identity');
  const raw = parseDiagnosticJson(readback.stdout), row = validateDirectObservation(raw, expected);
  assert.deepEqual(report.directObservation.row, row, 'raw capture and projection differ');
  assert.deepEqual(report.observerObservation, raw.observer, 'observer projection differs');
  assert.deepEqual(report.sourceHashes, report.admission.hashes, 'capture source binding differs');
  assert.deepEqual(report.captureBinding, { targetId: report.target.id, applyReceiptSequence: apply.sequence, readbackReceiptSequence: readback.sequence,
    sqlSha256: report.sourceHashes.sql, configSha256: report.sourceHashes.config,
    diagnosticAdmissionSha256: diagnosticHash(serial(report.admission)), rawReadbackSha256: diagnosticHash(readback.stdout), capturedRowSha256: diagnosticHash(serial(row)) }, 'capture binding differs');
  return row;
}
export function validateDiagnosticLedger(ledger) {
  assert(Array.isArray(ledger) && ledger.length === 1, 'exactly one actual ledger row required');
  const row = ledger[0]; exact(row, ['version', 'name', 'statements']);
  assert.equal(row.version, DIAGNOSTIC_VERSION); assert.equal(row.name, DIAGNOSTIC_NAME);
  assert(Array.isArray(row.statements) && row.statements.length > 0 && row.statements.every(s => typeof s === 'string' && s.length > 0), 'actual ordered ledger statements required');
  return { rows: structuredClone(ledger), sha256: diagnosticHash(serial(ledger)), representation: 'actual-cli-ledger; source-byte-hash-is-separate' };
}

export function createCliSessionRunner(dependencies = {}) {
  const simulation = Object.keys(dependencies).length > 0;
  if (simulation) { exact(dependencies, ['prepareRelease', 'adapterApi']); assert.equal(typeof dependencies.prepareRelease, 'function'); }
  return async ({ input, execute = false, runtime, save = () => {}, signal }) => {
    const prepared = (dependencies.prepareRelease ?? prepareRelease)(input);
    const artifacts = diagnosticArtifacts();
    const report = { schema: 'overdrafter.cli-session-diagnostic-run.v1', qualification: simulation ? 'fake-transport-only' : 'synthetic-only',
      status: execute ? 'running' : 'planned', runtime: 'not_run', candidate: prepared.plan.sourceCommit, profileSha256: prepared.profileSha256,
      diagnosticFile: DIAGNOSTIC_FILE, diagnosticSource: { parentSourceCommit: DIAGNOSTIC_PARENT, files: artifacts.files, hashes: artifacts.hashes }, candidateInputs: prepared.plan.inputs.length, diagnosticIsCandidateInput: false,
      directCliSessionObserved: false, result: null, cleanup: { status: 'not_run' } };
    if (!execute) return report;
    let adapter; let removeAbort = () => {};
    const persist = () => save(JSON.parse(serial(report)));
    try {
      assert(!signal?.aborted, 'diagnostic cancelled');
      exact(runtime, ['tools', 'image', 'session', 'parentDirectory', 'admission', 'platform', 'races', 'diagnosticAdmission']);
      const { diagnosticAdmission, ...base } = runtime;
      const catalog = readFileSync(new URL('./catalog.sql', import.meta.url));
      const options = { ...base, plan: prepared.plan, sourceFiles: prepared.sourceFiles, catalog: { bytes: catalog, sha256: diagnosticHash(catalog) } };
      // Validate in this already loaded module; rejected input must not evaluate adapter JS.
      admitDiagnostic(diagnosticAdmission, options.admission, DIAGNOSTIC_LIMITS);
      const api = dependencies.adapterApi ?? await import('./adapter.mjs');
      report.preflight = api.inspectPrerequisites(options); persist(); assert.equal(report.preflight.status, 'ready-for-runtime-preflight');
      adapter = api.createCachedFixtureAdapter(options);
      const abort = () => adapter.abort();
      signal?.addEventListener('abort', abort, { once: true }); removeAbort = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) abort();
      report.result = await adapter.observeCliSession({ diagnosticAdmission });
      report.cleanup = report.result.cleanup;
      assert.equal(report.result.qualification, simulation ? 'fake-transport-only' : 'synthetic-only', 'diagnostic qualification mismatch');
      report.cleanup = report.result.cleanup;
      report.status = report.result.status; report.runtime = simulation ? 'fake-transport-only' : report.result.runtime;
      report.directCliSessionObserved = !simulation && report.result.status === 'passed' && report.result.directCliSessionObserved === true;
      assert(report.status !== 'passed' || report.directCliSessionObserved, 'real pass requires direct evidence');
    } catch (error) { report.status = 'failed'; report.reason = error.message; report.runtime = adapter ? (simulation ? 'fake-transport-only' : 'attempted') : 'not_run'; }
    finally {
      removeAbort();
      // observeCliSession owns cleanup, including failures. Fallback only if no result was returned.
      if (adapter && !report.result) {
        try { report.cleanup = await adapter.cleanup(); } catch (error) { report.cleanup = error.cleanupOutcome ?? { status: 'failed', reason: error.message }; }
      }
      if (adapter && !['removed_and_observed_absent', 'not_started'].includes(report.cleanup.status)) report.status = 'failed';
      persist();
    }
    return report;
  };
}
function sourceFile(root, relative) {
  assert(/^[A-Za-z0-9_./-]+$/.test(relative) && !relative.split('/').some(p => ['', '.', '..'].includes(p)), 'unsafe bundle path');
  const file = path.join(root, relative), stat = lstatSync(file);
  assert(realpathSync(file) === file && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 8_000_000, 'unsafe bundle file');
  return readFileSync(file);
}
export async function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) { const key = argv[i]; assert(['--bundle', '--execute', '--evidence'].includes(key) && !flags.has(key), 'unknown/duplicate argument'); flags.set(key, key === '--execute' ? true : argv[++i]); }
  const root = flags.get('--bundle'); assert(typeof root === 'string' && path.isAbsolute(root) && realpathSync(root) === root, 'absolute bundle root required');
  const profileBytes = sourceFile(root, 'scripts/fixtures/free-quote-ci-source.json'); assert.equal(diagnosticHash(profileBytes), PROFILE_SHA256);
  const profile = parseDiagnosticJson(profileBytes.toString('utf8'));
  const input = { profileBytes, baseline: parseDiagnosticJson(sourceFile(root, 'synthetic-baseline.json').toString('utf8')), sourceFiles: new Map(Object.keys(profile.files).map(file => [file, sourceFile(root, file)])) };
  let runtime, save;
  if (flags.has('--execute')) {
    const config = parseDiagnosticJson(sourceFile(root, 'cli-session-runtime.json').toString('utf8'));
    exact(config, ['tools', 'image', 'session', 'parentDirectory', 'admission', 'diagnosticAdmission']);
    const manifestBytes = sourceFile(root, 'platform-manifest.json'); assert.equal(diagnosticHash(manifestBytes), PLATFORM_SHA256);
    const manifest = parseDiagnosticJson(manifestBytes.toString('utf8')), profileModule = sourceFile(root, 'scripts/free-quote-ci-profile.mjs'); assert.equal(diagnosticHash(profileModule), PROFILE_MODULE_SHA256);
    runtime = { ...config, races: { profileManifestBytes: profileBytes, helperFiles: new Map(Object.keys(RACE_HELPER_PINS).map(file => [file, sourceFile(root, file)])) },
      platform: { manifestBytes, profileBytes: profileModule, files: new Map(['auth', 'storage'].flatMap(kind => manifest[kind].map(e => [kind + '/' + e.name, sourceFile(root, 'platform/' + kind + '/' + e.name)]))) } };
    const out = flags.get('--evidence'); assert(typeof out === 'string' && path.isAbsolute(out), 'fresh evidence directory required');
    const parent = path.dirname(out), stat = lstatSync(parent);
    assert(realpathSync(parent) === parent && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, 'private evidence parent required');
    mkdirSync(out, { mode: 0o700 }); save = report => writeFileSync(path.join(out, 'report.json'), serial(report), { mode: 0o600 });
  } else assert(!flags.has('--evidence'), 'plan does not write evidence');
  const controller = new AbortController(), interrupt = () => controller.abort();
  if (flags.has('--execute')) { process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); }
  try { const report = await createCliSessionRunner()({ input, execute: flags.has('--execute'), runtime, save, signal: controller.signal }); console.log(serial(report)); return ['planned', 'passed'].includes(report.status) ? 0 : 1; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
