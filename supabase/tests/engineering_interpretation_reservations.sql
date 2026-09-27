begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.u(n integer) returns uuid language sql immutable as $$
  select ('51800000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id,aud,role,email,email_confirmed_at)
  values(pg_temp.u(1),'authenticated','authenticated','ovd518@example.test',now());
insert into public.organizations(id,name,slug) values(pg_temp.u(2),'Interpretation fixture','ovd518-fixture');
insert into public.organization_memberships(organization_id,user_id,role)
  values(pg_temp.u(2),pg_temp.u(1),'internal_admin');
insert into public.projects(id,organization_id,owner_user_id,name)
  values(pg_temp.u(3),pg_temp.u(2),pg_temp.u(1),'Interpretation fixture');
insert into public.project_memberships(project_id,user_id,role)
  values(pg_temp.u(3),pg_temp.u(1),'owner');
insert into engineering_private.engineering_operators(organization_id,user_id,enabled)
  values(pg_temp.u(2),pg_temp.u(1),true);
insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
  values(pg_temp.u(4),pg_temp.u(2),pg_temp.u(3),
    jsonb_build_object('schema','overdrafter.prepared-assembly.v2','snapshotId',pg_temp.u(4),
      'scope',jsonb_build_object('organizationId',pg_temp.u(2),'projectId',pg_temp.u(3)),
      'packageId','ovd-native04-assembly','configuration','Default')::text);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.u(1)::text,true);
select public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),pg_temp.u(5),pg_temp.u(4),0,pg_temp.u(11),'Set the depth to 8 mm');
select public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),pg_temp.u(5),pg_temp.u(4),1,pg_temp.u(12),'Set the depth to 8');
select public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),pg_temp.u(5),pg_temp.u(4),2,pg_temp.u(13),'mm');
reset role;
create function pg_temp.r(n integer) returns uuid language sql stable as $$
  select id from public.engineering_requests where conversation_id=pg_temp.u(5) and receipt_revision=n;
$$;
set local role anon;
select throws_ok($$select public.api_reserve_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21))$$,
  '42501',null,'anonymous cannot reserve a model call');
reset role;
set local role authenticated;
select throws_ok($$select public.api_reserve_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21))$$,
  '42501',null,'client cannot reserve a model call');
reset role;
set local role service_role;
select is((public.api_reserve_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21))->>'invoke')::boolean,
  true,'first reservation admits exactly one adapter invocation');
select is((public.api_reserve_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21))->>'invoke')::boolean,
  false,'identical reservation replay refuses another adapter invocation');
select throws_ok($$select public.api_reserve_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(22))$$,
  'PT409','Interpretation replay changed.','changed reservation identity conflicts');
select throws_ok($$select public.api_reserve_prepared_interpretation(pg_temp.r(2),0,pg_temp.u(23))$$,
  'PT409','Engineering interpretation order changed.','later request waits for earlier outcome');
select is((public.api_finish_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21),
  'prepared_change',8,'Recorded prepared depth request.',null)->>'outcome'),'prepared_change',
  'supported outcome and blocked task persist together');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.u(5)),1::bigint,
  'exactly one blocked task exists');
select is((public.api_finish_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21),
  'prepared_change',8,'Recorded prepared depth request.',null)->>'revision'),'1',
  'identical finalization replay returns the original revision');
select throws_ok($$select public.api_finish_prepared_interpretation(pg_temp.r(1),0,pg_temp.u(21),
  'prepared_change',9,'Changed.',null)$$,'PT409','Interpretation replay changed.',
  'changed finalization payload conflicts');
select throws_ok($$select public.api_reserve_prepared_interpretation(pg_temp.r(2),0,pg_temp.u(23))$$,
  'PT409','Engineering interpretation order changed.','stale queue revision conflicts');
select is((public.api_reserve_prepared_interpretation(pg_temp.r(2),1,pg_temp.u(23))->>'invoke')::boolean,
  true,'next queue revision reserves the clarification');
select throws_ok($$select public.api_finish_prepared_interpretation(pg_temp.r(2),1,pg_temp.u(23),
  'needs_context',null,'Which units?',
  jsonb_build_object('reason','unit','contextSha256',
    (select context_sha256 from public.engineering_snapshots where id=pg_temp.u(4)),'depthMm','8'))$$,
  '22023','Invalid clarification depth.','string depth cannot enter durable clarification');
select is((public.api_finish_prepared_interpretation(pg_temp.r(2),1,pg_temp.u(23),
  'needs_context',null,'Which units do you mean for 8?',
  jsonb_build_object('reason','unit','contextSha256',
    (select context_sha256 from public.engineering_snapshots where id=pg_temp.u(4)),'depthMm',8))->>'outcome'),
  'needs_context','clarification persists without a native task');
select is((select count(*) from public.engineering_tasks where conversation_id=pg_temp.u(5)),1::bigint,
  'clarification creates no native task');
select is((public.api_reserve_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24))->'priorClarification'->>'reason'),
  'unit','immediate prior clarification is read from durable history');
select is((public.api_fail_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24),'adapter_error')->>'state'),
  'failed','adapter error records a finite failure state');
