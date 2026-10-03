/** Explicit, source-reviewed alternative transport. Never provisions or changes authentication. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIMIT = 8_000_000;
const OPERATIONS = new Set(['claim', 'complete', 'legacy', 'attention-a', 'attention-b', 'expire', 'allocate', 'legacy-high']);
export const IDENTITY_SQL = `select jsonb_build_object('pid',pg_backend_pid(),'database',current_database(),'sessionUser',session_user,'currentUser',current_user,'serverAddress',inet_server_addr(),'clientAddress',inet_client_addr(),'backendStart',(select backend_start from pg_stat_activity where pid=pg_backend_pid()));`;

/** No ambient host libpq values, password wrapper, -h TCP route, or shell command. */
export function clientArgs(container, options, actor) {
  assert.match(container, /^ovd591-[a-z0-9-]+$/);
  assert.equal(options, '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000');
  return ['exec', '-i', '-e', `PGOPTIONS=${options} -capplication_name=${actor ? 'ovd591-race' : 'ovd591-coordinator'} -cclient_min_messages=warning`,
    container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-w', '-v', 'ON_ERROR_STOP=1'];
}

export class PsqlSession {
  constructor(child, name, record, { timeoutMs = 25_000, limit = LIMIT, consume = () => {} } = {}) {
    this.child = child; this.name = name; this.record = record; this.timeoutMs = timeoutMs; this.limit = limit;
    this.buffer = ''; this.bytes = 0; this.pending = null; this.failed = null; this.ending = false;
    record.stdout = ''; record.stderr = ''; record.submissions = []; record.exit = null;
    this.closed = new Promise(resolveClose => { this.resolveClose = resolveClose; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      try { consume(Buffer.byteLength(data)); } catch (error) { this.fail(error); return; }
      this.bytes += Buffer.byteLength(data);
      if (this.bytes > limit) return this.fail(new Error(`${name}: output limit`));
      record.stdout += data; this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
        const pending = this.pending;
        if (!pending) { this.fail(new Error(`${name}: unsolicited output`)); continue; }
        if (line === pending.marker) {
          clearTimeout(pending.timer); this.pending = null; pending.resolve(pending.lines.join('\n') + (pending.lines.length ? '\n' : ''));
        } else if (line.startsWith('ovd591-frame-')) this.fail(new Error(`${name}: stale or foreign acknowledgment`));
        else pending.lines.push(line);
      }
    });
    child.stderr.on('data', data => {
      try { consume(Buffer.byteLength(data)); } catch (error) { this.fail(error); return; }
      this.bytes += Buffer.byteLength(data);
      if (this.bytes <= limit) record.stderr += data;
      this.fail(new Error(`${name}: unexpected stderr`));
    });
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.on('close', (code, signal) => {
      record.exit = { code, signal };
      if (!this.ending || this.pending || this.buffer || code !== 0 || signal) this.fail(new Error(`${name}: incomplete or failed process exit`));
      this.resolveClose(record.exit);
    });
  }
  fail(error) {
    this.failed ??= error;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failed); this.pending = null; }
  }
  request(sql) {
    if (this.failed) return Promise.reject(this.failed);
    assert(!this.pending && !this.ending, `${this.name}: concurrent request`);
    assert(typeof sql === 'string' && Buffer.byteLength(sql) < this.limit);
    const marker = `ovd591-frame-${randomUUID()}`;
    this.record.submissions.push({ marker, sql });
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${this.name}: phase deadline`)), this.timeoutMs);
      this.pending = { marker, lines: [], resolve: resolveRequest, reject, timer };
      this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  async close() {
    if (!this.ending) {
      this.ending = true;
      if (!this.child.stdin.destroyed) this.child.stdin.end('\\q\n');
    }
    let timer;
    try {
      await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${this.name}: shutdown unconfirmed`)), this.timeoutMs); })]);
      if (this.failed) throw this.failed;
    } finally { clearTimeout(timer); }
  }
}
export function oneJson(output) {
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one JSON row required');
  return JSON.parse(lines[0]);
}
export function acceptIdentity(value) {
  assert(value && Number.isSafeInteger(value.pid) && value.pid > 0);
  assert.equal(value.database, 'postgres'); assert.equal(value.sessionUser, 'postgres'); assert.equal(value.currentUser, 'postgres');
  assert.equal(value.serverAddress, null); assert.equal(value.clientAddress, null);
  assert(typeof value.backendStart === 'string' && Number.isFinite(Date.parse(value.backendStart)));
  return value;
}
export function acceptOverlap(receipt, actors, coordinator) {
  assert(Array.isArray(receipt) && receipt.length === actors.length, 'wrong overlap count');
  assert.deepEqual(receipt.map(row => row.pid).sort((a,b) => a-b), [...actors].sort((a,b) => a-b), 'wrong actor PIDs');
  for (const row of receipt) {
    assert(Array.isArray(row.blockers) && row.blockers.includes(coordinator), 'coordinator is not blocker');
    assert(typeof row.waitEvent === 'string' && row.waitEvent.length > 0);
    assert(typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt)), 'database timestamp missing');
  }
}
export function actorResult(output) {
  const value = oneJson(output);
  assert(value && Object.keys(value).sort().join(',') === 'result,sqlstate', 'invalid actor result');
  assert(value.sqlstate === null || typeof value.sqlstate === 'string' && /^[A-Z0-9]{5}$/.test(value.sqlstate));
  assert(value.sqlstate === null ? value.result !== null && typeof value.result === 'object' : value.result === null);
  return value;
}
/** PostgreSQL text COPY data: every control/backslash escaped; never executable output. */
export function resultCopy(rows) {
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  return 'copy race_results(name,result) from stdin;\n' + rows.map(({ name, value }) => {
    assert(/^[a-z-]+$/.test(name));
    return `${escape(name)}\t${escape(JSON.stringify(value))}\n`;
  }).join('') + '\\.\n';
}

