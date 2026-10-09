import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitDiagnostic, diagnosticArtifacts, diagnosticHash, DIAGNOSTIC_PARENT, DIAGNOSTIC_VERSION, DIAGNOSTIC_NAME, DIAGNOSTIC_LIMITS,
  validateDirectObservation, validateDiagnosticLedger, createCliSessionRunner } from './cli-session.mjs';

const expected = { sessionUser: 'postgres', currentUser: 'postgres', isSuperuser: false, createRole: true, memberships: ['authenticator'] };
function captured() {
  const attributes = { name: 'postgres', superuser: false, inherit: true, createRole: true, createDatabase: true, canLogin: true, replication: false, bypassRls: true };
  const owners = { ovd660_cli_session: 'postgres', 'ovd660_cli_session.observation': 'postgres' };
  return { rows: [{ schema: 'overdrafter.cli-session-observation.v1', sessionUser: 'postgres', currentUser: 'postgres', database: 'postgres',
    serverAddress: '127.0.0.1', clientAddress: '127.0.0.1', serverPort: 5432, clientPort: 12345, backendPid: 101,
    backendStart: '2099-01-01T00:00:00Z', observedAt: '2099-01-01T00:00:01Z', settings: { role: 'none', searchPath: 'public,extensions,pg_catalog', statementTimeout: '20s' },
    roles: ['current', 'session'].map(kind => ({ kind, ...attributes })), directMemberships: ['authenticator'],
    membershipEdges: ['current', 'session'].map(root => ({ root, member: 'postgres', role: 'authenticator', grantor: 'supabase_admin', admin: false, inherit: true, set: true })),
    reachableRoles: ['current', 'session'].flatMap(root => ['authenticator', 'postgres'].map(name => ({ root, name, member: true, usable: true }))), owners }], owners,
    observer: { method: 'tcp-psql-readback', sessionUser: 'postgres', currentUser: 'postgres', backendPid: 102, backendStart: '2099-01-01T00:00:02Z', observedAt: '2099-01-01T00:00:03Z' } };
}

test('direct captured session, complete membership graph and owners validate separately from observer', () => {
  const value = captured(); assert.deepEqual(validateDirectObservation(value, expected), value.rows[0]);
  const cycle = captured();
  for (const root of ['current', 'session']) cycle.rows[0].membershipEdges.push({ root, member: 'authenticator', role: 'postgres', grantor: 'supabase_admin', admin: false, inherit: true, set: true });
  cycle.rows[0].membershipEdges.sort((a, b) => JSON.stringify([a.root, a.member, a.role, a.grantor]).localeCompare(JSON.stringify([b.root, b.member, b.role, b.grantor])));
  assert.doesNotThrow(() => validateDirectObservation(cycle, expected));
});

test('missing, duplicate, observer-substituted, inconsistent or drifted capture fails closed', () => {
  for (const change of [
    v => { v.rows = []; }, v => { v.rows.push(v.rows[0]); }, v => { v.rows = [v.observer]; },
    v => { v.rows[0].sessionUser = 'supabase_admin'; }, v => { v.rows[0].roles[0].superuser = true; },
    v => { v.rows[0].roles[1].bypassRls = false; }, v => { v.rows[0].roles[0].createRole = false; },
    v => { v.rows[0].membershipEdges = []; }, v => { v.rows[0].membershipEdges.push(v.rows[0].membershipEdges[0]); },
    v => { v.rows[0].membershipEdges[0].inherit = 'true'; }, v => { v.rows[0].reachableRoles.pop(); },
    v => { v.rows[0].membershipEdges[0].member = 'unreachable'; },
    v => { v.rows[0].directMemberships = []; }, v => { v.rows[0].owners = { ...v.rows[0].owners, ovd660_cli_session: 'supabase_admin' }; },
    v => { v.owners = { ...v.owners, 'ovd660_cli_session.observation': 'other' }; },
    v => { v.observer.backendPid = 101; v.observer.backendStart = v.rows[0].backendStart; },
    v => { v.observer.observedAt = '2000-01-01'; }, v => { v.rows[0].backendStart = null; },
    v => { v.rows[0].clientAddress = null; }, v => { v.rows[0].settings = {}; }, v => { v.extra = true; },
  ]) { const value = captured(); change(value); assert.throws(() => validateDirectObservation(value, expected)); }
});

