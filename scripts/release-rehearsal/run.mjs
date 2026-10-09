/** Synthetic rehearsal only. Import and default plan never construct a runtime adapter. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, classifyLedger, compareCatalogs, buildFaultCopy, MANIFEST_SCHEMA } from './core.mjs';

export const CANDIDATE = 'bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b';
export const PROFILE_SHA256 = '58404b1a4747e141df1a18e4615b5e52027815d3bc1a5e288e61eef2bb440713';
export const PLATFORM_SHA256 = '5513f6b047d5519bc8b381803b3caf483070180b88b24b486a9c1f1486315a78';
export const PROFILE_MODULE_SHA256 = '3e91b9e2dc4ff47c0531a0a3c54b5f8e41cb6b5458f08b68824fc8f5565c89c6';
export const SYNTHETIC_BASELINE_ORDINALS = Object.freeze([...Array.from({ length: 128 }, (_, i) => i + 1), 134]);
export const RACE_HELPER_PINS = Object.freeze({
  'scripts/free-quote-psql-races.mjs': '61d8bc30649e71d2159a265401b4aeb7917a0ebb74c747d6e4c6f32cb2071ef4',
  'scripts/ovd591-psql-concurrency.mjs': '8437eaec9bb2158cd1049b34cec2eeb5f6ba77d54838c15f0ff4587f23d45e28',
  'scripts/ovd591-sql-qualification.mjs': '38c0369381bf153506bef9d4be76d0260566da0a42f722120fa451ae72809945',
  'scripts/ovd591-libpq-environment.mjs': 'c03bb3b721aca0c68bd1af9f20fae20eb5233cc8caa45728d56ceb089bf25005',
  'scripts/ovd591-qualification-paths.mjs': 'ef453ac2cd4ca672f5c293a8502d1262e1c1ff1d670d32eb36ad697054638412',
});
const PROFILE_PATH = 'scripts/fixtures/free-quote-ci-source.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const serial = value => JSON.stringify(value, null, 2) + '\n';
const versions = files => files.map(file => file.version);
const identity = value => sha(Buffer.from(serial(value)));

export function prepareRelease({ profileBytes, sourceFiles, baseline }) {
  assert(Buffer.isBuffer(profileBytes) && sha(profileBytes) === PROFILE_SHA256, 'pinned profile mismatch');
  const profile = JSON.parse(profileBytes);
  assert.equal(profile.schema, 'free-quote-ci-source.v1');
  assert.equal(profile.migrationCount, 139); assert.equal(profile.baselineCount, 126);
  assert.equal(profile.contractMigrationCount, 133); assert.equal(Object.keys(profile.files).length, 174);
  assert.deepEqual(Object.keys(baseline).sort(lexical), ['ordinals', 'schema']);
  assert.equal(baseline.schema, 'overdrafter.synthetic-baseline-ordinals.v1');
  assert(Array.isArray(baseline.ordinals) && baseline.ordinals.length > 0);
  let previous = 0;
  for (const ordinal of baseline.ordinals) {
    assert(Number.isInteger(ordinal) && ordinal > previous && ordinal <= 139, 'baseline ordinals must be unique ordered candidate positions');
    previous = ordinal;
  }
  assert.deepEqual(baseline.ordinals, SYNTHETIC_BASELINE_ORDINALS, 'only reviewed synthetic recipe 1..128 plus134 is admitted');
  const manifest = { schema: MANIFEST_SCHEMA, sourceCommit: CANDIDATE,
    migrations: profile.migrations.map(file => ({ path: file, version: path.basename(file).split('_')[0], sha256: profile.files[file] })),
    inputs: Object.entries(profile.files).sort(([a], [b]) => lexical(a, b)).map(([file, digest]) => ({ path: file, sha256: digest })) };
  const plan = buildPlan({ manifest, sourceFiles, baselineVersions: baseline.ordinals.map(i => manifest.migrations[i - 1].version) });
  assert(plan.absent.some(a => plan.baseline.some(b => a.version < b.version)), 'R1 requires an explicitly non-prefix synthetic baseline');
  assert(!baseline.ordinals.includes(129), 'R2 migration129 must be absent from the synthetic baseline');
  const faultFile = plan.canonical[128], faultBytes = sourceFiles.get(faultFile.path);
  const terminal = /(?:\r?\n)?[ \t]*COMMIT;[ \t]*(?:\r?\n)?$/i.exec(faultBytes.toString('utf8'));
  assert(terminal, 'reviewed migration129 terminal COMMIT absent');
  const terminalAnchor = { text: terminal[0], offset: Buffer.byteLength(faultBytes.toString('utf8').slice(0, terminal.index)) };
  for (const mode of ['committed-prefix', 'in-file', 'commit-to-ledger']) buildFaultCopy({ bytes: faultBytes,
    expectedSha256: faultFile.sha256, mode, anchor: mode === 'committed-prefix'
      ? { text: faultBytes.toString('utf8').split('\n')[0] + '\n', offset: 0 } : terminalAnchor });
  const fault129 = { path: faultFile.path, sha256: faultFile.sha256, terminalAnchor, sourceOnly: true };
  // Copy buffers: caller mutation cannot alter the admitted source after planning.
  return { plan, profile, fault129, baseline: structuredClone(baseline), profileSha256: PROFILE_SHA256,
    sourceFiles: new Map([...sourceFiles].map(([file, bytes]) => [file, Buffer.from(bytes)])) };
}

export function planDescription({ plan, profile, baseline, profileSha256, fault129 }) {
  return { schema: 'overdrafter.release-rehearsal-run-plan.v1', qualification: 'synthetic-only',
    sourceCommit: plan.sourceCommit, planSha256: plan.planSha256, profileSha256, baseline, fault129,
    canonical: versions(plan.canonical), baselineOrder: versions(plan.baseline), absentOrder: versions(plan.absent),
    phases: ['r1-canonical', 'r1-baseline-then-absent', 'r2-uninterrupted-reference',
      'r2-committed-prefix', 'r2-in-file', 'r2-commit-to-ledger', 'closed-profile-canonical'],
    checkpoints: [profile.baselineCount, ...profile.migrationProbes.map(p => p.afterMigration), profile.contractMigrationCount, profile.migrationCount],
    recovery: 'fresh synthetic rebuild only; never retry failed target', runtime: 'not_run',
    historicalRestoration: false, productionReadiness: false };
}

// Reject skipped/TODO assertions, bailouts, gaps, duplicates and incomplete plans.
// Pinned psql suites interleave scalar/JSON setup results with TAP. Ignore only
// non-TAP rows; reserved TAP prefixes must parse strictly. Transport success is
// checked by the caller and cannot be inferred from assertion text.
export function acceptTap(text) {
  assert.equal(typeof text, 'string');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let plan = null; const seen = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    assert(!/^bail[ \t]*out\b/i.test(line), 'TAP bailout');
    if (!/^(?:not[ \t]*ok\b|ok\b|[0-9]+[ \t]*\.\.)/i.test(line)) continue;
    assert(!/#\s*(?:SKIP|TODO)\b/i.test(line), 'TAP incomplete or skipped');
    const count = /^1\.\.(\d+)$/.exec(line);
    if (count) { assert.equal(plan, null, 'duplicate TAP plan'); plan = Number(count[1]); continue; }
    const item = /^(not ok|ok)\s+(\d+)(?:\s.*)?$/.exec(line);
    assert(item, 'unexpected TAP output'); assert.equal(item[1], 'ok', 'TAP assertion failed');
    assert.equal(Number(item[2]), seen.length + 1, 'TAP numbering gap'); seen.push(Number(item[2]));
  }
  assert(Number.isSafeInteger(plan) && plan > 0 && seen.length === plan, 'TAP plan incomplete');
  return { assertions: plan, skipped: 0 };
}

/** Validate actual independent-session evidence, not serial SQL or elapsed delays. */
export function validateRaceEvidence(evidence, profile) {
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.transport, 'free-quote-independent-psql-unix-socket-v1');
  assert.equal(profile.races.length, 18);
  assert.deepEqual(evidence.races.map(r => r.name), profile.races.map(r => r.name));
  assert.equal(evidence.backendCleanup, 'all-non-observer-backends-observed-absent');
  assert.equal(evidence.observerExit, 'normal-psql-exit; final backend inventory remains fixture-owner responsibility');
  const sessions = evidence.sessions, pids = new Set();
  const inputPaths = new Set([profile.raceSetupSql, 'supabase/fixtures/free_quote_lifecycle_races/races.json']);
  const sessionNames = ['observer', 'setup'];
  for (const spec of profile.races) {
    for (const file of [spec.setupSql, spec.acquireSql, spec.releaseSql, spec.verifySql, ...spec.contenders, ...(spec.lockProbeSql ? [spec.lockProbeSql] : [])]) inputPaths.add(file);
    sessionNames.push(`${spec.name}-coordinator`, ...spec.contenders.map((_, i) => `${spec.name}-contender-${i + 1}`), `${spec.name}-verify`);
    if (spec.mode === 'complete-before-release') sessionNames.push(`${spec.name}-probe`);
  }
  assert.deepEqual(Object.keys(sessions).sort(lexical), sessionNames.sort(lexical));
  assert.deepEqual(Object.keys(evidence.inputs).sort(lexical), [...inputPaths].sort(lexical));
  for (const file of inputPaths) assert.equal(evidence.inputs[file].sha256, profile.files[file], 'race input binding mismatch');
  assert.equal(evidence.manifestSha256, sha(Buffer.from(JSON.stringify(profile))), 'race manifest binding mismatch');
  for (const record of Object.values(sessions)) {
    const value = record.identity;
    assert(Number.isSafeInteger(value.pid) && value.pid > 0 && !pids.has(value.pid)); pids.add(value.pid);
    assert.equal(value.database, 'postgres'); assert.equal(value.sessionUser, 'postgres'); assert.equal(value.currentUser, 'postgres');
    assert.equal(value.serverAddress, null); assert.equal(value.clientAddress, null);
    assert(Number.isFinite(Date.parse(value.backendStart))); assert.deepEqual(record.exit, { code: 0, signal: null });
  }
  const tapReceipt = receipt => {
    assert(Number.isSafeInteger(receipt.assertions) && receipt.assertions > 0);
    const phase = evidence.phases.find(p => p.session === receipt.session && p.label === receipt.path);
    assert(phase && phase.status === 'framed-completion');
    assert.equal(sha(Buffer.from(phase.output)), receipt.outputSha256);
    assert.equal(phase.outputSha256, receipt.outputSha256); assert.equal(phase.inputSha256, profile.files[receipt.path]);
    assert.equal(acceptTap(phase.output).assertions, receipt.assertions);
  };
  for (const [i, race] of evidence.races.entries()) {
    const spec = profile.races[i]; assert.equal(race.status, 'passed');
    assert.equal(race.mode, spec.mode ?? 'blocked-until-release');
    assert.deepEqual(race.contenders.map(c => c.path), spec.contenders); race.contenders.forEach(tapReceipt); tapReceipt(race.verification);
    assert.deepEqual(race.contenders.map(c => c.session), spec.contenders.map((_, j) => `${race.name}-contender-${j + 1}`));
    assert.equal(race.verification.session, `${race.name}-verify`);
    assert.equal(race.verification.path, spec.verifySql);
    const coordinator = sessions[`${race.name}-coordinator`].identity;
    const expectedLabels = spec.mode === 'complete-before-release'
      ? ['probe-blocked-before-contenders', 'probe-blocked-after-passing-contenders'] : ['all-contenders-blocked'];
    assert.deepEqual(race.overlaps.map(o => o.label), expectedLabels);
    if (spec.mode === 'complete-before-release') { tapReceipt(race.probe); assert.equal(race.probe.path, spec.lockProbeSql); assert.equal(race.probe.session, `${race.name}-probe`); }
    for (const overlap of race.overlaps) {
      const names = spec.mode === 'complete-before-release' ? [`${race.name}-probe`] : spec.contenders.map((_, j) => `${race.name}-contender-${j + 1}`);
      assert.equal(overlap.coordinatorPid, coordinator.pid); assert.equal(overlap.observerPid, sessions.observer.identity.pid);
      assert.deepEqual([...overlap.receipt.map(r => r.pid)].sort((a, b) => a - b), names.map(n => sessions[n].identity.pid).sort((a, b) => a - b));
      for (const row of overlap.receipt) {
        const actor = names.map(n => sessions[n].identity).find(s => s.pid === row.pid);
        assert.equal(row.backendStart, actor.backendStart); assert.equal(row.coordinatorBackendStart, coordinator.backendStart);
        assert(row.blockers.includes(coordinator.pid) && typeof row.waitEvent === 'string' && row.waitEvent.length > 0);
        assert(Number.isFinite(Date.parse(row.observedAt)));
      }
    }
  }
  for (const [name, session] of Object.entries(sessions)) {
    assert(evidence.shutdown.some(s => s.name === name && s.status === 'normal-exit' && s.exit.code === 0 && s.exit.signal === null));
    if (name !== 'observer') assert(evidence.absences.some(a => a.pids.includes(session.identity.pid) &&
      a.observerPid === sessions.observer.identity.pid && a.remaining.length === 0 && Number.isFinite(Date.parse(a.observedAt))));
  }
  const inventory = evidence.ownerFinalBackendInventory;
  assert.equal(inventory?.status, 'all-other-client-backends-observed-absent');
  assert.deepEqual(inventory.observation.remaining, []);
  assert(Number.isFinite(Date.parse(inventory.observation.observedAt)));
  assert.equal(inventory.receipt.status, 0); assert(!inventory.receipt.failure);
  assert.deepEqual(JSON.parse(inventory.receipt.stdout), inventory.observation);
  return { status: 'passed', races: evidence.races.length, backendCleanup: evidence.backendCleanup,
    directCliSessionObserved: false, evidenceSha256: identity(evidence) };
}

