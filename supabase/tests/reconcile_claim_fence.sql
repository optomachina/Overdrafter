begin;
select no_plan();
\set meter_fixture_limit 100
\ir fixtures/free_quote_meter_setup.inc

create temporary table acceptance_cases (
  name text primary key, request_id uuid, task_id uuid, result_id uuid,
  run_id uuid, job_id uuid, offers jsonb, response jsonb
);
create function pg_temp.new_acceptance_case(p_name text, p_free boolean default true)
returns void language plpgsql as $$
declare r uuid; t uuid; v uuid; q uuid; j uuid; part uuid; c free_meter_fixture.context%rowtype;
begin
  select * into c from free_meter_fixture.context;
  if p_free then
    r := free_meter_fixture.new_request();
    select work_queue_task_id,vendor_quote_result_id,quote_run_id,job_id into t,v,q,j
      from private.xometry_beta_dispatch_permits where quote_request_id = r;
  else
    j := gen_random_uuid(); r := gen_random_uuid(); q := gen_random_uuid(); v := gen_random_uuid(); t := gen_random_uuid();
    insert into public.jobs(id,organization_id,created_by,title,status)
      values(j,c.organization_id,c.user_id,'Non-free acceptance','quoting');
    part := gen_random_uuid();
    insert into public.parts(id,job_id,organization_id,name,normalized_key,quantity)
      values(part,j,c.organization_id,'Nonfree part','nonfree',1);
    insert into public.quote_requests(id,organization_id,job_id,requested_by,status)
      values(r,c.organization_id,j,c.user_id,'requesting');
    insert into public.quote_runs(id,job_id,organization_id,initiated_by,status,quote_request_id)
      values(q,j,c.organization_id,c.user_id,'running',r);
    insert into public.vendor_quote_results(id,quote_run_id,part_id,organization_id,vendor,status)
      values(v,q,part,c.organization_id,'xometry','running');
    insert into public.work_queue(id,organization_id,job_id,part_id,quote_run_id,task_type)
      values(t,c.organization_id,j,part,q,'run_vendor_quote');
  end if;
  update public.work_queue set status='running', locked_by='s11b-worker',
    locked_at='2026-10-29 01:00:00+00', attempts=1, payload='{"original":true}' where id=t;
  insert into acceptance_cases values(p_name,r,t,v,q,j,
    jsonb_build_array(jsonb_build_object('vendor_quote_result_id',v,'organization_id',c.organization_id,
    'geographic_origin','unknown','sort_rank',0,'offer_key','stable','supplier','Synthetic','lane_label','Fixture','unit_price_usd',12,
    'quoted_at',now()-interval '1 minute','valid_until',now()+interval '1 day',
    'validity_source','vendor_date','provenance_status','trusted_adapter','raw_payload','{}'::jsonb)),null);
end;
$$;
create function pg_temp.accept_case(p_name text, p_worker text default 's11b-worker',
 p_at timestamptz default '2026-10-29 01:00:00+00', p_attempt integer default 1,
 p_patch jsonb default '{"settled":true}') returns jsonb language sql as $$
 select public.accept_vendor_quote_result(task_id,p_worker,p_at,p_attempt,result_id,
 free_meter_fixture.result_payload(),offers,p_patch) from acceptance_cases where name=p_name
$$;
create function pg_temp.acceptance_snapshot(p_name text) returns jsonb language sql as $$
 select jsonb_build_object('task',to_jsonb(t),'result',to_jsonb(r),
 'offers',(select jsonb_agg(to_jsonb(o) order by o.id) from public.vendor_quote_offers o where vendor_quote_result_id=c.result_id),
 'receipts',(select jsonb_agg(to_jsonb(a)) from private.vendor_quote_acceptance_receipts a where work_queue_task_id=c.task_id),
 'followups',(select jsonb_agg(to_jsonb(f)) from private.quote_run_rollup_followups f where quote_run_id=c.run_id),
 'admission',(select to_jsonb(a) from private.quote_access_admissions a where quote_run_id=c.run_id),
 'request',(select to_jsonb(a) from public.quote_requests a where id=c.request_id))
 from acceptance_cases c join public.work_queue t on t.id=c.task_id
 join public.vendor_quote_results r on r.id=c.result_id where name=p_name