test('ledger retains actual ordered statements and rejects missing or invented source-hash representation', () => {
  const ledger = [{ version: DIAGNOSTIC_VERSION, name: DIAGNOSTIC_NAME, statements: ['/* real parser representation */ BEGIN', 'SELECT 1', 'COMMIT'] }];
  const result = validateDiagnosticLedger(ledger); assert.deepEqual(result.rows, ledger);
  const reverse = [{ ...ledger[0], statements: [...ledger[0].statements].reverse() }];
  assert.notEqual(validateDiagnosticLedger(reverse).sha256, result.sha256);
  for (const bad of [[], [...ledger, ...ledger], [{ ...ledger[0], version: 'wrong' }], [{ ...ledger[0], statements: [] }], [{ ...ledger[0], statements: null }], [{ ...ledger[0], sha256: 'a'.repeat(64) }]]) assert.throws(() => validateDiagnosticLedger(bad));
  result.rows[0].statements.push('mutated returned copy'); assert.equal(ledger[0].statements.length, 3);
});

test('diagnostic admission binds exact runtime closure, fixed artifacts, parent, rehearsal receipt, limits and expiry', () => {
  const artifacts = diagnosticArtifacts(), base = { synthetic: 'only' }, limits = { containers: 2 };
  const admission = { schema: 'overdrafter.cli-session-diagnostic-admission.v1', qualification: 'synthetic-only', purpose: 'direct-cli-session-only', parentSourceCommit: DIAGNOSTIC_PARENT,
    rehearsalAdmissionSha256: diagnosticHash(JSON.stringify(base, null, 2) + '\n'), files: artifacts.files, hashes: artifacts.hashes, limits, expiresAt: new Date(Date.now() + 60000).toISOString() };
  assert.deepEqual(admitDiagnostic(admission, base, limits).sql, artifacts.sql);
  for (const change of [a => { a.expiresAt = '2000-01-01'; }, a => { a.files.pop(); }, a => { a.files[0].sha256 = 'a'.repeat(64); },
    a => { a.hashes.sql = 'a'.repeat(64); }, a => { a.hashes.readQuery = 'a'.repeat(64); }, a => { a.limits.containers = 3; },
    a => { a.parentSourceCommit = 'a'.repeat(40); }, a => { a.rehearsalAdmissionSha256 = 'a'.repeat(64); }, a => { a.sql = 'arbitrary'; }, a => { a.purpose = 'r1'; }]) {
    const value = structuredClone(admission); change(value); assert.throws(() => admitDiagnostic(value, base, limits));
  }
});

test('fixed source captures identity in a top-level INSERT and has no privilege adjustment or candidate path', () => {
  const sql = readFileSync(new URL('./cli-session.sql', import.meta.url), 'utf8');
  assert.match(sql, /INSERT INTO ovd660_cli_session\.observation/); assert.match(sql, /'sessionUser', session_user, 'currentUser', current_user/);
  assert.match(sql, /m\.admin_option/); assert.match(sql, /m\.inherit_option/); assert.match(sql, /m\.set_option/);
  assert.match(sql, /'owners', jsonb_build_object/);
  assert.doesNotMatch(sql, /SECURITY DEFINER|SET ROLE|ALTER ROLE|CREATE ROLE|GRANT |ALTER OWNER|pg_authid|schema_migrations/i);
});

