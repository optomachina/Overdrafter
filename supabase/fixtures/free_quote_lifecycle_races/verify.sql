-- AUTHORED, NOT EXECUTED. Only the reviewed isolated fixture runner may run this
-- source: exclusive UUID/owner/source-labelled network-none container, owned Unix
-- socket, postgres identity, unchanged hash-bound stdin. No dblink or auth edits.
-- Every session independently bounds statements, lock waits, and idle transactions.
\set ON_ERROR_STOP on
set statement_timeout='10s';
set lock_timeout='6s';
set idle_in_transaction_session_timeout='20s';
set search_path=public,extensions,pg_catalog;
select no_plan();
select * from free_meter_fixture.verify_race();


-- These guards are checked once, after the first case drains. PostgreSQL needs
-- separate top-level transactions to exercise the actual isolation setting.
select (kind='meter-replay') as run_isolation_guards from free_meter_fixture.current_race \gset
select job_id as guard_job from free_meter_fixture.context \gset
\if :run_isolation_guards
begin isolation level repeatable read;
select free_meter_fixture.set_caller_identity('service_role');
set local role service_role;
select free_meter_fixture.capture('select public.api_reconcile_terminal_free_quote_tasks(null,1)') as guard_response \gset
reset role;
select is(:'guard_response'::jsonb->>'sqlstate','P0001','repeatable read service_role: isolation SQLSTATE');
select is(:'guard_response'::jsonb->>'error','free_quote_reconciliation_requires_read_committed','repeatable read service_role: fails closed');
commit;
begin isolation level repeatable read;
select free_meter_fixture.set_caller_identity('authenticated');
set local role authenticated;
select free_meter_fixture.capture(format('select public.api_request_xometry_beta_dispatch(%L::uuid,''inch'',%L,''founding-beta-2026-08-15'',gen_random_uuid(),true,true,true)',:'guard_job',repeat('a',64))) as guard_response \gset
reset role;
select is(:'guard_response'::jsonb->>'sqlstate','P0001','repeatable read authenticated: isolation SQLSTATE');
select is(:'guard_response'::jsonb->>'error','free_quote_isolation_unsupported','repeatable read authenticated: fails closed');
commit;
begin isolation level serializable;
select free_meter_fixture.set_caller_identity('service_role');
set local role service_role;
select free_meter_fixture.capture('select public.api_reconcile_terminal_free_quote_tasks(null,1)') as guard_response \gset
reset role;
select is(:'guard_response'::jsonb->>'sqlstate','P0001','serializable service_role: isolation SQLSTATE');
select is(:'guard_response'::jsonb->>'error','free_quote_reconciliation_requires_read_committed','serializable service_role: fails closed');
commit;
begin isolation level serializable;
select free_meter_fixture.set_caller_identity('authenticated');
set local role authenticated;
select free_meter_fixture.capture(format('select public.api_request_xometry_beta_dispatch(%L::uuid,''inch'',%L,''founding-beta-2026-08-15'',gen_random_uuid(),true,true,true)',:'guard_job',repeat('a',64))) as guard_response \gset
reset role;
select is(:'guard_response'::jsonb->>'sqlstate','P0001','serializable authenticated: isolation SQLSTATE');
select is(:'guard_response'::jsonb->>'error','free_quote_isolation_unsupported','serializable authenticated: fails closed');
commit;
\endif
select * from finish();
