-- Run only after BOTH meter and confirmed-admission migrations are applied.
-- This file rolls back its synthetic fixtures. It has not run without a DB.
begin;
select no_plan();
\set meter_fixture_limit 20
\ir fixtures/free_quote_meter_setup.inc

select ok(not has_table_privilege('authenticated','private.quote_access_admissions','INSERT'),'clients cannot forge receipts');
select ok(not has_table_privilege('service_role','private.quote_access_admissions','UPDATE'),'service cannot directly rewrite receipts');
select ok(not has_function_privilege('authenticated','private.finalize_free_quote_job(uuid)','EXECUTE'),'clients cannot self-certify completion');
select ok(not has_function_privilege('service_role','private.record_quote_access_admission(uuid,uuid,text,uuid)','EXECUTE'),'service cannot bypass admission wrapper');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='private.quote_access_admissions'::regclass),'receipt RLS forced');
set local role authenticated;
select throws_ok($$select private.finalize_free_quote_job('00000000-0000-4000-8000-000000000001'::uuid)$$,'42501',null,'actual authenticated execution cannot self-certify');
select throws_ok($$select * from private.quote_access_admissions$$,'42501',null,'actual authenticated execution cannot enumerate private receipts');
reset role;
set local role service_role;
select throws_ok($$update private.quote_access_admissions set state='consumed'$$,'42501',null,'actual service transport cannot mutate private receipts');
reset role;

select throws_ok($$insert into private.free_quote_policies(revision,enabled,subject_kind,completed_limit,window_start,window_end)
values('synthetic-reset',true,'user',200,clock_timestamp(),clock_timestamp()+interval '1 hour')$$,'23P01',null,'overlapping revision cannot reset window/subject/cap');
update private.free_quote_policies set enabled=false where revision='synthetic-meter-only';
select throws_ok($$insert into private.free_quote_policies(revision,enabled,subject_kind,completed_limit,window_start,window_end)
values('synthetic-reset-disabled',true,'organization',200,clock_timestamp(),clock_timestamp()+interval '1 hour')$$,'23P01',null,'disabled history still prevents reset');
select throws_ok($$update private.free_quote_policies set completed_limit=21 where revision='synthetic-meter-only'$$,'P0001','free_quote_policy_immutable','policy cap immutable');
update private.free_quote_policies set enabled=true where revision='synthetic-meter-only';

create temporary table cases(name text primary key,request_id uuid not null);
insert into cases values('success',free_meter_fixture.new_request());
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='success')),'reserved','new request holds one slot');
-- Force constraint timing early: successful result must not release before offers.
set constraints all immediate;
select lives_ok(format('select public.reconcile_vendor_quote_offers(%L::uuid,%L::jsonb,%L::jsonb)',
 free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id)),
 'canonical valid offer succeeds with constraints immediate') from cases where name='success';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='success')),'consumed','one usable quote consumes once');
select is(private.finalize_free_quote_job((select request_id from cases where name='success'))->>'changed','false','reconcile receipt is idempotent');
select lives_ok(format('select public.reconcile_vendor_quote_offers(%L::uuid,%L::jsonb,%L::jsonb)',
 free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id)),
 'successful canonical replay does not double count') from cases where name='success';
select is((select count(*)::integer from private.quote_access_admissions where state='consumed'),1,'one consumed regardless of replay');
select is(public.api_cancel_quote_request((select request_id from cases where name='success'))->>'reasonCode','already_received','completed result wins cancellation');
select throws_ok(format('update public.vendor_quote_results set status=''running'' where id=%L::uuid',
 free_meter_fixture.result_id((select request_id from cases where name='success'))),'P0001','free_quote_terminal_fenced','consumed request cannot reopen');