test('import and default plan never construct a runtime adapter; injected outputs cannot claim real qualification', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./cli-session.mjs', import.meta.url).href)});`], { timeout: 10000, env: { LANG: 'C' }, encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  let calls = 0;
  const run = createCliSessionRunner({ prepareRelease: () => ({ plan: { sourceCommit: 'fake', inputs: [] }, profileSha256: 'fake' }), adapterApi: { inspectPrerequisites: () => { calls++; throw new Error('must not execute'); } } });
  const report = await run({ input: null }); assert.equal(report.status, 'planned'); assert.equal(report.qualification, 'fake-transport-only'); assert.equal(report.directCliSessionObserved, false); assert.equal(calls, 0);
  assert.throws(() => createCliSessionRunner({ adapterApi: {} }));
});

test('membership graph uses PostgreSQL C byte ordering without changing legacy direct-grant order', () => {
  const value = captured(), names = ['authenticator', 'quote"role', '\ue000', '\u{10000}'];
  const utf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // Legacy direct rows retain their supplied order; graph identities have their own C ordering.
  value.rows[0].directMemberships = [...names].reverse();
  value.rows[0].membershipEdges = ['current', 'session'].flatMap(root => names.map(role => ({ root, member: 'postgres', role, grantor: 'supabase_admin', admin: false, inherit: true, set: true })));
  value.rows[0].reachableRoles = ['current', 'session'].flatMap(root => [...names, 'postgres'].sort(utf8).map(name => ({ root, name, member: true, usable: true })));
  assert.doesNotThrow(() => validateDirectObservation(value, { ...expected, memberships: [...names].reverse() }));
  value.rows[0].reachableRoles.reverse(); assert.throws(() => validateDirectObservation(value, { ...expected, memberships: [...names].reverse() }));
});

test('standalone fake runner rejects a real-proof spoof and preserves cleanup failure', async () => {
  const prepared = { plan: { sourceCommit: 'fake', inputs: [] }, sourceFiles: new Map(), profileSha256: 'fake' };
  const runtime = { tools: {}, image: {}, session: {}, parentDirectory: '/fake', admission: {}, platform: {}, races: {}, diagnosticAdmission: {} };
  const artifacts = diagnosticArtifacts();
  runtime.diagnosticAdmission = { schema: 'overdrafter.cli-session-diagnostic-admission.v1', qualification: 'synthetic-only', purpose: 'direct-cli-session-only', parentSourceCommit: DIAGNOSTIC_PARENT,
    rehearsalAdmissionSha256: diagnosticHash(JSON.stringify(runtime.admission, null, 2) + '\n'), files: artifacts.files, hashes: artifacts.hashes, limits: DIAGNOSTIC_LIMITS, expiresAt: new Date(Date.now() + 60000).toISOString() };
  for (const result of [
    { qualification: 'synthetic-only', status: 'passed', directCliSessionObserved: true, cleanup: { status: 'removed_and_observed_absent' } },
    { qualification: 'fake-transport-only', status: 'passed', directCliSessionObserved: true, cleanup: { status: 'removed_and_observed_absent' } },
    { qualification: 'fake-transport-only', status: 'simulated-completed', directCliSessionObserved: false, cleanup: { status: 'failed', reason: 'unconfirmed' } },
  ]) {
    let cleanupCalls = 0;
    const run = createCliSessionRunner({ prepareRelease: () => prepared, adapterApi: {
      inspectPrerequisites: () => ({ status: 'ready-for-runtime-preflight' }),
      createCachedFixtureAdapter: () => ({ observeCliSession: async () => result, abort: () => {}, cleanup: () => { cleanupCalls++; return { status: 'removed_and_observed_absent' }; } }),
    } });
    const report = await run({ input: null, execute: true, runtime });
    assert.equal(report.status, 'failed'); assert.equal(report.directCliSessionObserved, false); assert.equal(report.qualification, 'fake-transport-only');
    assert.equal(cleanupCalls, 0, 'returned diagnostic cleanup cannot be retried or replaced');
    assert.deepEqual(report.result, result, 'the admitted fake adapter must actually be exercised');
  }
});

