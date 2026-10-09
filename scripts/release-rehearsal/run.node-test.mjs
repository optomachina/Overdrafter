import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildPlan, MANIFEST_SCHEMA, CATALOG_SCHEMA, CATALOG_COVERAGE } from './core.mjs';
import { acceptTap, createRunner, prepareRelease, validateRaceEvidence, CANDIDATE, PROFILE_SHA256, SYNTHETIC_BASELINE_ORDINALS } from './run.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const platformBytes = readFileSync(new URL('../fixtures/free-quote-platform-manifest.json', import.meta.url));
const actualProfile = readFileSync(new URL('../fixtures/free-quote-ci-source.json', import.meta.url));
const session = { sessionUser: 'postgres', currentUser: 'postgres', isSuperuser: false, createRole: true, memberships: [] };
const outcome = (stdout = '') => ({ status: 0, signal: null, failure: null, stdout, stderr: '' });

function fixture() {
  const sourceFiles = new Map(), migrations = [];
  for (let i = 1; i <= 139; i++) {
    const version = String(20260101000000 + i), file = `supabase/migrations/${version}_fixture_${i}.sql`;
    const bytes = Buffer.from(`-- owned synthetic migration ${i}\nBEGIN;\nCREATE TABLE private.capability_runtime_revisions_${i}(id integer);\nCOMMIT;\n`);
    migrations.push({ version, path: file, sha256: hash(bytes) }); sourceFiles.set(file, bytes);
  }
  const baselineSuites = ['catalog', 'service_role', 'old_scope', 'publication_source_baseline'].map(n => `supabase/fixtures/${n}.sql`);
  const candidateSuites = ['catalog', 'service_role', 'old_scope', 'publication_source_candidate'].map(n => `supabase/fixtures/${n}.sql`);
  const tapSuites = ['free-meter', 'free-access', 'free-terminal'].map(n => `supabase/fixtures/${n}.sql`);
  const probe = 'supabase/fixtures/atomicity.sql';
  for (const file of new Set([...baselineSuites, ...candidateSuites, ...tapSuites, probe])) sourceFiles.set(file, Buffer.from('-- invented TAP source\n'));
  const inputs = [...sourceFiles].map(([path, bytes]) => ({ path, sha256: hash(bytes) })).sort((a, b) => a.path < b.path ? -1 : 1);
  const baseline = { schema: 'overdrafter.synthetic-baseline-ordinals.v1', ordinals: [...Array.from({ length: 126 }, (_, i) => i + 1), 138] };
  const plan = buildPlan({ manifest: { schema: MANIFEST_SCHEMA, sourceCommit: CANDIDATE, migrations, inputs }, sourceFiles,
    baselineVersions: baseline.ordinals.map(i => migrations[i - 1].version) });
  const profile = { migrationCount: 139, baselineCount: 126, contractMigrationCount: 133, baselineSuites, candidateSuites, tapSuites,
    migrationProbes: [{ name: 'atomicity', afterMigration: 132, sql: probe }], races: Array.from({ length: 18 }, (_, i) => ({ name: `synthetic-race-${i + 1}` })),
    files: Object.fromEntries(inputs.map(file => [file.path, file.sha256])) };
  return { plan, baseline, profile, profileSha256: PROFILE_SHA256, sourceFiles };
}

