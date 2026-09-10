/**
 * Verify ordered admission with independent sessions in a named disposable local
 * engineering database. Emits reports only to stdout, retains synthetic fixture
 * identities, and never accepts a remote database URL or runs native CAD.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
if (process.argv.length !== 3 || !/^supabase_db_ovd49[67]-[a-z0-9-]+$/.test(process.argv[2])) {
  throw new Error('Pass exactly one disposable local OVD-496/497 container; reports go only to stdout.');
}
const container = process.argv[2];
const psql = ['exec','-i',container,'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
/** SQL interpolation below is restricted to generated fixture values. */
function quote(value) { return `'${String(value).replaceAll("'","''")}'`; }
/** Bound local database calls and fail on PostgreSQL errors. */
async function sql(source) {
  return (await exec('docker',[...psql,'-c',source],{timeout:15_000,maxBuffer:2_000_000})).stdout.trim();
}
const tap = await sql(await readFile(new URL('../supabase/tests/engineering_ordered_changes.sql',import.meta.url),'utf8'));
assert.doesNotMatch(tap,/not ok|Looks like you failed|planned \d+ tests but ran/i);
assert.match(tap,/^1\.\.61$/m);
assert.equal(tap.split('\n').filter((line)=>/^ok \d+\b/.test(line)).length,61);
const actor=randomUUID(),organization=randomUUID(),project=randomUUID(),snapshot=randomUUID(),conversation=randomUUID();
const context=JSON.stringify({schema:'overdrafter.prepared-assembly.v2',snapshotId:snapshot,
  scope:{organizationId:organization,projectId:project},packageId:'ovd-native04-assembly',configuration:'Default',testOnly:true});
await sql(`begin;
 insert into auth.users(id,aud,role,email,email_confirmed_at) values(${quote(actor)},'authenticated','authenticated',${quote(`ovd497-${actor}@example.test`)},now());
 insert into public.organizations(id,name,slug) values(${quote(organization)},'OVD-497 fixture',${quote(`ovd497-${organization}`)});
 insert into public.organization_memberships(organization_id,user_id,role) values(${quote(organization)},${quote(actor)},'client');
 insert into public.projects(id,organization_id,owner_user_id,name) values(${quote(project)},${quote(organization)},${quote(actor)},'OVD-497 fixture');
 insert into public.project_memberships(project_id,user_id,role) values(${quote(project)},${quote(actor)},'owner');
 insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values(${quote(organization)},${quote(actor)},true);
 insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values(${quote(snapshot)},${quote(organization)},${quote(project)},${quote(context)});
 commit;`);
