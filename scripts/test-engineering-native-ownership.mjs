/** Exercise native claim/lease races only in an explicitly named local fixture
 * container. Admissions are simulated; this never qualifies a Windows process. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const exec=promisify(execFile);
if (process.argv.length!==3 || !/^supabase_db_ovd(?:498|501)-[a-z0-9-]+$/.test(process.argv[2])) {
  throw new Error('Pass exactly one disposable local OVD-498/501 container; no output path or connection URL.');
}
const psql=['exec','-i',process.argv[2],'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
/** Quote only generated fixture values, never external SQL. */
function q(value) { return `'${String(value).replaceAll("'","''")}'`; }
function digest() { return createHash('sha256').update(randomUUID()).digest('hex'); }
/** Bound every local connection and keep credentials out of the report. */
async function sql(text) { return (await exec('docker',[...psql,'-c',text],{timeout:20_000,maxBuffer:2_000_000})).stdout.trim(); }
const tap=await sql(await readFile(new URL('../supabase/tests/engineering_native_ownership.sql',import.meta.url),'utf8'));
assert.doesNotMatch(tap,/not ok|Looks like you failed|planned \d+ tests but ran/i);
assert.match(tap,/^1\.\.120$/m);
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
    insert into auth.users(id,aud,role,email,email_confirmed_at) values(${q(f.actor)},'authenticated','authenticated',${q(`ovd501-${f.actor}@example.test`)},now());
    insert into public.organizations(id,name,slug) values(${q(f.org)},'OVD501 fixture',${q(`ovd501-${f.org}`)});
    insert into public.organization_memberships(organization_id,user_id,role) values(${q(f.org)},${q(f.actor)},'client');
    insert into public.projects(id,organization_id,owner_user_id,name) values(${q(f.project)},${q(f.org)},${q(f.actor)},'OVD501 fixture');
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
/** Simulate an authenticated gateway call inside only the local database. */
async function call(f,expression,name=`ovd501-${randomUUID()}`,role='service_role') {
  return JSON.parse(await sql(`begin;set local application_name=${q(name)};set local role ${role};set local request.jwt.claim.sub=${q(f.actor)};select ${expression};commit;`));
}
function claim(f,key=randomUUID(),task=f.task,name) {
  return call(f,`public.api_claim_native_task(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(task)},${q(f.runtime)},${q(f.input)},0,${q(key)})`,name);
}
/** Observe an actual database wait, instead of guessing scheduling delays. */
async function waitFor(query) {
  for(let i=0;i<50;i++) { if(await sql(query)==='t') return; await delay(100); }
  throw new Error('Database barrier not reached.');
}
/** Hold the conversation lock after the contender acquires slot and worker. */
async function barrier(f,run) {
  const name=`ovd501-barrier-${randomUUID()}`;
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
const duplicate=await fixture(),key=randomUUID();
const receipts=await Promise.all(Array.from({length:5},()=>claim(duplicate,key)));
receipts.forEach(receipt=>assert.deepEqual(receipt,receipts[0]));
assert.equal(receipts[0].outcome,'claimed');
assert.equal(await sql(`select count(*) from public.engineering_execution_attempts where organization_id=${q(duplicate.org)}`),'1');
const race=await fixture();
const contenders=await Promise.all([claim(race),claim(race,randomUUID(),race.otherTask)]);
assert.equal(contenders.filter(r=>r.outcome==='claimed').length,1);
assert.equal(contenders.filter(r=>r.reason==='native_slot_occupied').length,1);
const access=await fixture();
await barrier(access,async release=>{
  const name=`ovd501-access-${randomUUID()}`;
  const waiting=claim(access,randomUUID(),access.task,name).then(value=>({value}),error=>({error}));
  await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(name)} and wait_event='advisory')`);
  await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${q(access.org)}`);
  release(); const result=await waiting; assert.match(result.error?.stderr??'',/42501/);
});
assert.equal(await sql(`select count(*) from public.engineering_execution_attempts where organization_id=${q(access.org)}`),'0');
const clock=await fixture(),active=await claim(clock);
await sql(`update public.engineering_execution_attempts set lease_expires_at=clock_timestamp()+interval '2 seconds',revision=revision+1 where id=${q(active.attemptId)}`);
const expiry=await sql(`select lease_expires_at::text from public.engineering_execution_attempts where id=${q(active.attemptId)}`);
await barrier(clock,async release=>{
  const name=`ovd501-expiry-${randomUUID()}`;
  const waiting=call(clock,`public.api_heartbeat_native_attempt(${q(clock.worker)},${q(clock.credential)},${q(clock.boot)},${q(clock.task)},${q(active.attemptId)},1,1,${q(randomUUID())})`,name);
  await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(name)} and wait_event='advisory')`);
  assert.equal(await sql(`select xact_start<${q(expiry)}::timestamptz from pg_stat_activity where application_name=${q(name)}`),'t');
  await waitFor(`select clock_timestamp()>=${q(expiry)}::timestamptz`);
  release(); assert.equal((await waiting).outcome,'recovery_required');
});
assert.equal(await sql(`select active_attempt_id::text from engineering_private.native_slots where organization_id=${q(clock.org)}`),active.attemptId);
// A replacement worker cannot bypass the old revoked worker's occupied slot.
await call(duplicate,`public.api_control_worker_session(${q(duplicate.worker)},2,${q(randomUUID())},'revoked',null)`,undefined,'authenticated');
const replacement={...duplicate,worker:randomUUID(),installation:randomUUID(),boot:randomUUID(),credential:digest()};
await sql(`begin;
  insert into public.engineering_workers(id,organization_id,project_id,owner_user_id,installation_id,current_boot_id)
    values(${q(replacement.worker)},${q(replacement.org)},${q(replacement.project)},${q(replacement.actor)},${q(replacement.installation)},${q(replacement.boot)});
  insert into engineering_private.worker_credentials(worker_id,credential_sha256,paired_at) values(${q(replacement.worker)},${q(replacement.credential)},clock_timestamp());
  set local request.jwt.claim.sub=${q(replacement.actor)};
  select public.api_control_worker_session(${q(replacement.worker)},1,${q(randomUUID())},'enabled',${q(replacement.boot)});commit;`);
assert.equal((await claim(replacement,randomUUID(),replacement.otherTask)).reason,'native_slot_occupied');
console.log(JSON.stringify({schema:'overdrafter.native-ownership-db-test.v1',tapAssertions:120,duplicateClaims:5,createdAttemptsFromDuplicates:1,
  concurrentConversationClaims:2,nativeWinners:1,accessRecheckedAfterConversationWait:true,leaseExpiryRecheckedAfterWait:true,
  revokedWorkerReplacementPreservesOccupancy:true,exampleJobText:receipts[0].jobText,exampleContextText:duplicate.contextText,
  windowsQualification:false,productionChanged:false},null,2));