$$;

-- Both RPCs expose only the service boundary, and helpers have no API grants.
select ok(has_function_privilege('service_role',sig,'execute'), 'service can execute '||sig)
from unnest(array['public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)',
 'public.drain_quote_run_rollup_followups(integer)','public.reconcile_vendor_quote_offers(uuid,jsonb,jsonb)']) sig;
select ok(not has_function_privilege(role_name,sig,'execute'), role_name||' denied '||sig)
from unnest(array['anon','authenticated']) role_name cross join unnest(array[
 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)',
 'public.drain_quote_run_rollup_followups(integer)',
 'private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)']) sig;
select ok(not has_function_privilege('service_role','private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)','execute'),
 'service cannot bypass fencing through helper');
select ok((select relrowsecurity from pg_class where oid=relation::regclass),'RLS enabled '||relation)
from unnest(array['private.vendor_quote_acceptance_receipts','private.quote_run_rollup_followups']) relation;
-- deny: anon private.vendor_quote_acceptance_receipts
-- deny: anon private.quote_run_rollup_followups
set local role anon;
select throws_ok('select * from private.vendor_quote_acceptance_receipts','42501',null,'anon receipts denied');
select throws_ok('select * from private.quote_run_rollup_followups','42501',null,'anon followups denied');
select throws_ok('select public.accept_vendor_quote_result(null,null,null,null,null,null,null)','42501',null,'anon acceptance denied');
select throws_ok('select public.drain_quote_run_rollup_followups()','42501',null,'anon drain denied');
reset role;
-- deny: other_user private.vendor_quote_acceptance_receipts
-- deny: other_user private.quote_run_rollup_followups
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select throws_ok('select * from private.vendor_quote_acceptance_receipts','42501',null,'other user receipts denied');
select throws_ok('select * from private.quote_run_rollup_followups','42501',null,'other user followups denied');
select throws_ok('select public.accept_vendor_quote_result(null,null,null,null,null,null,null)','42501',null,'authenticated acceptance denied');
select throws_ok('select public.drain_quote_run_rollup_followups()','42501',null,'authenticated drain denied');
reset role;
-- deny: role_boundary private.vendor_quote_acceptance_receipts
-- deny: role_boundary private.quote_run_rollup_followups
set local role service_role;
select throws_ok('select * from private.vendor_quote_acceptance_receipts','42501',null,'service receipts denied');
select throws_ok('select * from private.quote_run_rollup_followups','42501',null,'service followups denied');
reset role;
-- end deny

select pg_temp.new_acceptance_case('accepted');
select throws_ok(format('update public.quote_runs set job_id=%L where id=%L',
 '00000000-0000-4000-8000-000000008821',run_id), 'P0001',
 'Quote run job_id is immutable.','quote run cannot move to another fixture job')
 from acceptance_cases where name='accepted';
select throws_ok(format('update public.quote_runs set job_id=null where id=%L',run_id),
 'P0001','Quote run job_id is immutable.','quote run cannot clear its job binding')
 from acceptance_cases where name='accepted';
select lives_ok(format('update public.quote_runs set job_id=job_id, status=''queued'' where id=%L',run_id),
 'unchanged job binding allows other run updates') from acceptance_cases where name='accepted';
update acceptance_cases set response=pg_temp.accept_case(name) where name='accepted';
select is(response->>'outcome','accepted','accept returns accepted') from acceptance_cases where name='accepted';
select is(t.status::text,'completed','task committed completed with cleared claim') from public.work_queue t
 join acceptance_cases c on c.task_id=t.id where c.name='accepted';
select ok(t.locked_at is null and t.locked_by is null and t.last_error is null
 and t.payload='{"original":true,"settled":true}'::jsonb,'task patch merged and lock cleared')
 from public.work_queue t join acceptance_cases c on c.task_id=t.id where c.name='accepted';