function transport(prepared, options = {}) {
  const active = new Set(), states = new Map(), trace = []; let max = 0, failed = null;
  const row = entry => ({ version: entry.version, name: entry.path.split('/').at(-1).slice(15, -4), statements: [`actual fake CLI statement for ${entry.version}`] });
  const object = { kind: 'relation', identity: 'private.capability_runtime_revisions', owner: 'postgres', acl: null,
    rls: false, forceRls: false, definition: { columns: ['scope_key', 'high_water'] } };
  const adapter = {
    abort() { trace.push(['abort']); },
    async startTarget(label) {
      assert(active.size < 2); const target = { label, id: label, qualification: 'fake-transport-only' };
      active.add(target); states.set(target, { rows: [], frozen: false, survived: false }); max = Math.max(max, active.size);
      trace.push(['start', label]); return { target, session: { observation: session }, receipts: [] };
    },
    async apply(target, args) {
      const state = states.get(target); assert(!state.frozen, 'dirty target retry');
      const staged = args.files.map(f => f.version), pending = args.expectedPending.map(f => f.version);
      assert(state.rows.every(r => staged.includes(r.version)), 'missing local history');
      assert.deepEqual(staged.filter(v => !state.rows.some(r => r.version === v)), pending, 'expected pending ordering');
      trace.push(['apply', target.label, staged, pending, args.fault?.mode ?? null]);
      if (options.baselineFailure && target.label === 'r1-alternative') return { status: 'failed', execution: { ...outcome(), status: 1 } };
      if (args.fault) {
        state.frozen = true; state.survived = args.fault.mode === 'commit-to-ledger'; failed = target;
        const execution = { status: 1, signal: null, failure: null, stderr: `${options.wrongFault ? 'unrelated failure' : args.fault.marker} (SQLSTATE P0001)`, stdout: '' };
        if (options.timeout) execution.failure = 'timeout';
        if (options.faultExit) Object.assign(execution, options.faultExit);
        return { status: 'failed', execution, dryRun: outcome(pending.join('\n')), frozen: true };
      }
      if (options.rebuildFailure && target.label.startsWith('rebuild-')) return { status: 'failed', execution: { ...outcome(), status: 1 } };
      for (const entry of args.expectedPending) state.rows.push(row(entry));
      return { status: 'passed', execution: outcome(), dryRun: outcome(pending.join('\n')), frozen: false };
    },
    async snapshot(target) {
      const state = states.get(target);
      const records = [{ kind: 'schema', identity: 'public', owner: 'postgres', acl: null }];
      if (state.survived || state.rows.some(r => r.version === prepared.plan.canonical[128].version)) records.push(structuredClone(object));
      if (options.catalogDrift && target.label === 'r1-alternative') records[0].owner = 'unexpected_owner';
      const ledger = structuredClone(state.rows);
      if (options.statementDrift && target.label === 'r1-alternative') ledger[0].statements.push('drift');
      return { ledgerPresent: true, ledger, catalog: { schema: CATALOG_SCHEMA, coverage: [...CATALOG_COVERAGE], records },
        session: { measured: { method: 'fake TCP psql', observation: structuredClone(session) }, directCliSessionObserved: false }, receipts: {} };
    },
    async runChecks(target, specs) {
      assert(!states.get(target).frozen); trace.push(['checks', target.label, states.get(target).rows.length, specs]);
      if (specs.some(spec => spec.kind === 'race') && options.raceEvidence) {
        assert.deepEqual(specs, prepared.profile.races.map(r => ({ kind: 'race', name: r.name })));
        return { status: 'executed', checks: specs.map(spec => ({ ...spec, status: 'passed' })), raceEvidence: options.raceEvidence };
      }
      const checks = specs.map(spec => ({ ...spec, status: spec.kind === 'race' ? 'blocked' : spec.kind === 'candidate-precheck' ? 'passed' : 'executed',
        receipt: outcome(spec.kind === 'sql' ? (options.skippedTap ? '1..1\nok 1 # SKIP missing\n' : '1..1\nok 1 - synthetic\n') : '{}'),
        ...(spec.kind === 'race' ? { runtime: 'not_run', reason: 'independent_session_race_executor_not_supplied' } : {}) }));
      if (options.sqlFailure && specs.some(s => s.kind === 'sql')) checks[0].receipt.status = 1;
      return { status: specs.some(s => s.kind === 'race') ? 'blocked' : 'executed', checks, capabilities: { independentSessionRaces: false } };
    },
    async stopTarget(target) {
      trace.push(['remove', target.label]);
      if (options.unconfirmedRemoval) return { status: 'stopped' };
      active.delete(target); return { status: 'removed_and_observed_absent', id: target.id };
    },
    async cleanup() { trace.push(['cleanup']); active.clear(); return { status: options.cleanupFailure ? 'failed' : 'removed_and_observed_absent' }; },
  };
  const api = { inspectPrerequisites: () => ({ status: options.blocked ? 'blocked' : 'ready-for-runtime-preflight', runtimeVerified: false }),
    createCachedFixtureAdapter: () => { trace.push(['construct']); return adapter; } };
  return { api, trace, get max() { return max; }, get active() { return active.size; }, get failed() { return failed; } };
}