update public.vendor_quote_offers set invalidated_at=clock_timestamp(),invalidated_by=(select user_id from free_meter_fixture.context),invalidation_reason='Synthetic invalidation'
where vendor_quote_result_id=free_meter_fixture.result_id((select request_id from cases where name='success'));
select is(private.finalize_free_quote_job((select request_id from cases where name='success'))->>'state','consumed','historical receipt survives later invalidation');
select ok((select qualifying_evidence->>'scopeFingerprint'=scope_fingerprint from private.quote_access_admissions where state='consumed'),'completion pins scope evidence');
select throws_ok($$insert into private.quote_access_admissions(organization_id,actor_user_id,job_id,quote_request_id,quote_run_id,permit_id,
approval_reference,scope_version,scope_fingerprint,notice_revision,admission_source,bucket_id,policy_revision,state,terminal_at,outcome_reason,qualifying_offer_id,qualifying_evidence)
select organization_id,actor_user_id,job_id,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),scope_version,scope_fingerprint,notice_revision,
admission_source,bucket_id,policy_revision,'consumed',clock_timestamp(),'usable_quote',gen_random_uuid(),null
from private.quote_access_admissions where state='consumed' limit 1$$,'23514',null,'consumed receipt cannot lack evidence');
select throws_ok($$insert into private.quote_access_admissions(organization_id,actor_user_id,job_id,quote_request_id,quote_run_id,permit_id,
approval_reference,scope_version,scope_fingerprint,notice_revision,admission_source,bucket_id,policy_revision,state,terminal_at,outcome_reason,qualifying_offer_id,qualifying_evidence)
select organization_id,actor_user_id,job_id,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),scope_version,scope_fingerprint,notice_revision,
admission_source,bucket_id,policy_revision,'consumed',clock_timestamp(),null,gen_random_uuid(),'{}'::jsonb
from private.quote_access_admissions where state='consumed' limit 1$$,'23514',null,'consumed receipt rejects NULL outcome reason');

select throws_ok($$insert into private.quote_access_admissions(organization_id,actor_user_id,job_id,quote_request_id,quote_run_id,permit_id,
approval_reference,scope_version,scope_fingerprint,notice_revision,admission_source,bucket_id,policy_revision,state,terminal_at,outcome_reason,qualifying_offer_id,qualifying_evidence)
select organization_id,actor_user_id,job_id,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),scope_version,scope_fingerprint,notice_revision,
admission_source,bucket_id,policy_revision,'released',clock_timestamp(),null,null,null
from private.quote_access_admissions where state='consumed' limit 1$$,'23514',null,'released receipt rejects NULL outcome reason');



insert into cases values('zero',free_meter_fixture.new_request());
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id,0)) from cases where name='zero';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='zero')),'consumed','known finite zero quote is usable');
insert into cases values('no-offer',free_meter_fixture.new_request());
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),'[]'::jsonb) from cases where name='no-offer';
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='no-offer')),'released','canonical successful status alone does not consume');
select throws_ok(format('select public.reconcile_vendor_quote_offers(%L::uuid,%L::jsonb,%L::jsonb)',
 free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id)),
 'P0001','free_quote_terminal_fenced','late offer cannot resurrect released lifecycle') from cases where name='no-offer';

insert into cases values('nan',free_meter_fixture.new_request()),('expired',free_meter_fixture.new_request()),('unverified',free_meter_fixture.new_request());
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id,'NaN'::numeric)) from cases where name='nan';
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id,12,clock_timestamp()-interval '1 second')) from cases where name='expired';
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id,12,clock_timestamp()+interval '1 day','unverified')) from cases where name='unverified';
select is((select count(*)::integer from private.quote_access_admissions where quote_request_id in(select request_id from cases where name in('nan','expired','unverified')) and state='released'),3,'NaN expired and unverified offers do not consume');

insert into cases values('retry',free_meter_fixture.new_request());
update public.vendor_quote_results set status='running' where id=free_meter_fixture.result_id((select request_id from cases where name='retry'));
update public.vendor_quote_results set status='queued' where id=free_meter_fixture.result_id((select request_id from cases where name='retry'));
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='retry')),'reserved','queued provider retry retains hold');
update public.work_queue set status='running' where quote_run_id=(select quote_run_id from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='retry'));
-- Exercise normal deferred timing explicitly; the earlier success case forced
-- all constraints immediate to prove it cannot see an incomplete offer set.
set constraints public.settle_terminal_free_quote_result deferred;
update public.vendor_quote_results set status='failed' where id=free_meter_fixture.result_id((select request_id from cases where name='retry'));
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='retry')),'reserved','failure is still held before deferred event fires');
set constraints public.settle_terminal_free_quote_result immediate;
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='retry')),'released','terminal result releases while task still running cleanup');
select is((select status::text from public.work_queue where quote_run_id=(select quote_run_id from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='retry')) and task_type='run_vendor_quote'),'running','fixture proves distinct cleanup state');