select is(r.status::text,'instant_quote_received','quote remains visible without drain')
 from public.vendor_quote_results r join acceptance_cases c on c.result_id=r.id where c.name='accepted';
select is((select count(*)::int from public.vendor_quote_offers o join acceptance_cases c on c.result_id=o.vendor_quote_result_id where name='accepted'),1,'one visible offer');
select is((select count(*)::int from private.vendor_quote_acceptance_receipts),1,'one receipt');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),1,'crash after accept leaves durable pending followup');
select is(pg_temp.accept_case('accepted')->>'outcome','replayed','lost acknowledgement replays after claim cleared');
select is(pg_temp.accept_case('accepted')->>'original_outcome','accepted','replay preserves original outcome');
select is(pg_temp.accept_case('accepted','different')->>'outcome','payload_mismatch','replay checks original worker');
select is(pg_temp.accept_case('accepted',p_patch=>'{}')->>'outcome','payload_mismatch','replay checks payload');
select throws_ok('update private.vendor_quote_acceptance_receipts set payload_digest=''changed'' where true','P0001',
 'Vendor quote acceptance receipts are append-only.','receipts cannot be updated');
select throws_ok('delete from private.vendor_quote_acceptance_receipts where true','P0001',
 'Vendor quote acceptance receipts are append-only.','receipts cannot be deleted');

-- Independent task-free rollup after simulated worker crash.
-- Contention after selection still defers atomically and leaves a retryable row.
create function pg_temp.s11b_rollup_contention() returns trigger language plpgsql as $$
begin raise sqlstate '55P03' using message='synthetic rollup contention'; end $$;
create trigger s11b_rollup_contention before insert on public.audit_events
 for each row execute function pg_temp.s11b_rollup_contention();
select is(public.drain_quote_run_rollup_followups(),'{"scanned":1,"processed":0,"deferred":1}'::jsonb,
 'later contention defers the selected followup without acknowledging it');
drop trigger s11b_rollup_contention on public.audit_events;
select is(public.drain_quote_run_rollup_followups()->>'processed','1','independent drain acknowledges completed task');
select is(r.status::text,'completed','drain completes run') from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name='accepted';
select is(j.status::text,'internal_review','drain updates job') from public.jobs j join acceptance_cases c on c.job_id=j.id where name='accepted';
select is((select count(*)::int from public.audit_events a join acceptance_cases c on c.job_id=a.job_id
 where name='accepted' and event_type='worker.quote_run_completed' and actor_user_id is null
 and payload=jsonb_build_object('quoteRunId',c.run_id,'successfulVendorQuotes',1,'manualReviewVendorQuotes',0,'failedVendorQuotes',0)),1,'exact worker audit payload');
select is(public.drain_quote_run_rollup_followups()->>'processed','0','drain idempotent');
select throws_ok('select public.drain_quote_run_rollup_followups(0)','P0001','quote_run_rollup_limit_invalid','drain bound lower');
select throws_ok('select public.drain_quote_run_rollup_followups(501)','P0001','quote_run_rollup_limit_invalid','drain bound upper');

