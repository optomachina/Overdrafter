begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.n(n integer) returns uuid language sql immutable as $$
  select ('50100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.h(n integer) returns text language sql immutable as $$
  select encode(extensions.digest('synthetic-ovd501-'||n::text,'sha256'),'hex');
$$;
-- These are database-owner admission fixtures, never proof of Windows execution.
insert into auth.users(id,aud,role,email,email_confirmed_at) values
 (pg_temp.n(1),'authenticated','authenticated','native-owner@example.test',now()),
 (pg_temp.n(2),'authenticated','authenticated','native-other@example.test',now()),
 (pg_temp.n(3),'authenticated','authenticated','native-peer@example.test',now());
insert into public.organizations(id,name,slug) values
 (pg_temp.n(4),'Native A','ovd501-a'),(pg_temp.n(5),'Native B','ovd501-b');
insert into public.organization_memberships(organization_id,user_id,role) values
 (pg_temp.n(4),pg_temp.n(1),'client'),(pg_temp.n(4),pg_temp.n(3),'client'),(pg_temp.n(5),pg_temp.n(2),'internal_admin');
insert into public.projects(id,organization_id,owner_user_id,name) values
 (pg_temp.n(7),pg_temp.n(4),pg_temp.n(1),'Native A'),(pg_temp.n(8),pg_temp.n(5),pg_temp.n(2),'Native B');
insert into public.project_memberships(project_id,user_id,role) values
 (pg_temp.n(7),pg_temp.n(1),'owner'),(pg_temp.n(7),pg_temp.n(3),'editor');
insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values
 (pg_temp.n(4),pg_temp.n(1),true),(pg_temp.n(4),pg_temp.n(3),true),(pg_temp.n(5),pg_temp.n(2),true);
insert into public.engineering_snapshots(id,organization_id,project_id,context_text) values
 (pg_temp.n(20),pg_temp.n(4),pg_temp.n(7),jsonb_build_object(
 'schema','overdrafter.prepared-assembly.v2','packageId','ovd-native04-assembly',
 'scope',jsonb_build_object('organizationId',pg_temp.n(4),'projectId',pg_temp.n(7)),
 'snapshotId',pg_temp.n(20),'seedSnapshotId',pg_temp.n(20),'sequence',0,'producer',null,
 'createdAt','2026-09-10T00:00:00.000Z','configuration','Default','assemblyPath','synthetic-assembly.SLDASM',
 'files',jsonb_build_array(
   jsonb_build_object('path','synthetic-assembly.SLDASM','bytes',59987,'sha256','90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a'),
   jsonb_build_object('path','parts/baseline-5mm.SLDPRT','bytes',56144,'sha256','e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa'),
   jsonb_build_object('path','parts/candidate-8mm.SLDPRT','bytes',56171,'sha256','b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898')),
 'depthMm',5,'checks','[]'::jsonb)::text);
insert into public.engineering_workers(id,organization_id,project_id,owner_user_id,installation_id,current_boot_id)
 values(pg_temp.n(50),pg_temp.n(4),pg_temp.n(7),pg_temp.n(1),pg_temp.n(51),pg_temp.n(52));
insert into engineering_private.worker_credentials(worker_id,credential_sha256,paired_at) values(pg_temp.n(50),pg_temp.h(9),clock_timestamp());

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(30),pg_temp.n(20),0,pg_temp.n(100),'Depth 8 mm');
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(30),pg_temp.n(20),1,pg_temp.n(101),'Depth 9 mm');
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(31),pg_temp.n(20),0,pg_temp.n(102),'Depth 7 mm');
reset role;
do $$
declare q record;
begin
 for q in select r.id,r.receipt_revision,m.body,s.context_sha256 from public.engineering_requests r
   join public.engineering_messages m on m.id=r.message_id join public.engineering_snapshots s on s.id=r.input_snapshot_id
   where r.organization_id=pg_temp.n(4) order by r.conversation_id,r.receipt_revision loop
   perform public.api_resolve_engineering_request(q.id,q.receipt_revision-1,gen_random_uuid(),'prepared_change',8,'Prepared fixture',
    jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
     'policyVersion','prepared-depth-v1','inputSha256',encode(extensions.digest(q.body,'sha256'),'hex'),'contextSha256',q.context_sha256));
 end loop;