reset role;
update public.engineering_interpretation_reservations set deadline_at=clock_timestamp()-interval '1 second'
  where request_id=pg_temp.r(3);
set local role service_role;
select is((public.api_fail_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24),'adapter_error')->>'failureCode'),
  'adapter_error','identical failure replay keeps its original outcome after expiry');
select throws_ok($$select public.api_fail_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24),'timed_out')$$,
  'PT409','Interpretation failure replay changed.','changed failure replay conflicts after expiry');
select is((select interpretation_state from public.engineering_requests where id=pg_temp.r(3)),
  'failed','failed interpretation is visible on the durable request');
select is((public.api_reserve_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24))->>'invoke')::boolean,
  false,'failed delivery cannot spend a second model call');
select throws_ok($$select public.api_finish_prepared_interpretation(pg_temp.r(3),2,pg_temp.u(24),
  'prepared_change',8,'Late result.',null)$$,'PT409',
  'Interpretation reservation is no longer active.','late model result cannot create a task');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.u(1)::text,true);
select public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),
  pg_temp.u(43),pg_temp.u(4),0,pg_temp.u(910),'Set the depth to 9 mm');
reset role;
set local role service_role;
select is((public.api_reserve_prepared_interpretation(
  (select id from public.engineering_requests where conversation_id=pg_temp.u(43)),
  0,pg_temp.u(911))->>'invoke')::boolean,true,'separate request reserves one finite call');
reset role;
update public.engineering_interpretation_reservations set deadline_at=now()-interval '1 second'
  where conversation_id=pg_temp.u(43);
set local role service_role;
select is((public.api_reserve_prepared_interpretation(
  (select id from public.engineering_requests where conversation_id=pg_temp.u(43)),
  0,pg_temp.u(911))->>'failureCode'),'timed_out',
  'expired reservation becomes a durable visible timeout on replay');
select is((select interpretation_state from public.engineering_requests
  where conversation_id=pg_temp.u(43)),'failed',
  'expired request has a finite failed state');
reset role;
insert into public.engineering_snapshots(id,organization_id,project_id,context_text)
  values(pg_temp.u(6),pg_temp.u(2),pg_temp.u(3),
    jsonb_build_object('schema','overdrafter.prepared-assembly.v2','snapshotId',pg_temp.u(6),
      'scope',jsonb_build_object('organizationId',pg_temp.u(2),'projectId',pg_temp.u(3)),
      'packageId','ovd-native04-assembly','configuration','Default')::text);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.u(1)::text,true);
select public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),
  pg_temp.u(44),pg_temp.u(4),0,pg_temp.u(913),'Set the depth to 8 mm');
reset role;
update engineering_private.engineering_operators set enabled=false
  where organization_id=pg_temp.u(2) and user_id=pg_temp.u(1);
set local role service_role;
select throws_ok($$select public.api_reserve_prepared_interpretation(
  (select id from public.engineering_requests where conversation_id=pg_temp.u(44)),0,pg_temp.u(914))$$,
  '42501','Engineering access is unavailable.','revoked operator access refuses reservation');
reset role;
update engineering_private.engineering_operators set enabled=true
  where organization_id=pg_temp.u(2) and user_id=pg_temp.u(1);
update public.engineering_conversations set head_snapshot_id=pg_temp.u(6)
  where id=pg_temp.u(44);
set local role service_role;
select throws_ok($$select public.api_reserve_prepared_interpretation(
  (select id from public.engineering_requests where conversation_id=pg_temp.u(44)),0,pg_temp.u(914))$$,
  'PT409','Requested engineering context is stale.','changed conversation head refuses before invocation');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.u(1)::text,true);
do $$ begin
  for n in 1..196 loop
    perform public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),
      pg_temp.u(40),pg_temp.u(4),n-1,pg_temp.u(600+n),'Synthetic budget request');
  end loop;
  perform public.api_submit_engineering_message(pg_temp.u(2),pg_temp.u(3),
    pg_temp.u(41),pg_temp.u(4),0,pg_temp.u(900),'Set the depth to 8 mm');
end $$;
reset role;
-- Populate the remaining month with synthetic reservations under the same
-- checked foreign keys. This tests the real cap without 196 model calls.
insert into public.engineering_interpretation_reservations
  (request_id,conversation_id,organization_id,project_id,owner_user_id,
   expected_queue_revision,idempotency_key,budget_month)
select r.id,r.conversation_id,r.organization_id,r.project_id,r.owner_user_id,
  0,pg_temp.u(1000+r.receipt_revision::integer),
  date_trunc('month',now() at time zone 'UTC')::date
from public.engineering_requests r where r.conversation_id=pg_temp.u(40);
select is((select count(*) from public.engineering_interpretation_reservations
  where budget_month=date_trunc('month',now() at time zone 'UTC')::date),200::bigint,
  'all 200 fixed-cost monthly reservations are accounted for');
set local role service_role;
select throws_ok($$select public.api_reserve_prepared_interpretation(
  (select id from public.engineering_requests where conversation_id=pg_temp.u(41)),0,pg_temp.u(901))$$,
  'PT429','Engineering interpretation budget exhausted.',
  'exhausted month refuses before an adapter invocation can be admitted');
reset role;
select * from finish();
rollback;