/** Factory injection is solely for synthetic process tests; production entry supplies fixed docker args. */
export async function executePhases(phases, makeSession, { timeoutMs = 120_000, shutdownMs = 25_000, evidence = {} } = {}) {
  assert.equal(phases.schema, 'ovd591.psql-phases.v1');
  assert.equal(phases.races.length, 6);
  evidence.transport = 'persistent-psql-unix-socket-v1'; evidence.sessions = {}; evidence.races = [];
  evidence.backendCleanup = 'unconfirmed';
  const sessions = {};
  let stdout = '', timer;
  const collect = async sql => {
    const output = await sessions.coordinator.request(sql); stdout += output;
    assert(!output.split(/\r?\n/).some(line => /^(not ok\b|Bail out!)/i.test(line.trim())), 'coordinator TAP failure');
    return output;
  };
  const work = async () => {
    for (const name of ['coordinator', 'a', 'b']) sessions[name] = makeSession(name, evidence.sessions[name] = {});
    const identities = await Promise.all(Object.entries(sessions).map(async ([name, session]) => {
      const identity = acceptIdentity(oneJson(await session.request(IDENTITY_SQL)));
      evidence.sessions[name].identity = identity; return identity;
    }));
    assert.equal(new Set(identities.map(v => v.pid)).size, 3, 'three independent sessions required');
    // All connections established before setup or the two-second expiry allocation.
    await collect(phases.setup);
    for (const race of phases.races) {
      assert(/^[a-z-]+$/.test(race.name));
      assert(race.actors.length >= 1 && race.actors.length <= 2);
      assert.equal(new Set(race.actors.map(v => v.session)).size, race.actors.length);
      // The preceding setup/after SQL ends only after BEGIN and lock acquisition.
      const pending = race.actors.map(actor => {
        assert(['a', 'b'].includes(actor.session) && OPERATIONS.has(actor.operation));
        const promise = sessions[actor.session].request(`select private.ovd591_fixture_call('${actor.operation}');`);
        // A transport failure must not become an expected business SQLSTATE.
        promise.catch(() => {}); return promise;
      });
      await collect(race.observe);
      const overlap = oneJson(await sessions.coordinator.request(`select receipt from overlap_receipts where name='${race.name}';`));
      acceptOverlap(overlap, race.actors.map(actor => evidence.sessions[actor.session].identity.pid), identities[0].pid);
      evidence.races.push({ name: race.name, overlap });
      // Includes original pre-release TAP, SQL-clock wait, or same-session append.
      await collect(race.release);
      const outputs = await Promise.all(pending);
      const rows = outputs.map((output, index) => ({ name: race.actors[index].resultName, value: actorResult(output) }));
      evidence.races.at(-1).results = rows;
      await collect(resultCopy(rows));
      await collect(race.after);
    }
    await Promise.all([sessions.a.close(), sessions.b.close()]);
    const pids = [identities[1].pid, identities[2].pid];
    const remaining = oneJson(await sessions.coordinator.request(`select count(*) from pg_stat_activity where pid in (${pids.join(',')});`));
    assert.equal(remaining, 0, 'actor backends must be absent before helper cleanup');
    evidence.backendCleanup = 'actors-observed-absent';
    await collect(phases.finish);
    await sessions.coordinator.close();
    evidence.coordinatorExit = 'normal-psql-exit; final backend inventory remains fixture-owner responsibility';
    return stdout;
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new Error('concurrency suite deadline');
      for (const session of Object.values(sessions)) session.fail(error);
      reject(error);
    }, timeoutMs); })]);
  } finally {
    clearTimeout(timer);
    evidence.stdout = stdout;
    // EOF queues quit after any running statement; statement timeout is still 20s.
    // Killing a Docker CLI is containment only, never backend termination evidence.
    evidence.shutdown = await Promise.all(Object.entries(sessions).map(async ([name, session]) => {
      let cleanupTimer;
      try {
        await Promise.race([session.close(), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('bounded shutdown expired')), shutdownMs); })]);
        return { name, status: 'normal-exit' };
      } catch (error) {
        session.child.kill('SIGKILL');
        session.child.stdin?.destroy(); session.child.stdout?.destroy(); session.child.stderr?.destroy();
        session.child.unref?.();
        return { name, status: 'unconfirmed', containment: 'own-cli-only; backend termination unproven', error: error.message };
      } finally { clearTimeout(cleanupTimer); }
    }));
  }
}
export async function runPsqlConcurrency({ root, container, psqlOptions, out }) {
  const phasePath = 'supabase/tests/capability_runtime_persistence_psql.phases.json';
  const bytes = readFileSync(resolve(root, phasePath)); const phases = JSON.parse(bytes);
  const original = readFileSync(resolve(root, 'supabase/tests/capability_runtime_persistence_concurrency.sql'));
  assert.equal(createHash('sha256').update(original).digest('hex'), phases.originalSha256, 'reviewed original SQL mismatch');
  const evidence = { phasePath, phaseSha256: createHash('sha256').update(bytes).digest('hex'), startedAt: new Date().toISOString() };
  let outputBytes = 0;
  const consume = count => { outputBytes += count; assert(outputBytes <= LIMIT, 'aggregate session output limit'); };
  try {
    const output = await executePhases(phases, (name, record) => {
      const args = clientArgs(container, psqlOptions, name !== 'coordinator'); record.command = ['docker', ...args];
      return new PsqlSession(spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }), name, record, { consume });
    }, { evidence });
    evidence.status = 'completed'; return output;
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; }
  finally {
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(resolve(out, 'psql-concurrency-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    for (const [name, record] of Object.entries(evidence.sessions ?? {})) {
      writeFileSync(resolve(out, `psql-${name}.stdout`), record.stdout ?? '');
      writeFileSync(resolve(out, `psql-${name}.stderr`), record.stderr ?? '');
    }
    writeFileSync(resolve(out, 'capability_runtime_persistence_concurrency.stdout'), evidence.stdout ?? '');
  }
}
