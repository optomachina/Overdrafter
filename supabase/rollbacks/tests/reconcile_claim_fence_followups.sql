-- Start with the original S1.1b migration installed and follow-ups absent.
-- Commit down/reapply stages to exercise the real upgrade recovery path.
\set ON_ERROR_STOP on
select no_plan();
create temporary table followups_original_drain as
 select oid,proowner,proacl,proconfig,pg_get_functiondef(oid) definition from pg_proc
 where oid='public.drain_quote_run_rollup_followups(integer)'::regprocedure;
create temporary table followups_table_identity as select oid,relname from pg_class
 where oid in ('private.vendor_quote_acceptance_receipts'::regclass,'private.quote_run_rollup_followups'::regclass);
begin;
insert into private.vendor_quote_acceptance_receipts(id,work_queue_task_id,claim_locked_at,
 claim_attempts,vendor_quote_result_id,payload_digest,outcome)
values('00000000-0000-4000-8000-000000009830',gen_random_uuid(),now(),1,gen_random_uuid(),'followups-rollback-fixture','accepted');
insert into private.quote_run_rollup_followups(receipt_id,job_id,quote_run_id)
values('00000000-0000-4000-8000-000000009830',gen_random_uuid(),gen_random_uuid());
\ir ../../migrations/20261101110559_reconcile_claim_fence_followups.sql
commit;
create temporary table followups_upgraded_drain as
 select pg_get_functiondef('public.drain_quote_run_rollup_followups(integer)'::regprocedure) definition;
select ok(exists(select 1 from pg_trigger where tgrelid='public.quote_runs'::regclass
 and tgname='quote_runs_job_id_immutable'),'upgrade installs job binding trigger');
begin;
\ir ../20261101110559_reconcile_claim_fence_followups.rollback.sql
commit;
select ok(to_regprocedure('private.reject_quote_run_job_reassignment()') is null,'rollback removes trigger helper');
select ok(not exists(select 1 from pg_trigger where tgrelid='public.quote_runs'::regclass
 and tgname='quote_runs_job_id_immutable'),'rollback removes job binding trigger');
select is(pg_get_functiondef(p.oid),b.definition,'rollback restores the exact original drain definition')
 from pg_proc p join followups_original_drain b using(oid);
select ok(p.proowner=b.proowner and p.proacl=b.proacl and p.proconfig=b.proconfig,
 'rollback preserves drain owner, grants, search_path and lock_timeout')
 from pg_proc p join followups_original_drain b using(oid);
begin;
\ir ../../migrations/20261101110559_reconcile_claim_fence_followups.sql
commit;
select is(pg_get_functiondef('public.drain_quote_run_rollup_followups(integer)'::regprocedure),definition,
 'reapply restores the exact upgraded drain definition') from followups_upgraded_drain;
select ok(p.proowner=b.proowner and p.proacl=b.proacl and p.proconfig=b.proconfig,
 'reapply preserves drain identity, owner, grants and configuration')
 from pg_proc p join followups_original_drain b using(oid);
select is((select count(*)::int from followups_table_identity b join pg_class c using(oid,relname)),2,
 'down/reapply preserves receipt and followup table identities');
select is((select count(*)::int from private.vendor_quote_acceptance_receipts
 where id='00000000-0000-4000-8000-000000009830'),1,'down/reapply preserves receipt');
select is((select count(*)::int from private.quote_run_rollup_followups
 where receipt_id='00000000-0000-4000-8000-000000009830' and processed_at is null),1,'down/reapply preserves pending followup');
select ok(exists(select 1 from pg_trigger where tgrelid='public.quote_runs'::regclass
 and tgname='quote_runs_job_id_immutable'),'reapply restores job binding trigger');
select ok(p.proconfig @> array['search_path=""']::text[] and not p.prosecdef,
 'trigger helper uses empty search path and invoker rights') from pg_proc p
 where oid='private.reject_quote_run_job_reassignment()'::regprocedure;
select ok(not has_function_privilege(role_name,'private.reject_quote_run_job_reassignment()','execute'),
 role_name||' denied trigger helper after reapply') from unnest(array['anon','authenticated','service_role']) role_name;
begin;
alter table private.vendor_quote_acceptance_receipts disable trigger vendor_quote_acceptance_receipts_append_only;
delete from private.quote_run_rollup_followups where receipt_id='00000000-0000-4000-8000-000000009830';
delete from private.vendor_quote_acceptance_receipts where id='00000000-0000-4000-8000-000000009830';
alter table private.vendor_quote_acceptance_receipts enable trigger vendor_quote_acceptance_receipts_append_only;
commit;
select * from finish();
