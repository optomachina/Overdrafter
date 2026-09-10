/** OVD-505 PostgreSQL finalization and race tests. All admissions in this
 * runner are explicitly simulated; actual-byte verification has separate tests.
 * Retains disjoint synthetic fixtures; never accepts a production URL. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const exec=promisify(execFile);
if (process.argv.length!==3 || !/^supabase_db_ovd(?:498|505)-[a-z0-9-]+$/.test(process.argv[2])) {
  throw new Error('Pass one disposable local OVD-498/505 container; the database is fixed to ovd505_native_results.');
}
const psql=['exec','-i',process.argv[2],'psql','-U','postgres','-d','ovd505_native_results','-Atq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
/** SQL values below are generated synthetic fixture constants only. */
function q(value) { return `'${String(value).replaceAll("'","''")}'`; }
function digest() { return createHash('sha256').update(randomUUID()).digest('hex'); }
async function sql(text) { return (await exec('docker',[...psql,'-c',text],{timeout:20_000,maxBuffer:2_000_000})).stdout.trim(); }
const seedFiles=[
  {path:'synthetic-assembly.SLDASM',bytes:59987,sha256:'90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a'},
  {path:'parts/baseline-5mm.SLDPRT',bytes:56144,sha256:'e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa'},
  {path:'parts/candidate-8mm.SLDPRT',bytes:56171,sha256:'b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898'},
];
/** Commit a disjoint synthetic organization so separate connections can race. */
async function fixture() {
  const f=Object.fromEntries(['actor','org','project','worker','installation','boot','snapshot','runtime','input','conversation','otherConversation'].map(k=>[k,randomUUID()]));
  f.credential=digest();
  f.contextText=JSON.stringify({schema:'overdrafter.prepared-assembly.v2',packageId:'ovd-native04-assembly',
    scope:{organizationId:f.org,projectId:f.project},snapshotId:f.snapshot,seedSnapshotId:f.snapshot,sequence:0,
    producer:null,createdAt:'2026-09-10T00:00:00.000Z',configuration:'Default',assemblyPath:'synthetic-assembly.SLDASM',files:seedFiles,depthMm:5,checks:[]});
  await sql(`begin;
    insert into auth.users(id,aud,role,email,email_confirmed_at) values(${q(f.actor)},'authenticated','authenticated',${q(`ovd505-${f.actor}@example.test`)},now());
    insert into public.organizations(id,name,slug) values(${q(f.org)},'OVD505 fixture',${q(`ovd505-${f.org}`)});
    insert into public.organization_memberships(organization_id,user_id,role) values(${q(f.org)},${q(f.actor)},'client');
    insert into public.projects(id,organization_id,owner_user_id,name) values(${q(f.project)},${q(f.org)},${q(f.actor)},'OVD505 fixture');
    insert into public.project_memberships(project_id,user_id,role) values(${q(f.project)},${q(f.actor)},'owner');
    insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values(${q(f.org)},${q(f.actor)},true);
    insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values(${q(f.snapshot)},${q(f.org)},${q(f.project)},${q(f.contextText)});
    insert into public.engineering_workers(id,organization_id,project_id,owner_user_id,installation_id,current_boot_id)
      values(${q(f.worker)},${q(f.org)},${q(f.project)},${q(f.actor)},${q(f.installation)},${q(f.boot)});
    insert into engineering_private.worker_credentials(worker_id,credential_sha256,paired_at) values(${q(f.worker)},${q(f.credential)},clock_timestamp());
    set local request.jwt.claim.sub=${q(f.actor)};
    select public.api_control_worker_session(${q(f.worker)},1,${q(randomUUID())},'enabled',${q(f.boot)});
    select public.api_submit_engineering_message(${q(f.org)},${q(f.project)},${q(f.conversation)},${q(f.snapshot)},0,${q(randomUUID())},'Depth 8 mm');
    select public.api_submit_engineering_message(${q(f.org)},${q(f.project)},${q(f.otherConversation)},${q(f.snapshot)},0,${q(randomUUID())},'Depth 9 mm');
    select public.api_resolve_engineering_request(r.id,0,gen_random_uuid(),'prepared_change',8,'Fixture response',
      jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1','policyVersion','prepared-depth-v1',
      'inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
      from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id join public.engineering_snapshots s on s.id=r.input_snapshot_id
      where r.organization_id=${q(f.org)};
    insert into engineering_private.native_runtime_admissions(id,worker_id,installation_id,organization_id,project_id,owner_user_id,
      job_schema,source_manifest_sha256,environment_sha256,native_sha256,interop_sha256,compiler_sha256,evidence_sha256,policy_version,validator_version,admitted_by)
      values(${q(f.runtime)},${q(f.worker)},${q(f.installation)},${q(f.org)},${q(f.project)},${q(f.actor)},'overdrafter.prepared-dimension-job.v2',
      ${Array.from({length:6},()=>q(digest())).join(',')},'prepared-native-ownership-v1','test-only',${q(f.actor)});
    insert into engineering_private.native_input_admissions(id,snapshot_id,organization_id,project_id,kind,context_sha256,
      storage_manifest_sha256,evidence_sha256,requirements_sha256,check_policy_version,validator_version)
      select ${q(f.input)},id,organization_id,project_id,'qualified_seed',context_sha256,${q(digest())},${q(digest())},${q(digest())},'prepared-native-checks-v2','test-only'
      from public.engineering_snapshots where id=${q(f.snapshot)};
    commit;`);
  f.task=await sql(`select id from public.engineering_tasks where conversation_id=${q(f.conversation)}`);
  f.otherTask=await sql(`select id from public.engineering_tasks where conversation_id=${q(f.otherConversation)}`);
  return f;
}