select pg_temp.new_acceptance_case('stale');
create temporary table before_stale as select pg_temp.acceptance_snapshot('stale') snapshot;
select is(pg_temp.accept_case('stale','wrong')->>'outcome','stale','wrong worker stale');
select is(pg_temp.accept_case('stale',p_at=>'2026-10-29 01:00:01+00')->>'outcome','stale','wrong timestamp stale');
select is(pg_temp.accept_case('stale',p_attempt=>2)->>'outcome','stale','wrong attempt stale');
select is(pg_temp.acceptance_snapshot('stale'),snapshot,'stale calls change nothing') from before_stale;
update public.work_queue set status='queued' where id=(select task_id from acceptance_cases where name='stale');
update before_stale set snapshot=pg_temp.acceptance_snapshot('stale') where true;
select is(pg_temp.accept_case('stale')->>'outcome','stale','queued task stale');
select is(pg_temp.acceptance_snapshot('stale'),snapshot,'queued no writes') from before_stale;
update public.work_queue set status='completed' where id=(select task_id from acceptance_cases where name='stale');
update before_stale set snapshot=pg_temp.acceptance_snapshot('stale') where true;
select is(pg_temp.accept_case('stale')->>'outcome','stale','completed task stale');
select is(pg_temp.acceptance_snapshot('stale'),snapshot,'completed no writes') from before_stale;
update public.work_queue set status='cancelled' where id=(select task_id from acceptance_cases where name='stale');
update before_stale set snapshot=pg_temp.acceptance_snapshot('stale') where true;
select is(pg_temp.accept_case('stale')->>'outcome','stale','cancelled task stale');
select is(pg_temp.acceptance_snapshot('stale'),snapshot,'cancelled no writes') from before_stale;
update public.work_queue set status='running',attempts=2,locked_at='2026-10-29 02:00:00+00'
 where id=(select task_id from acceptance_cases where name='stale');
select is(pg_temp.accept_case('stale')->>'outcome','stale','same-name reclaimed generation stale');

select pg_temp.new_acceptance_case('canceled');
select public.api_cancel_quote_request(request_id) from acceptance_cases where name='canceled';
create temporary table before_fence as select pg_temp.acceptance_snapshot('canceled') snapshot;
select is(pg_temp.accept_case('canceled')->>'outcome','fenced','free-beta canceled/released is typed fenced');
select is(pg_temp.acceptance_snapshot('canceled'),snapshot,'fenced writes nothing') from before_fence;
select pg_temp.new_acceptance_case('released');
update private.quote_access_admissions set state='released',terminal_at=now(),outcome_reason='failed'
 where quote_request_id=(select request_id from acceptance_cases where name='released');
select is(pg_temp.accept_case('released')->>'outcome','fenced','released without cancel also fenced');

select pg_temp.new_acceptance_case('nonfree',false);
update public.quote_requests set status='canceled' where id=(select request_id from acceptance_cases where name='nonfree');
select is(pg_temp.accept_case('nonfree')->>'outcome','request_canceled','non-free canceled accepted and task cancelled');
select ok(t.status='cancelled' and t.last_error='Canceled while vendor automation was in flight.'
 and t.payload->>'ignoredDueToCanceledRequest'='true' and t.locked_by is null and t.locked_at is null,
 'cancelled task settlement complete') from public.work_queue t join acceptance_cases c on c.task_id=t.id where name='nonfree';
select is(pg_temp.accept_case('nonfree')->>'original_outcome','request_canceled','canceled receipt replays');

select is(r.status::text,'canceled','non-free result trigger preserves canceled request')
 from public.quote_requests r join acceptance_cases c on c.request_id=r.id where name='nonfree';
select is((select count(*)::int from public.vendor_quote_offers o join acceptance_cases c
 on c.result_id=o.vendor_quote_result_id where name='nonfree'),1,'legacy non-free canceled path retains offer');

-- Non-permit enqueue identity selects a single vendor/quantity within a run.
select pg_temp.new_acceptance_case('multi-vendor',false);
select pg_temp.new_acceptance_case('multi-quantity',false);
insert into public.vendor_quote_results(quote_run_id,part_id,organization_id,vendor,requested_quantity,status)
 select r.quote_run_id,r.part_id,r.organization_id,
 case when c.name='multi-vendor' then 'fictiv'::public.vendor_name else r.vendor end,
 case when c.name='multi-quantity' then 2 else r.requested_quantity end,'running'
 from acceptance_cases c join public.vendor_quote_results r on r.id=c.result_id
 where c.name in ('multi-vendor','multi-quantity');
-- Missing identity retains the legacy unique-result fallback, failing closed.
select is(pg_temp.accept_case(name)->>'outcome','stale',name||' ambiguous fallback stale')
 from acceptance_cases where name in ('multi-vendor','multi-quantity');