end;
$$;
create function pg_temp.task(n integer default 1,c integer default 30) returns uuid language sql security definer as $$
 select t.id from public.engineering_tasks t join public.engineering_decisions d on d.id=t.decision_id
 where t.conversation_id=pg_temp.n(c) and d.sequence=n;
$$;
create function pg_temp.attempt() returns uuid language sql security definer as $$
 select current_attempt_id from public.engineering_task_execution where task_id=pg_temp.task();
$$;
create function pg_temp.claim(n integer default 1,c integer default 30,k integer default 200,r bigint default 0,
 rt integer default 60,inp integer default 70,b integer default 52,credential integer default 9) returns jsonb language sql security invoker as $$
 select public.api_claim_native_task(pg_temp.n(50),pg_temp.h(credential),pg_temp.n(b),pg_temp.task(n,c),pg_temp.n(rt),pg_temp.n(inp),r,pg_temp.n(k));
$$;
create function pg_temp.beat(r bigint,k integer,b integer default 52,f bigint default 1) returns jsonb language sql security invoker as $$
 select public.api_heartbeat_native_attempt(pg_temp.n(50),pg_temp.h(9),pg_temp.n(b),pg_temp.task(),pg_temp.attempt(),f,r,pg_temp.n(k));
$$;
create function pg_temp.eligible() returns jsonb language sql security invoker as $$
 select public.api_native_attempt_eligibility(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(),pg_temp.attempt(),1);
$$;
set local role authenticated;
select throws_ok($$select pg_temp.claim()$$,'42501',null,'owner cannot impersonate a worker claim');
select throws_ok($$select * from engineering_private.native_runtime_admissions$$,'42501',null,'runtime admissions are private');
select throws_ok($$select * from engineering_private.native_input_admissions$$,'42501',null,'input admissions are private');
select throws_ok($$select * from engineering_private.native_slots$$,'42501',null,'native occupancy internals are private');
set local role service_role;
select throws_ok($$select pg_temp.claim(1,30,200,0,60,70,52,8)$$,'42501',null,'wrong credential refused');
select is(pg_temp.claim()->>'reason','owner_enablement_required','paired boot alone has no native authority');
reset role;
select is((select count(*) from public.engineering_execution_attempts where organization_id=pg_temp.n(4)),0::bigint,'ineligible request creates no attempt');
set local role authenticated;
select public.api_control_worker_session(pg_temp.n(50),1,pg_temp.n(110),'enabled',pg_temp.n(52));
set local role service_role;
select is(pg_temp.claim()->>'reason','qualified_inputs_required','enablement cannot create runtime/input qualification');
select throws_ok($$insert into engineering_private.native_runtime_admissions(id) values(pg_temp.n(60))$$,'42501',null,'gateway cannot forge runtime admissions');
select throws_ok($$insert into engineering_private.native_input_admissions(id) values(pg_temp.n(70))$$,'42501',null,'gateway cannot forge input admissions');
select throws_ok($$select * from public.engineering_execution_attempts$$,'42501',null,'gateway has no direct attempt read');
select throws_ok($$update public.engineering_tasks set execution_state='succeeded',verification_state='passed'$$,'42501',null,'no worker success setter');
reset role;
insert into engineering_private.native_runtime_admissions(id,worker_id,installation_id,organization_id,project_id,owner_user_id,
 job_schema,source_manifest_sha256,environment_sha256,native_sha256,interop_sha256,compiler_sha256,evidence_sha256,policy_version,validator_version,admitted_by)
 values(pg_temp.n(60),pg_temp.n(50),pg_temp.n(51),pg_temp.n(4),pg_temp.n(7),pg_temp.n(1),
 'overdrafter.prepared-dimension-job.v2',pg_temp.h(1),pg_temp.h(2),pg_temp.h(3),pg_temp.h(4),pg_temp.h(5),pg_temp.h(6),'prepared-native-ownership-v1','test-only',pg_temp.n(1));
