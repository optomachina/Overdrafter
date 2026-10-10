-- AUTHORED, NOT EXECUTED. Only the reviewed isolated fixture runner may run this
-- source: exclusive UUID/owner/source-labelled network-none container, owned Unix
-- socket, postgres identity, unchanged hash-bound stdin. No dblink or auth edits.
-- Every session independently bounds statements, lock waits, and idle transactions.
\set ON_ERROR_STOP on
set statement_timeout='10s';
set lock_timeout='6s';
set idle_in_transaction_session_timeout='20s';
set search_path=public,extensions,pg_catalog;

select case when kind='delete-admission' then isolation_level else 'read committed' end as acquire_isolation,
 constraints_mode,acquire_role,acquire_sql from free_meter_fixture.current_race \gset
begin isolation level :acquire_isolation;
set constraints all :constraints_mode;
select free_meter_fixture.set_caller_identity(:'acquire_role');
set local role :acquire_role;
select free_meter_fixture.capture(:'acquire_sql') as acquired \gset
reset role;
select free_meter_fixture.require_acquired(:'acquired'::jsonb);
-- Leave the actual target locks held. The runner records this backend PID and
-- observes every waiting contender (or probe) before sending release.sql.
