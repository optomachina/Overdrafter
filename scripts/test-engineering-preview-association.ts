/** Disposable real PostgreSQL preview association and RLS tests. Native/export
 * admission and transport authentication are explicitly simulated. STEP bytes
 * and report geometry are retained9mm export data, rebound to disjoint fixtures. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNativeVerifier } from "../server/engineering/native-verifier-client";
import { q, sql, call, stoppedFixture, finalize, rejected, waitFor } from "./lib/native-result-db-fixtures.mjs";
const source = "a".repeat(64);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
async function fixture(previewEnabled=true) {
  const dir = "server/engineering/fixtures/preview-9mm/";
  const bundle = JSON.parse(await readFile(dir+"preview.json","utf8"));
  const report = JSON.parse(await readFile(dir+"native-step.stdout.txt","utf8"));
  const f = await stoppedFixture(false,null,{depthMm:9,outputFiles:bundle.nativeFiles});
  await finalize(f); f.exportId=randomUUID(); f.principal=randomUUID(); f.key=randomUUID();
  const context=f.context;
  Object.assign(bundle,{scope:context.scope,snapshotId:context.snapshotId,contextSha256:hash(encode(context)),
    requestSha256:context.producer.requestSha256,resultSha256:context.producer.resultSha256});
  for(const key of ["contextSha256","requestSha256","resultSha256"]) report[key]=bundle[key];
  const bytes={report:encode(report),bundle:new Uint8Array()};bundle.export.reportSha256=hash(bytes.report);bytes.bundle=encode(bundle);
  const objects=(["bundle","report"] as const).map(role=>({id:randomUUID(),role,bytes:bytes[role].length,sha256:hash(bytes[role])}));
  const process={nativePid:report.nativePid,helperPid:report.helperPid,nativeStartTicks:report.nativeStartTicks,candidateRoot:report.candidateRoot};
  await sql(`insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,admitted_at,expires_at,preview_policy_version)
    values(${q(f.principal)},${q(f.org)},${q(f.project)},${q(source)},'prepared-native-reports-v1','preview-test',${q(f.actor)},clock_timestamp(),clock_timestamp()+interval '10 minutes',${previewEnabled?q('prepared-native-preview-v1'):'null'});
    insert into engineering_private.native_preview_exports(id,snapshot_id,organization_id,project_id,context_sha256,source_commit,process,objects,evidence_sha256,admitted_by)
    values(${q(f.exportId)},${q(context.snapshotId)},${q(f.org)},${q(f.project)},${q(bundle.contextSha256)},${q(bundle.export.sourceCommit)},
      ${q(JSON.stringify(process))},${q(JSON.stringify(objects))},${q('b'.repeat(64))},${q(f.actor)});
    insert into storage.buckets(id,name,public) values('engineering-native-previews','engineering-native-previews',false) on conflict do nothing;`);
  const names=objects.map(o=>`${f.org}/${f.project}/${f.exportId}/${o.id}`);
  for(const name of names)await sql(`insert into storage.objects(bucket_id,name) values('engineering-native-previews',${q(name)})`);
  const verifier=(expression:string)=>call({...f,actor:f.principal},expression,undefined,'engineering_native_verifier');
  const load=()=>verifier(`public.api_load_native_preview(${q(f.exportId)},${q(f.key)})`);
  const ownerRead=()=>call(f,`public.api_get_native_preview(${q(context.snapshotId)})`,undefined,'authenticated');
  const requests:string[]=[];
  const token=`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({role:'engineering_native_verifier',sub:f.principal})).toString('base64url')}.fixture`;
  const fetcher:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));assert.equal(u.origin,'https://preview.example.test');assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${token}`);
    if(u.pathname.startsWith('/storage/v1/object/engineering-native-previews/')){
      const name=u.pathname.slice('/storage/v1/object/engineering-native-previews/'.length);requests.push(name);
      const admitted=await verifier(`jsonb_build_object('allowed',exists(select 1 from storage.objects where bucket_id='engineering-native-previews' and name=${q(name)}))`);
      if(!admitted.allowed)return new Response(null,{status:403});
      const index=names.indexOf(name);assert.ok(index>=0);return new Response(bytes[objects[index].role]);
    }
    const body=JSON.parse(String(init?.body));
    if(u.pathname.endsWith('api_load_native_preview'))return Response.json(await verifier(`public.api_load_native_preview(${q(body.p_export)},${q(body.p_key)})`));
    assert.ok(u.pathname.endsWith('api_complete_native_preview'));
    return Response.json(await verifier(`public.api_complete_native_preview(${q(body.p_run)},${q(body.p_step_sha256)},${body.p_step_bytes})`));
  };
  const client=createNativeVerifier({enabled:true,projectUrl:'https://preview.example.test',apiKey:'fixture',verifierToken:token,sourceSha256:source},fetcher);
  return {...f,context,bundle,report,bytes,objects,names,verifier,load,ownerRead,requests,client};
}
const nativeOnly=await fixture(false);await rejected(nativeOnly.load(),'42501');
await rejected(sql(`update engineering_private.native_verifier_principals set preview_policy_version='prepared-native-preview-v1' where id=${q(nativeOnly.principal)}`),'55000');
const f=await fixture();assert.equal((await f.ownerRead()).status,'unavailable');
for(const role of ['anon','authenticated','service_role']){
  await rejected(call({...f,actor:f.principal},`public.api_load_native_preview(${q(f.exportId)},${q(f.key)})`,undefined,role),'42501');
  await rejected(call({...f,actor:f.principal},`public.api_complete_native_preview(${q(randomUUID())},${q('a'.repeat(64))},10)`,undefined,role),'42501');
}
await rejected(call({...f,actor:randomUUID()},`public.api_get_native_preview(${q(f.context.snapshotId)})`,undefined,'authenticated'),'42501');
await rejected(call(f,`public.api_get_native_preview(${q(f.snapshot)})`,undefined,'authenticated'),'42501');
const before=await sql(`select jsonb_build_object('head',head_snapshot_id,'revision',revision) from public.engineering_conversations where id=${q(f.conversation)}`);
const loads=await Promise.all(Array.from({length:5},()=>f.load()));loads.forEach(l=>assert.deepEqual(l,loads[0]));
const delivery=loads[0];assert.equal(delivery.status,'ready');
// Broad PUBLIC policies must not reveal unverified previews or reports.
const policy=`preview_fixture_${randomUUID().replaceAll('-','')}`;
await sql(`create policy ${policy} on storage.objects for all to public using(true) with check(true)`);
assert.equal((await call(f,`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`,undefined,'authenticated')).count,0);
assert.equal((await f.verifier(`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`)).count,2);
const result=await f.client.verifyPreview(f.exportId,f.key) as {status:string;snapshotId:string;step:{sha256:string}};assert.equal(result.status,'ready');
assert.equal(result.snapshotId,f.context.snapshotId);assert.equal(result.step.sha256,f.bundle.step.sha256);assert.equal(f.requests.length,2);
assert.deepEqual(await f.ownerRead(),result);assert.deepEqual(await f.client.verifyPreview(f.exportId,f.key),result);assert.equal(f.requests.length,2);
assert.equal(await sql(`select jsonb_build_object('head',head_snapshot_id,'revision',revision) from public.engineering_conversations where id=${q(f.conversation)}`),before);
assert.equal((await call(f,`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`,undefined,'authenticated')).count,1);
assert.equal((await f.verifier(`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`)).count,0);
const complete=()=>f.verifier(`public.api_complete_native_preview(${q(delivery.runId)},${q(f.bundle.step.sha256)},${f.bundle.step.bytes})`);
(await Promise.all(Array.from({length:5},complete))).forEach(r=>assert.deepEqual(r,result));
await rejected(f.verifier(`public.api_complete_native_preview(${q(delivery.runId)},${q('f'.repeat(64))},${f.bundle.step.bytes})`),'PT409');
await rejected(sql(`begin;set local role authenticated;set local request.jwt.claim.sub=${q(f.actor)};
 insert into storage.objects(bucket_id,name) values('engineering-native-previews','bad');rollback;`),'42501');
await rejected(sql(`begin;set local role authenticated;set local request.jwt.claim.sub=${q(f.actor)};
 delete from storage.objects where name=${q(f.names[0])};rollback;`),'42501');
assert.equal(await sql(`begin;set local role authenticated;set local request.jwt.claim.sub=${q(f.actor)};
 with u as(update storage.objects set name='changed' where name=${q(f.names[0])} returning *)select count(*) from u;rollback;`),'0');
for(const table of ['native_preview_exports','native_preview_runs','native_preview_receipts','native_preview_revocations'])
 await rejected(sql(`begin;set local role engineering_native_verifier;select * from engineering_private.${table};rollback;`),'42501');
await rejected(sql(`update engineering_private.native_preview_receipts set step_bytes=1 where export_id=${q(f.exportId)}`),'55000');
await sql(`insert into engineering_private.native_preview_revocations(export_id,revoked_by,reason) values(${q(f.exportId)},${q(f.actor)},'Fixture quarantine')`);
assert.equal((await f.ownerRead()).status,'unavailable');await rejected(f.load(),'42501');
assert.equal((await call(f,`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`,undefined,'authenticated')).count,0);

// A fresh admitted export can recover a quarantined preview for the same exact
// snapshot. The old receipt remains immutable and cannot be read or reactivated.
const replacement=randomUUID(), replacementKey=randomUUID();
await sql(`insert into engineering_private.native_preview_exports(id,snapshot_id,organization_id,project_id,context_sha256,source_commit,process,objects,evidence_sha256,admitted_by)
 select ${q(replacement)},snapshot_id,organization_id,project_id,context_sha256,source_commit,process,objects,evidence_sha256,admitted_by
 from engineering_private.native_preview_exports where id=${q(f.exportId)}`);
const replacementLoad=await f.verifier(`public.api_load_native_preview(${q(replacement)},${q(replacementKey)})`);
await rejected(f.verifier(`public.api_load_native_preview(${q(replacement)},${q(f.key)})`),'PT409');
const replaced=await f.verifier(`public.api_complete_native_preview(${q(replacementLoad.runId)},${q(f.bundle.step.sha256)},${f.bundle.step.bytes})`);
assert.equal(replaced.exportId,replacement);assert.equal((await f.ownerRead()).exportId,replacement);
assert.equal(await sql(`select count(*) from engineering_private.native_preview_receipts where snapshot_id=${q(f.context.snapshotId)}`),'2');
const competing=randomUUID();
await sql(`insert into engineering_private.native_preview_exports(id,snapshot_id,organization_id,project_id,context_sha256,source_commit,process,objects,evidence_sha256,admitted_by)
 select ${q(competing)},snapshot_id,organization_id,project_id,context_sha256,source_commit,process,objects,evidence_sha256,admitted_by
 from engineering_private.native_preview_exports where id=${q(f.exportId)}`);
await rejected(f.verifier(`public.api_load_native_preview(${q(competing)},${q(randomUUID())})`),'PT409');
const historyKey=randomUUID();
assert.equal((await f.verifier(`public.api_load_native_preview(${q(replacement)},${q(historyKey)})`)).status,'completed');
assert.equal(await sql(`select export_id from engineering_private.native_preview_runs where principal_id=${q(f.principal)} and idempotency_key=${q(historyKey)}`),replacement);
await rejected(f.verifier(`public.api_load_native_preview(${q(competing)},${q(historyKey)})`),'PT409');

assert.equal((await call(f,`jsonb_build_object('count',(select count(*) from storage.objects where bucket_id='engineering-native-previews'))`,undefined,'anon')).count,0);

for(const kind of ['bad_bytes','revoked_principal','disabled_owner','revoked_export','expired_run']){
 const x=await fixture();const l=await x.load();
 if(kind==='bad_bytes')x.bytes.bundle[5]^=1;
 if(kind==='revoked_principal')await sql(`update engineering_private.native_verifier_principals set revoked_at=clock_timestamp() where id=${q(x.principal)}`);
 if(kind==='disabled_owner')await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${q(x.org)}`);
 if(kind==='revoked_export')await sql(`insert into engineering_private.native_preview_revocations(export_id,revoked_by,reason) values(${q(x.exportId)},${q(x.actor)},'Fixture')`);
 if(kind==='expired_run'){
   const expired=randomUUID();await sql(`insert into engineering_private.native_preview_runs(id,principal_id,idempotency_key,export_id,created_at,expires_at)
     select ${q(expired)},${q(x.principal)},gen_random_uuid(),${q(x.exportId)},at_time-interval '2 minutes',at_time-interval '1 minute' from (select clock_timestamp() as at_time) timing`);
   await rejected(x.verifier(`public.api_complete_native_preview(${q(expired)},${q(x.bundle.step.sha256)},${x.bundle.step.bytes})`),'PT409');
 }else await assert.rejects(x.client.verifyPreview(x.exportId,x.key));
 assert.equal(await sql(`select count(*) from engineering_private.native_preview_receipts where export_id=${q(x.exportId)}`),'0');
 assert.equal(await sql(`select verification_state from public.engineering_tasks where id=${q(x.task)}`),'passed');
 assert.ok(l.runId);
}
// Actual lock barriers prove revocation is seen after waits and deadlines are
// rechecked after receipt insertion. Near-expiry fixtures never mutate history.
const exec=promisify(execFile);
const args=['exec','-i',process.argv[2],'psql','-U','postgres','-d','ovd505_native_results','-Atq','-v','ON_ERROR_STOP=1'];
for(const kind of ['export_revocation','owner_revocation','run_deadline','principal_deadline']){
 const x=await fixture();let principal=x.principal,run=(await x.load()).runId;
 const name=`preview-race-${randomUUID()}`,guardName=name+'-guard';
 let lock=`select id from public.engineering_snapshots where id=${q(x.context.snapshotId)} for update`;
 if(kind.endsWith('deadline')){
   principal=randomUUID();run=randomUUID();
   await sql(`insert into engineering_private.native_verifier_principals(id,organization_id,project_id,source_sha256,policy_version,validator_version,admitted_by,admitted_at,expires_at,preview_policy_version)
     select ${q(principal)},${q(x.org)},${q(x.project)},${q(source)},'prepared-native-reports-v1','deadline',${q(x.actor)},t,t+interval '${kind==='principal_deadline'?'3 seconds':'10 minutes'}','prepared-native-preview-v1' from(select clock_timestamp() t) timing;
     insert into engineering_private.native_preview_runs(id,principal_id,idempotency_key,export_id,created_at,expires_at)
     select ${q(run)},${q(principal)},gen_random_uuid(),${q(x.exportId)},t,t+interval '60 seconds' from(select clock_timestamp()-interval '${kind==='run_deadline'?'57 seconds':'0 seconds'}' t) timing;`);
   const fn='preview_deadline_'+randomUUID().replaceAll('-',''),key='preview:'+x.exportId;
   await sql(`create function engineering_private.${fn}() returns trigger language plpgsql set search_path='' as $$ begin
     perform pg_advisory_xact_lock(hashtextextended(${q(key)},0));return new;end;$$;
     create trigger ${fn} before insert on engineering_private.native_preview_receipts for each row
       when(new.export_id=${q(x.exportId)}::uuid) execute function engineering_private.${fn}()`);
   lock=`select pg_advisory_xact_lock(hashtextextended(${q(key)},0))`;
 }
 const guard=exec('docker',args,{timeout:20000});const guardResult=guard.then(()=>true,()=>false);
 guard.child.stdin!.write(`begin;set local application_name=${q(guardName)};set local idle_in_transaction_session_timeout='15s';${lock};\n`);
 let pending;
 try{
   await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(guardName)} and state='idle in transaction')`);
   pending=call({...x,actor:principal},`public.api_complete_native_preview(${q(run)},${q(x.bundle.step.sha256)},${x.bundle.step.bytes})`,name,'engineering_native_verifier')
     .then(value=>({value}),error=>({error}));
   await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(name)} and wait_event in('transactionid','advisory'))`);
   if(kind==='export_revocation')await sql(`insert into engineering_private.native_preview_revocations(export_id,revoked_by,reason) values(${q(x.exportId)},${q(x.actor)},'Race fixture')`);
   else if(kind==='owner_revocation')await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${q(x.org)}`);
   else await waitFor(`select expires_at<=clock_timestamp() from engineering_private.${kind==='run_deadline'?'native_preview_runs':'native_verifier_principals'} where id=${q(kind==='run_deadline'?run:principal)}`);
 }finally{guard.child.stdin!.end('commit;\n');assert.equal(await guardResult,true);}
 const outcome=await pending;assert.match(outcome?.error?.stderr??'',/PT409|42501/,kind);
 assert.equal(await sql(`select count(*) from engineering_private.native_preview_receipts where export_id=${q(x.exportId)}`),'0');
}

console.log(JSON.stringify({status:'passed',proof:'real PostgreSQL association, scoped roles/storage RLS, concurrent delivery replay, immutable history, source preservation, unavailable and revoked/invalid refusal',transport:'simulated fetch/JWT and native admission; retained9mm STEP/geometry with rebound fixture context'}));