update public.work_queue t set payload=payload||jsonb_build_object('vendor',r.vendor,'requestedQuantity',r.requested_quantity)
 from acceptance_cases c join public.vendor_quote_results r on r.id=c.result_id
 where t.id=c.task_id and c.name in ('multi-vendor','multi-quantity');
create temporary table multi_before as select name,pg_temp.acceptance_snapshot(name) snapshot
 from acceptance_cases where name in ('multi-vendor','multi-quantity');
select is(public.accept_vendor_quote_result(c.task_id,'s11b-worker','2026-10-29 01:00:00+00',1,
 other.id,free_meter_fixture.result_payload(),'[]')->>'outcome','stale',c.name||' other result stale')
 from acceptance_cases c join public.vendor_quote_results other on other.quote_run_id=c.run_id
 and other.id<>c.result_id where c.name in ('multi-vendor','multi-quantity');
select is(pg_temp.acceptance_snapshot(name),snapshot,name||' mismatch writes nothing') from multi_before;
select is(pg_temp.accept_case(name)->>'outcome','accepted',name||' correct result accepted')
 from acceptance_cases where name in ('multi-vendor','multi-quantity');

-- Later lifecycle states survive both a pending follow-up and repeat drains.
select pg_temp.new_acceptance_case('published',false);
select pg_temp.accept_case('published');
update public.quote_runs set status='published' where id=(select run_id from acceptance_cases where name='published');
update public.jobs set status='client_selected' where id=(select job_id from acceptance_cases where name='published');
select public.drain_quote_run_rollup_followups();
select is(r.status::text,'published','published run preserved') from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name='published';
select is(j.status::text,'client_selected','later job preserved') from public.jobs j join acceptance_cases c on c.job_id=j.id where name='published';
select is((select count(*)::int from public.audit_events a join acceptance_cases c on c.job_id=a.job_id where name='published' and event_type like 'worker.quote_run_%'),0,'no audit when nothing changes');

-- Delayed drains preserve every job phase outside active quoting, including
-- admin/user transitions that are not terminal enum values.
select pg_temp.new_acceptance_case('phase-'||phase,false) from unnest(array[
 'uploaded','extracting','needs_spec_review','ready_to_quote','internal_review']) phase;
select pg_temp.accept_case(name) from acceptance_cases where name like 'phase-%';
update public.jobs j set status=substring(c.name from 7)::public.job_status
 from acceptance_cases c where j.id=c.job_id and c.name like 'phase-%';
select public.drain_quote_run_rollup_followups();
select is(j.status::text,substring(c.name from 7),'delayed drain preserves '||j.status)
 from acceptance_cases c join public.jobs j on j.id=c.job_id where name like 'phase-%';

-- An older run can settle itself but cannot overwrite a newer run's job state.
select pg_temp.new_acceptance_case('older-run',false);
select pg_temp.accept_case('older-run');
insert into public.quote_runs(job_id,organization_id,initiated_by,status,created_at)
 select r.job_id,r.organization_id,r.initiated_by,'running',r.created_at+interval '1 second'
 from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name='older-run';
select public.drain_quote_run_rollup_followups();
select is(j.status::text,'quoting','old followup cannot complete newer quoting job')
 from public.jobs j join acceptance_cases c on c.job_id=j.id where name='older-run';
select is(r.status::text,'completed','old run still settles independently')
 from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name='older-run';

-- Manual review never moves backwards to quoting. Terminal runs never reopen,
-- even when the result snapshot has changed while the followup was delayed.
select pg_temp.new_acceptance_case('manual-pending',false);
select pg_temp.new_acceptance_case('manual-failed',false);
select pg_temp.new_acceptance_case('manual-success',false);
select pg_temp.new_acceptance_case('run-completed',false);
select pg_temp.new_acceptance_case('run-failed',false);
select pg_temp.accept_case(name) from acceptance_cases
 where name in ('manual-pending','manual-failed','manual-success','run-completed','run-failed');
update public.jobs j set status='awaiting_vendor_manual_review'
 from acceptance_cases c where j.id=c.job_id and name like 'manual-%';