async function exercise(options = {}, execute = true) {
  const prepared = fixture();
  if (options.completeRaces) {
    const races = raceFixture(); const files = { ...prepared.profile.files, ...races.profile.files }; Object.assign(prepared.profile, races.profile, { files });
    for (const key of Object.keys(races.evidence.inputs)) races.evidence.inputs[key].sha256 = files[key];
    races.evidence.manifestSha256 = hash(Buffer.from(JSON.stringify(prepared.profile)));
    options = { ...options, raceEvidence: races.evidence };
  }
  const t = transport(prepared, options), saved = [];
  const run = createRunner({ prepareRelease: () => prepared, adapterApi: t.api });
  const result = await run({ input: {}, execute, runtime: { platform: { manifestBytes: platformBytes }, session: { expected: session },
    admission: { schema: 'fake-only', sourceCommit: CANDIDATE, planSha256: prepared.plan.planSha256 } }, signal: options.signal, save: value => saved.push({ status: value.status }) });
  return { result, t, saved, prepared };
}

test('default plan constructs no adapter, saves nothing and never claims runtime', async () => {
  const { result, t, saved } = await exercise({}, false);
  assert.equal(result.status, 'planned'); assert.equal(result.runtime, 'not_run'); assert.equal(result.qualification, 'mock-only');
  assert.deepEqual(t.trace, []); assert.deepEqual(saved, []);
});

test('pinned binding rejects changed profile, missing source closure and private baseline-shaped input', () => {
  const baseline = { schema: 'overdrafter.synthetic-baseline-ordinals.v1', ordinals: [...SYNTHETIC_BASELINE_ORDINALS] };
  assert.throws(() => prepareRelease({ profileBytes: Buffer.from('{}'), sourceFiles: new Map(), baseline }), /profile mismatch/);
  assert.throws(() => prepareRelease({ profileBytes: actualProfile, sourceFiles: new Map(), baseline: { versions: [] } }));
  assert.throws(() => prepareRelease({ profileBytes: actualProfile, sourceFiles: new Map(), baseline }), /not closed/);
  assert.throws(() => prepareRelease({ profileBytes: actualProfile, sourceFiles: new Map(), baseline: { ...baseline, ordinals: [1, 138] } }), /reviewed synthetic recipe/);
});

test('complete mocked orchestration keeps staged history, real ordering boundaries, fresh rebuilds and profile stages distinct', async () => {
  const { result, t, prepared } = await exercise();
  assert.equal(result.reason, undefined); assert.equal(result.r1.status, 'passed'); assert.equal(result.r2.status, 'passed');
  assert.equal(result.status, 'blocked'); assert.equal(result.profile.status, 'blocked'); assert.equal(result.qualification, 'mock-only');
  assert.equal(t.max, 2); assert.equal(t.active, 0);
  const pushes = t.trace.filter(e => e[0] === 'apply' && e[1] === 'r1-alternative');
  assert.equal(pushes.length, 2); assert.deepEqual(pushes[0][2], prepared.plan.baseline.map(f => f.version));
  assert.deepEqual(pushes[1][2], prepared.plan.canonical.map(f => f.version)); assert.deepEqual(pushes[1][3], prepared.plan.absent.map(f => f.version));
  assert(t.trace.findIndex(e => e[0] === 'remove' && e[1] === 'r2-reference') < t.trace.findIndex(e => e[0] === 'start' && e[1] === 'rebuild-committed-prefix'));
  for (const item of result.r2.cases) {
    assert.equal(item.ledger.safeToResume, false); assert.equal(item.recovery.status, 'passed');
    assert.equal(item.recovery.kind, 'synthetic-rebuild-recovery'); assert.equal(item.recovery.inPlaceFixForward, false);
    assert.equal(item.failedObjectSurvives, item.mode === 'commit-to-ledger');
  }
  const stages = t.trace.filter(e => e[0] === 'checks');
  assert.deepEqual(stages.filter(e => e[3][0].kind === 'sql').map(e => e[2]), [126,126,126,126,132,139,139,139,139,139,139,139]);
  const races = result.profile.checks.at(-1); assert.equal(races.specs.length, 18);
  assert(races.evidence.checks.every(c => c.runtime === 'not_run'));
});

test('unavailable prerequisites block before adapter construction', async () => {
  const { result, t } = await exercise({ blocked: true }); assert.equal(result.status, 'blocked');
  assert.equal(result.runtime, 'not_run'); assert.deepEqual(t.trace, []);
});

