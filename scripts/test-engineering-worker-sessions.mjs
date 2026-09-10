/**
 * Exercise pairing and session authority in an explicitly named disposable local
 * PostgreSQL container. Synthetic secrets are never printed; reports go to stdout.
 * These are database contract tests, not Windows/DPAPI/native qualification.
 */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
if (process.argv.length !== 3 || !/^supabase_db_ovd498-[a-z0-9-]+$/.test(process.argv[2])) {
  throw new Error('Pass exactly one disposable local OVD-498 container; reports go only to stdout.');
}
const psql = ['exec','-i',process.argv[2],'psql','-U','postgres','-Atq','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
/** Only local generated fixture values enter SQL. */
function q(value) { return `'${String(value).replaceAll("'","''")}'`; }
/** Generate independent high-entropy test digests without retaining raw tokens. */
function digest() { return createHash('sha256').update(randomBytes(32)).digest('hex'); }
/** Execute finite test-owned database calls; never accept a connection URL. */
async function sql(source) {
  return (await exec('docker',[...psql,'-c',source],{timeout:15_000,maxBuffer:2_000_000})).stdout.trim();
}
const tap = await sql(await readFile(new URL('../supabase/tests/engineering_worker_sessions.sql',import.meta.url),'utf8'));
assert.doesNotMatch(tap,/not ok|Looks like you failed|planned \d+ tests but ran/i);
assert.match(tap,/^1\.\.81$/m);
assert.equal(tap.split('\n').filter((line)=>/^ok \d+\b/.test(line)).length,81);
/** Create a separate synthetic scope for each independent race. */
async function fixture() {
  const f={actor:randomUUID(),org:randomUUID(),project:randomUUID(),worker:randomUUID(),code:digest(),credential:digest(),installation:randomUUID(),boot:randomUUID()};
  await sql(`begin;
    insert into auth.users(id,aud,role,email,email_confirmed_at) values(${q(f.actor)},'authenticated','authenticated',${q(`ovd498-${f.actor}@example.test`)},now());
    insert into public.organizations(id,name,slug) values(${q(f.org)},'OVD-498 fixture',${q(`ovd498-${f.org}`)});
    insert into public.organization_memberships(organization_id,user_id,role) values(${q(f.org)},${q(f.actor)},'client');
    insert into public.projects(id,organization_id,owner_user_id,name) values(${q(f.project)},${q(f.org)},${q(f.actor)},'OVD-498 fixture');
    insert into public.project_memberships(project_id,user_id,role) values(${q(f.project)},${q(f.actor)},'owner');
    insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values(${q(f.org)},${q(f.actor)},true);
    commit;`);
  return f;
}
/** Simulate gateway/owner roles only inside this disposable test database. */
async function call(f,role,expression,name='ovd498-test') {
  return JSON.parse(await sql(`begin; set local application_name=${q(name)}; set local role ${role};
    set local request.jwt.claim.sub=${q(f.actor)}; select ${expression}; commit;`));
}
function invitation(f,key) { return call(f,'authenticated',`public.api_create_worker_pairing(${q(f.worker)},${q(f.org)},${q(f.project)},0,${q(key)},${q(f.code)})`); }
function pairing(f,key) { return call(f,'service_role',`public.api_consume_worker_pairing(${q(f.worker)},1,${q(key)},${q(f.code)},${q(f.installation)},${q(f.credential)})`); }
function boot(f,revision,key= randomUUID()) { return call(f,'service_role',`public.api_register_worker_boot(${q(f.worker)},${revision},${q(key)},${q(f.credential)},${q(f.boot)})`); }
function control(f,revision,key,action='enabled',name) { return call(f,'authenticated',`public.api_control_worker_session(${q(f.worker)},${revision},${q(key)},${q(action)},${q(f.boot)})`,name); }
function eligible(f,name) { return call(f,'service_role',`public.api_worker_session_eligibility(${q(f.worker)},${q(f.credential)},${q(f.boot)})`,name); }
/** Confirm the same immutable receipt under duplicate concurrent delivery. */
async function duplicates(operation) {
  const results=await Promise.all(Array.from({length:5},operation));
  for (const result of results) assert.deepEqual(result,results[0]);
  return results[0];
}
const f=await fixture(),inviteKey=randomUUID(),pairKey=randomUUID(),enableKey=randomUUID();
await duplicates(()=>invitation(f,inviteKey));
await duplicates(()=>pairing(f,pairKey));
await boot(f,2);
const enabled=await duplicates(()=>control(f,3,enableKey));
assert.equal((await eligible(f)).sessionEligible,true);
assert.equal(await sql(`select count(*) from public.engineering_worker_sessions where worker_id=${q(f.worker)}`),'1');
const pauseKey=randomUUID();
await duplicates(()=>control(f,4,pauseKey,'paused'));
assert.equal((await eligible(f)).reason,'paused');
const race=await fixture();
await invitation(race,randomUUID());
const other={...race,installation:randomUUID(),credential:digest()};
const contenders=await Promise.allSettled([pairing(race,randomUUID()),pairing(other,randomUUID())]);
assert.equal(contenders.filter((r)=>r.status==='fulfilled').length,1);
assert.match(contenders.find((r)=>r.status==='rejected').reason.stderr,/PT409/);
const winner=contenders[0].status==='fulfilled' ? race : other;
const loser=contenders[0].status==='fulfilled' ? other : race;
await boot(winner,2);
await assert.rejects(eligible(loser),(error)=>error.stderr.includes('42501'));
const enableRace=await Promise.allSettled([control(winner,3,randomUUID()),control(winner,3,randomUUID())]);
assert.equal(enableRace.filter((r)=>r.status==='fulfilled').length,1);
assert.match(enableRace.find((r)=>r.status==='rejected').reason.stderr,/PT409/);
assert.equal(await sql(`select count(*) from public.engineering_worker_sessions where worker_id=${q(winner.worker)}`),'1');
/** Wait for a test-observable database barrier, not an assumed machine speed. */
async function waitFor(query) {
  for (let i=0;i<50;i++) {
    if (await sql(query)==='t') return;
    await delay(100);
  }
  throw new Error('Database barrier was not reached.');
}
/** Hold a test-owned worker lock until the caller explicitly releases it. */
async function barrier(worker,run) {
  const name=`ovd498-lock-${randomUUID()}`;
  const child=exec('docker',psql,{timeout:30_000,maxBuffer:2_000_000});
  const outcome=child.then(()=>({ok:true}),(error)=>({ok:false,error}));
  child.child.stdin.write(`begin; set local idle_in_transaction_session_timeout='30s'; set local application_name=${q(name)};
    select pg_advisory_xact_lock(hashtextextended('engineering-worker:' || ${q(worker)},0));\n`);
  try {
    await waitFor(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${q(name)} and l.locktype='advisory' and l.granted)`);
    await run(()=>child.child.stdin.end('commit;\n'));
  } finally {
    if (!child.child.stdin.writableEnded) child.child.stdin.end('rollback;\n');
    const result=await outcome;
    assert.equal(result.ok,true,result.error?.stderr);
  }
}
// Access is revoked while both owner and service callers wait on the worker lock.
await barrier(f.worker,async(release)=>{
  const readName=`ovd498-read-${randomUUID()}`,ownerName=`ovd498-owner-${randomUUID()}`;
  const waiting=Promise.allSettled([eligible(f,readName),control(f,3,enableKey,'enabled',ownerName)]);
  await waitFor(`select count(*)=2 from pg_stat_activity where application_name in (${q(readName)},${q(ownerName)}) and wait_event='advisory'`);
  await sql(`update engineering_private.engineering_operators set enabled=false where organization_id=${q(f.org)} and user_id=${q(f.actor)}`);
  release();
  const results=await waiting;
  assert.ok(results.every((r)=>r.status==='rejected' && r.reason.stderr.includes('42501')));
});
// A fixed test-only grant expires while the eligibility call waits. The earlier
// transaction start time cannot extend authority beyond the database deadline.
const clock=await fixture();
await invitation(clock,randomUUID()); await pairing(clock,randomUUID()); await boot(clock,2);
const clockSession=randomUUID();
const expiry=await sql(`select (clock_timestamp()+interval '2 seconds')::text`);
await sql(`begin;
 insert into public.engineering_worker_sessions(id,worker_id,organization_id,project_id,owner_user_id,installation_id,boot_id,enabled_at,expires_at)
 values(${q(clockSession)},${q(clock.worker)},${q(clock.org)},${q(clock.project)},${q(clock.actor)},${q(clock.installation)},${q(clock.boot)},${q(expiry)}::timestamptz-interval '8 hours',${q(expiry)}::timestamptz);
 update public.engineering_workers set current_session_id=${q(clockSession)},revision=revision+1 where id=${q(clock.worker)};
 commit;`);
await barrier(clock.worker,async(release)=>{
  const name=`ovd498-clock-${randomUUID()}`;
  const waiting=eligible(clock,name);
  await waitFor(`select exists(select 1 from pg_stat_activity where application_name=${q(name)} and wait_event='advisory')`);
  assert.equal(await sql(`select xact_start<${q(expiry)}::timestamptz from pg_stat_activity where application_name=${q(name)}`),'t','expiry test must begin before its deadline');
  await waitFor(`select clock_timestamp()>=${q(expiry)}::timestamptz`);
  release();
  assert.equal((await waiting).reason,'expired');
});
console.log(JSON.stringify({schema:'overdrafter.worker-session-db-test.v1',tapAssertions:81,
  duplicateInvitations:5,duplicatePairings:5,duplicateEnables:5,duplicatePauses:5,
  pairingContenders:2,pairingWinners:1,enableContenders:2,enableWinners:1,
  revokedWaitingCallers:2,expiryRecheckedAfterLock:true,initialSessionId:enabled.sessionId,
  windowsQualification:false,productionChanged:false},null,2));
