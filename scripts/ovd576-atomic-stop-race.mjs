/** Race only synthetic stop requests in the owned disposable migration replay. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const n=value=>`50100000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const q=value=>`'${String(value).replaceAll("'","''")}'`;
function section(source,name) {
  const begin=`-- OVD576_RACE_${name}_BEGIN`;
  const end=`-- OVD576_RACE_${name}_END`;
  assert.equal(source.split(begin).length,2,`${name} start marker`);
  assert.equal(source.split(end).length,2,`${name} end marker`);
  return source.split(begin)[1].split(end)[0];
}
function childSql(dockerExecutable,container,password,statement,stdin=false) {
  const args=['exec','-i','-e',`PGPASSWORD=${password}`,container,
    'psql','-U','postgres','-d','postgres','-X','-Atq',
    '-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
  if(!stdin)args.push('-c',statement);
  const child=spawn(dockerExecutable,args,{stdio:[stdin?'pipe':'ignore','pipe','pipe'],timeout:30_000});
  let stdout='',stderr='';
  if(stdin)child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  // Settle to a value immediately: a failing child must not create an
  // unhandled rejection while the lock-barrier observer is still polling.
  const result=new Promise(resolve=>{
    child.on('error',error=>resolve({ok:false,error:String(error)}));
    child.on('close',code=>resolve({ok:code===0,stdout:stdout.trim(),
      error:code===0?null:`ovd576_race_psql_failed:${stderr.slice(0,500)}`}));
  });
  if(stdin)child.stdin.write(statement);
  return {child,result};
}
async function waitFor(psql,query) {
  for(let i=0;i<80;i++) {
    if(psql(query)==='t')return;
    await delay(100);
  }
  throw new Error('ovd576_race_lock_barrier_not_observed');
}

export async function runAtomicStopRace({dockerExecutable,container,password,psql,prefix,test}) {
  const seed=`${prefix}\n${section(test,'SEED')}\n${section(test,'QUAL')}\n`+
    'grant ovd576_stop_validator to postgres with set true;\ncommit;';
  psql(seed,240_000);
  const task=psql(`select t.id from public.engineering_tasks t
    join public.engineering_decisions d on d.id=t.decision_id
    where t.conversation_id=${q(n(30))} and d.sequence=1`);
  const attempt=psql(`select current_attempt_id from public.engineering_task_execution
    where task_id=${q(task)}`);
  const credential=psql("select encode(extensions.digest('synthetic-ovd501-9','sha256'),'hex')");
  const org=n(4);
  const statement=index=>`begin;set local application_name='ovd576-race-${index}';
       set local role ovd576_stop_validator;
       select engineering_private.admit_qualified_native_stop(
         ${q(n(50))},${q(credential)},${q(n(52))},${q(task)},${q(attempt)},
         1,${q(n(91))},1,${q(n(220))});commit;`;
  // Authorization must be read after a queued caller acquires native locks.
  const disabledBlocker=childSql(dockerExecutable,container,password,
    `begin;set local application_name='ovd576-disable-blocker';
     select pg_advisory_xact_lock(hashtextextended('engineering-native:'||${q(org)},0));\n`,true);
  let disableReleased=false;
  try {
    await waitFor(psql,`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='ovd576-disable-blocker' and l.locktype='advisory' and l.granted)`);
    const waiting=childSql(dockerExecutable,container,password,statement('disabled')).result
      .then(outcome=>({denied:!outcome.ok && /42501/.test(outcome.error)}));
    await waitFor(psql,`select exists(select 1 from pg_stat_activity
      where application_name='ovd576-race-disabled' and wait_event_type='Lock')`);
    psql("update engineering_private.native_stop_validator_actors set enabled=false where executor_role='ovd576_stop_validator'");
    disabledBlocker.child.stdin.end('commit;\n');disableReleased=true;
    assert.deepEqual(await waiting,{denied:true},'queued call observes validator disablement');
    assert.equal(psql(`select count(*) from engineering_private.native_stop_admissions
      where attempt_id=${q(attempt)}`),'0');
    assert.equal(psql(`select active_attempt_id from engineering_private.native_slots
      where organization_id=${q(org)}`),attempt);
    psql("update engineering_private.native_stop_validator_actors set enabled=true where executor_role='ovd576_stop_validator'");
  } finally {
    if(!disableReleased && !disabledBlocker.child.stdin.destroyed)
      disabledBlocker.child.stdin.end('rollback;\n');
    const result=await disabledBlocker.result;
    assert.equal(result.ok,true,result.error);
  }
  const blocker=childSql(dockerExecutable,container,password,
    `begin;set local application_name='ovd576-race-blocker';
     select pg_advisory_xact_lock(hashtextextended('engineering-native:'||${q(org)},0));\n`,true);
  let released=false;
  try {
    await waitFor(psql,`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='ovd576-race-blocker' and l.locktype='advisory' and l.granted)`);
    const call=index=>childSql(dockerExecutable,container,password,statement(index)).result;
    const first=call(1),second=call(2);
    await waitFor(psql,`select (select count(*) from pg_stat_activity
      where application_name like 'ovd576-race-%' and application_name<>'ovd576-race-blocker'
        and wait_event_type='Lock')=2`);
    blocker.child.stdin.end('commit;\n');released=true;
    const [left,right]=await Promise.all([first,second]);
    assert.equal(left.ok,true,left.error);
    assert.equal(right.ok,true,right.error);
    const receiptLeft=JSON.parse(left.stdout.split('\n').at(-1));
    const receiptRight=JSON.parse(right.stdout.split('\n').at(-1));
    assert.deepEqual(receiptLeft,receiptRight,'concurrent duplicates return one receipt');
    assert.equal(receiptLeft.outcome,'process_stopped');
    assert.equal(psql(`select count(*) from engineering_private.native_stop_admissions
      where attempt_id=${q(attempt)}`),'1');
    assert.equal(psql(`select count(*) from engineering_private.native_attempt_events
      where attempt_id=${q(attempt)} and kind='stopped'`),'1');
    assert.equal(psql(`select active_attempt_id is null from engineering_private.native_slots
      where organization_id=${q(org)}`),'t');
    return {validatorDisableAfterWaitDenied:true,concurrentCallers:2,observedLockWaiters:2,admissions:1,stopEvents:1,
      sameReceipt:true,slotReleased:true,fixtureOnly:true,actualNativeQualification:false};
  } finally {
    if(!released && !blocker.child.stdin.destroyed)blocker.child.stdin.end('rollback;\n');
    const result=await blocker.result;
    assert.equal(result.ok,true,result.error);
  }
}
