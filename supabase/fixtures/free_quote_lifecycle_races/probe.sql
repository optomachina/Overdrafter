-- AUTHORED, NOT EXECUTED. Only the reviewed isolated fixture runner may run this
-- source: exclusive UUID/owner/source-labelled network-none container, owned Unix
-- socket, postgres identity, unchanged hash-bound stdin. No dblink or auth edits.
-- Every session independently bounds statements, lock waits, and idle transactions.
\set ON_ERROR_STOP on
set statement_timeout='10s';
set lock_timeout='6s';
set idle_in_transaction_session_timeout='20s';
set search_path=public,extensions,pg_catalog;

-- Complete-before-release only. This SELECT FOR UPDATE targets the exact result,
-- request or queue row held by acquire.sql, not an unrelated sentinel lock.
select name,probe_sql from free_meter_fixture.current_race \gset
begin;
select no_plan();
select free_meter_fixture.capture(:'probe_sql') as response \gset
select is(:'response'::jsonb->>'sqlstate','00000',:'name'||': real target-lock probe resumes after release');
select ok(:'response'::jsonb ? 'locked',:'name'||': target row remained identifiable after release');
commit;
select * from finish();
