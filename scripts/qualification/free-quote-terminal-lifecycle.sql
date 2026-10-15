-- AUTHORED, NOT EXECUTED. Apply the CLI-generated lifecycle migration to an owned disposable
-- full-schema fixture first. This suite rolls back all synthetic rows.
begin;
select no_plan();
\set meter_fixture_limit 20
\ir ../../supabase/tests/fixtures/free_quote_meter_setup.inc

select ok(not has_function_privilege('anon','public.api_reconcile_terminal_free_quote_tasks(uuid,integer)','EXECUTE'),'anonymous reconciliation forbidden');
select ok(not has_function_privilege('authenticated','public.api_reconcile_terminal_free_quote_tasks(uuid,integer)','EXECUTE'),'customer reconciliation forbidden');
select ok(has_function_privilege('service_role','public.api_reconcile_terminal_free_quote_tasks(uuid,integer)','EXECUTE'),'service-only bounded reconciliation');
select ok(not has_function_privilege('service_role','private.fence_reserved_free_quote_job_delete()','EXECUTE'),'no direct delete-fence authority');
set local role authenticated;
select throws_ok($$select public.api_reconcile_terminal_free_quote_tasks()$$,'42501',null,'actual customer invocation rejected');
reset role;
set local role service_role;
select lives_ok($$select public.api_reconcile_terminal_free_quote_tasks()$$,'actual service invocation succeeds without direct receipt permissions');
reset role;
select throws_ok($$select public.api_reconcile_terminal_free_quote_tasks(null,101)$$,'P0001','free_quote_reconciliation_limit_invalid','unbounded batch rejected');

create temporary table lifecycle_cases(name text primary key,request_id uuid not null,job_id uuid);
insert into lifecycle_cases(name,request_id) values
 ('crash',free_meter_fixture.new_request()),('retry',free_meter_fixture.new_request()),
 ('success',free_meter_fixture.new_request()),('cancel',free_meter_fixture.new_request()),
 ('delete',free_meter_fixture.new_request()),('revived',free_meter_fixture.new_request());
update lifecycle_cases c set job_id=a.job_id from private.quote_access_admissions a where a.quote_request_id=c.request_id;

-- Simulate the durable queue write from a crashed-worker reap. The scan runs in
-- a separate call and must also recover an interruption before that call.
update public.work_queue set status='failed',locked_at=null,locked_by=null,last_error='worker_crash_recovery'
where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='crash');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='crash')),'reserved','queue-only terminal write leaves recoverable hold');
select public.api_reconcile_terminal_free_quote_tasks();
select is((select status::text from public.vendor_quote_results where id=free_meter_fixture.result_id((select request_id from lifecycle_cases where name='crash'))),'failed','reconciliation terminalizes the pinned result');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='crash')),'released','crash releases free capacity');
select is((public.api_reconcile_terminal_free_quote_tasks()->>'reconciled')::integer,0,'repeat scan does not double-settle');
select throws_ok(format('select public.reconcile_vendor_quote_offers(%L::uuid,%L::jsonb,%L::jsonb)',
 free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id)),
 'P0001','free_quote_terminal_fenced','late success cannot resurrect released task') from lifecycle_cases where name='crash';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='retry')),'reserved','queued retry remains reserved');

-- Terminal-looking task with a still-active lease is not an eligible settlement.
update public.work_queue set status='failed',locked_at=clock_timestamp(),locked_by='synthetic-worker'
where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='revived');
select public.api_reconcile_terminal_free_quote_tasks();
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='revived')),'reserved','uncleared lease is deferred');
update public.work_queue set status='running' where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='revived');
select public.api_reconcile_terminal_free_quote_tasks();
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='revived')),'reserved','revived running task is untouched');

