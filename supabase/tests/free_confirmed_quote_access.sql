begin;

select no_plan();

create function pg_temp.set_free_access_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated', -- NOSONAR: repeated authenticated JWT fixture claim
      'aal', 'aal1'
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

-- Exact fixture-only permission, rolled back with this suite. Do not depend on
-- native image defaults or broaden production helper grants for role tests.
grant execute on function pg_temp.set_free_access_identity(uuid) to authenticated;

create temporary table free_access_context (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  approval_reference uuid not null,
  scope_fingerprint text,
  rollback_scope_fingerprint text,
  quote_run_id uuid
) on commit drop;

insert into free_access_context values (
  '00000000-0000-4000-8000-000000003671',
  '00000000-0000-4000-8000-000000003672',
  '00000000-0000-4000-8000-000000003673',
  '00000000-0000-4000-8000-000000003674',
  '00000000-0000-4000-8000-000000003675',
  null,
  null,
  null
);

grant select, update on free_access_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (
  (select user_id from free_access_context),
  'authenticated',
  'authenticated',
  'ovd367-member@example.test',
  timezone('utc', now())
);

insert into public.organizations (id, name, slug)
values (
  (select organization_id from free_access_context),
  'OVD 367 Dispatch',
  'ovd-367-dispatch'
);

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client'
from free_access_context;

-- This dispatch fixture starts after an administrator confirmed its destination.
update public.organizations set shipping_same_as_billing=false, shipping_street='123 Fixture Ave',
  shipping_city='Tucson', shipping_state='AZ', shipping_zip='85701', shipping_country='US'
where id=(select organization_id from free_access_context);
insert into private.sourcing_destination_history (organization_id, state, address)
select organization_id, 'confirmed', private.effective_sourcing_address(organization_id) from free_access_context;

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'OVD-367 local pgTAP fixture'
where capability = 'automatic_quote_collection'; -- NOSONAR: canonical rollout capability fixture is exercised across preflight states

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select job_id, organization_id, user_id, 'OVD-367 validation part',
  'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote' -- NOSONAR: deterministic quote-envelope fixture
from free_access_context;

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select '00000000-0000-4000-8000-000000003681', organization_id, user_id, -- NOSONAR: deterministic fixture identifier
  'OVD-367 rollback part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote'
from free_access_context;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select
  '00000000-0000-4000-8000-000000003676', organization_id,
  repeat('a', 64), repeat('a', 64), 'job-files', -- NOSONAR: deterministic trusted-file hash and bucket fixture
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step', -- NOSONAR: deterministic trusted storage path
  100, 'application/step' -- NOSONAR: canonical STEP MIME fixture
from free_access_context;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select
  '00000000-0000-4000-8000-000000003677', job_id, organization_id, -- NOSONAR: deterministic fixture identifier
  user_id, '00000000-0000-4000-8000-000000003676', repeat('a', 64),
  repeat('a', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step',
  'part.step', 'part', 'cad', 'application/step', 100
from free_access_context;

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
)
select part_id, job_id, organization_id, 'Validation part', 'validation-part',
  '00000000-0000-4000-8000-000000003677', 1
from free_access_context;

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select part_id, organization_id, user_id, '6061-T6 Aluminum', 'As machined', -- NOSONAR: canonical controlled-beta material and finish fixture
  0.0050, 1, array[1], array['xometry']::public.vendor_name[], -- NOSONAR: canonical tolerance, quantity, provider, and transport-scale fixture
  '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb -- NOSONAR: canonical process and transport-scale fixture
from free_access_context;


-- Synthetic fixtures only: no production allowance or enrollment selected.
insert into private.founding_beta_enrollment_events(organization_id,actor_user_id,action,reason,policy_revision,terms_path,privacy_path,idempotency_key)
select organization_id,user_id,'grant','free access fixture','founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy','free-access-grant' from free_access_context;
insert into private.founding_beta_notice_acceptances(organization_id,user_id,policy_revision,terms_path,privacy_path)
select organization_id,user_id,'founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy' from free_access_context;
insert into public.org_vendor_configs(organization_id,vendor,enabled_for_client_quote_requests)
select organization_id,'xometry',true from free_access_context;