insert into engineering_private.native_input_admissions(id,snapshot_id,organization_id,project_id,kind,context_sha256,
 storage_manifest_sha256,evidence_sha256,requirements_sha256,check_policy_version,validator_version)
 select pg_temp.n(70),id,organization_id,project_id,'qualified_seed',context_sha256,pg_temp.h(7),pg_temp.h(8),pg_temp.h(10),'prepared-native-checks-v2','test-only'
 from public.engineering_snapshots where id=pg_temp.n(20);
set local role service_role;
select is(pg_temp.claim(2,30,201)->>'reason','verified_predecessor_required','successor cannot skip unrealized predecessor');
select is(pg_temp.claim(1,30,200,0,60,70,53)->>'reason','owner_enablement_required','other boot cannot claim');
select is(pg_temp.claim()->>'outcome','claimed','enabled qualified worker claims exact first task');
select is(pg_temp.claim(),pg_temp.claim(),'same claim returns immutable original receipt');
select throws_ok($$select pg_temp.claim(1,30,200,0,60,71)$$,'PT409',null,'claim key cannot change input admission');
select throws_ok($$select pg_temp.claim(1,30,202)$$,'PT409',null,'another request cannot use old task revision');
select is(pg_temp.claim(1,31,203)->>'reason','native_slot_occupied','another conversation cannot overlap native work');
select is(pg_temp.eligible()->>'eligible','true','fresh authority is independent of claim replay');
select throws_ok($$select pg_temp.beat(0,204,53)$$,'42501',null,'wrong boot heartbeat refused');
select throws_ok($$select pg_temp.beat(0,204,52,2)$$,'42501',null,'wrong fence heartbeat refused');
select is(pg_temp.beat(0,204)->>'outcome','renewed','heartbeat renews exact current attempt');
select is(pg_temp.beat(0,204),pg_temp.beat(0,204),'heartbeat replay preserves old expiry');
select throws_ok($$select pg_temp.beat(0,205)$$,'PT409',null,'stale heartbeat revision refused');
reset role;
select is((select count(*) from public.engineering_execution_attempts where organization_id=pg_temp.n(4)),1::bigint,'duplicate dispatch created one attempt');
select is((select deadline_at-claimed_at from public.engineering_execution_attempts where id=pg_temp.attempt()),interval '10 minutes','deadline fixed at first claim');
select ok((select lease_expires_at<=deadline_at from public.engineering_execution_attempts where id=pg_temp.attempt()),'lease cannot exceed deadline');
select is((select verification_state from public.engineering_tasks where id=pg_temp.task()),'unverified','claim does not imply verification');
select ok((select job_text::jsonb->>'contextSha256'=s.context_sha256 from public.engineering_execution_attempts a
 join public.engineering_snapshots s on s.id=a.input_snapshot_id where a.id=pg_temp.attempt()),'job binds exact stored context digest');
