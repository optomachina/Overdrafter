/** OVD-575 synthetic database proof. Owns one internal network and one bounded
 * disposable PostgreSQL container. No hosted target or real principal is used. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const owner='ovd575-observer-registry-test';
const suffix=randomUUID().slice(0,8);
const network=`ovd575-registry-${suffix}`;
const container=`ovd575-registry-db-${suffix}`;
const image='public.ecr.aws/supabase/postgres:17.6.1.095';
const migration='supabase/migrations/20260927130000_ovd575_native_observer_registry.sql';
const fixture='scripts/native/stop-observer/fixtures/ovd575_registry.sql';
const started=Date.now();
const docker=['/opt/homebrew/bin/docker','/usr/local/bin/docker','/usr/bin/docker']
  .find(candidate=>existsSync(candidate));
if(!docker)throw new Error('Docker executable not found in the supported system paths');
let networkId=null,containerId=null,assertions=0,report=null;
function run(args,options={}) {
  return execFileSync(docker,args,{encoding:'utf8',timeout:options.timeout??30_000,
    input:options.input,maxBuffer:2_000_000,stdio:['pipe','pipe','pipe']}).trim();
}
function sql(statement) {
  return run(['exec','-i',container,'psql','-U','postgres','-X','-Atq','-v','ON_ERROR_STOP=1',
    '-v','VERBOSITY=verbose','-c',statement]);
}
function file(path) {
  return run(['exec','-i',container,'psql','-U','postgres','-X','-q','-v','ON_ERROR_STOP=1'],
    {input:readFileSync(path),timeout:60_000});
}
function q(value) {return `'${String(value).replaceAll("'","''")}'`;}
function hash(value) {return createHash('sha256').update(value).digest('hex');}
function check(value,message) {assert.ok(value,message);assertions++;}
function equal(actual,expected,message) {assert.equal(actual,expected,message);assertions++;}
function ordinalKeyCompare(left,right) {
  if(left<right)return -1;
  if(left>right)return 1;
  return 0;
}
function fail(statement,pattern,message) {
  let error;
  try {sql(statement);} catch (error_) {error=error_;}
  check(error && pattern.test(String(error.stderr)),`${message}: ${String(error?.stderr).slice(0,350)}`);
}
function canonical(value) {
  if (value===null) return 'null';
  if (typeof value==='boolean') return value?'true':'false';
  if (typeof value==='number') {
    assert.ok(Number.isSafeInteger(value));
    return String(value);
  }
  if (typeof value==='string') {
    let out='"';
    const slash=String.fromCharCode(92);
    for(let i=0;i<value.length;i++) {
      const code=value[i].codePointAt(0);
      if(code===34)out+=slash+'"';
      else if(code===92)out+=slash+slash;
      else if(code<32||code>126)out+=slash+'u'+code.toString(16).padStart(4,'0');
      else out+=value[i];
    }
    return out+'"';
  }
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  const members=Object.keys(value).sort(ordinalKeyCompare)
    .map(key=>canonical(key)+':'+canonical(value[key]));
  return '{'+members.join(',')+'}';
}
function evidence() {
  const manifest=JSON.parse(readFileSync('scripts/native/stop-observer/fixtures/manifest.json'));
  const journal=JSON.parse(readFileSync('scripts/native/stop-observer/fixtures/journal.json'));
  const now=Date.now();
  const iso=ms=>new Date(ms).toISOString();
  const claimed=iso(now-30_000),startedAt=iso(now-20_000);
  const observedAt=iso(now-5_000),deadline=iso(now+570_000);
  const processAt=iso(now-18_000),exitedAt=iso(now-10_000);
  const ticks=(BigInt(now-19_000)*10000n+621355968000000000n).toString();
  manifest.startedAt=startedAt;manifest.observedAt=observedAt;manifest.deadline=deadline;
  manifest.root.observedAt=processAt;manifest.root.exitedAt=exitedAt;
  manifest.root.identity.creationTicks=ticks;
  for(const process of manifest.observedProcesses) {
    process.observedAt=processAt;process.exitedAt=exitedAt;
    process.identity.creationTicks=ticks;
  }
  for(const terminal of manifest.terminalProcesses)terminal.creationTicks=ticks;
  journal.binding=structuredClone(manifest.binding);
  let previous=hash(canonical(journal.binding));
  for(const record of journal.records) {
    record.at=exitedAt;
    record.bindingSha256=hash(canonical(journal.binding));
    record.previousSha256=previous;
    if(record.data?.creationTicks)record.data.creationTicks=ticks;
    const {sha256,...body}=record;
    record.sha256=hash(canonical(body));
    previous=record.sha256;
  }
  journal.headSha256=previous;
  manifest.journalHeadSha256=previous;
  const journalText=canonical(journal);
  manifest.journalSha256=hash(journalText);
  return {manifest,journal,claimed,deadline};
}
function ingest(profile,manifest,journal,role='ovd575_observer_validator',extra='') {
  const m=Buffer.from(typeof manifest==='string'?manifest:canonical(manifest)).toString('hex');
  const j=Buffer.from(typeof journal==='string'?journal:canonical(journal)).toString('hex');
  return `begin;set local role ${role};${extra}select engineering_private.store_native_observer_evidence(
    ${q(profile)}::uuid,decode(${q(m)},'hex'),decode(${q(j)},'hex'));commit;`;
}
function changed(value,mutate) {const copy=structuredClone(value);mutate(copy);return copy;}
function rechain(manifest,journal) {
  let previous=hash(canonical(journal.binding));
  journal.records.forEach((record,index)=>{
    record.sequence=index+1;
    record.bindingSha256=hash(canonical(journal.binding));
    record.previousSha256=previous;
    const {sha256,...body}=record;
    record.sha256=hash(canonical(body));previous=record.sha256;
  });
  journal.headSha256=previous;
  manifest.journalHeadSha256=previous;
  manifest.journalSha256=hash(canonical(journal));
  return {manifest,journal};
}
try {
  networkId=run(['network','create','--internal','--label',`ovd575.owner=${owner}`,network]);
  containerId=run(['run','-d','--name',container,'--label',`ovd575.owner=${owner}`,
    '--network',network,'--cpus','2','--memory','3g','--pids-limit','256',
    '--tmpfs','/var/lib/postgresql/data:rw,size=1g','--tmpfs','/tmp:rw,size=256m',
    '-e',`POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,image]);
  let ready=false;
  for(let i=0;i<50;i++) {
    try {run(['exec',container,'psql','-U','postgres','-Atqc','select 1']);ready=true;break;}
    catch {await delay(250);}
  }
  check(ready,'disposable database starts');
  // The image briefly runs a bootstrap server before its final postmaster.
  await delay(3000);
  equal(run(['exec',container,'psql','-U','postgres','-Atqc','select 1']),'1',
    'final postmaster accepts connections');
  file(fixture);
  sql('create role ovd575_observer_validator nologin noinherit;grant ovd575_observer_validator to service_role with set true');
  let contaminated;
  try {file(migration);} catch(error) {contaminated=error;}
  check(contaminated && /unsafe attributes or membership/.test(String(contaminated.stderr)),
    'migration rejects preexisting service_role membership');
  sql('revoke ovd575_observer_validator from service_role');
  file(migration);
  equal(canonical({a:1,_:2,A:3}),'{"A":3,"_":2,"a":1}',
    'test oracle keeps ordinal JSON key order');
  equal(sql('select engineering_private.native_observer_json_string(chr(128512))'),
    canonical('😀'),'supplementary Unicode retains UTF-16 escape pairs');
  equal(sql("select length(engineering_private.native_observer_json_string(repeat('é',10000)))"),
    '60002','long Unicode string is encoded without repeated prefix scans');
  // Fixture-only membership lets the local database owner exercise SET ROLE.
  sql('grant ovd575_observer_validator to postgres with set true');
  equal(sql('select count(*) from engineering_private.native_observer_profiles'),'0',
    'migration seeds no qualification profile');
  equal(sql('select count(*) from engineering_private.native_observer_validator_actors'),'0',
    'migration seeds no actor mapping');
  const keys=['actor','other','runtime','input','profile','attempt','task','organization','project',
    'worker','installation','boot','session'].map(()=>randomUUID());
  const [actor,other,runtime,input,profile,attempt,task,organization,project,worker,installation,boot,session]=keys;
  const {manifest,journal,claimed,deadline}=evidence();
  Object.assign(manifest.binding,{attemptId:attempt,taskId:task,organizationId:organization,
    projectId:project,workerId:worker,installationId:installation,bootId:boot,
    runtimeAdmissionId:runtime});
  journal.binding=structuredClone(manifest.binding);
  let prior=hash(canonical(journal.binding));
  for(const record of journal.records) {
    record.bindingSha256=hash(canonical(journal.binding));
    record.previousSha256=prior;
    const {sha256,...body}=record;record.sha256=hash(canonical(body));prior=record.sha256;
  }
  journal.headSha256=prior;manifest.journalHeadSha256=prior;
  manifest.journalSha256=hash(canonical(journal));
  const job=JSON.stringify({jobId:manifest.binding.jobId,contextSha256:manifest.contextSha256});
  sql(`insert into auth.users(id) values (${q(actor)}),(${q(other)});
    insert into engineering_private.native_runtime_admissions(id) values(${q(runtime)});
    insert into public.engineering_workers(id,current_boot_id) values(${q(worker)},${q(boot)});
    insert into public.engineering_execution_attempts(id,task_id,organization_id,project_id,
      worker_id,installation_id,boot_id,session_id,runtime_admission_id,input_admission_id,
      fence,job_text,job_sha256,claimed_at,deadline_at,lease_expires_at,phase,result_eligible) values
      (${q(attempt)},${q(task)},${q(organization)},${q(project)},${q(worker)},
       ${q(installation)},${q(boot)},${q(session)},${q(runtime)},${q(input)},1,${q(job)},
       ${q(manifest.binding.jobSha256)},${q(claimed)},${q(deadline)},
       ${q(new Date(Date.now()+30_000).toISOString())},'running',true);
    insert into engineering_private.native_slots(organization_id,active_attempt_id)
      values(${q(organization)},${q(attempt)});
    insert into engineering_private.native_observer_profiles(id,runtime_admission_id,
      observer_schema,observer_version,boundary,profile_version,observer_source_sha256,
      qualification_sha256,native_qualification,stop_admission,admitted_by) values
      (${q(profile)},${q(runtime)},'overdrafter.native-stop-observer.v1',
       'windows-job-observer/1','trusted-user-direct-createprocess-job-v1',
       'observer-ingest-v1',${q(hash('synthetic-observer-source'))},
       ${q(hash('synthetic-qualification'))},false,false,${q(actor)});
    insert into engineering_private.native_observer_validator_actors(executor_role,admitted_by,enabled)
      values('ovd575_observer_validator',${q(actor)},true);`);
  equal(sql(`select rolcanlogin::text||','||rolinherit::text from pg_roles where rolname='ovd575_observer_validator'`),'false,false','executor is NOLOGIN NOINHERIT');
  equal(sql(`select pg_has_role('service_role','ovd575_observer_validator','member')`),'f','service role lacks membership');
  equal(sql(`select has_function_privilege('service_role','engineering_private.store_native_observer_evidence(uuid,bytea,bytea)','EXECUTE')`),'f','service role cannot ingest');
  equal(sql(`select has_table_privilege('ovd575_observer_validator','engineering_private.native_observer_evidence','INSERT')`),'f','validator has no direct DML');
  equal(sql(`select relrowsecurity from pg_class where oid='engineering_private.native_observer_evidence'::regclass`),'t','evidence RLS enabled');
  fail(ingest(profile,manifest,journal,'service_role'),/42501/,'service role cannot invoke validator');
  fail(ingest(randomUUID(),manifest,journal),/PT409/,'unadmitted profile denied');
  fail(ingest(profile,' '+canonical(manifest),journal),/22023/,'noncanonical bytes denied');
  fail(ingest(profile,changed(manifest,m=>{m.stopAdmission=true;}),journal),/22023/,'forged stop flag denied');
  fail(ingest(profile,changed(manifest,m=>{m.nativeQualification=true;}),journal),/22023/,'forged native qualification denied');
  fail(ingest(profile,changed(manifest,m=>{m.root=null;}),journal),/22023/,'missing root denied');
  fail(ingest(profile,changed(manifest,m=>{m.startedAt=null;}),journal),/22023/,'missing start time denied');
  fail(ingest(profile,changed(manifest,m=>{m.root.exitCode=1;}),journal),/22023/,'false success outcome denied');
  fail(ingest(profile,changed(manifest,m=>{m.root.identity.creationTicks='1';}),journal),/22023/,'root creation outside run denied');
  fail(ingest(profile,changed(manifest,m=>{m.root.identity.pid='100';}),journal),/22023/,'string PID denied');
  fail(ingest(profile,changed(manifest,m=>{m.root.parentPid=null;}),journal),/22023/,'null parent PID denied');
  fail(ingest(profile,changed(manifest,m=>{m.observedProcesses[0].identity.executablePath=String.raw`C:\Fixture\other.exe`;}),journal),/22023/,'substituted child path denied');
  fail(ingest(profile,changed(manifest,m=>{m.binding.projectId=randomUUID();}),journal),/22023/,'foreign scope denied');
  fail(ingest(profile,manifest,changed(journal,j=>{j.records[0].kind='failure';})),/22023/,'substituted journal denied');
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{j.records[0].data={};}));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed malformed intent denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      j.records[0].data.argumentsSha256=null;
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed null digest denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      j.records[0].data.workingDirectory='';
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed invalid working directory denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      [j.records[1],j.records[2]]=[j.records[2],j.records[1]];
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed exit-before-start denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      j.records=j.records.filter(record=>record.kind!=='phase');
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed missing phase denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      for(const record of j.records)record.at='2025-09-27T12:00:00.000Z';
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'coherently rehashed old journal time denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      for(const record of j.records)record.at=manifest.startedAt;
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'journal start before creation denied');
  }
  {
    const altered=rechain(structuredClone(manifest),changed(journal,j=>{
      j.records.push({...structuredClone(j.records.at(-1)),kind:'phase',data:{phase:'outputs_saved'}});
    }));
    fail(ingest(profile,altered.manifest,altered.journal),/22023/,'extra terminal phase denied');
  }
  fail(ingest(profile,changed(manifest,m=>{m.terminalProcesses=[];}),journal),/22023/,'missing terminal set denied');
  sql(`update engineering_private.native_slots set active_attempt_id=null where organization_id=${q(organization)}`);
  fail(ingest(profile,manifest,journal),/PT409/,'stale slot denied');
  sql(`update engineering_private.native_slots set active_attempt_id=${q(attempt)} where organization_id=${q(organization)}`);
  sql(`update public.engineering_workers set current_boot_id=${q(randomUUID())} where id=${q(worker)}`);
  fail(ingest(profile,manifest,journal),/PT409/,'changed worker boot denied');
  sql(`update public.engineering_workers set current_boot_id=${q(boot)},revoked_at=clock_timestamp() where id=${q(worker)}`);
  fail(ingest(profile,manifest,journal),/PT409/,'revoked worker denied');
  sql(`update public.engineering_workers set revoked_at=null where id=${q(worker)}`);
  sql(`insert into engineering_private.native_admission_revocations(id,input_admission_id)
    values(${q(randomUUID())},${q(input)})`);
  fail(ingest(profile,manifest,journal),/PT409/,'revoked input admission denied');
  sql(`delete from engineering_private.native_admission_revocations where input_admission_id=${q(input)}`);
  sql(`update engineering_private.native_observer_validator_actors set enabled=false`);
  fail(ingest(profile,manifest,journal),/42501/,'disabled actor mapping denied');
  sql(`update engineering_private.native_observer_validator_actors set enabled=true`);
  const receipt=sql(ingest(profile,manifest,journal,'ovd575_observer_validator',
    `set local request.jwt.claim.sub=${q(other)};`)).split('\n').at(-1);
  check(/^[0-9a-f-]{36}$/.test(receipt),'valid narrow ingestion returns evidence ID');
  equal(sql(`select admitted_by from engineering_private.native_observer_evidence where id=${q(receipt)}`),actor,
    'server-owned mapping controls auth.users attribution');
  equal(sql(`select active_attempt_id from engineering_private.native_slots where organization_id=${q(organization)}`),
    attempt,'registry does not release occupancy');
  equal(sql(`select result_eligible from public.engineering_execution_attempts where id=${q(attempt)}`),
    't','registry does not change result eligibility');
  equal(sql(`select encode(manifest_bytes,'hex') from engineering_private.native_observer_evidence where id=${q(receipt)}`),
    Buffer.from(canonical(manifest)).toString('hex'),'exact canonical manifest bytes retained');
  equal(sql(`select encode(journal_bytes,'hex') from engineering_private.native_observer_evidence where id=${q(receipt)}`),
    Buffer.from(canonical(journal)).toString('hex'),'exact canonical journal bytes retained');
  fail(ingest(profile,manifest,journal),/23505/,'duplicate attempt evidence denied');
  fail(`begin;set local role ovd575_observer_validator;insert into engineering_private.native_observer_evidence(id) values(gen_random_uuid());commit;`,/42501/,'direct validator DML denied');
  fail(`update engineering_private.native_observer_evidence set verdict='complete_in_job_envelope' where id=${q(receipt)}`,/55000/,'evidence update denied');
  fail(`delete from engineering_private.native_observer_evidence where id=${q(receipt)}`,/55000/,'evidence deletion denied');
  fail(`update engineering_private.native_observer_profiles set observer_version='windows-job-observer/1' where id=${q(profile)}`,/55000/,'profile update denied');
  equal(sql(`select count(*) from engineering_private.native_stop_admissions`),'0','registry creates no stop admission');
  report={schema:'overdrafter.ovd575-registry-test.v1',assertions,
    sourceMigration:migration,containerImage:image,fixtureOnly:true,stopAdmission:false,
    resultEligibilityChanged:false,cleanup:'pending'};
} finally {
  const cleanupErrors=[];
  if(containerId) {
    try {
      const id=run(['inspect','--format','{{.Id}}',container]);
      if(id!==containerId)cleanupErrors.push('OVD-575 container ownership changed; preserved for inspection');
      else run(['rm','-f',container]);
    } catch(error_) {cleanupErrors.push(String(error_));}
  }
  if(networkId) {
    try {
      const id=run(['network','inspect','--format','{{.Id}}',network]);
      if(id!==networkId)cleanupErrors.push('OVD-575 network ownership changed; preserved for inspection');
      else if(cleanupErrors.length===0)run(['network','rm',network]);
    } catch(error_) {cleanupErrors.push(String(error_));}
  }
  if(Date.now()-started>20*60_000)cleanupErrors.push('OVD-575 fixture setup exceeded 20 minute cap');
  if(cleanupErrors.length) {
    process.exitCode=1;
    for(const cleanupError of cleanupErrors)console.error(cleanupError);
    report=null;
  }
}
if(report)console.log(JSON.stringify({...report,cleanup:'verified'}));
