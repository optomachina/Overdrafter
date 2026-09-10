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
const report=JSON.parse(await readFile(new URL('../../server/engineering/fixtures/prepared-reports.json',import.meta.url),'utf8'));
/** Create a stopped eligible attempt via the real coordinator, then insert
 * database-owner verification fixtures. These are not physical CAD evidence. */
async function stoppedFixture(expiring=false,prepareResult=null) {
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
  f.objects=Object.fromEntries(roles.map(role=>[role,{id:randomUUID(),sha256:digest(),bytes:100}]));
  roles.slice(0,3).forEach((role,index)=>Object.assign(f.objects[role],report.result.outputFiles[index]));
  let binding=null;
  if(prepareResult) {
    f.prepared=await prepareResult({jobText:f.claim.jobText,contextText:f.contextText});
    f.objects=Object.fromEntries(f.prepared.objects.map(object=>[object.role,object]));
    binding={schema:'overdrafter.native-report-process.v1',...f.prepared.admission.process,nativeReportSha256:f.objects.native.sha256};
  }
  await sql(`insert into engineering_private.native_stop_admissions(id,attempt_id,organization_id,project_id,worker_id,installation_id,boot_id,session_id,
    runtime_admission_id,fence,job_sha256,context_sha256,journal_sha256,evidence_sha256,verdict,authority,terminal_processes,
    execution_outcome,failure_code,failure_policy_version,validator_version,stopped_at,observed_at,admitted_by,report_binding)
    select ${q(f.stop)},a.id,a.organization_id,a.project_id,a.worker_id,a.installation_id,a.boot_id,a.session_id,a.runtime_admission_id,a.fence,
    a.job_sha256,a.job_text::jsonb->>'contextSha256',${q(digest())},${q(digest())},'all_owned_processes_exited','qualified_worker_validator',
    '[{"fixtureOnly":true}]'::jsonb,'native_exit_succeeded',null,'prepared-native-failure-v1','test-only',clock_timestamp(),clock_timestamp(),${q(f.actor)},${binding?q(JSON.stringify(binding)):'null'}
    from public.engineering_execution_attempts a where id=${q(f.attempt)};`);
  await call(f,`public.api_record_native_stop(${q(f.worker)},${q(f.credential)},${q(f.boot)},${q(f.task)},${q(f.attempt)},${q(f.stop)},0,${q(randomUUID())})`);
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
  if(!prepareResult) await insertReceipt(f);
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


export { q, sql, digest, call, stoppedFixture, insertReceipt, finalize, rejected, barrier, waitFor };