select is((select jsonb_array_length(job_text::jsonb->'requiredChecks') from public.engineering_execution_attempts where id=pg_temp.attempt()),7,'all seven checks frozen into job');
select throws_ok($$update public.engineering_execution_attempts set job_text='{}',revision=revision+1 where id=pg_temp.attempt()$$,'55000',null,'native job bytes immutable');
select throws_ok($$delete from public.engineering_execution_attempts where id=pg_temp.attempt()$$,'55000',null,'attempt history cannot be deleted');
select throws_ok($$update engineering_private.native_slots set fence=0 where organization_id=pg_temp.n(4)$$,'55000',null,'fence cannot move backward');
select throws_ok($$update engineering_private.native_input_admissions set evidence_sha256=pg_temp.h(99) where id=pg_temp.n(70)$$,'55000',null,'admitted evidence cannot be rewritten');
set local role authenticated;
select is((select count(*) from public.engineering_execution_attempts where organization_id=pg_temp.n(4)),1::bigint,'owner can inspect own attempt');
select set_config('request.jwt.claim.sub',pg_temp.n(3)::text,true);
select is((select count(*) from public.engineering_execution_attempts where organization_id=pg_temp.n(4)),0::bigint,'allowed project peer cannot read another owner attempt');
select set_config('request.jwt.claim.sub',pg_temp.n(2)::text,true);
select is((select count(*) from public.engineering_task_execution where organization_id=pg_temp.n(4)),0::bigint,'other tenant cannot read task ownership');
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select public.api_control_worker_session(pg_temp.n(50),2,pg_temp.n(111),'paused',pg_temp.n(52));
set local role service_role;
select is(pg_temp.beat(1,206)->>'outcome','renewed','paused session drains active attempt');
select is(pg_temp.claim(1,31,207)->>'reason','owner_enablement_required','pause blocks another claim');
reset role;
update engineering_private.engineering_operators set enabled=false where user_id=pg_temp.n(1);
set local role service_role;
select throws_ok($$select pg_temp.beat(2,208)$$,'42501',null,'access loss blocks heartbeat authority');
reset role;
select is((select active_attempt_id from engineering_private.native_slots where organization_id=pg_temp.n(4)),pg_temp.attempt(),'access loss does not pretend the native process stopped');
update engineering_private.engineering_operators set enabled=true where user_id=pg_temp.n(1);
-- Simulate an expired lease after time has moved beyond the initial claim.
select pg_sleep(0.05);
update public.engineering_execution_attempts set lease_expires_at=claimed_at+interval '1 millisecond',revision=revision+1 where id=pg_temp.attempt();
set local role service_role;
select is(pg_temp.eligible()->>'reason','lease_expired','fresh read rejects an expired lease before a heartbeat');
select is(pg_temp.beat(3,209)->>'outcome','recovery_required','expiry persists uncertainty rather than reviving');
select is(pg_temp.claim()->>'outcome','claimed','old claim receipt remains historical');
select is(pg_temp.eligible()->>'eligible','false','historical claim replay cannot restore authority');
select throws_ok($$select pg_temp.beat(4,210)$$,'PT409',null,'recovery attempt cannot renew');
reset role;
select is((select active_attempt_id from engineering_private.native_slots where organization_id=pg_temp.n(4)),pg_temp.attempt(),'expired lease keeps organization occupancy');
select is((select execution_state from public.engineering_tasks where id=pg_temp.task()),'failed','uncertain execution blocks its task');
select ok((select not result_eligible from public.engineering_execution_attempts where id=pg_temp.attempt()),'expired output loses result eligibility');
select ok(not exists(select 1 from engineering_private.native_attempt_events where task_id=pg_temp.task() and (arguments::text like '%'||pg_temp.h(9)||'%' or receipt::text like '%'||pg_temp.h(9)||'%')),'credentials excluded from transition history');
create function pg_temp.stop_fixture(n integer,attempt uuid,bad_job boolean default false,p_failure text default null,
 p_authority text default 'qualified_worker_validator') returns void language sql security definer as $$
 insert into engineering_private.native_stop_admissions(id,attempt_id,organization_id,project_id,worker_id,installation_id,boot_id,session_id,
  runtime_admission_id,fence,job_sha256,context_sha256,journal_sha256,evidence_sha256,verdict,authority,terminal_processes,
  execution_outcome,failure_code,failure_policy_version,validator_version,stopped_at,observed_at,admitted_by)
 select pg_temp.n(n),a.id,a.organization_id,a.project_id,a.worker_id,a.installation_id,a.boot_id,a.session_id,a.runtime_admission_id,a.fence,
  case when bad_job then pg_temp.h(999) else a.job_sha256 end,a.job_text::jsonb->>'contextSha256',pg_temp.h(20),pg_temp.h(21),
  'all_owned_processes_exited',p_authority,'[{"fixtureOnly":true}]'::jsonb,case when p_failure is null then 'native_exit_succeeded' else 'native_failed' end,p_failure,
  'prepared-native-failure-v1','test-only',clock_timestamp(),clock_timestamp(),pg_temp.n(1)
 from public.engineering_execution_attempts a where a.id=attempt;