insert into cases values('obsolete-failure',free_meter_fixture.new_request());
set constraints public.settle_terminal_free_quote_result deferred;
update public.vendor_quote_results set status='failed' where id=free_meter_fixture.result_id((select request_id from cases where name='obsolete-failure'));
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='obsolete-failure')),'reserved','second failure remains reserved while deferred');
update public.vendor_quote_results set status='queued' where id=free_meter_fixture.result_id((select request_id from cases where name='obsolete-failure'));
set constraints public.settle_terminal_free_quote_result immediate;
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='obsolete-failure')),'reserved','obsolete failed event cannot release a currently queued retry');
set constraints public.settle_terminal_free_quote_result deferred;


insert into cases values('cancel',free_meter_fixture.new_request());
select is(public.api_cancel_quote_request((select request_id from cases where name='cancel'))->>'canceled','true','customer cancel wins before usable result');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='cancel')),'released','cancel releases hold');
select is(private.release_cancelled_free_quote_job((select request_id from cases where name='cancel'))->>'changed','false','cancel release idempotent');
select throws_ok(format('update public.vendor_quote_results set status=''instant_quote_received'' where id=%L::uuid',
 free_meter_fixture.result_id((select request_id from cases where name='cancel'))),'P0001','free_quote_terminal_fenced','late result cannot overwrite canceled request');
select is((select status::text from public.quote_requests where id=(select request_id from cases where name='cancel')),'canceled','request cancellation remains authoritative');

-- Corrupted cancellation binding is indeterminate, never a quota release.
insert into cases values('cancel-identity',free_meter_fixture.new_request());
update public.quote_requests set status='canceled',job_id=(select job_id from free_meter_fixture.context)
 where id=(select request_id from cases where name='cancel-identity');
select is(private.release_cancelled_free_quote_job((select request_id from cases where name='cancel-identity'))->>'reasonCode',
 'identity_indeterminate','canceled request with mismatched job retains hold');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='cancel-identity')),
 'reserved','mismatched cancellation cannot release receipt');
insert into cases values('cancel-run-identity',free_meter_fixture.new_request());
update public.quote_requests set status='canceled' where id=(select request_id from cases where name='cancel-run-identity');
update public.quote_runs set quote_request_id=null where id=(select quote_run_id from private.quote_access_admissions
 where quote_request_id=(select request_id from cases where name='cancel-run-identity'));
select is(private.release_cancelled_free_quote_job((select request_id from cases where name='cancel-run-identity'))->>'reasonCode',
 'identity_indeterminate','canceled request with unbound pinned run retains hold');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='cancel-run-identity')),
 'reserved','pinned run mismatch cannot release receipt');
insert into cases values('cancel-disabled-policy',free_meter_fixture.new_request());
update private.free_quote_policies set enabled=false where revision='synthetic-meter-only';
select is(public.api_cancel_quote_request((select request_id from cases where name='cancel-disabled-policy'))->>'canceled','true',
 'disabled free policy still allows authoritative cancellation');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='cancel-disabled-policy')),
 'released','valid cancellation settles even after policy disable');
update private.free_quote_policies set enabled=true where revision='synthetic-meter-only';

insert into cases values('rollback',free_meter_fixture.new_request());
select throws_ok(format('select public.reconcile_vendor_quote_offers(%L::uuid,%L::jsonb,%L::jsonb)',
 free_meter_fixture.result_id(request_id),free_meter_fixture.result_payload(),
 jsonb_set(free_meter_fixture.offers(request_id),'{0,supplier}','null'::jsonb)),
 '23502',null,'invalid canonical offer rolls back entire write') from cases where name='rollback';
select is((select status::text from public.vendor_quote_results where id=free_meter_fixture.result_id((select request_id from cases where name='rollback'))),'queued','failed offer mutation rolls back parent status');
select is((select state from private.quote_access_admissions where quote_request_id=(select request_id from cases where name='rollback')),'reserved','failed offer write retains hold');
select throws_ok($$update private.quote_access_admissions set admission_source='commercial_entitlement' where state='reserved'$$,'P0001','quote_access_admission_immutable','admitted source cannot be rewritten');
select is((select count(*)::integer from public.spend_ledger where organization_id=(select organization_id from free_meter_fixture.context)),
 (select count(*)::integer from free_meter_fixture.spend_before),'all known and pending attempted-spend rows survive quota outcomes');
select ok(not exists(select 1 from free_meter_fixture.spend_before expected left join public.spend_ledger actual on actual.id=expected.id
 where to_jsonb(actual) is distinct from expected.original_row),'success failure cancellation preserve exact costs settlement state and lineage');
select * from finish();
rollback;
