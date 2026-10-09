import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const RACE_SOURCE_COMMIT = 'bbd78c05e726ce55f4fff1e4fd5fdec7bdd33f3b';
export const RACE_PROFILE_SHA256 = '58404b1a4747e141df1a18e4615b5e52027815d3bc1a5e288e61eef2bb440713';
export const RACE_HELPER_SHA256 = Object.freeze({
  'scripts/free-quote-psql-races.mjs': '61d8bc30649e71d2159a265401b4aeb7917a0ebb74c747d6e4c6f32cb2071ef4',
  'scripts/ovd591-psql-concurrency.mjs': '8437eaec9bb2158cd1049b34cec2eeb5f6ba77d54838c15f0ff4587f23d45e28',
  'scripts/ovd591-sql-qualification.mjs': '38c0369381bf153506bef9d4be76d0260566da0a42f722120fa451ae72809945',
  'scripts/ovd591-libpq-environment.mjs': 'c03bb3b721aca0c68bd1af9f20fae20eb5233cc8caa45728d56ceb089bf25005',
  'scripts/ovd591-qualification-paths.mjs': 'ef453ac2cd4ca672f5c293a8502d1262e1c1ff1d670d32eb36ad697054638412',
});
export const RACE_NAMES = Object.freeze([
  'meter-same-approval-full', 'meter-distinct-last-slot', 'sweep-before-success-deferred',
  'sweep-before-success-immediate', 'sweep-before-cancel-deferred', 'sweep-before-cancel-immediate',
  'cancel-before-sweep-deferred', 'cancel-before-sweep-immediate', 'task-revival', 'two-sweepers-pages',
  'admission-before-delete-rc', 'delete-before-admission-rc', 'admission-before-delete-rr',
  'delete-before-admission-rr', 'admission-before-delete-serializable', 'delete-before-admission-serializable',
  'success-before-sweep-deferred', 'success-before-sweep-immediate',
]);
const LIMIT = 8_000_000;
const OPTIONS = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000 -cclient_min_messages=warning';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const bound = (n, max, name) => assert(Number.isSafeInteger(n) && n > 0 && n <= max, `invalid ${name}`);

/** Only verified bytes are imported; no caller filename/module resolution. Each
 * relative import is rebound to another verified immutable data module. The old
 * CLI entry points remain uncalled. Importing this bridge itself does no work.
 */
export async function loadPinnedRaceEngine(helperFiles) {
  assert(helperFiles instanceof Map && helperFiles.size === 5, 'exact five-helper closure required');
  const sources = new Map();
  for (const [name, expected] of Object.entries(RACE_HELPER_SHA256)) {
    const bytes = helperFiles.get(name);
    assert(Buffer.isBuffer(bytes) && digest(bytes) === expected, `pinned helper mismatch: ${name}`);
    sources.set(name, utf8(bytes));
  }
  const urls = new Map();
  const url = (name) => {
    if (urls.has(name)) return urls.get(name);
    assert(sources.has(name), 'unbound helper import');
    const source = sources.get(name).replace(/from '(\.\/[^']+)'/g, (_whole, relative) => {
      const target = path.posix.join(path.posix.dirname(name), relative);
      return `from '${url(target)}'`;
    });
    const result = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    urls.set(name, result); return result;
  };
  return import(url('scripts/free-quote-psql-races.mjs'));
}