select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id))
from lifecycle_cases where name='success';
update public.work_queue set status='failed',locked_at=null,locked_by=null where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='success');
select public.api_reconcile_terminal_free_quote_tasks();
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='success')),'consumed','success before cleanup failure remains consumed exactly once');
select is((select status::text from public.vendor_quote_results where id=free_meter_fixture.result_id((select request_id from lifecycle_cases where name='success'))),'instant_quote_received','canonical success is not overwritten');
select public.api_cancel_quote_request(request_id) from lifecycle_cases where name='cancel';
select public.api_reconcile_terminal_free_quote_tasks();
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='cancel')),'released','canceled receipt remains released');

-- No lifecycle reconciliation may change any attempted cost observation.
select ok(not exists(select 1 from free_meter_fixture.spend_before expected left join public.spend_ledger actual on actual.id=expected.id
 where to_jsonb(actual) is distinct from expected.original_row),'reconciliation preserves every known and unresolved spend row exactly');

update public.jobs set archived_at=clock_timestamp() where id in(select job_id from lifecycle_cases);
select throws_ok(format('select public.api_delete_archived_jobs(array[%L::uuid])',job_id),'P0001','free_quote_reservation_unresolved',
 'archived reserved job cannot be deleted') from lifecycle_cases where name='delete';
select ok(exists(select 1 from public.jobs where id=(select job_id from lifecycle_cases where name='delete')),'rejected delete preserves job and canonical identity');
select public.api_cancel_quote_request(request_id) from lifecycle_cases where name='delete';
select lives_ok(format('select public.api_delete_archived_jobs(array[%L::uuid])',job_id),'settled released job may be deleted') from lifecycle_cases where name='delete';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='delete')),'released','released historical receipt survives deletion');
select lives_ok(format('select public.api_delete_archived_jobs(array[%L::uuid])',job_id),'consumed job may be deleted') from lifecycle_cases where name='success';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='success')),'consumed','consumed history survives deletion');
select is((select count(*)::integer from public.spend_ledger where id in(select id from free_meter_fixture.spend_before)),
 (select count(*)::integer from free_meter_fixture.spend_before),'historical attempted costs survive job deletion');

-- Forged task metadata cannot redirect settlement; immutable permit IDs win.
insert into lifecycle_cases(name,request_id) values('forged-task',free_meter_fixture.new_request());
update public.work_queue set status='failed',locked_at=null,locked_by=null,part_id=null
where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='forged-task');
select ok((public.api_reconcile_terminal_free_quote_tasks()->>'indeterminate')::integer>0,'forged binding emits bounded diagnostic');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from lifecycle_cases where name='forged-task')),'reserved','forged binding retains hold for investigation');
select is((select status::text from public.vendor_quote_results where id=free_meter_fixture.result_id((select request_id from lifecycle_cases where name='forged-task'))),'queued','forged binding cannot mutate unrelated result');

-- Nullable job and lane-result fields must also fail closed (SQL NULL is not false).
insert into lifecycle_cases(name,request_id) values('null-job',free_meter_fixture.new_request()),('null-lane-result',free_meter_fixture.new_request());
update public.work_queue set status='failed',locked_at=null,locked_by=null,job_id=null
where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='null-job');
update public.work_queue set status='failed',locked_at=null,locked_by=null
where id=(select p.work_queue_task_id from private.xometry_beta_dispatch_permits p
 join lifecycle_cases c on c.request_id=p.quote_request_id where c.name='null-lane-result');
update public.quote_request_lanes set vendor_quote_result_id=null
where quote_request_id=(select request_id from lifecycle_cases where name='null-lane-result');
select public.api_reconcile_terminal_free_quote_tasks();
select is((select count(*)::integer from private.quote_access_admissions where state='reserved'
 and quote_request_id in(select request_id from lifecycle_cases where name in('null-job','null-lane-result'))),2,'null bindings retain holds');
select is((select count(*)::integer from public.vendor_quote_results where status='queued'
 and id in(select free_meter_fixture.result_id(request_id) from lifecycle_cases where name in('null-job','null-lane-result'))),2,'null bindings cannot terminalize results');

select * from finish();
rollback;