/** Simulate the existing service gateway, with an explicitly scoped worker. */
async function call(f,expression,name=`ovd505-${randomUUID()}`,role='service_role') {
  return JSON.parse(await sql(`begin;set local application_name=${q(name)};set local role ${role};set local request.jwt.claim.sub=${q(f.actor)};select ${expression};commit;`));
}
const roles=['assembly','target','companion','identity','preservation','native','result'];
const report=JSON.parse(await readFile(new URL('../server/engineering/fixtures/prepared-reports.json',import.meta.url),'utf8'));
/** Create a stopped eligible attempt via the real coordinator, then insert
 * database-owner verification fixtures. These are not physical CAD evidence. */
async function stoppedFixture(expiring=false) {
  const f=await fixture();
  if(expiring) {
    const session=randomUUID();
    await sql(`insert into public.engineering_worker_sessions(id,worker_id,organization_id,project_id,owner_user_id,installation_id,boot_id,enabled_at,expires_at)
      select ${q(session)},${q(f.worker)},${q(f.org)},${q(f.project)},${q(f.actor)},${q(f.installation)},${q(f.boot)},deadline-interval '8 hours',deadline
      from (select clock_timestamp()+interval '2 seconds' as deadline) timing;
      update public.engineering_workers set current_session_id=${q(session)},revision=revision+1 where id=${q(f.worker)};`);
    f.expiresAt=await sql(`select expires_at::text from public.engineering_worker_sessions where id=${q(session)}`);
  }
  f.claim=await call(f,`public.api_claim_native_task(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.runtime)},${q(f.input)},0,${q(randomUUID())})`);
  assert.equal(f.claim.outcome,'claimed');
  f.attempt=f.claim.attemptId; f.job=JSON.parse(f.claim.jobText); f.stop=randomUUID(); f.manifest=randomUUID(); f.receipt=randomUUID();
  f.jobDigest=createHash('sha256').update(f.claim.jobText).digest('hex');
  await sql(`insert into engineering_private.native_stop_admissions(id,attempt_id,organization_id,project_id,worker_id,installation_id,boot_id,session_id,
    runtime_admission_id,fence,job_sha256,context_sha256,journal_sha256,evidence_sha256,verdict,authority,terminal_processes,
    execution_outcome,failure_code,failure_policy_version,validator_version,stopped_at,observed_at,admitted_by)
    select ${q(f.stop)},a.id,a.organization_id,a.project_id,a.worker_id,a.installation_id,a.boot_id,a.session_id,a.runtime_admission_id,a.fence,
    a.job_sha256,a.job_text::jsonb->>'contextSha256',${q(digest())},${q(digest())},'all_owned_processes_exited','qualified_worker_validator',
    '[{"fixtureOnly":true}]'::jsonb,'native_exit_succeeded',null,'prepared-native-failure-v1','test-only',clock_timestamp(),clock_timestamp(),${q(f.actor)}
    from public.engineering_execution_attempts a where id=${q(f.attempt)};`);
  await call(f,`public.api_record_native_stop(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.attempt)},${q(f.stop)},0,${q(randomUUID())})`);
  f.objects=Object.fromEntries(roles.map(role=>[role,{id:randomUUID(),sha256:digest(),bytes:100}]));
  roles.slice(0,3).forEach((role,index)=>Object.assign(f.objects[role],report.result.outputFiles[index]));
  for(const role of roles) {
    const o=f.objects[role];
    await sql(`insert into engineering_private.native_result_objects(id,attempt_id,organization_id,project_id,role,bytes,sha256)
      values(${q(o.id)},${q(f.attempt)},${q(f.org)},${q(f.project)},${q(role)},${o.bytes},${q(o.sha256)})`);
  }
  f.manifestObjects=Object.fromEntries(roles.map(role=>[role,f.objects[role].id]));
  await sql(`insert into engineering_private.native_result_manifests(id,attempt_id,organization_id,project_id,objects)
    values(${q(f.manifest)},${q(f.attempt)},${q(f.org)},${q(f.project)},${q(JSON.stringify(f.manifestObjects))})`);
  const checks=f.job.requiredChecks.map((id,index)=>{
    let role='native'; if(index===0) role='identity'; else if(index===6) role='preservation';
    return {id,verdict:'pass',evidenceSha256:f.objects[role].sha256};
  });
  f.context={...JSON.parse(f.contextText),snapshotId:f.job.outputSnapshotId,sequence:f.job.sequence,depthMm:f.job.depthMm,
    producer:{jobId:f.job.jobId,attemptId:f.attempt,fence:f.job.fence,inputSnapshotId:f.snapshot,inputContextSha256:f.job.contextSha256,
      requestSha256:f.jobDigest,resultSha256:f.objects.result.sha256},files:report.result.outputFiles,checks};
  f.contextResult=JSON.stringify(f.context);
  await insertReceipt(f);
  return f;
}
async function insertReceipt(f,context=f.contextResult,id=f.receipt,manifest=f.manifest) {
  return sql(`insert into engineering_private.native_verification_receipts(id,attempt_id,organization_id,project_id,manifest_id,
    stop_admission_id,job_sha256,context_text,policy_version,validator_version)
    values(${q(id)},${q(f.attempt)},${q(f.org)},${q(f.project)},${q(manifest)},${q(f.stop)},${q(f.jobDigest)},${q(context)},'prepared-native-reports-v1','test-only')`);
}
function finalize(f,key=randomUUID(),receipt=f.receipt,revision=1,name=undefined) {
  return call(f,`public.api_finalize_native_result(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.attempt)},${q(receipt)},${revision},${q(key)})`,name);
}
async function rejected(promise,code) { await assert.rejects(promise,error=>error.stderr?.includes(code)); }
/** Establish actual PostgreSQL lock barriers, never an assumed sleep window. */
async function waitFor(query) {
  for(let n=0;n<50;n++) { if(await sql(query)==='t') return; await delay(100); }
  throw new Error('Database barrier not reached.');
}
async function barrier(f,run) {
  const name=`ovd505-barrier-${randomUUID()}`;
  const child=exec('docker',psql,{timeout:30_000,maxBuffer:2_000_000});
  const outcome=child.then(()=>({ok:true}),error=>({ok:false,error}));
  child.child.stdin.write(`begin;set local idle_in_transaction_session_timeout='30s';set local application_name=${q(name)};
    select pg_advisory_xact_lock(hashtextextended('engineering:'||${q(f.conversation)},0));\n`);
  try {
    await waitFor(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${q(name)} and l.locktype='advisory' and l.granted)`);
    await run(()=>child.child.stdin.end('commit;\n'));
  } finally {
    if(!child.child.stdin.writableEnded) child.child.stdin.end('rollback;\n');
    const result=await outcome; assert.equal(result.ok,true,result.error?.stderr);
  }
}

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