function admitRunner(runtime, plan) {
  const admission = runtime.runnerAdmission;
  assert.equal(admission?.schema, 'overdrafter.release-rehearsal-runner-admission.v1');
  assert.equal(admission.sourceCommit, CANDIDATE); assert.equal(admission.planSha256, plan.planSha256);
  assert.equal(admission.profileSha256, PROFILE_SHA256); assert.equal(admission.recovery, 'synthetic-rebuild-v1');
  assert(Number.isFinite(Date.parse(admission.expiresAt)) && Date.parse(admission.expiresAt) > Date.now());
  assert.deepEqual(admission.files.map(f => f.path), ['adapter.mjs', 'catalog.sql', 'core.mjs', 'races.mjs', 'run.mjs']);
  assert.deepEqual(admission.helperFiles, Object.entries(RACE_HELPER_PINS).sort(([a], [b]) => lexical(a, b)).map(([path, sha256]) => ({ path, sha256 })));
  assert(runtime.races?.helperFiles instanceof Map && runtime.races.helperFiles.size === 5);
  assert.equal(sha(runtime.races.profileManifestBytes), PROFILE_SHA256);
  for (const [file, digest] of Object.entries(RACE_HELPER_PINS)) assert.equal(sha(runtime.races.helperFiles.get(file)), digest, 'race helper admission mismatch');
  for (const entry of admission.files) assert.equal(sha(readFileSync(new URL(entry.path, import.meta.url))), entry.sha256, 'runner source admission mismatch');
}