import { parseDiagnosticJson, validateDiagnosticBackends } from './cli-session.mjs';
test('strict readback parser rejects duplicate decoded keys, trailing JSON/output and excessive depth', () => {
  const escaped = { a: [{ b: 'escaped " brace } and colon :' }], c: 1 }; assert.deepEqual(parseDiagnosticJson(JSON.stringify(escaped)), escaped);
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"rows":[{"x":1,"x":2}]}', '{}\n{}', '{}\nNOTICE', '[', '['.repeat(129) + '0' + ']'.repeat(129)]) assert.throws(() => parseDiagnosticJson(text));
  for (const value of [{ remaining: [], observedAt: '1' }, { remaining: [], observedAt: null }, { remaining: [{ pid: 1 }], observedAt: '2099-01-01T00:00:00Z' }, { remaining: [], observedAt: '2099-01-01T00:00:00Z', extra: true }]) assert.throws(() => validateDiagnosticBackends(value));
});

test('distinct grantor edges and transitive reachability do not replace legacy direct grant rows', () => {
  const value = captured();
  value.rows[0].directMemberships = ['authenticator', 'authenticator'];
  value.rows[0].membershipEdges = ['current', 'session'].flatMap(root => [
    { root, member: 'authenticator', role: 'leaf', grantor: 'supabase_admin', admin: false, inherit: false, set: true },
    { root, member: 'postgres', role: 'authenticator', grantor: 'other_admin', admin: true, inherit: false, set: true },
    { root, member: 'postgres', role: 'authenticator', grantor: 'supabase_admin', admin: false, inherit: true, set: true },
  ]);
  value.rows[0].reachableRoles = ['current', 'session'].flatMap(root => ['authenticator', 'leaf', 'postgres'].map(name => ({ root, name, member: true, usable: name !== 'leaf' })));
  assert.doesNotThrow(() => validateDirectObservation(value, { ...expected, memberships: ['authenticator', 'authenticator'] }));
  assert.throws(() => validateDirectObservation(value, { ...expected, memberships: ['authenticator', 'leaf'] }));
});