$$;
create function pg_temp.stop(n integer,r bigint,k integer,task uuid default pg_temp.task(),attempt uuid default pg_temp.attempt())
returns jsonb language sql security invoker as $$
 select public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),task,attempt,pg_temp.n(n),r,pg_temp.n(k));
$$;
set local role service_role;
select throws_ok($$select pg_temp.stop(80,4,220)$$,'PT409',null,'missing admitted stop cannot release occupancy');
select throws_ok($$insert into engineering_private.native_stop_admissions(id) values(pg_temp.n(80))$$,'42501',null,'worker cannot insert shutdown claims as stop authority');
select throws_ok($$select public.api_reconcile_native_stop(pg_temp.n(50),pg_temp.n(52),pg_temp.task(),pg_temp.attempt(),pg_temp.n(80),4,pg_temp.n(220))$$,
 '42501',null,'worker cannot select owner recovery');
reset role;
select pg_temp.stop_fixture(80,pg_temp.attempt(),true);
select pg_temp.stop_fixture(81,pg_temp.attempt());
set local role service_role;
select throws_ok($$select pg_temp.stop(80,4,220)$$,'PT409',null,'mismatched job stop evidence rejected');
select is(pg_temp.stop(81,4,220)->>'outcome','process_stopped','admitted exact stop resolves physical occupancy');
select is(pg_temp.stop(81,4,220)->>'resultEligible','false','late successful native exit remains historical after lease loss');
reset role;
select is((select active_attempt_id from engineering_private.native_slots where organization_id=pg_temp.n(4)),null::uuid,'confirmed stop releases only its own slot');
select is((select verification_state from public.engineering_tasks where id=pg_temp.task()),'unverified','stop admission is not verification');
set local role authenticated;
select public.api_control_worker_session(pg_temp.n(50),3,pg_temp.n(112),'enabled',pg_temp.n(52));
set local role service_role;
select is(pg_temp.claim(1,31,230)->>'fence','2','new independent task receives a higher organization fence');
select is(pg_temp.stop(81,4,220)->>'outcome','process_stopped','old stop replay returns only its historical receipt');
select throws_ok($$select pg_temp.stop(81,5,231)$$,'PT409',null,'late old stop cannot release newer occupancy');
reset role;
select is((select a.task_id from engineering_private.native_slots ns join public.engineering_execution_attempts a on a.id=ns.active_attempt_id
 where ns.organization_id=pg_temp.n(4)),pg_temp.task(1,31),'newer task retains its physical slot');
select pg_temp.stop_fixture(82,(select current_attempt_id from public.engineering_task_execution where task_id=pg_temp.task(1,31)));
create function pg_temp.other_attempt() returns uuid language sql security definer as $$
 select current_attempt_id from public.engineering_task_execution where task_id=pg_temp.task(1,31);
$$;
set local role service_role;
select is(pg_temp.stop(82,0,232,pg_temp.task(1,31),pg_temp.other_attempt())->>'phase','awaiting_result','current successful exit awaits artifact verification');
reset role;
select is((select verification_state from public.engineering_tasks where id=pg_temp.task(1,31)),'unverified','successful exit cannot fabricate passing checks');
select is((select head_snapshot_id from public.engineering_conversations where id=pg_temp.n(31)),pg_temp.n(20),'successful exit cannot advance the candidate head');
select throws_ok($$update engineering_private.native_stop_admissions set verdict='no_launch_proven_by_recovery' where organization_id=pg_temp.n(4)$$,'55000',null,'admitted stop history is immutable');
-- Retry requests retain old failures and cannot create process authority.
create table pg_temp.attempt_history(label text primary key,attempt uuid);
insert into pg_temp.attempt_history values('initial',pg_temp.attempt());
create function pg_temp.auto_retry(r bigint,k integer,b integer default 52) returns jsonb language sql security invoker as $$
 select public.api_request_native_retry(pg_temp.n(50),pg_temp.h(9),pg_temp.n(b),pg_temp.task(),pg_temp.attempt(),r,pg_temp.n(k));