const requests=[];
for(let i=0;i<6;i++) {
  const receipt=JSON.parse(await sql(`begin; set local role authenticated; set local request.jwt.claim.sub=${quote(actor)};
    select public.api_submit_engineering_message(${quote(organization)},${quote(project)},${quote(conversation)},${quote(snapshot)},${i},${quote(randomUUID())},'Make depth 8 mm'); commit;`));
  requests.push(receipt.requestId);
}
/** Exercise the actual server-only API; role switching is a local fixture operation. */
async function admit(index,revision,key,depth=8,name='ovd497-admit') {
  return JSON.parse(await sql(`begin; set local application_name=${quote(name)}; set local role service_role;
    select public.api_resolve_engineering_request(${quote(requests[index])},${revision},${quote(key)},'prepared_change',${depth},'Fixture response',
      jsonb_build_object('model','test-only','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1','policyVersion','prepared-depth-v1',
        'inputSha256',encode(extensions.digest('Make depth 8 mm','sha256'),'hex'),
        'contextSha256',(select context_sha256 from public.engineering_snapshots where id=${quote(snapshot)})));
    commit;`));
}
const initialKey=randomUUID();
const duplicates=await Promise.all(Array.from({length:5},()=>admit(0,0,initialKey)));
for(const receipt of duplicates) assert.deepEqual(receipt,duplicates[0]);
const decisions=[duplicates[0].decisionId];
for(let i=1;i<4;i++) decisions.push((await admit(i,i,randomUUID())).decisionId);
const competitors=await Promise.allSettled([admit(4,4,randomUUID(),9),admit(4,4,randomUUID(),7)]);
assert.equal(competitors.filter((result)=>result.status==='fulfilled').length,1);
assert.match(competitors.find((result)=>result.status==='rejected').reason.stderr,/PT409/);
decisions.push(competitors.find((result)=>result.status==='fulfilled').value.decisionId);
const overflow=await Promise.allSettled(Array.from({length:4},()=>admit(5,5,randomUUID())));
assert.ok(overflow.every((result)=>result.status==='rejected' && result.reason.stderr.includes('Five engineering changes are already outstanding.')));
const cancelKey=randomUUID();
/** Cancellation names every active decision in the suffix, in exact order. */
async function cancel(revision,key,name="ovd497-cancel") {
  return JSON.parse(await sql(`begin; set local application_name=${quote(name)}; set local role authenticated; set local request.jwt.claim.sub=${quote(actor)};
    select public.api_cancel_engineering_suffix(${quote(conversation)},${revision},${quote(key)},
      array[${quote(decisions[4])}]::uuid[],'Cancel the last queued change'); commit;`));
}
const cancellations=await Promise.all(Array.from({length:3},()=>cancel(5,cancelKey)));
for(const receipt of cancellations) assert.deepEqual(receipt,cancellations[0]);
const next=await admit(5,6,randomUUID(),10);
assert.equal(next.predecessorDecisionId,decisions[3]);
assert.equal(next.revision,7);
// Explicit release barrier proves both APIs recheck access after waiting.
const blockerName=`ovd497-blocker-${randomUUID()}`,waiterName=`ovd497-waiter-${randomUUID()}`,cancelName=`ovd497-cancel-${randomUUID()}`;
const blocker=exec('docker',psql,{timeout:30_000,maxBuffer:2_000_000});
const blockerOutcome=blocker.then(()=>({ok:true}),(error)=>({ok:false,error}));
blocker.child.stdin.write(`begin; set local idle_in_transaction_session_timeout='30s'; set local application_name=${quote(blockerName)};
 select pg_advisory_xact_lock(hashtextextended('engineering:' || ${quote(conversation)},0));\n`);
/** Wait on actual lock state instead of assuming host speed. */
async function waitFor(query) {
 for(let i=0;i<25;i++) { if(await sql(query)==='t') return; await delay(100); }
 throw new Error('Database lock barrier not observed.');
}
try {
 await waitFor(`select exists(select 1 from pg_locks l join pg_stat_activity a using(pid) where a.application_name=${quote(blockerName)} and l.locktype='advisory' and l.granted)`);
 const waiter=admit(0,0,initialKey,8,waiterName).then((value)=>({ok:true,value}),(error)=>({ok:false,error}));
 const cancelWaiter=cancel(5,cancelKey,cancelName).then((value)=>({ok:true,value}),(error)=>({ok:false,error}));
 await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${quote(waiterName)} and wait_event='advisory')`);
 await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${quote(cancelName)} and wait_event='advisory')`);
 await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${quote(organization)} and user_id=${quote(actor)}`);
 blocker.child.stdin.end('commit;\n');
 assert.equal((await blockerOutcome).ok,true);
 const denied=await waiter;
 assert.equal(denied.ok,false);
 assert.match(denied.error.stderr,/42501/);
 const cancelDenied=await cancelWaiter;
 assert.equal(cancelDenied.ok,false);
 assert.match(cancelDenied.error.stderr,/42501/);
} finally {
 if(!blocker.child.stdin.writableEnded) blocker.child.stdin.end('rollback;\n');
 await blockerOutcome;
}
const state=JSON.parse(await sql(`select jsonb_build_object(
 'revision',(select revision from public.engineering_change_queues where conversation_id=${quote(conversation)}),
 'decisions',(select count(*) from public.engineering_decisions where conversation_id=${quote(conversation)}),
 'outstanding',(select count(*) from public.engineering_tasks where conversation_id=${quote(conversation)} and execution_state<>'canceled'),
 'canceled',(select count(*) from public.engineering_tasks where conversation_id=${quote(conversation)} and execution_state='canceled'),
 'events',(select count(*) from public.engineering_events where conversation_id=${quote(conversation)})
);`));
assert.deepEqual(state,{revision:7,decisions:6,outstanding:5,canceled:1,events:7});
console.log(JSON.stringify({outcome:'passed',sqlAssertions:61,duplicateAdmissions:5,lastSlotCompetitors:2,
 overflowRefusals:4,duplicateCancellations:3,revokedWaitingReplay:'denied',revokedWaitingCancellation:'denied',state,
 localContainer:container,retainedFixture:{actor,organization,project,snapshot,conversation}},null,2));