update public.quote_runs r set status=substring(c.name from 5)::public.quote_run_status
 from acceptance_cases c where r.id=c.run_id and name in ('run-completed','run-failed');
update public.vendor_quote_results r set status=case when c.name='manual-failed'
 then 'failed'::public.vendor_status else 'running'::public.vendor_status end
 from acceptance_cases c where r.id=c.result_id
 and name in ('manual-pending','manual-failed','run-completed','run-failed');
select public.drain_quote_run_rollup_followups();
select is(j.status::text,'awaiting_vendor_manual_review',name||' cannot regress to quoting')
 from public.jobs j join acceptance_cases c on c.job_id=j.id where name in ('manual-pending','manual-failed');
select is(j.status::text,'internal_review','manual review can advance after successful acceptance')
 from public.jobs j join acceptance_cases c on c.job_id=j.id where name='manual-success';
select is(r.status::text,substring(c.name from 5),name||' is not reopened')
 from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name in ('run-completed','run-failed');

-- Invalid finalization and deferred failures roll back the entire candidate.
select pg_temp.new_acceptance_case('atomic',false);
create temporary table before_atomic as select pg_temp.acceptance_snapshot('atomic') snapshot;
select throws_ok(format('select public.accept_vendor_quote_result(%L,%L,%L,1,%L,%L,%L)',
 task_id,'s11b-worker','2026-10-29 01:00:00+00',result_id,free_meter_fixture.result_payload('running'),offers),
 'P0001','Vendor quote acceptance requires a terminal result.','nonterminal cannot complete task')
 from acceptance_cases where name='atomic';
select is(pg_temp.acceptance_snapshot('atomic'),snapshot,'nonterminal changes nothing') from before_atomic;
select throws_ok(format('select public.accept_vendor_quote_result(%L,%L,%L,1,%L,%L,%L)',
 task_id,'s11b-worker','2026-10-29 01:00:00+00',result_id,free_meter_fixture.result_payload(),
 jsonb_set(offers,'{0,vendor_quote_result_id}',to_jsonb(gen_random_uuid()))),
 'P0001',format('Every offer must belong to vendor quote result %s.',result_id),'offer ownership validated')
 from acceptance_cases where name='atomic';
select is(pg_temp.acceptance_snapshot('atomic'),snapshot,'invalid offer changes nothing') from before_atomic;
select throws_ok(format('select public.accept_vendor_quote_result(%L,%L,%L,1,%L,%L,%L)',
 task_id,'s11b-worker','2026-10-29 01:00:00+00',result_id,free_meter_fixture.result_payload(),
 jsonb_set(offers,'{0,organization_id}',to_jsonb(gen_random_uuid()))),
 'P0001','Every offer must belong to the result organization.','offer organization cannot be forged')
 from acceptance_cases where name='atomic';
select is(pg_temp.acceptance_snapshot('atomic'),snapshot,'forged offer organization changes nothing') from before_atomic;
create function pg_temp.s11b_deferred_contention() returns trigger language plpgsql as $$
begin raise sqlstate '55P03' using message='synthetic deferred contention'; end $$;
create constraint trigger s11b_deferred_contention after update on public.vendor_quote_results
 deferrable initially deferred for each row execute function pg_temp.s11b_deferred_contention();
set constraints s11b_deferred_contention deferred;
select is(pg_temp.accept_case('atomic')->>'outcome','busy','deferred contention caught inside candidate');
select is(pg_temp.acceptance_snapshot('atomic'),snapshot,'deferred failure rolls back offers/task/receipt/outbox') from before_atomic;
drop trigger s11b_deferred_contention on public.vendor_quote_results;
select is(pg_temp.accept_case('atomic')->>'outcome','accepted','deferred candidate retries once');

