/** Separate retention protocol. Imports framing primitives, never changes OVD-591's six races. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PsqlSession, IDENTITY_SQL, clientArgs, oneJson, acceptIdentity, acceptOverlap,
  actorResult, resultCopy } from './ovd591-psql-concurrency.mjs';

export const PHASE_PATH = 'supabase/tests/capability_preparation_concurrency.phases.json';
export const GROUPS = ['duplicate-claim', 'changed-claim', 'shared-completion', 'duplicate-completion',
  'duplicate-attention', 'numeric-order', 'commit-visibility', 'rollback-gap', 'replay-authority'];
const CASES = ['duplicate-claim', 'changed-claim', 'shared-completion', 'duplicate-completion',
  'duplicate-attention', 'changed-attention', 'numeric-order', 'visible-claim', 'visible-attention', 'rollback-gap', 'replay-authority'];
const OPERATIONS = new Set(['duplicate-claim', 'changed-claim-a', 'changed-claim-b', 'shared-completion-a',
  'shared-completion-b', 'duplicate-completion', 'duplicate-attention', 'changed-attention-a', 'changed-attention-b',
  'numeric-a', 'numeric-b', 'visible-claim-a', 'visible-claim-b', 'visible-attention-a', 'visible-attention-b', 'rollback-a', 'rollback-b']);
const HELD = new Map([['visible-claim', 'held-commit'], ['visible-attention', 'held-commit'], ['rollback-gap', 'held-rollback']]);
export const ASSERTIONS = 90;
const LIMIT = 8_000_000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function admitPhases(phases) {
  assert.equal(phases.schema, 'ovd591.retention-psql-phases.v1');
  assert.deepEqual(Object.keys(phases.sourceReferences).sort(), [
    'supabase/tests/capability_preparation_persistence.sql',
    'supabase/tests/capability_runtime_persistence_concurrency.sql',
  ]);
  for (const hash of Object.values(phases.sourceReferences)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(phases.groups, GROUPS); assert.equal(phases.assertions, ASSERTIONS);
  assert.deepEqual(phases.cases.map(value => value.name), CASES);
  assert.deepEqual([...new Set(phases.cases.map(value => value.group))], GROUPS);
  for (const item of phases.cases) {
    assert.equal(item.mode, HELD.get(item.name) ?? 'race');
    assert.deepEqual(item.actors.map(value => value.session), ['a', 'b']);
    for (const actor of item.actors) {
      assert(OPERATIONS.has(actor.operation)); assert.equal(actor.resultName, `${item.name}-${actor.session}`);
    }
    for (const field of ['before', 'whileHeld', 'after']) assert.equal(typeof item[field], 'string');
    assert.equal(Boolean(item.whileHeld), HELD.has(item.name));
  }
  assert.equal(typeof phases.setup, 'string'); assert.equal(typeof phases.finish, 'string');
}

export async function executeRetentionPhases(phases, makeSession, {
  timeoutMs = 180_000, shutdownMs = 25_000, signal, evidence = {},
} = {}) {
  admitPhases(phases);
  evidence.transport = 'persistent-psql-unix-socket-v1'; evidence.sessions = {}; evidence.cases = [];
  evidence.backendCleanup = 'unconfirmed';
  const sessions = {};
  let stdout = '', timer;
  const assertActive = () => assert(!signal?.aborted, 'retention qualification cancelled');
  const collect = async sql => {
    assertActive();
    if (!sql) return '';
    const output = await sessions.coordinator.request(sql); assertActive(); stdout += output;
    assert(!output.split(/\r?\n/).some(line => /^(not ok\b|Bail out!)/i.test(line.trim())), 'retention TAP failure');
    return output;
  };
  const stop = error => { for (const session of Object.values(sessions)) session.fail(error); };
  const cancelled = () => stop(new Error('retention qualification cancelled'));
  signal?.addEventListener('abort', cancelled, { once: true });
  const start = actor => {
    assertActive();
    const result = sessions[actor.session].request(`select private.ovd591_retention_call('${actor.operation}');`);
    result.catch(() => {}); return result;
  };
  const work = async () => {
    assertActive();
    for (const name of ['coordinator', 'a', 'b']) sessions[name] = makeSession(name, evidence.sessions[name] = {});
    const identities = await Promise.all(Object.entries(sessions).map(async ([name, session]) => {
      const identity = acceptIdentity(oneJson(await session.request(IDENTITY_SQL)));
      evidence.sessions[name].identity = identity; return identity;
    }));
    assertActive(); assert.equal(new Set(identities.map(value => value.pid)).size, 3, 'three independent sessions required');
    const pid = name => evidence.sessions[name].identity.pid;
    const observe = async (record, actors, blocker, label) => {
      assertActive();
      const pids = actors.map(actor => pid(actor));
      const receipt = oneJson(await sessions.coordinator.request(
        `select pg_temp.await_retention_overlap(array[${pids.join(',')}]::integer[],${pid(blocker)});`));
      acceptOverlap(receipt, pids, pid(blocker)); assertActive();
      record.overlaps.push({ label, blocker: pid(blocker), receipt });
      // Values are validated real SQL receipts, and this assertion belongs to the coordinator TAP stream.
      await collect(`select is(${receipt.length},${pids.length},'${record.name}: ${label} exact backends overlap');`);
    };
    await collect(phases.setup);
    for (const item of phases.cases) {
      assertActive();
      const record = { name: item.name, group: item.group, mode: item.mode, overlaps: [] };
      evidence.cases.push(record);
      await collect(item.before);
      await collect('begin; select pg_advisory_xact_lock(591,1);');
      let outputs;
      if (item.mode === 'race') {
        const pending = item.actors.map(start);
        await observe(record, ['a', 'b'], 'coordinator', 'coordinator-held');
        await collect('commit;');
        outputs = await Promise.all(pending);
      } else {
        // Actor A retains its real transaction/lock after returning its preparation receipt.
        await sessions.a.request('begin;'); assertActive();
        const first = start(item.actors[0]);
        await observe(record, ['a'], 'coordinator', 'first-actor-waits');
        await collect('commit;');
        const firstOutput = await first; actorResult(firstOutput); assertActive();
        const second = start(item.actors[1]);
        await observe(record, ['b'], 'a', 'second-actor-waits-for-publication');
        await collect(item.whileHeld);
        await sessions.a.request(item.mode === 'held-rollback' ? 'rollback;' : 'commit;'); assertActive();
        outputs = [firstOutput, await second];
      }
      assertActive();
      const rows = outputs.map((output, index) => ({ name: item.actors[index].resultName, value: actorResult(output) }));
      record.results = rows;
      await collect(resultCopy(rows));
      await collect(item.after);
    }
    await Promise.all([sessions.a.close(), sessions.b.close()]); assertActive();
    const remaining = oneJson(await sessions.coordinator.request(`select count(*) from pg_stat_activity where pid in (${pid('a')},${pid('b')});`));
    assert.equal(remaining, 0, 'retention actor backends remain'); evidence.backendCleanup = 'actors-observed-absent';
    await collect(phases.finish);
    await sessions.coordinator.close(); assertActive();
    evidence.coordinatorExit = 'normal-psql-exit; final inventory remains fixture-owner responsibility';
    return stdout;
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new Error('retention suite deadline'); stop(error); reject(error);
    }, timeoutMs); })]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancelled); evidence.stdout = stdout;
    evidence.shutdown = await Promise.all(Object.entries(sessions).map(async ([name, session]) => {
      let deadline;
      try {
        await Promise.race([session.close(), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('shutdown deadline')), shutdownMs);
        })]);
        return { name, status: 'normal-exit' };
      } catch {
        session.child.kill('SIGKILL');
        session.child.stdin?.destroy(); session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref?.();
        return { name, status: 'unconfirmed', containment: 'owned-cli-only; backend termination unproven' };
      } finally { clearTimeout(deadline); }
    }));
  }
}

export async function runRetentionConcurrency({ root, container, psqlOptions, out, signal }) {
  const bytes = readFileSync(resolve(root, PHASE_PATH)), phases = JSON.parse(bytes); admitPhases(phases);
  for (const [path, expected] of Object.entries(phases.sourceReferences)) {
    assert.equal(sha(readFileSync(resolve(root, path))), expected, 'retention source-reference drift');
  }
  const evidence = { phasePath: PHASE_PATH, phaseSha256: sha(bytes), startedAt: new Date().toISOString() };
  let total = 0;
  const consume = count => { total += count; assert(total <= LIMIT, 'retention aggregate output bound'); };
  try {
    const output = await executeRetentionPhases(phases, (name, record) => {
      const args = clientArgs(container, psqlOptions, name !== 'coordinator'); record.command = ['docker', ...args];
      return new PsqlSession(spawn('docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }), name, record, { consume });
    }, { evidence, signal });
    evidence.status = 'completed'; return output;
  } catch { evidence.status = 'failed'; throw new Error('retention concurrency failed; inspect fixed synthetic receipts'); }
  finally {
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(resolve(out, 'retention-concurrency-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    for (const [name, record] of Object.entries(evidence.sessions ?? {})) {
      writeFileSync(resolve(out, `retention-${name}.stdout`), record.stdout ?? '');
      writeFileSync(resolve(out, `retention-${name}.stderr`), record.stderr ?? '');
    }
    writeFileSync(resolve(out, 'capability_preparation_concurrency.stdout'), evidence.stdout ?? '');
  }
}