$$;
create function pg_temp.owner_retry(r bigint,k integer,b integer default 52,reason text default 'Retry the unchanged prepared change.') returns jsonb language sql security invoker as $$
 select public.api_retry_native_task(pg_temp.n(50),pg_temp.n(b),pg_temp.task(),pg_temp.attempt(),r,pg_temp.n(k),reason);
$$;
set local role service_role;
select is(pg_temp.auto_retry(2,240)->>'reason','automatic_retry_not_permitted','lease failure is not automatically transient');
select throws_ok($$select pg_temp.owner_retry(2,240)$$,'42501',null,'worker cannot select explicit owner retry');
select throws_ok($$select engineering_private.request_native_retry(pg_temp.n(50),pg_temp.h(9),pg_temp.n(52),pg_temp.task(),pg_temp.attempt(),2,pg_temp.n(240),true,'bypass')$$,
 '42501',null,'worker cannot call core retry with owner mode');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.n(3)::text,true);
select throws_ok($$select pg_temp.owner_retry(2,240)$$,'42501',null,'project peer cannot retry another owner task');
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select throws_ok($$select pg_temp.owner_retry(2,240,52,' ')$$,'22023',null,'explicit retry requires a reason');
select is(pg_temp.owner_retry(2,240)->>'outcome','retry_requested','owner can request a stopped unchanged task');
select is(pg_temp.owner_retry(2,240),pg_temp.owner_retry(2,240),'retry replay retains one request');
select throws_ok($$select pg_temp.owner_retry(2,240,52,'Changed reason')$$,'PT409',null,'retry key cannot change its reason');
reset role;
select is((select execution_state from public.engineering_tasks where id=pg_temp.task()),'failed','retry request alone does not start work');
select is((select automatic_retries from public.engineering_task_execution where task_id=pg_temp.task()),0,'explicit retry does not consume automatic allowance');
set local role service_role;
select is(pg_temp.claim(1,30,241,3)->>'fence','3','retry claim receives a higher fence');
reset role;
select is((select previous_attempt_id from public.engineering_execution_attempts where id=pg_temp.attempt()),
 (select attempt from pg_temp.attempt_history where label='initial'),'retry preserves exact prior attempt lineage');
select is((select input_admission_id from public.engineering_execution_attempts where id=pg_temp.attempt()),pg_temp.n(70),'retry retains exact admitted input');
select ok((select phase='failed' and not result_eligible from public.engineering_execution_attempts where id=(select attempt from pg_temp.attempt_history where label='initial')),'old failure remains failed');
set local role service_role;
select throws_ok($$select pg_temp.auto_retry(4,242)$$,'PT409',null,'running attempt cannot retry without stop evidence');
reset role;
select pg_temp.stop_fixture(83,pg_temp.attempt(),false,'native_startup_timeout');
set local role service_role;
select is(pg_temp.stop(83,0,243)->>'failureCode','native_startup_timeout','admitted deterministic transient failure retained');
select is(pg_temp.auto_retry(5,244)->>'outcome','retry_requested','one classified automatic retry can be requested');
select is(pg_temp.auto_retry(5,244)->>'automaticRetries','0','automatic allowance consumed at claim, not delivery');
select is(pg_temp.claim(1,30,245,6)->>'fence','4','automatic retry claims a new fenced attempt');
select is(pg_temp.claim(1,30,245,6),pg_temp.claim(1,30,245,6),'duplicate automatic claim returns exact receipt');
reset role;
select is((select automatic_retries from public.engineering_task_execution where task_id=pg_temp.task()),1,'automatic retry count increments exactly once');
select pg_temp.stop_fixture(84,pg_temp.attempt(),false,'native_startup_timeout');
set local role service_role;
select is(pg_temp.stop(84,0,246)->>'phase','failed','second transient failure remains failed');
select is(pg_temp.auto_retry(8,247)->>'reason','automatic_retry_not_permitted','automatic allowance is exhausted');
set local role authenticated;
select is(pg_temp.owner_retry(8,248)->>'outcome','retry_requested','explicit owner retry remains distinct after automatic exhaustion');
-- A renewed session cannot inherit an earlier retry authorization.
select public.api_control_worker_session(pg_temp.n(50),4,pg_temp.n(113),'paused',pg_temp.n(52));
select public.api_control_worker_session(pg_temp.n(50),5,pg_temp.n(114),'enabled',pg_temp.n(52));
set local role service_role;
select is(pg_temp.claim(1,30,249,9)->>'reason','fresh_retry_authorization_required','new session invalidates an unconsumed retry grant');
select public.api_register_worker_boot(pg_temp.n(50),6,pg_temp.n(115),pg_temp.h(9),pg_temp.n(53));
select is(pg_temp.claim(1,30,250,9,60,70,53)->>'reason','owner_enablement_required','restart requires explicit enablement');
set local role authenticated;
select public.api_control_worker_session(pg_temp.n(50),7,pg_temp.n(116),'enabled',pg_temp.n(53));
set local role service_role;
select is(pg_temp.auto_retry(9,251,53)->>'reason','automatic_retry_not_permitted','restart cannot reset the automatic allowance');
select is(pg_temp.claim(1,30,252,9,60,70,53)->>'reason','fresh_retry_authorization_required','new boot cannot inherit old retry intent');
set local role authenticated;
select is(pg_temp.owner_retry(9,253,53)->>'outcome','retry_requested','owner can authorize retry for newly enabled boot');
set local role service_role;
select is(pg_temp.claim(1,30,254,10,60,70,53)->>'fence','5','new boot retry claims a higher fence');
reset role;
select is((select automatic_retries from public.engineering_task_execution where task_id=pg_temp.task()),1,'explicit retry and restart preserve automatic count');
select is((select count(*) from public.engineering_execution_attempts where task_id=pg_temp.task()),4::bigint,'history retains all four actual attempts');
create function pg_temp.suffix_ids() returns uuid[] language sql security definer as $$
 select array_agg(id order by sequence) from public.engineering_decisions where conversation_id=pg_temp.n(30);