for (const option of ['wrongFault', 'timeout', 'rebuildFailure', 'unconfirmedRemoval', 'skippedTap', 'baselineFailure', 'cleanupFailure', 'sqlFailure']) {
  test(`${option} cannot be promoted and still invokes owned cleanup without retries`, async () => {
    const { result, t } = await exercise({ [option]: true }); assert.equal(result.status, 'failed');
    assert.equal(t.trace.filter(e => e[0] === 'cleanup').length, 1); assert.equal(t.active, 0);
    const rebuilds = t.trace.filter(e => e[0] === 'start' && e[1].startsWith('rebuild-'));
    if (option === 'wrongFault' || option === 'timeout' || option === 'unconfirmedRemoval') assert.equal(rebuilds.length, 0);
    if (option === 'rebuildFailure') assert.equal(rebuilds.length, 1);
  });
}

test('catalog and statement differences remain separate failures', async () => {
  const catalog = await exercise({ catalogDrift: true }); assert.equal(catalog.result.r1.catalogs.equal, false);
  assert.equal(catalog.result.r1.ledgerStatements.equal, true); assert.equal(catalog.result.status, 'failed');
  const statement = await exercise({ statementDrift: true }); assert.equal(statement.result.r1.catalogs.equal, true);
  assert.equal(statement.result.r1.ledgerStatements.equal, false); assert.equal(statement.result.status, 'failed');
});

test('TAP rejects omission, numbering drift, skip/TODO and false successes', () => {
  assert.deepEqual(acceptTap('ok 1 - valid\n1..1\n'), { assertions: 1, skipped: 0 });
  for (const value of ['', '1..0', '1..2\nok 1', '1..1\nok 2', '1..1\nnot ok 1', '1..1\nok 1 # TODO later', '1..1\nok 1 # SKIP', 'Bail out!']) assert.throws(() => acceptTap(value));
});

test('catalog source retains named grants, column ACLs, roles and all declared categories without data reads', () => {
  const sql = readFileSync(new URL('./catalog.sql', import.meta.url), 'utf8');
  for (const source of ['BEGIN READ ONLY', 'aclexplode', 'a.attacl', 'm.inherit_option', 'm.set_option', 'pg_get_function_identity_arguments', 'c.relforcerowsecurity', 'pg_default_acl', 'd.defaclnamespace', 'p.polwithcheck']) assert(sql.includes(source), source);
  assert(!/rolpassword|FROM\s+auth\.users|FROM\s+public\.jobs/i.test(sql));
});

// Invented observer receipts test the gate only; they do not simulate SQL locks.
function raceFixture() {
  const profile = { raceSetupSql: 'supabase/fixtures/setup.sql', files: {}, races: [] };
  const evidence = { status: 'completed', transport: 'free-quote-independent-psql-unix-socket-v1',
    backendCleanup: 'all-non-observer-backends-observed-absent',
    observerExit: 'normal-psql-exit; final backend inventory remains fixture-owner responsibility',
    sessions: {}, races: [], inputs: {}, phases: [], absences: [], shutdown: [] };
  const time = '2026-01-01T00:00:00Z'; let pid = 100;
  const open = name => {
    const identity = { pid: ++pid, database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres',
      serverAddress: null, clientAddress: null, backendStart: time };
    evidence.sessions[name] = { identity, exit: { code: 0, signal: null } };
    evidence.shutdown.push({ name, status: 'normal-exit', exit: { code: 0, signal: null } });
    if (name !== 'observer') evidence.absences.push({ pids: [pid], observerPid: evidence.sessions.observer.identity.pid, remaining: [], observedAt: time });
    return identity;
  };
  open('observer'); open('setup');
  const bind = file => { profile.files[file] = hash(Buffer.from(file)); evidence.inputs[file] = { sha256: profile.files[file], bytes: file.length }; };
  bind(profile.raceSetupSql); bind('supabase/fixtures/free_quote_lifecycle_races/races.json');
  const tap = (session, file) => {
    bind(file); const output = '1..1\nok 1 - invented receipt\n', outputSha256 = hash(Buffer.from(output));
    evidence.phases.push({ session, label: file, status: 'framed-completion', output, outputSha256, inputSha256: profile.files[file] });
    return { session, path: file, assertions: 1, outputSha256 };
  };
  for (let i = 0; i < 18; i++) {
    const name = 'race-' + i, prefix = 'supabase/fixtures/' + name;
    const spec = { name, setupSql: prefix + '-setup.sql', acquireSql: prefix + '-acquire.sql', releaseSql: prefix + '-release.sql',
      verifySql: prefix + '-verify.sql', contenders: [prefix + '-contender.sql'], ...(i === 0 ? { mode: 'complete-before-release', lockProbeSql: prefix + '-probe.sql' } : {}) };
    for (const file of [spec.setupSql, spec.acquireSql, spec.releaseSql]) bind(file);
    profile.races.push(spec); const coordinator = open(name + '-coordinator'), actor = open(name + '-contender-1'); open(name + '-verify');
    const probe = spec.lockProbeSql ? open(name + '-probe') : null;
    const overlap = label => ({ label, observerPid: evidence.sessions.observer.identity.pid, coordinatorPid: coordinator.pid,
      receipt: [{ pid: (probe ?? actor).pid, blockers: [coordinator.pid], waitEvent: 'transactionid', observedAt: time,
        backendStart: time, coordinatorBackendStart: time }] });
    evidence.races.push({ name, status: 'passed', mode: spec.mode ?? 'blocked-until-release',
      contenders: [tap(name + '-contender-1', spec.contenders[0])], verification: tap(name + '-verify', spec.verifySql),
      overlaps: probe ? [overlap('probe-blocked-before-contenders'), overlap('probe-blocked-after-passing-contenders')] : [overlap('all-contenders-blocked')],
      ...(probe ? { probe: tap(name + '-probe', spec.lockProbeSql) } : {}) });
  }
  const observation = { remaining: [], observedAt: time };
  evidence.ownerFinalBackendInventory = { status: 'all-other-client-backends-observed-absent', observation, receipt: outcome(JSON.stringify(observation)) };
  evidence.manifestSha256 = hash(Buffer.from(JSON.stringify(profile))); return { profile, evidence };
}