export function prepareRacePackage({ sourceFiles, profileManifestBytes }) {
  assert(Buffer.isBuffer(profileManifestBytes) && digest(profileManifestBytes) === RACE_PROFILE_SHA256, 'pinned race profile required');
  const profile = JSON.parse(utf8(profileManifestBytes));
  assert(sourceFiles instanceof Map && sourceFiles.size === Object.keys(profile.files).length, 'closed source map required');
  assert.equal(sourceFiles.size, 174);
  const source = new Map();
  for (const [name, expected] of Object.entries(profile.files)) {
    const bytes = sourceFiles.get(name);
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < LIMIT && digest(bytes) === expected, `race source mismatch: ${name}`);
    const text = utf8(bytes); assert(!text.includes('\0'), 'NUL in race source'); source.set(name, text);
  }
  const manifestPath = 'supabase/fixtures/free_quote_lifecycle_races/races.json';
  const manifest = JSON.parse(source.get(manifestPath));
  assert.deepEqual(manifest.races, profile.races); assert.equal(manifest.raceSetupSql, profile.raceSetupSql);
  assert.deepEqual(manifest.races.map((race) => race.name), RACE_NAMES, 'exact eighteen race definitions required');
  const paths = new Set([manifestPath, manifest.raceSetupSql]);
  for (const race of manifest.races) {
    for (const value of [race.setupSql, race.acquireSql, ...race.contenders, race.releaseSql, race.verifySql]) paths.add(value);
    if (race.lockProbeSql) paths.add(race.lockProbeSql);
  }
  const sql = {}; const inputs = {};
  for (const name of paths) {
    assert(source.has(name), 'missing admitted race input');
    sql[name] = source.get(name); inputs[name] = { sha256: profile.files[name], bytes: Buffer.byteLength(sql[name]) };
  }
  return { raceSetupSql: manifest.raceSetupSql, races: manifest.races, sql, inputs, manifestSha256: digest(JSON.stringify(profile)) };
}

/** Shape checks supplement the adapter's live tool/target ownership admission.
 * No host URL, shell, PATH Docker lookup, inherited libpq environment or password.
 */
