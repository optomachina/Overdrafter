-- AUTHORED, NOT EXECUTED. Only the reviewed isolated fixture runner may run this
-- source: exclusive UUID/owner/source-labelled network-none container, owned Unix
-- socket, postgres identity, unchanged hash-bound stdin. No dblink or auth edits.
-- Every session independently bounds statements, lock waits, and idle transactions.
\set ON_ERROR_STOP on
set statement_timeout='10s';
set lock_timeout='6s';
set idle_in_transaction_session_timeout='20s';
set search_path=public,extensions,pg_catalog;

select case when kind='admission-delete' then isolation_level else 'read committed' end as contender_isolation,
 constraints_mode,contender_role,contender_sql,(kind='two-sweepers') as two_sweepers
 from free_meter_fixture.current_race \gset
begin isolation level :contender_isolation;
select no_plan();
set constraints all :constraints_mode;
select free_meter_fixture.set_caller_identity(:'contender_role');
set local role :contender_role;
select free_meter_fixture.capture(:'contender_sql') as response \gset
reset role;
select * from free_meter_fixture.assert_contender(:'response'::jsonb);
\if :two_sweepers
 select free_meter_fixture.second_page_sql(:'response'::jsonb) as second_sql \gset
 set local role service_role;
 select free_meter_fixture.capture(:'second_sql') as second_response \gset
 reset role;
 select * from free_meter_fixture.assert_second_page(:'second_response'::jsonb);
\endif
select free_meter_fixture.remember();
commit;
select * from finish();