select ok(has_function_privilege('authenticated','public.api_get_quote_access(uuid)','execute'),'authenticated read RPC exposed');
select ok(not has_function_privilege('anon','public.api_get_quote_access(uuid)','execute'),'anonymous read denied');
select ok(not has_function_privilege('authenticated','private.resolve_quote_access_for_permit(uuid,uuid,uuid)','execute'),'binding context not client callable');
select ok(not has_function_privilege('authenticated','private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)','execute'),'private scope seam not client callable');

set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select is(public.api_get_quote_access((select job_id from free_access_context))->>'reasonCode','free_policy_unavailable','unset free policy fails closed');
reset role;
insert into private.free_quote_policies(revision,enabled,subject_kind,completed_limit,window_start,window_end)
values ('synthetic-access-only',true,'organization',1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '15 seconds');
set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select is(public.api_get_quote_access((select job_id from free_access_context))->>'source','free_beta','free access without Pro');
select is(public.api_get_quote_access((select job_id from free_access_context))->>'schema','quote-access.v1','frozen schema');
select is(public.api_get_quote_access((select job_id from free_access_context))->>'actorUserId',(select user_id::text from free_access_context),'verified actor echoed');
select is(public.api_get_quote_access((select job_id from free_access_context))->>'organizationId',(select organization_id::text from free_access_context),'actual job organization echoed');
select is((public.api_get_quote_access((select job_id from free_access_context))->>'state'),'eligible','policy eligible');
update free_access_context set scope_fingerprint=public.api_get_xometry_beta_dispatch_scope(job_id,'inch')->>'scopeFingerprint';
select throws_ok(format($$select public.api_request_xometry_beta_dispatch(%L::uuid,'inch',%L,'founding-beta-2026-08-15',%L::uuid,false,true,true)$$,
 (select job_id from free_access_context),(select scope_fingerprint from free_access_context),(select approval_reference from free_access_context)),
 'P0001','All Xometry beta dispatch affirmations are required.','free preserves explicit customer affirmation');
select is(public.api_request_xometry_beta_dispatch(job_id,'inch',scope_fingerprint,'founding-beta-2026-08-15',approval_reference,true,true,true)->>'accepted','true','confirmed free admission succeeds') from free_access_context;
select is(public.api_get_quote_access((select job_id from free_access_context))->>'state','eligible','full capacity does not change policy eligibility');
select is(public.api_request_xometry_beta_dispatch(job_id,'inch',scope_fingerprint,'founding-beta-2026-08-15',approval_reference,true,true,true)->>'deduplicated','true','same approval replay at last held slot') from free_access_context;
reset role;
select is((select count(*)::integer from private.quote_access_admissions),1,'one admission receipt');
select is((select count(*)::integer from private.organization_entitlement_grants where organization_id=(select organization_id from free_access_context)),0,'free path creates no commercial grant');
select is((select state from private.quote_access_admissions),'reserved','capacity held until usable quote');
select is((select count(*)::integer from public.work_queue where task_type='run_vendor_quote' and job_id=(select job_id from free_access_context)),1,'replay creates no extra task');
select is(private.require_automatic_quote_access((select job_id from free_access_context))->>'reasonCode','pro_required','generic automatic guard remains commercial only');

-- Keep one pinned hold across original expiry; new eligibility becomes blocked.
-- Bounded at 15 seconds from policy creation. No production clock alteration.
select pg_sleep(greatest(0,extract(epoch from ((select window_end from private.free_quote_policies where revision='synthetic-access-only')-clock_timestamp())))+0.01);
set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select is(public.api_get_quote_access((select job_id from free_access_context))->>'reasonCode','free_policy_unavailable','new policy expires');
select is(public.api_request_xometry_beta_dispatch(job_id,'inch',scope_fingerprint,'founding-beta-2026-08-15',approval_reference,true,true,true)->>'deduplicated','true','pinned replay after original window expiry') from free_access_context;
reset role;