// Fresh processes ensure the dynamic-import cache cannot hide premature evaluation.
// The loader only appends an inert counter; every executable transport is absent
// or the existing in-memory adapter fixture. No Docker/CLI/SQL command runs.
function importBoundaryProbe(route, mode) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ovd660-import-'));
  try {
    const sourceRoot = process.env.OVD_RACE_HELPER_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
    const adapterUrl = new URL('./adapter.mjs', import.meta.url).href;
    const diagnosticUrl = new URL('./cli-session.mjs', import.meta.url).href;
    const target = route === 'standalone' ? adapterUrl : diagnosticUrl;
    const loader = path.join(temporary, 'loader.mjs'), probe = path.join(temporary, 'probe.mjs');
    writeFileSync(loader, `export async function load(url, context, nextLoad) { const r = await nextLoad(url, context); return url === ${JSON.stringify(target)} ? { ...r, source: String(r.source) + String.fromCharCode(10) + 'globalThis.__ovd660ImportMarker = (globalThis.__ovd660ImportMarker ?? 0) + 1;' + String.fromCharCode(10) } : r; }`);
    const artifacts = diagnosticArtifacts();
    const descriptor = { schema: 'overdrafter.cli-session-diagnostic-admission.v1', qualification: 'synthetic-only', purpose: 'direct-cli-session-only', parentSourceCommit: DIAGNOSTIC_PARENT,
      files: artifacts.files, hashes: artifacts.hashes, limits: DIAGNOSTIC_LIMITS, expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (mode === 'schema') descriptor.schema = 'invalid';
    if (mode === 'source-hash') descriptor.files[route === 'standalone' ? 0 : 2].sha256 = 'a'.repeat(64);
    if (mode === 'artifact-hash') descriptor.hashes.readQuery = 'a'.repeat(64);
    if (mode === 'expired') descriptor.expiresAt = '2000-01-01';
    if (mode === 'extra-field') descriptor.sql = 'arbitrary';
    if (route === 'standalone') {
      writeFileSync(probe, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createCliSessionRunner } from ${JSON.stringify(diagnosticUrl)};
let transportCalls = 0; childProcess.spawn = () => { transportCalls++; throw new Error('real transport forbidden in inert probe'); }; syncBuiltinESMExports();
const sourceRoot = ${JSON.stringify(sourceRoot)};
const profileBytes = readFileSync(path.join(sourceRoot, 'scripts/fixtures/free-quote-ci-source.json'));
const profile = JSON.parse(profileBytes);
const input = { profileBytes, sourceFiles: new Map(Object.keys(profile.files).map(p => [p, readFileSync(path.join(sourceRoot, p))])), baseline: { schema: 'overdrafter.synthetic-baseline-ordinals.v1', ordinals: [...Array.from({length:128}, (_,i)=>i+1),134] } };
const admission = {}, diagnosticAdmission = { ...${JSON.stringify(descriptor)}, rehearsalAdmissionSha256: createHash('sha256').update(JSON.stringify(admission,null,2)+String.fromCharCode(10)).digest('hex') };
const run = createCliSessionRunner();
assert.equal((await run({input})).status, 'planned'); assert.equal(globalThis.__ovd660ImportMarker, undefined);
const result = await run({input,execute:true,runtime:{tools:{},image:{},session:{},parentDirectory:'/nonexistent-ovd660-test-only',admission,platform:{},races:{},diagnosticAdmission}});
assert.equal(result.runtime,'not_run'); assert.equal(result.status,'failed');
console.log(JSON.stringify({route:'standalone',mode:${JSON.stringify(mode)},imports:globalThis.__ovd660ImportMarker??0,transportCalls}));
`);
    } else {
      const fixtureSource = readFileSync(new URL('./adapter.node-test.mjs', import.meta.url), 'utf8');
      const prefix = fixtureSource.slice(0, fixtureSource.indexOf(String.fromCharCode(10) + 'test(')).replace("from './adapter.mjs'", 'from ' + JSON.stringify(adapterUrl));
      writeFileSync(probe, prefix + `
const f = await fixture();
try {
  const admission = { ...${JSON.stringify(descriptor)}, rehearsalAdmissionSha256: hash(Buffer.from(JSON.stringify(f.options.admission,null,2)+String.fromCharCode(10))) };
  assert.equal(globalThis.__ovd660ImportMarker, undefined);
  let result; try { result = await f.create().observeCliSession({diagnosticAdmission:admission}); } catch (error) { result={status:'rejected',reason:error.message}; }
  assert(['failed','rejected'].includes(result.status));
  console.log(JSON.stringify({route:'adapter',mode:${JSON.stringify(mode)},imports:globalThis.__ovd660ImportMarker??0,transportCalls:f.state.calls.length}));
} finally { await f.dispose(); }
`);
    }
    const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, probe], { env: { LANG: 'C' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    return JSON.parse(child.stdout);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
for (const route of ['standalone', 'adapter']) test(`${route} rejects admission/source drift before target import side effects`, () => {
  for (const mode of ['schema', 'source-hash', 'artifact-hash', 'expired', 'extra-field']) {
    const result = importBoundaryProbe(route, mode);
    assert.equal(result.imports, 0, mode); assert.equal(result.transportCalls, 0, mode);
  }
  const admitted = importBoundaryProbe(route, 'valid');
  assert.equal(admitted.imports, 1, 'valid source/admission must reach the newly trusted module');
  if (route === 'standalone') assert.equal(admitted.transportCalls, 0);
  else assert(admitted.transportCalls > 0, 'valid adapter route exercises only the existing fake transport');
});
