-- Transactional follow-up coverage; all synthetic records roll back.
begin;
select no_plan();
\set meter_fixture_limit 100
\ir fixtures/free_quote_meter_setup.inc

create temporary table acceptance_cases (
  name text primary key, request_id uuid, task_id uuid, result_id uuid,
  run_id uuid, job_id uuid, offers jsonb, response jsonb
);
create function pg_temp.new_acceptance_case(p_name text)
returns void language plpgsql as $$
declare r uuid; t uuid; v uuid; q uuid; j uuid; c free_meter_fixture.context%rowtype;
begin
  select * into c from free_meter_fixture.context;
  r := free_meter_fixture.new_request();
  select work_queue_task_id,vendor_quote_result_id,quote_run_id,job_id into t,v,q,j
    from private.xometry_beta_dispatch_permits where quote_request_id = r;
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
select ok(not has_function_privilege(role_name,
 'private.reject_quote_run_job_reassignment()','execute'), role_name||' cannot call the trigger helper')
 from unnest(array['anon','authenticated','service_role']) role_name;

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
select is(response->>'outcome','accepted','acceptance creates the followup') from acceptance_cases where name='accepted';
-- Contention after selection still defers atomically and leaves a retryable row.
create function pg_temp.s11b_rollup_contention() returns trigger language plpgsql as $$
begin raise sqlstate '55P03' using message='synthetic rollup contention'; end $$;
create trigger s11b_rollup_contention before insert on public.audit_events
 for each row execute function pg_temp.s11b_rollup_contention();
select is(public.drain_quote_run_rollup_followups(),'{"scanned":1,"processed":0,"deferred":1}'::jsonb,
 'later contention defers the selected followup without acknowledging it');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),1,
 'contention leaves the selected followup pending');
select is(r.status::text,'queued','contention rolls back the run status change')
 from public.quote_runs r join acceptance_cases c on c.run_id=r.id where name='accepted';
select is(j.status::text,'quoting','contention rolls back the job status change')
 from public.jobs j join acceptance_cases c on c.job_id=j.id where name='accepted';
drop trigger s11b_rollup_contention on public.audit_events;
select is(public.drain_quote_run_rollup_followups()->>'processed','1','independent drain acknowledges completed task');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),0,
 'retry acknowledges the pending followup');
select * from finish();
rollback;