test('race gate accepts complete invented receipt and rejects missing/source-drift/serial/timing-only evidence', () => {
  const { profile, evidence } = raceFixture(); assert.equal(validateRaceEvidence(evidence, profile).races, 18);
  for (const mutate of [e => e.races.pop(), e => { e.backendCleanup = 'not_run'; },
    e => { e.races[1].overlaps = []; }, e => { e.races[1].overlaps[0].receipt[0].blockers = []; },
    e => { e.races[0].overlaps[1].receipt[0].coordinatorBackendStart = 'changed'; },
    e => { e.sessions['race-1-contender-1'].identity.pid = e.sessions.observer.identity.pid; },
    e => { e.phases[0].output = '1..1\nok 1 # SKIP unavailable'; },
    e => { e.inputs[profile.raceSetupSql].sha256 = '0'.repeat(64); }, e => { e.absences = []; },
    e => { e.ownerFinalBackendInventory.observation.remaining = [{ pid: 999 }]; },
    e => { e.sessions.observer.exit = { code: null, signal: 'SIGKILL' }; }]) {
    const changed = structuredClone(evidence); mutate(changed); assert.throws(() => validateRaceEvidence(changed, profile));
  }
});


test('complete fake race batch executes once and remains mock-only even when every gate passes', async () => {
  const { result, t } = await exercise({ completeRaces: true });
  assert.equal(result.reason, undefined); assert.equal(result.status, 'passed'); assert.equal(result.runtime, 'mock-only');
  const batches = t.trace.filter(e => e[0] === 'checks' && e[3][0].kind === 'race');
  assert.equal(batches.length, 1); assert.equal(batches[0][3].length, 18);
  assert.equal(result.profile.checks.at(-1).validation.races, 18);
});

test('pre-aborted run cannot construct an adapter or claim an attempted rehearsal', async () => {
  const controller = new AbortController(); controller.abort();
  const { result, t } = await exercise({ signal: controller.signal });
  assert.equal(result.status, 'blocked'); assert.equal(result.runtime, 'not_run'); assert.deepEqual(t.trace, []);
});


// Bound to unchanged public SQL, not captured runtime output. set_config returns
// the chosen value; RPC JSON below is representative shape, not an execution claim.
function pinnedSql(file) {
  const bytes = readFileSync(new URL('../../' + file, import.meta.url));
  assert.equal(hash(actualProfile), PROFILE_SHA256);
  assert.equal(hash(bytes), JSON.parse(actualProfile).files[file]);
  return bytes.toString('utf8');
}