function checkedSnapshot(snapshot, expected) {
  assert(snapshot && snapshot.ledgerPresent === true && Array.isArray(snapshot.ledger), 'observed CLI ledger required');
  assert.deepEqual([...snapshot.ledger.map(row => row.version)].sort(lexical), [...expected].sort(lexical), 'ledger membership mismatch');
  assert(snapshot.session, 'measured session evidence required');
  compareCatalogs(snapshot.catalog, snapshot.catalog); // Validate coverage and named semantics.
  return JSON.parse(serial(snapshot));
}

function compareLedger(left, right) {
  const ordered = rows => [...rows].sort((a, b) => lexical(a.version, b.version));
  const a = ordered(left), b = ordered(right);
  return { equal: serial(a) === serial(b), leftSha256: identity(a), rightSha256: identity(b),
    evidence: 'actual CLI version/name/ordered-statements; not migration byte hashes or chronology' };
}

/** Injected dependencies are for source tests only, never selectable by CLI/JSON.
 * Their receipts are always mock-only even if a fake reports success.
 */
export function createRunner(dependencies = {}) {
  const simulation = Object.keys(dependencies).length > 0;
  if (simulation) assert(typeof dependencies.prepareRelease === 'function' && dependencies.adapterApi,
    'test preparation and fake adapter must be injected together');
  const prepare = dependencies.prepareRelease ?? prepareRelease;
  return async function run({ input, execute = false, runtime, save = () => {}, signal }) {
    const prepared = prepare(input), { plan, profile, sourceFiles } = prepared;
    const report = { ...planDescription(prepared), qualification: simulation ? 'mock-only' : 'synthetic-only',
      status: execute ? 'running' : 'planned', operations: [], r1: { status: 'not_run' },
      r2: { status: 'not_run', cases: [] }, profile: { status: 'not_run', checks: [] }, cleanup: { status: 'not_run' } };
    if (!execute) return report;
    let adapter;
    let removeAbortListener = () => {};
    const active = new Set();
    const persist = () => save(JSON.parse(serial(report)));
    try {
      assert(!signal?.aborted, 'rehearsal cancelled before runtime');
      const catalogBytes = readFileSync(new URL('./catalog.sql', import.meta.url));
      if (!simulation) { admitRunner(runtime, plan); report.runnerAdmission = structuredClone(runtime.runnerAdmission); }
      const api = dependencies.adapterApi ?? await import('./adapter.mjs');
      const adapterOptions = { ...runtime }; delete adapterOptions.runnerAdmission;
      const options = { ...adapterOptions, plan, sourceFiles, catalog: { bytes: catalogBytes, sha256: sha(catalogBytes) } };
      assert.equal(sha(options.platform.manifestBytes), PLATFORM_SHA256, 'platform manifest mismatch');
      report.preflight = api.inspectPrerequisites(options); persist();
      assert.equal(report.preflight.status, 'ready-for-runtime-preflight', 'runtime prerequisites blocked');
      adapter = api.createCachedFixtureAdapter(options);
      const abort = () => adapter.abort();
      if (signal) {
        assert.equal(typeof adapter.abort, 'function', 'adapter cancellation required');
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      }
      const start = async label => {
        assert(active.size < 2, 'container ceiling');
        const started = await adapter.startTarget(label); active.add(started.target);
        report.operations.push({ phase: label, action: 'start', evidence: started }); persist(); return started.target;
      };
      const stop = async target => {
        const receipt = await adapter.stopTarget(target);
        assert(['removed_and_observed_absent', 'observed_absent'].includes(receipt?.status), 'owned removal must be observed before capacity release');
        active.delete(target); report.operations.push({ phase: target.label, action: 'remove', evidence: receipt }); persist();
      };
      const apply = async (target, files, expectedPending, fault = null) => {
        // Actual CLI needs all local history, not an absent-only project directory.
        for (const file of files) assert.equal(sha(sourceFiles.get(file.path)), file.sha256, 'original source drift');
        const invocation = { phase: target.label, action: 'apply', staged: files, expectedPending,
          fault, evidence: await adapter.apply(target, { files, expectedPending, cliMode: 'apply', fault }) };
        report.operations.push(invocation); persist(); return invocation.evidence;
      };
      const successfulApply = async (target, files, pending) => {
        const receipt = await apply(target, files, pending); assert.equal(receipt.status, 'passed', 'CLI apply failed');
      };
      const snapshot = async (target, expected) => {
        const value = checkedSnapshot(await adapter.snapshot(target), expected);
        assert.deepEqual(value.session.measured?.observation, runtime.session.expected, 'snapshot session contract drift');
        const evidence = { phase: target.label, action: 'snapshot', sha256: identity(value), value };
        report.operations.push(evidence); persist(); return value;
      };
      const checks = async (target, specs, stage) => {
        const result = await adapter.runChecks(target, specs);
        const record = { stage, specs, evidence: result, status: result.status };
        report.profile.checks.push(record); persist();
        if (!['executed', 'passed'].includes(result.status)) return record;
        assert.equal(result.checks.length, specs.length, 'missing check receipt');
        for (const [i, spec] of specs.entries()) {
          const item = result.checks[i]; assert.equal(item.kind, spec.kind, 'check kind mismatch');
          if (spec.kind === 'sql') assert.equal(item.path, spec.path, 'check source mismatch');
          if (spec.kind === 'race') { assert.equal(item.name, spec.name, 'race receipt order mismatch'); assert.equal(item.status, 'passed'); }
          if (spec.kind === 'sql') {
            assert.equal(item.receipt.status, 0); assert(!item.receipt.failure);
            item.tap = acceptTap(item.receipt.stdout);
          } else if (spec.kind !== 'race') assert.equal(item.status, 'passed', 'check acceptance not proven');
        }
        if (specs.some(spec => spec.kind === 'race')) record.validation = validateRaceEvidence(result.raceEvidence, profile);
        record.status = 'passed';
        persist(); return record;
      };
      const pgtap = async target => {
        const result = await adapter.runChecks(target, [{ kind: 'ensure-pgtap' }]);
        assert(['executed', 'passed'].includes(result.status) && result.checks.length === 1 &&
          result.checks[0].receipt.status === 0 && !result.checks[0].receipt.failure, 'pgTAP prerequisite blocked');
        report.operations.push({ phase: target.label, action: 'ensure-pgtap', evidence: result }); persist();
      };
      const fullReplay = async target => {
        await successfulApply(target, plan.baseline, plan.baseline);
        const baseline = await snapshot(target, versions(plan.baseline));
        await successfulApply(target, plan.canonical, plan.absent);
        const final = await snapshot(target, versions(plan.canonical));
        const ledger = classifyLedger({ plan, baselineLedger: baseline.ledger, currentLedger: final.ledger });
        assert.equal(ledger.status, 'final'); return { baseline, final, ledger };
      };

      // Pure ordering comparison has no qualification-fixture mutations.
      report.r1.status = 'running'; persist();
      const a = await start('r1-canonical'), b = await start('r1-alternative');
      await successfulApply(a, plan.canonical, plan.canonical);
      const canonical = await snapshot(a, versions(plan.canonical));
      const alternative = await fullReplay(b);
      report.r1 = { status: 'completed', catalogs: compareCatalogs(canonical.catalog, alternative.final.catalog),
        ledgerStatements: compareLedger(canonical.ledger, alternative.final.ledger), alternativeLedger: alternative.ledger,
        chronology: 'retained separate invocation staged manifests, pending order and CLI receipts', historicalRestoration: false };
      report.r1.status = report.r1.catalogs.equal && report.r1.ledgerStatements.equal ? 'passed' : 'failed'; persist();
      await stop(a); await stop(b);

      // Independent uninterrupted reference; no pgTAP/data fixtures contaminate it.
      report.r2.status = 'running'; persist();
      const referenceTarget = await start('r2-reference');
      const reference = await fullReplay(referenceTarget);
      const referenceBytes = serial(reference);
      const binding = { schema: 'overdrafter.synthetic-rebuild-reference.v1', sourceCommit: plan.sourceCommit,
        planSha256: plan.planSha256, profileSha256: prepared.profileSha256, baseline: prepared.baseline,
        admission: structuredClone(runtime.admission), runnerAdmission: runtime.runnerAdmission ?? null };
      const referenceSha256 = identity({ binding, reference });
      report.r2 = { status: 'running', referenceSha256, reference, binding, cases: [] }; persist();
      const faultFile = plan.canonical[128];
      assert(plan.absent.some(file => file.version === faultFile.version), 'fault129 must be pending');
      const earlier = plan.absent.filter(file => file.version < faultFile.version);
      const prefix = plan.canonical.filter(file => plan.baseline.some(base => base.version === file.version) || earlier.some(before => before.version === file.version));
      const terminal = /(?:\r?\n)?[ \t]*COMMIT;[ \t]*(?:\r?\n)?$/i.exec(sourceFiles.get(faultFile.path).toString('utf8'));
      assert(terminal, 'reviewed migration129 terminal COMMIT absent');
      let referenceRemoved = false;
      for (const mode of ['committed-prefix', 'in-file', 'commit-to-ledger']) {
        const target = await start('r2-' + mode);
        await successfulApply(target, plan.baseline, plan.baseline);
        const baseline = await snapshot(target, versions(plan.baseline));
        if (earlier.length) await successfulApply(target, prefix, earlier);
        const before = await snapshot(target, versions(prefix));
        const bytes = sourceFiles.get(faultFile.path);
        const anchor = mode === 'committed-prefix'
          ? { text: bytes.toString('utf8').split('\n')[0] + '\n', offset: 0 }
          : { text: terminal[0], offset: Buffer.byteLength(bytes.toString('utf8').slice(0, terminal.index)) };
        const fault = { ...buildFaultCopy({ bytes, expectedSha256: faultFile.sha256, mode, anchor }), path: faultFile.path };
        const staged = plan.canonical.filter(file => prefix.some(p => p.version === file.version) || file.version === faultFile.version);
        const failure = await apply(target, staged, [faultFile], fault);
        assert.equal(failure.status, 'failed', 'expected injected failure was not observed');
        assert(failure.execution && Number.isInteger(failure.execution.status) &&
          failure.execution.status > 0 && failure.execution.status <= 255 &&
          failure.execution.signal === null && failure.execution.failure === null,
        'unconfirmed, signalled or failed transport exit is not injected SQL failure');
        assert((failure.execution.stderr + '\n' + failure.execution.stdout).includes(fault.marker), 'specific SQL fault marker missing');
        assert(/P0001/.test(failure.execution.stderr + '\n' + failure.execution.stdout), 'expected SQLSTATE not observed');
        const after = await snapshot(target, versions(prefix));
        const state = classifyLedger({ plan, baselineLedger: baseline.ledger, currentLedger: after.ledger });
        const catalog = compareCatalogs(before.catalog, after.catalog);
        const failedObject = 'private.capability_runtime_revisions';
        const exists = after.catalog.records.some(record => record.kind === 'relation' && record.identity === failedObject);
        const absentBefore = !before.catalog.records.some(record => record.kind === 'relation' && record.identity === failedObject);
        const unchangedLedger = compareLedger(before.ledger, after.ledger);
        const boundaryMatches = unchangedLedger.equal && (mode === 'commit-to-ledger' ? absentBefore && exists && !catalog.equal : catalog.equal);
        const item = { mode, status: boundaryMatches ? 'observed' : 'failed', fault, before, after,
          failure, ledger: state, unchangedLedger, catalog, failedObject, failedObjectSurvives: exists, safeToResume: false,
          recovery: { status: 'not_run', kind: 'synthetic-rebuild-recovery' } };
        item.failureEvidenceSha256 = identity({ fault, before, after, failure, state, catalog });
        report.r2.cases.push(item); persist();
        assert(boundaryMatches, 'observed catalog boundary differs from admitted fault');
        assert.equal(serial(reference), referenceBytes, 'reference receipt mutated');
        assert.equal(identity({ binding, reference }), referenceSha256, 'reference binding mutated');
        if (!referenceRemoved) { await stop(referenceTarget); referenceRemoved = true; }
        // Keep failed target intact while rebuilding on a distinct owned cluster.
        const rebuilt = await start('rebuild-' + mode);
        const restored = await fullReplay(rebuilt);
        item.recovery = { status: 'completed', kind: 'synthetic-rebuild-recovery',
          referenceSha256, rebuilt: restored,
          catalog: compareCatalogs(reference.final.catalog, restored.final.catalog),
          ledgerStatements: compareLedger(reference.final.ledger, restored.final.ledger),
          inPlaceFixForward: false, historicalRestoration: false, productionRecovery: false };
        item.recovery.status = item.recovery.catalog.equal && item.recovery.ledgerStatements.equal ? 'passed' : 'failed'; persist();
        assert.equal(item.recovery.status, 'passed', 'rebuild differs from immutable reference; no retry');
        await stop(rebuilt); await stop(target);
      }
      report.r2.status = 'passed'; persist();

      // Separate canonical target preserves exact profile stage semantics.
      report.profile.status = 'running'; persist();
      const qualification = await start('closed-profile'); await pgtap(qualification);
      let count = 0;
      for (const end of [126, 132, 133, 139]) {
        await successfulApply(qualification, plan.canonical.slice(0, end), plan.canonical.slice(count, end)); count = end;
        const paths = end === 126 ? profile.baselineSuites : end === 132 ? profile.migrationProbes.map(probe => probe.sql) : [];
        for (const file of paths) {
          const checked = await checks(qualification, [{ kind: 'sql', path: file, sha256: profile.files[file] }], 'after-' + end);
          assert.equal(checked.status, 'passed', 'staged profile check failed or unavailable');
        }
      }
      const precheck = await checks(qualification, [{ kind: 'candidate-precheck' }], 'candidate139-precheck');
      if (precheck.status === 'passed') {
        for (const file of [...profile.candidateSuites, ...profile.tapSuites]) {
          const checked = await checks(qualification, [{ kind: 'sql', path: file, sha256: profile.files[file] }], 'candidate139');
          assert.equal(checked.status, 'passed', 'candidate check failed or unavailable');
        }
        const races = await checks(qualification, profile.races.map(race => ({ kind: 'race', name: race.name })), 'independent-session-races');
        report.profile.status = races.status;
      } else report.profile.status = precheck.status;
      report.profile.workerCompatibility = 'not-qualified; archived-worker incompatibilities remain separate';
      await stop(qualification);
      report.status = report.r1.status === 'failed' ? 'failed' : report.profile.status === 'passed' ? 'passed' : 'blocked';
      report.runtime = simulation ? 'mock-only' : report.status === 'passed' ? 'synthetic-executed' : 'executed-incomplete';
    } catch (error) {
      report.status = adapter ? 'failed' : 'blocked'; report.reason = error.message;
      report.runtime = adapter ? (simulation ? 'mock-only' : 'attempted') : 'not_run';
      for (const phase of [report.r1, report.r2, report.profile]) if (phase.status === 'running') phase.status = 'failed';
    } finally {
      removeAbortListener();
      if (adapter) {
        try { report.cleanup = await adapter.cleanup(); }
        catch (error) { report.cleanup = { status: 'failed', reason: error.message }; }
        if (!['removed_and_observed_absent', 'not_started'].includes(report.cleanup.status)) report.status = 'failed';
      }
      persist();
    }
    return report;
  };
}

