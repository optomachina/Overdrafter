-- Run against an owned local main-only baseline, before the forward migration.
-- All stages commit so reapplication exercises the actual retained-table path.
\set ON_ERROR_STOP on
begin;
\ir ../../migrations/20261029165751_reconcile_claim_fence.sql
commit;
select no_plan();
insert into private.vendor_quote_acceptance_receipts(id,work_queue_task_id,claim_locked_at,
 claim_attempts,vendor_quote_result_id,payload_digest,outcome)
values('00000000-0000-4000-8000-000000009760',gen_random_uuid(),now(),1,gen_random_uuid(),'rollback-fixture','accepted');
insert into private.quote_run_rollup_followups(receipt_id,job_id,quote_run_id)
values('00000000-0000-4000-8000-000000009760',gen_random_uuid(),gen_random_uuid());
create temporary table rollback_table_identity as select oid,relname from pg_class
where oid in ('private.vendor_quote_acceptance_receipts'::regclass,'private.quote_run_rollup_followups'::regclass);
begin;
\ir ../20261029165751_reconcile_claim_fence.rollback.sql
commit;
select ok(to_regprocedure(signature) is null,'rollback removes '||signature) from unnest(array[
 'public.drain_quote_run_rollup_followups(integer)',
 'private.aggregate_quote_run_status(public.vendor_status[])',
 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)',
 'private.vendor_quote_acceptance_request_ids(uuid)',
 'private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)',
 'private.reject_vendor_quote_acceptance_receipt_mutation()']) signature;
select ok(not exists(select 1 from pg_trigger where tgname='vendor_quote_acceptance_receipts_append_only'),
 'rollback removes append-only trigger');
select is((select count(*)::int from private.vendor_quote_acceptance_receipts),1,'rollback retains receipt');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),1,'rollback retains pending followup');
begin;
\ir ../../migrations/20261029165751_reconcile_claim_fence.sql
commit;
select ok(to_regprocedure(signature) is not null,'reapply restores '||signature) from unnest(array[
 'public.drain_quote_run_rollup_followups(integer)',
 'private.aggregate_quote_run_status(public.vendor_status[])',
 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)',
 'private.vendor_quote_acceptance_request_ids(uuid)',
 'private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)',
 'private.reject_vendor_quote_acceptance_receipt_mutation()']) signature;
select is((select count(*)::int from rollback_table_identity b join pg_class c using(oid,relname)),2,
 'reapply preserves original table identities');
select is((select count(*)::int from private.vendor_quote_acceptance_receipts),1,'reapply preserves receipt');
select is((select count(*)::int from private.quote_run_rollup_followups where processed_at is null),1,'reapply preserves pending followup');
select throws_ok('delete from private.vendor_quote_acceptance_receipts','P0001',
 'Vendor quote acceptance receipts are append-only.','reapply restores append-only enforcement');
select ok(c.relrowsecurity and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r
 where has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'reapply preserves RLS and privilege denial '||c.relname)
 from pg_class c join rollback_table_identity b using(oid,relname);
select ok(p.proconfig @> array['search_path=""']::text[],'empty search path '||p.proname)
from pg_proc p where p.oid in (
 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)'::regprocedure,
 'public.drain_quote_run_rollup_followups(integer)'::regprocedure,
 'private.vendor_quote_acceptance_request_ids(uuid)'::regprocedure,
 'private.apply_vendor_quote_result_offers(uuid,jsonb,jsonb)'::regprocedure,
 'private.aggregate_quote_run_status(public.vendor_status[])'::regprocedure,
 'private.reject_vendor_quote_acceptance_receipt_mutation()'::regprocedure);
select ok(p.proconfig @> array['lock_timeout=1s']::text[],'bounded implicit lock waits '||p.proname)
from pg_proc p where p.oid in (
 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)'::regprocedure,
 'public.drain_quote_run_rollup_followups(integer)'::regprocedure);
-- Delete only this suite's synthetic evidence, with the guard restored immediately.
begin;
alter table private.vendor_quote_acceptance_receipts disable trigger vendor_quote_acceptance_receipts_append_only;
delete from private.quote_run_rollup_followups where receipt_id='00000000-0000-4000-8000-000000009760';
delete from private.vendor_quote_acceptance_receipts where id='00000000-0000-4000-8000-000000009760';
alter table private.vendor_quote_acceptance_receipts enable trigger vendor_quote_acceptance_receipts_append_only;
commit;
select * from finish();