$$;
create function pg_temp.cancel(k integer,ids uuid[] default null) returns jsonb language sql security invoker as $$
 select public.api_cancel_engineering_suffix(pg_temp.n(30),2,pg_temp.n(k),
  coalesce(ids,pg_temp.suffix_ids()),
  'Cancel this failed change and its pending dependent change.');
$$;
set local role authenticated;
select throws_ok($$select pg_temp.cancel(260)$$,'PT409',null,'running native task cannot be canceled as a pending suffix');
reset role;
select pg_sleep(0.01);
update public.engineering_execution_attempts set lease_expires_at=claimed_at+interval '1 millisecond',revision=revision+1 where id=pg_temp.attempt();
set local role service_role;
select is(pg_temp.beat(1,261,53,5)->>'outcome','recovery_required','new boot lease loss retains process uncertainty');
set local role authenticated;
select throws_ok($$select pg_temp.cancel(260)$$,'PT409',null,'uncertain failed process still prevents cancellation');
reset role;
select pg_temp.stop_fixture(85,pg_temp.attempt(),false,'native_operation_failed');
set local role service_role;
select is(public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(53),pg_temp.task(),pg_temp.attempt(),pg_temp.n(85),2,pg_temp.n(262))->>'phase',
 'failed','confirmed stop resolves failed attempt occupancy');
set local role authenticated;
select is(pg_temp.owner_retry(12,263,53)->>'outcome','retry_requested','pending explicit retry can be canceled with its suffix');
reset role;
-- Simulate an independently failed check; cancellation must preserve its verdict.
update public.engineering_tasks set verification_state='failed' where id=pg_temp.task();
set local role authenticated;
select throws_ok($$select pg_temp.cancel(260,array[(select decision_id from public.engineering_tasks where id=pg_temp.task())])$$,
 'PT409',null,'failed cancellation must still include the exact pending suffix');