function sourceFile(root, relative) {
  assert(/^[A-Za-z0-9_./-]+$/.test(relative) && !relative.split('/').some(p => ['', '.', '..'].includes(p)), 'unsafe bundle path');
  const file = path.join(root, relative), info = lstatSync(file);
  assert(realpathSync(file) === file && info.isFile() && !info.isSymbolicLink() && info.size <= 8_000_000, 'unsafe bundle file');
  return readFileSync(file);
}

export async function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; assert(['--bundle', '--execute', '--evidence'].includes(key) && !flags.has(key), 'unknown/duplicate argument');
    flags.set(key, key === '--execute' ? true : argv[++i]);
  }
  const root = flags.get('--bundle'); assert(typeof root === 'string' && path.isAbsolute(root) && realpathSync(root) === root, 'absolute regular bundle root required');
  const profileBytes = sourceFile(root, PROFILE_PATH); assert.equal(sha(profileBytes), PROFILE_SHA256);
  const profile = JSON.parse(profileBytes);
  const input = { profileBytes, baseline: JSON.parse(sourceFile(root, 'synthetic-baseline.json')),
    sourceFiles: new Map(Object.keys(profile.files).map(file => [file, sourceFile(root, file)])) };
  let runtime, save;
  if (flags.has('--execute')) {
    const config = JSON.parse(sourceFile(root, 'runtime.json'));
    assert(!Object.hasOwn(config, 'sourceFiles') && !Object.hasOwn(config, 'plan') && !Object.hasOwn(config, 'catalog') && !Object.hasOwn(config, 'platform') && !Object.hasOwn(config, 'races'));
    const manifestBytes = sourceFile(root, 'platform-manifest.json'); assert.equal(sha(manifestBytes), PLATFORM_SHA256);
    const manifest = JSON.parse(manifestBytes);
    const profileModule = sourceFile(root, 'scripts/free-quote-ci-profile.mjs'); assert.equal(sha(profileModule), PROFILE_MODULE_SHA256);
    runtime = { ...config, races: { profileManifestBytes: profileBytes, helperFiles: new Map(Object.keys(RACE_HELPER_PINS).map(file => [file, sourceFile(root, file)])) }, platform: { manifestBytes, profileBytes: profileModule, files: new Map(['auth', 'storage'].flatMap(kind => manifest[kind].map(e => [kind + '/' + e.name, sourceFile(root, 'platform/' + kind + '/' + e.name)]))) } };
    const out = flags.get('--evidence'); assert(typeof out === 'string' && path.isAbsolute(out), 'fresh evidence directory required');
    const parent = path.dirname(out), stat = lstatSync(parent);
    assert(realpathSync(parent) === parent && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, 'private caller-owned evidence parent required');
    mkdirSync(out, { mode: 0o700 });
    save = report => writeFileSync(path.join(out, 'report.json'), serial(report), { mode: 0o600 });
  } else assert(!flags.has('--evidence'), 'plan does not write evidence');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (flags.has('--execute')) { process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); }
  try {
    const report = await createRunner()({ input, execute: flags.has('--execute'), runtime, save, signal: controller.signal });
    console.log(serial(report)); return report.status === 'planned' || report.status === 'passed' ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