-- Permit-backed lane identity is checked in full after locking.
select pg_temp.new_acceptance_case('binding');
update public.vendor_quote_results set requested_quantity=2 where id=(select result_id from acceptance_cases where name='binding');
select is(pg_temp.accept_case('binding')->>'outcome','stale','permit quantity mismatch rejected');
update public.vendor_quote_results set requested_quantity=1 where id=(select result_id from acceptance_cases where name='binding');
update public.vendor_quote_results set vendor='fictiv' where id=(select result_id from acceptance_cases where name='binding');
select is(pg_temp.accept_case('binding')->>'outcome','stale','permit provider mismatch rejected');

-- Orphaned immutable follow-ups do not consume an actionable batch forever.
select pg_temp.new_acceptance_case('later',false);
-- Insert lower IDs before the valid producer creates its followup.
insert into private.quote_run_rollup_followups(receipt_id,job_id,quote_run_id)
 select gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(1,3);
select pg_temp.accept_case('later');
-- Drain all earlier valid rows first; the limit-one call must reach the valid row
-- even with three older orphaned rows remaining pending.
select public.drain_quote_run_rollup_followups();
update private.quote_run_rollup_followups set processed_at=null where quote_run_id=(select run_id from acceptance_cases where name='later');
select is(public.drain_quote_run_rollup_followups(1)->>'processed','1','missing targets cannot starve valid followup');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),3,'orphan diagnostic backlog retained');

-- SQL reducer mirrors the worker precedence and counts, including no lanes.
select is((select jsonb_build_object('run',run_status,'job',job_status,'success',successful,'manual',manual_review,'failed',failed)
 from private.aggregate_quote_run_status(statuses)), expected, label)
from (values
 ('empty','{}'::public.vendor_status[],'{"run":"failed","job":"quoting","success":0,"manual":0,"failed":0}'::jsonb),
 ('failed',array['failed','stale']::public.vendor_status[],'{"run":"failed","job":"quoting","success":0,"manual":0,"failed":1}'::jsonb),
 ('success',array['instant_quote_received','official_quote_received','failed']::public.vendor_status[],'{"run":"completed","job":"internal_review","success":2,"manual":0,"failed":1}'::jsonb),
 ('manual beats success',array['manual_review_pending','manual_vendor_followup','official_quote_received']::public.vendor_status[],'{"run":"completed","job":"awaiting_vendor_manual_review","success":1,"manual":2,"failed":0}'::jsonb),
 ('queued beats manual',array['queued','manual_review_pending','instant_quote_received']::public.vendor_status[],'{"run":"running","job":"quoting","success":1,"manual":1,"failed":0}'::jsonb),
 ('running',array['running']::public.vendor_status[],'{"run":"running","job":"quoting","success":0,"manual":0,"failed":0}'::jsonb)
) cases(label,statuses,expected);
select ok(not exists(select 1 from pg_constraint where contype='f' and conrelid in
 ('private.vendor_quote_acceptance_receipts'::regclass,'private.quote_run_rollup_followups'::regclass)),
 'immutable evidence IDs have no deletion-coupled FKs');
select pg_temp.new_acceptance_case('protected-published',false);
select pg_temp.new_acceptance_case('protected-closed',false);
select pg_temp.accept_case(name) from acceptance_cases where name like 'protected-%';
update public.jobs set status='published' where id=(select job_id from acceptance_cases where name='protected-published');
update public.jobs set status='closed' where id=(select job_id from acceptance_cases where name='protected-closed');
select public.drain_quote_run_rollup_followups();
select is(j.status::text,substring(c.name from 11),'later job remains '||j.status::text)
 from acceptance_cases c join public.jobs j on j.id=c.job_id where c.name like 'protected-%';

-- Legacy overload and its service grant remain fully functional.
select pg_temp.new_acceptance_case('legacy',false);
select lives_ok(format('select public.reconcile_vendor_quote_offers(%L,%L,%L)',result_id,
 free_meter_fixture.result_payload(),offers),'old reconcile still works') from acceptance_cases where name='legacy';
select is((select count(*)::int from public.vendor_quote_offers o join acceptance_cases c on c.result_id=o.vendor_quote_result_id where name='legacy'),1,'legacy persists offer');
select * from finish();
rollback;
