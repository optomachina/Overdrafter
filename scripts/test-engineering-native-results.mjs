/** Run only against the explicitly named disposable local fixture database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { q, sql, digest, call, stoppedFixture, insertReceipt, finalize, rejected, barrier, waitFor } from './lib/native-result-db-fixtures.mjs';
const exec=promisify(execFile);
const psql=['exec','-i',process.argv[2],'psql','-U','postgres','-d','ovd505_native_results','-Atq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];

const f=await stoppedFixture(),key=randomUUID();
const receipts=await Promise.all(Array.from({length:5},()=>finalize(f,key)));
receipts.forEach(receipt=>assert.deepEqual(receipt,receipts[0]));
assert.equal(receipts[0].outcome,'finalized');
assert.equal(receipts[0].adoption,'unadopted');
assert.equal(await sql(`select count(*) from engineering_private.native_result_finalizations where attempt_id=${q(f.attempt)}`),'1');
assert.equal(await sql(`select head_snapshot_id from public.engineering_conversations where id=${q(f.conversation)}`),f.job.outputSnapshotId);
assert.equal(await sql(`select context_text from public.engineering_snapshots where id=${q(f.job.outputSnapshotId)}`),f.contextResult);
await rejected(finalize(f,key,randomUUID()),'PT409');
await rejected(finalize(f),'PT409');
await rejected(sql(`update engineering_private.native_result_objects set sha256=${q(digest())} where id=${q(f.objects.native.id)}`),'55000');
await rejected(sql(`delete from engineering_private.native_verification_receipts where id=${q(f.receipt)}`),'55000');

for(const role of ['anon','authenticated','service_role']) {
  for(const table of ['native_result_objects','native_result_manifests','native_verification_receipts','native_result_finalizations']) {
    await rejected(sql(`begin;set local role ${role};select * from engineering_private.${table};rollback;`),'42501');
    await rejected(sql(`begin;set local role ${role};insert into engineering_private.${table} default values;rollback;`),'42501');
  }
}
const invalid=await stoppedFixture();
for(const [label,edit] of [
  ['wrong snapshot',c=>{c.snapshotId=randomUUID();}], ['wrong predecessor',c=>{c.producer.inputSnapshotId=randomUUID();}],
  ['missing checks',c=>{c.checks=[];}], ['changed file',c=>{c.files[0].sha256=digest();}], ['wrong fence',c=>{c.producer.fence++;}],
]) {
  const context=structuredClone(invalid.context); edit(context);
  await rejected(insertReceipt(invalid,JSON.stringify(context),randomUUID()),'23514');
  assert.equal(await sql(`select count(*) from engineering_private.native_verification_receipts where attempt_id=${q(invalid.attempt)}`),'1',label);
}
await rejected(insertReceipt(invalid,invalid.contextResult,randomUUID(),f.manifest),'23514');
await rejected(sql(`insert into engineering_private.native_result_manifests(id,attempt_id,organization_id,project_id,objects)
  values(${q(randomUUID())},${q(invalid.attempt)},${q(invalid.org)},${q(invalid.project)},${q(JSON.stringify({...invalid.manifestObjects,native:f.objects.native.id}))})`),'23514');
await rejected(finalize({...invalid,credential:digest()}),'42501');
await rejected(finalize({...invalid,worker:f.worker,credential:f.credential}),'42501');

// Failure between writes rolls the whole finalization back; delivery retries
// consume the same evidence rather than running CAD again.
await rejected(sql(`begin;select public.api_finalize_native_result(${q(invalid.worker)},${q(invalid.credential)},${q(invalid.boot)},${q(invalid.task)},${q(invalid.attempt)},${q(invalid.receipt)},1,${q(randomUUID())});select 1/0;commit;`),'22012');
assert.equal(await sql(`select count(*) from public.engineering_snapshots where id=${q(invalid.job.outputSnapshotId)}`),'0');
assert.equal(await sql(`select phase from public.engineering_execution_attempts where id=${q(invalid.attempt)}`),'awaiting_result');
assert.equal((await finalize(invalid)).outcome,'finalized');

for(const kind of ['access','runtime','cancel']) {
  const blocked=await stoppedFixture();
  await barrier(blocked,async release=>{
    const name=`ovd505-${kind}-${randomUUID()}`;
    const waiting=finalize(blocked,randomUUID(),blocked.receipt,1,name).then(value=>({value}),error=>({error}));
    await waitFor(`select exists(select 1 from pg_stat_activity where datname='ovd505_native_results' and application_name=${q(name)} and wait_event='advisory')`);
    if(kind==='access') await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${q(blocked.org)}`);
    else if(kind==='runtime') await sql(`insert into engineering_private.native_admission_revocations(runtime_admission_id,revoked_by,reason) values(${q(blocked.runtime)},${q(blocked.actor)},'test revocation')`);
    else await sql(`update public.engineering_tasks set execution_state='canceled' where id=${q(blocked.task)}`);
    release(); const result=await waiting; assert.match(result.error?.stderr??'',kind==='access'?/42501/:/PT409/);
  });
  assert.equal(await sql(`select count(*) from engineering_private.native_result_finalizations where attempt_id=${q(blocked.attempt)}`),'0');
}

// Another conversation may occupy the worker while a stopped result is checked.
const occupied=await stoppedFixture();
const next=await call(occupied,`public.api_claim_native_task(${q(occupied.worker)},${q(occupied.credential)},${q(occupied.boot)},${q(occupied.otherTask)},${q(occupied.runtime)},${q(occupied.input)},0,${q(randomUUID())})`);
assert.equal(next.outcome,'claimed');
assert.equal((await finalize(occupied)).outcome,'finalized');
assert.equal(await sql(`select active_attempt_id from engineering_private.native_slots where organization_id=${q(occupied.org)}`),next.attemptId);
// Queue the successor before finalization: original request context remains the
// baseline, but native execution must consume the first verified candidate.
const chain=await stoppedFixture();
await sql(`begin;set local request.jwt.claim.sub=${q(chain.actor)};
  select public.api_submit_engineering_message(${q(chain.org)},${q(chain.project)},${q(chain.conversation)},${q(chain.snapshot)},
    (select revision from public.engineering_conversations where id=${q(chain.conversation)}),${q(randomUUID())},'Depth 9 mm');
  select public.api_resolve_engineering_request(r.id,1,gen_random_uuid(),'prepared_change',9,'Second synthetic change',
    jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1','policyVersion','prepared-depth-v1',
    'inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
    from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
      join public.engineering_snapshots s on s.id=r.input_snapshot_id
    where r.conversation_id=${q(chain.conversation)} and r.interpretation_state='queued';commit;`);
const successor=await sql(`select t.id from public.engineering_tasks t join public.engineering_decisions d on d.id=t.decision_id
  where t.conversation_id=${q(chain.conversation)} and d.sequence=2`);
const claimSuccessor=input=>call(chain,`public.api_claim_native_task(${q(chain.worker)},${q(chain.credential)},${q(chain.boot)},${q(successor)},${q(chain.runtime)},${q(input)},0,${q(randomUUID())})`);
assert.equal((await claimSuccessor(chain.input)).reason,'verified_predecessor_required');
const finished=await finalize(chain);
assert.equal((await claimSuccessor(chain.input)).reason,'verified_predecessor_required');
const chained=await claimSuccessor(finished.inputAdmissionId);
assert.equal(chained.outcome,'claimed');
const chainedJob=JSON.parse(chained.jobText);
assert.equal(chainedJob.inputSnapshotId,finished.snapshotId);
assert.equal(chainedJob.expectedDepthMm,8); assert.equal(chainedJob.depthMm,9);
assert.equal(chainedJob.sequence,2);

for(const mode of ['paused','expired']) {
  const drain=await stoppedFixture(mode==='expired');
  if(mode==='paused') await call(drain,`public.api_control_worker_session(${q(drain.worker)},2,${q(randomUUID())},'paused',${q(drain.boot)})`,undefined,'authenticated');
  else await waitFor(`select clock_timestamp()>=${q(drain.expiresAt)}::timestamptz`);
  assert.equal((await finalize(drain)).outcome,'finalized');
}
// Pause inside snapshot insertion, AFTER the eligibility check. Revocations
// must wait for this finalization instead of committing in that gap.
for(const kind of ['runtime','input','access']) {
  const race=await stoppedFixture(), suffix=randomUUID().replaceAll('-',''), fn=`ovd505_insert_${suffix}`;
  const key=`ovd505-insert:${race.org}`, finalName=`ovd505-final-${suffix}`, revokeName=`ovd505-revoke-${suffix}`;
  await sql(`create function engineering_private.${fn}() returns trigger language plpgsql as $$ begin
    perform pg_advisory_xact_lock(hashtextextended(${q(key)},0));return new;end;$$;
    create trigger ${fn} before insert on public.engineering_snapshots for each row
      when (new.organization_id=${q(race.org)}::uuid) execute function engineering_private.${fn}();`);
  const guard=exec('docker',psql,{timeout:30_000,maxBuffer:2_000_000}), guardName=`ovd505-guard-${suffix}`;
  const guarded=guard.then(()=>({ok:true}),error=>({error}));
  guard.child.stdin.write(`begin;set local idle_in_transaction_session_timeout='30s';set local application_name=${q(guardName)};
    select pg_advisory_xact_lock(hashtextextended(${q(key)},0));\n`);
  let finished,revoked;
  try {
    await waitFor(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${q(guardName)} and l.locktype='advisory' and l.granted)`);
    finished=finalize(race,randomUUID(),race.receipt,1,finalName).then(value=>({value}),error=>({error}));
    await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(finalName)} and wait_event='advisory')`);
    let revokeStatement=`update engineering_private.engineering_operators set enabled=false where organization_id=${q(race.org)}`;
    let committed=`exists(select 1 from engineering_private.engineering_operators where organization_id=${q(race.org)} and not enabled)`;
    if(kind!=='access') {
      revokeStatement=`insert into engineering_private.native_admission_revocations(${kind}_admission_id,revoked_by,reason)
        values(${q(race[kind])},${q(race.actor)},'post-check fixture revocation')`;
      committed=`exists(select 1 from engineering_private.native_admission_revocations where ${kind}_admission_id=${q(race[kind])})`;
    }
    revoked=sql(`begin;set local application_name=${q(revokeName)};${revokeStatement};commit;`).then(()=>({ok:true}),error=>({error}));
    await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(revokeName)} and wait_event='transactionid')
      or ${committed}`);
    assert.equal(await sql(`select ${committed}`),'f',`${kind} revocation must not commit between check and finalization`);
  } finally {
    guard.child.stdin.end('commit;\n');
    const result=await guarded; assert.equal(result.ok,true,result.error?.stderr);
    if(finished) { const result=await finished; assert.equal(result.value?.outcome,'finalized',result.error?.stderr); }
    if(revoked) { const result=await revoked; assert.equal(result.ok,true,result.error?.stderr); }
  }
}
console.log(JSON.stringify({outcome:'passed',simulatedAdmissions:true,physicalCadEvidence:false,productionChanged:false,
  duplicateFinalizations:5,committedCandidates:1,apiRolesCannotMintReceipts:true,rollbackRetriedWithoutCad:true,
  postWaitAccessRuntimeCancellationChecks:true,newerNativeOccupancyPreserved:true,
  successorRequiresCommittedAdmission:true,pausedExpiredSessionsDrain:true,postCheckRevocationsSerialized:true},null,2));
