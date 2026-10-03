import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadFirstLoopProof, runFirstLoopProof, checkTap, reviewedAuthorityNames, redactFixtureTranscript } from './first-loop-local-sql.mjs';
const root = new URL('..', import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), 'first-loop-adapter-'));
const packet = join(directory, 'packet');
execFileSync('python3', ['scripts/prepare-first-loop-sql-ci.py', '--output', packet], { cwd: root });
const proof = loadFirstLoopProof(root, packet);
const diagnostic = JSON.stringify({ syntheticOnly: true, taskId: '50100000-0000-4000-8000-000000000001', attemptId: '50100000-0000-4000-8000-000000000002', evidenceId: '50100000-0000-4000-8000-000000000003', stopReceipt: {} });
const tap = `ok 1 - synthetic\n1..1\n${diagnostic}`;
const snapshot = JSON.stringify(['auth.users','storage.objects','storage.buckets','public.engineering_execution_attempts'].map(name => ({ name, digest: '1'.repeat(32) })));
const identity = 'first_loop_identity:postgres:ovd561_seed';
function setup(overrides = {}) {
  const calls = [], records = [];
  return { calls, records, options: { proof, deadline: Date.now()+300000,
    record: event => { records.push(event); },
    session: async sql => { calls.push(sql); return { code: 0, stdout: identity+'\n'+(sql.includes('SYNTHETIC METADATA ONLY') ? tap : sql.includes('first_loop_snapshot') ? snapshot : ''), stderr: '' }; }, ...overrides } };
}
test.after(() => rmSync(directory, { recursive: true }));
test('ordered stages, identities, before intent, rollback and final TAP', async () => {
  const { options, calls, records } = setup(); const result = await runFirstLoopProof(options);
  assert.equal(result.assertions, 1); assert.equal(result.rollback, 'exact_relation_snapshot_restored');
  assert.equal(calls.length, 9); assert.equal(records[0].status, 'started');
  assert.match(calls[0], /set local role ovd575/);
  assert.ok(calls.every(sql => sql.includes("current_user <> 'postgres'")));
});
test('source substitution makes zero calls', async () => {
  const { options, calls } = setup({ proof: { ...proof, fixture: proof.fixture+' ' } });
  await assert.rejects(runFirstLoopProof(options), /source_mismatch/); assert.equal(calls.length,0);
});
test('stage substitution makes zero calls', async () => {
  const { options,calls } = setup({ proof: { ...proof, sources: proof.sources.slice(1) } });
  await assert.rejects(runFirstLoopProof(options), /source_mismatch/); assert.equal(calls.length,0);
});
test('expired deadline makes zero calls', async () => {
  const { options,calls } = setup({ deadline: 1 }); await assert.rejects(runFirstLoopProof(options), /deadline/); assert.equal(calls.length,0);
});
test('SQL access failure prevents stages', async () => {
  let calls=0; const { options }=setup({ session: async () => { calls++; return { code:1,stdout:'',stderr:'denied' }; } });
  await assert.rejects(runFirstLoopProof(options), /execution_failed:access/); assert.equal(calls,1);
});
test('lost outcome is retained and never retried', async () => {
  const { options,records }=setup({ session: async () => { throw new Error('lost'); } });
  await assert.rejects(runFirstLoopProof(options), /session_outcome_unknown/); assert.equal(records.at(-1).status,'outcome_unknown'); assert.equal(records.length,2);
});
test('wrong actual identity fails even exit zero', async () => {
  const { options }=setup({ session: async () => ({ code:0,stdout:'',stderr:'' }) });
  await assert.rejects(runFirstLoopProof(options), /execution_failed/);
});
test('TAP rejects skips, TODO, duplicate plan, wrong numbering, bailout and missing diagnostic', () => {
  for (const value of [tap+'\n1..1',tap.replace('ok 1','ok 2'),tap+'\nBail out! broken',tap.replace('synthetic\n','synthetic # SKIP\n'),tap.replace('synthetic\n','synthetic # TODO\n'),'ok 1 - x\n1..1']) assert.throws(()=>checkTap(value));
});
test('disk fixture bytes must match reviewed digest', () => {
  const bad=join(directory,'first-loop.sql');writeFileSync(bad,'bad'); assert.throws(()=>loadFirstLoopProof(root,directory),/digest/);
});
test('portable entrypoint guards phase selection before runtime discovery', () => {
  assert.throws(()=>execFileSync(process.execPath,['scripts/ovd510-disposable-replay.mjs','--first-loop-packet=/absent'],{cwd:root,stdio:'pipe'}),error=>String(error.stderr).includes('first_loop_requires_reviewed_authority'));
});
test('no OVD558 SQL modification or role grants introduced in adapter', () => {
  assert.equal(readFileSync(join(root,'docs/release/ovd-558-verifier-authority-forward.sql'),'utf8'),execFileSync('git',['show','f4f0a087f041078244bbb28e081fe96d6418d036:docs/release/ovd-558-verifier-authority-forward.sql'],{cwd:root,encoding:'utf8'}));
});

test('offline authority baseline validates exact existing manifest pin', () => { assert.equal(reviewedAuthorityNames(root).length,117); });

test('empty snapshot cannot prove rollback', async () => {
  const {options}=setup({ session: async () => ({code:0,stdout:identity,stderr:''}) });
  await assert.rejects(runFirstLoopProof(options), /snapshot_invalid/);
});
test('SQL fixture loss records unresolved rollback', async () => {
  const {options, records}=setup(); const original=options.session;
  options.session=async sql=> { if(sql.includes('SYNTHETIC METADATA ONLY')) throw new Error('lost'); return original(sql); };
  await assert.rejects(runFirstLoopProof(options), /session_outcome_unknown/);
  assert.deepEqual(records.at(-1), {name:'rollback',status:'unresolved',reason:'execution_failed_or_unknown'});
});
test('TAP failure still verifies rollback', async () => {
  const {options,records}=setup(); const original=options.session;
  options.session=async sql=> { const result=await original(sql); if(sql.includes('SYNTHETIC METADATA ONLY')) result.stdout=result.stdout.replace('ok 1','not ok 1'); return result; };
  await assert.rejects(runFirstLoopProof(options), /tap_failed/); assert.equal(records.at(-1).name,'rollback'); assert.equal(records.at(-1).status,'passed');
});

test('arbitrary secret-bearing thrown errors never reach receipts or propagated message', async () => {
  const secret='fixture-secret-unique';
  const {options,records}=setup({session:async()=>{throw new Error(secret);}});
  await assert.rejects(runFirstLoopProof(options),error=>!String(error).includes(secret));
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.equal(redactFixtureTranscript('start '+secret+' end '+secret,secret),'start [fixture-secret-redacted] end [fixture-secret-redacted]');
});
test('overflow and signal cannot qualify even with successful exit marker', async () => {
  const {options,records}=setup({session:async()=>({code:0,stdout:identity,stderr:'',outputOverflow:true,signal:'SIGKILL',timedOut:true})});
  await assert.rejects(runFirstLoopProof(options),/execution_failed/);
  assert.equal(records.at(-1).outputOverflow,true); assert.equal(records.at(-1).timedOut,true); assert.equal(records.at(-1).signal,'SIGKILL');
});

test('asynchronous or failed durable intent cannot start SQL', async () => {
  for (const record of [()=>Promise.reject(new Error('private')),()=>{throw new Error('private');}]) {
    const {options,calls}=setup({record});
    await assert.rejects(runFirstLoopProof(options),/first_loop_record_/); assert.equal(calls.length,0);
  }
});