select set_config('request.jwt.claim.sub',pg_temp.n(3)::text,true);
select throws_ok($$select pg_temp.cancel(260)$$,'42501',null,'project peer cannot cancel the owner recovery suffix');
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select is(pg_temp.cancel(260)->>'revision','3','owner cancels confirmed failed task and exact pending suffix');
select is(pg_temp.cancel(260),pg_temp.cancel(260),'cancellation replay adds no new transition');
reset role;
select is((select verification_state from public.engineering_tasks where id=pg_temp.task()),'failed','cancellation preserves failed verification');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.n(30) and execution_state='canceled'),2::bigint,'failed task and pending dependent task are canceled together');
select ok((select retry_mode is null from public.engineering_task_execution where task_id=pg_temp.task()),'cancellation clears pending retry authority');
select is((select automatic_retries from public.engineering_task_execution where task_id=pg_temp.task()),1,'cancellation retains consumed retry history');
set local role service_role;
select throws_ok($$select pg_temp.claim(1,30,264,14,60,70,53)$$,'PT409',null,'canceled retry cannot launch another attempt');
reset role;
-- Owner recovery can reconcile old physical occupancy after boot/revocation.
set local role authenticated;
select public.api_submit_engineering_message(pg_temp.n(4),pg_temp.n(7),pg_temp.n(32),pg_temp.n(20),0,pg_temp.n(300),'Depth 8 mm');
reset role;
select public.api_resolve_engineering_request(r.id,0,pg_temp.n(301),'prepared_change',8,'Recovery fixture',
 jsonb_build_object('model','fixture','promptVersion','v1','schemaVersion','overdrafter.prepared-interpretation.v1',
 'policyVersion','prepared-depth-v1','inputSha256',encode(extensions.digest(m.body,'sha256'),'hex'),'contextSha256',s.context_sha256))
 from public.engineering_requests r join public.engineering_messages m on m.id=r.message_id
 join public.engineering_snapshots s on s.id=r.input_snapshot_id where r.conversation_id=pg_temp.n(32);
create function pg_temp.third_attempt() returns uuid language sql security definer as $$
 select current_attempt_id from public.engineering_task_execution where task_id=pg_temp.task(1,32);
$$;
set local role service_role;
select is(pg_temp.claim(1,32,302,0,60,70,53)->>'fence','6','independent recovery fixture claims the next fence');
reset role;
select pg_temp.stop_fixture(86,pg_temp.third_attempt(),false,null,'authorized_recovery_validator');
set local role service_role;
select throws_ok($$select public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(53),pg_temp.task(1,32),pg_temp.third_attempt(),pg_temp.n(86),0,pg_temp.n(303))$$,
 'PT409',null,'worker cannot consume owner-only recovery evidence');
select public.api_register_worker_boot(pg_temp.n(50),8,pg_temp.n(304),pg_temp.h(9),pg_temp.n(54));
select throws_ok($$select public.api_record_native_stop(pg_temp.n(50),pg_temp.h(9),pg_temp.n(53),pg_temp.task(1,32),pg_temp.third_attempt(),pg_temp.n(86),0,pg_temp.n(303))$$,
 '42501',null,'old boot cannot report through normal worker stop path');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.n(3)::text,true);
select throws_ok($$select public.api_reconcile_native_stop(pg_temp.n(50),pg_temp.n(53),pg_temp.task(1,32),pg_temp.third_attempt(),pg_temp.n(86),0,pg_temp.n(303))$$,
 '42501',null,'project peer cannot authorize process recovery');
select set_config('request.jwt.claim.sub',pg_temp.n(1)::text,true);
select public.api_control_worker_session(pg_temp.n(50),9,pg_temp.n(305),'revoked',null);
select is(public.api_reconcile_native_stop(pg_temp.n(50),pg_temp.n(53),pg_temp.task(1,32),pg_temp.third_attempt(),pg_temp.n(86),0,pg_temp.n(303))->>'resultEligible',
 'false','owner reconciles original boot after worker revocation without reviving output');
reset role;
select is((select active_attempt_id from engineering_private.native_slots where organization_id=pg_temp.n(4)),null::uuid,'authorized revoked-worker recovery releases exact physical occupancy');
select is((select head_snapshot_id from public.engineering_conversations where id=pg_temp.n(32)),pg_temp.n(20),'recovery never adopts obsolete native output');
select * from finish();
rollback;