create temporary table free_worker_args as
select permit.work_queue_task_id task_id,permit.vendor_quote_result_id result_id,lane.scope_snapshot snapshot,clock_timestamp() claimed_at
from private.xometry_beta_dispatch_permits permit join public.quote_request_lanes lane on lane.id=permit.quote_request_lane_id;
grant select on free_worker_args to service_role;
update public.work_queue set status='running',locked_by='synthetic-free-worker',locked_at=(select claimed_at from free_worker_args)
where id=(select task_id from free_worker_args);
update public.vendor_quote_results set status='running' where id=(select result_id from free_worker_args);
set local role service_role;
select is(public.api_authorize_xometry_beta_worker_dispatch(task_id,result_id,snapshot,'synthetic-free-worker',claimed_at)->>'authorized','true','worker executes its pinned held slot after window expiry') from free_worker_args;
reset role;

-- Fixture-only terminal receipt proves historical validity never grants execution.
update private.quote_access_admissions set state='released',terminal_at=clock_timestamp(),outcome_reason='failed';
set local role service_role;
select is(public.api_authorize_xometry_beta_worker_dispatch(task_id,result_id,snapshot,'synthetic-free-worker',claimed_at)->>'authorized','false','terminal receipt cannot authorize another execution') from free_worker_args;
reset role;
set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select is(public.api_request_xometry_beta_dispatch(job_id,'inch',scope_fingerprint,'founding-beta-2026-08-15',approval_reference,true,true,true)->>'deduplicated','true','terminal replay only acknowledges same receipt') from free_access_context;
reset role;
select is((select count(*)::integer from public.work_queue where task_type='run_vendor_quote' and job_id=(select job_id from free_access_context)),1,'terminal replay creates no task');
update private.free_quote_policies set enabled=false where revision='synthetic-access-only';
set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select throws_ok(format($$select public.api_request_xometry_beta_dispatch(%L::uuid,'inch',%L,'founding-beta-2026-08-15',%L::uuid,true,true,true)$$,
 (select job_id from free_access_context),(select scope_fingerprint from free_access_context),(select approval_reference from free_access_context)),
 'P0001','free_policy_unavailable','disabled original policy blocks replay authorization');
reset role;

insert into private.organization_entitlement_grants(organization_id,grant_type,starts_at,review_at,grant_reason,granted_by_user_id)
select organization_id,'complimentary',clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days','synthetic commercial regression',user_id from free_access_context;
set local role authenticated;
select pg_temp.set_free_access_identity((select user_id from free_access_context));
select is(public.api_get_quote_access((select job_id from free_access_context))->>'source','commercial_entitlement','manual grant stays honest commercial source');
select is(public.api_get_quote_access((select job_id from free_access_context))->>'policyRevision',null::text,'commercial source no free policy revision');
select throws_ok(format($$select public.api_request_xometry_beta_dispatch(%L::uuid,'inch',%L,'founding-beta-2026-08-15',%L::uuid,true,true,true)$$,
 (select job_id from free_access_context),(select scope_fingerprint from free_access_context),(select approval_reference from free_access_context)),
 'P0001','free_policy_unavailable','paid upgrade cannot bypass originally free disabled policy');
reset role;
insert into auth.users(id,aud,role,email,email_confirmed_at) values ('00000000-0000-4000-8000-000000003690','authenticated','authenticated','free-outsider@example.test',clock_timestamp());
set local role authenticated;
select pg_temp.set_free_access_identity('00000000-0000-4000-8000-000000003690');
select throws_ok(format('select public.api_get_quote_access(%L::uuid)',(select job_id from free_access_context)),'P0001','quote_access_not_authorized','cross-organization access denied');
reset role;
select * from finish();
rollback;