test('TAP source-bound service-role setup permits its scalar and JSON stdout', () => {
  const sql = pinnedSql('supabase/fixtures/worker-compatibility/service_role.sql');
  const values = [...sql.matchAll(/select set_config\('request\.jwt\.(?:claim\.(?:sub|role)|claims)', '([^']*)', true\);/g)].map(match => match[1]);
  assert.deepEqual(values, ['', 'service_role', '{"role":"service_role"}']);
  assert(sql.includes("'synthetic operations use the native service role'"));
  assert.deepEqual(acceptTap(['1..1', ...values, 'ok 1 - synthetic operations use the native service role'].join('\n')), { assertions: 1, skipped: 0 });
});

test('TAP source-bound RPC suite permits representative JSON between assertions', () => {
  const sql = pinnedSql('supabase/fixtures/free-quote-qualification/free-quote-job-meter.expanded.sql');
  assert(sql.includes("select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id,0)) from cases where name='zero';"));
  assert(sql.includes("'known finite zero quote is usable'"));
  const stdout = '1..2\nok 1 - setup\n{"resultId":"invented","metadata":{"note":"TODO and SKIP are JSON data"}}\nok 2 - known finite zero quote is usable\n';
  assert.deepEqual(acceptTap(stdout), { assertions: 2, skipped: 0 });
});

test('TAP source-bound SKIP LOCKED description is not a skipped assertion', () => {
  const sql = pinnedSql('supabase/fixtures/free_quote_lifecycle_races/00-common-setup.sql');
  const suffix = /v_race\.name\|\|'(: SKIP LOCKED completes before release)'/.exec(sql)?.[1];
  assert.equal(suffix, ': SKIP LOCKED completes before release');
  assert.deepEqual(acceptTap('1..1\nok 1 - two-sweepers-pages' + suffix), { assertions: 1, skipped: 0 });
});

test('mixed stdout never masks malformed TAP, failures, directives or incomplete plans', () => {
  const around = value => 'service_role\n{"role":"service_role"}\n' + value + '\n42\n';
  for (const value of ['1..1\nok one', '1..one\nok 1', '1..1\nOK 1', '1..1\nnotok 1',
    '1..1\nnot ok 1', '1..1\nok 1\nnot ok garbage', '1..1\nok 1\nBail out! failure',
    '1..1\nok 1 # sKiP blocked', '1..1\nok 1 # tOdO later', '1..0 # SKIP all',
    '1..1\nok 1\n1..1', '1..2\nok 1\nok 1', '1..2\nok 1', '1..1\nok 1\nok 2',
    'ok 1', '{"ok":true}', '1..9007199254740992\nok 1']) assert.throws(() => acceptTap(around(value)), value);
  assert.deepEqual(acceptTap(around('# TODO here is a diagnostic\nok 1 - TODO wording and SKIP LOCKED describe behavior\n1..1')), { assertions: 1, skipped: 0 });
});


for (const [name, faultExit] of [
  ['null-SIGKILL', { status: null, signal: 'SIGKILL' }],
  ['null-no-signal', { status: null }], ['missing-status', { status: undefined }],
  ['string-status', { status: '1' }], ['negative-status', { status: -1 }],
  ['fractional-status', { status: 1.5 }], ['out-of-range-status', { status: 256 }],
  ['zero-status', { status: 0 }], ['numeric-SIGTERM', { status: 1, signal: 'SIGTERM' }],
  ['missing-signal', { signal: undefined }], ['missing-failure', { failure: undefined }],
  ['transport-failure', { failure: 'exit_unconfirmed' }],
]) {
  test(`R2 rejects marker-bearing ${name} receipt before post-failure snapshot or rebuild`, async () => {
    const { result, t } = await exercise({ faultExit, completeRaces: true });
    assert.equal(result.status, 'failed', JSON.stringify({ status: result.status, r2: result.r2.status,
      cases: result.r2.cases.map(c => ({ mode: c.mode, status: c.status, recovery: c.recovery.status })) }));
    assert.equal(result.r2.status, 'failed'); assert.equal(result.r2.cases.length, 0);
    assert.equal(t.trace.filter(e => e[0] === 'start' && e[1].startsWith('rebuild-')).length, 0);
    assert.equal(t.trace.filter(e => e[0] === 'cleanup').length, 1);
    assert.match(result.reason, /not injected SQL failure/);
  });
}

test('R2 accepts normal positive numeric error exits with explicit null signal and failure', async () => {
  for (const status of [1, 255]) {
    const { result } = await exercise({ faultExit: { status, signal: null, failure: null }, completeRaces: true });
    assert.equal(result.status, 'passed'); assert.equal(result.runtime, 'mock-only');
    assert.equal(result.r2.cases.length, 3);
    assert(result.r2.cases.every(c => c.failure.execution.status === status && c.failure.execution.signal === null && c.failure.execution.failure === null));
  }
});