export function validateRaceProcessSpec(spec) {
  assert(spec && path.isAbsolute(spec.binary) && path.normalize(spec.binary) === spec.binary && path.basename(spec.binary) === 'docker', 'absolute Docker executable required');
  assert(/^[a-f0-9]{64}$/.test(spec.sha256), 'Docker identity required');
  assert(path.isAbsolute(spec.cwd) && path.normalize(spec.cwd) === spec.cwd, 'owned absolute cwd required');
  const a = spec.args;
  assert(Array.isArray(a) && a.every((v) => typeof v === 'string' && !v.includes('\0')));
  assert.equal(a.length, 30, 'exact socket psql argv required');
  assert.equal(a[0], '--host'); assert.match(a[1], /^unix:\/\//);
  const socket = a[1].slice(7); assert(path.isAbsolute(socket) && path.normalize(socket) === socket);
  assert.deepEqual(a.slice(2, 6), ['--config', spec.env?.DOCKER_CONFIG, 'exec', '-i']);
  assert.match(a[6], /^[a-f0-9]{64}$/, 'owned immutable container ID required');
  assert.deepEqual(a.slice(7, 9), ['env', '-i']);
  assert.match(a[9], /^PATH=\/[A-Za-z0-9_./:-]+$/);
  for (const directory of a[9].slice(5).split(':')) assert(path.isAbsolute(directory) && path.normalize(directory) === directory, 'absolute image PATH components required');
  assert.deepEqual(a.slice(10), ['HOME=/tmp/ovd658-home', 'LANG=C', 'LC_ALL=C', 'PGHOST=/var/run/postgresql', 'PGPORT=5432',
    'PGPASSFILE=/dev/null/ovd658-disabled', `PGOPTIONS=${OPTIONS}`, 'PGAPPNAME=ovd658-race',
    'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose']);
  assert.deepEqual(new Set(Object.keys(spec.env)), new Set(['DOCKER_CONFIG', 'HOME', 'LANG', 'LC_ALL']));
  assert.equal(spec.env.LANG, 'C'); assert.equal(spec.env.LC_ALL, 'C');
  for (const key of ['HOME', 'DOCKER_CONFIG']) assert(path.isAbsolute(spec.env[key]) && path.normalize(spec.env[key]) === spec.env[key]);
  return { ...spec, args: [...a], env: { ...spec.env } };
}

class FramedSession {
  constructor(spec, name, record, { timeoutMs, limit, consume, offline = false }) {
    bound(timeoutMs, 25_000, 'phase deadline'); bound(limit, LIMIT, 'session output limit');
    this.name = name; this.record = record; this.timeoutMs = timeoutMs; this.limit = limit;
    this.buffer = ''; this.bytes = 0; this.pending = null; this.failed = null; this.ending = false; this.exited = false;
    this.decoders = { stdout: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }), stderr: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }) };
    const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
    Object.assign(record, { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      timeoutMs, maxOutputBytes: limit, startedAt: new Date().toISOString(),
      submissions: [], exit: null, processCleanup: 'pending', qualification: offline ? 'offline-test-only' : 'owned-session' });
    this.child = spawn(spec.binary, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise((resolve) => { this.resolveClose = resolve; });
    for (const stream of ['stdout', 'stderr']) this.child[stream].on('data', (bytes) => {
      try {
        record[stream + 'Bytes'] += bytes.length; hashes[stream].update(bytes);
        this.bytes += bytes.length; consume(bytes.length);
        if (this.bytes > this.limit) throw new Error(`${name}: output limit`);
        const text = this.decoders[stream].decode(bytes, { stream: true }); record[stream] += text;
        if (stream === 'stderr') throw new Error(`${name}: unexpected stderr`);
        this.receive(text);
      } catch (error) { this.fail(error); }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('close', (code, signal) => {
      this.exited = true; record.exit = { code, signal }; record.processCleanup = 'process-close-observed';
      record.finishedAt = new Date().toISOString();
      for (const stream of ['stdout', 'stderr']) record[stream + 'Sha256'] = hashes[stream].digest('hex');
      try {
        for (const stream of ['stdout', 'stderr']) assert.equal(this.decoders[stream].decode(), '', 'incomplete UTF-8 stream');
        assert(this.ending && !this.pending && !this.buffer && code === 0 && signal === null, `${name}: incomplete or failed process exit`);
      } catch (error) { this.fail(error); }
      this.resolveClose(record.exit);
    });
  }
  receive(text) {
    this.buffer += text;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending;
      if (!pending) { this.fail(new Error(`${this.name}: unsolicited output`)); continue; }
      if (line === pending.marker) {
        clearTimeout(pending.timer); this.pending = null; pending.resolve(pending.lines.join('\n') + (pending.lines.length ? '\n' : ''));
      } else if (line.startsWith('ovd591-frame-')) this.fail(new Error(`${this.name}: stale or foreign acknowledgment`));
      else pending.lines.push(line);
    }
  }
  fail(error) {
    this.failed ??= error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failed); this.pending = null; }
  }
  request(sql) {
    if (this.failed) return Promise.reject(this.failed);
    assert(!this.pending && !this.ending, `${this.name}: concurrent or closed request`);
    assert(typeof sql === 'string' && Buffer.byteLength(sql) < this.limit, 'bounded SQL submission required');
    const marker = `ovd591-frame-${randomUUID()}`;
    this.record.submissions.push({ marker, sql });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${this.name}: phase deadline`)), this.timeoutMs);
      this.pending = { marker, timer, resolve, reject, lines: [] };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  contain() {
    if (this.exited) return;
    this.record.processCleanup = 'kill-requested; backend-unproven';
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') this.record.containmentError = error.code ?? 'unknown'; }
  }
  async close() {
    if (!this.ending) { this.ending = true; if (!this.child.stdin.destroyed) this.child.stdin.end('\\q\n'); }
    let timer;
    try {
      await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => {
        this.contain(); reject(new Error(`${this.name}: shutdown unconfirmed`));
      }, this.timeoutMs); })]);
      if (this.failed) throw this.failed;
    } finally { clearTimeout(timer); }
  }
}

/** Explicit offline seam: can only launch this Node binary, never produce an
 * admitted race receipt. Real runOwnedRaces has no injectable session factory.
 */
export function createOfflineRaceSession({ args, name = 'offline', record = {}, timeoutMs = 1_000, limit = 65_536, consume = () => {} }) {
  const session = new FramedSession({ binary: process.execPath, args, cwd: process.cwd(), env: {} }, name, record,
    { timeoutMs, limit, consume, offline: true });
  return { session, record, qualification: 'offline-test-only' };
}

export function acceptRaceCompletion(evidence, races) {
  assert.deepEqual(races.map((race) => race.name), RACE_NAMES);
  assert.equal(evidence.races?.length, 18);
  assert.deepEqual(evidence.races.map((race) => race.name), RACE_NAMES);
  for (let i = 0; i < 18; i++) {
    assert.equal(evidence.races[i].status, 'passed');
    assert.equal(evidence.races[i].mode, races[i].mode ?? 'blocked-until-release');
  }
  assert.equal(evidence.backendCleanup, 'all-non-observer-backends-observed-absent');
  assert.equal(evidence.observerExit, 'normal-psql-exit; final backend inventory remains fixture-owner responsibility');
  assert(Object.keys(evidence.sessions ?? {}).length > 18 && evidence.shutdown?.length === Object.keys(evidence.sessions).length);
  assert.deepEqual(new Set(evidence.shutdown.map((receipt) => receipt.name)), new Set(Object.keys(evidence.sessions)), 'one shutdown receipt for every session required');
  for (const record of Object.values(evidence.sessions)) assert.deepEqual(record.exit, { code: 0, signal: null });
  for (const receipt of evidence.shutdown) assert.equal(receipt.status, 'normal-exit');
}

export async function runOfflineRaceEngine({ helperFiles, pkg, makeSession, evidence = {}, options = {} }) {
  evidence.qualification = 'offline-test-only'; evidence.status = 'simulating';
  try {
    const engine = await loadPinnedRaceEngine(helperFiles);
    await engine.executeFreeQuoteRaces(pkg, makeSession, { ...options, evidence });
    acceptRaceCompletion(evidence, pkg.races);
    evidence.status = 'simulated-completed';
    return { status: 'simulated-completed', qualification: 'offline-test-only', raceEvidence: evidence };
  } catch (error) { evidence.status = 'simulation-failed'; throw error; }
  finally { evidence.qualification = 'offline-test-only'; }
}

/** Called only by the adapter after current owned-target/tool admission. A passed
 * engine still requires the adapter's final observer/backend inventory receipt.
 */
export async function runOwnedRaces({ sourceFiles, profileManifestBytes, helperFiles, processSpec, evidence = {}, deadlineMs, signal }) {
  bound(deadlineMs, 300_000, 'race budget'); assert(deadlineMs > 25_000, 'race cleanup reserve required');
  const spec = validateRaceProcessSpec(processSpec);
  const pkg = prepareRacePackage({ sourceFiles, profileManifestBytes });
  const engine = await loadPinnedRaceEngine(helperFiles);
  assert(!signal?.aborted, 'race already cancelled');
  const sessions = []; let outputBytes = 0; let deadline;
  const consume = (size) => { outputBytes += size; assert(outputBytes <= LIMIT, 'aggregate session output limit'); };
  Object.assign(evidence, { qualification: 'synthetic-only', sourceCommit: RACE_SOURCE_COMMIT,
    helperHashes: { ...RACE_HELPER_SHA256 }, profileSha256: RACE_PROFILE_SHA256,
    startedAt: new Date().toISOString(), finalBackendInventory: 'owner-required', status: 'running' });
  try {
    deadline = setTimeout(() => { for (const session of sessions) { session.fail(new Error('race absolute deadline')); session.contain(); } }, deadlineMs);
    await engine.executeFreeQuoteRaces(pkg, (name, record) => {
      const stat = lstatSync(spec.binary);
      assert(stat.isFile() && !stat.isSymbolicLink() && realpathSync(spec.binary) === spec.binary && digest(readFileSync(spec.binary)) === spec.sha256, 'Docker binary changed');
      const args = [...spec.args]; args[17] = name.endsWith('-coordinator') ? 'PGAPPNAME=ovd658-coordinator' : 'PGAPPNAME=ovd658-race';
      record.command = [spec.binary, ...args];
      const session = new FramedSession({ ...spec, args }, name, record, { timeoutMs: 25_000, limit: LIMIT, consume });
      sessions.push(session); return session;
    }, { evidence, signal, timeoutMs: Math.min(240_000, deadlineMs - 25_000), shutdownMs: 25_000, overlapMs: 4_000, absenceMs: 2_000 });
    acceptRaceCompletion(evidence, pkg.races); evidence.status = 'completed';
    return { status: 'passed', raceEvidence: evidence };
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
  finally {
    clearTimeout(deadline);
    for (const session of sessions) if (!session.exited) session.contain();
    evidence.finishedAt = new Date().toISOString(); evidence.outputBytes = outputBytes;
  }
}
