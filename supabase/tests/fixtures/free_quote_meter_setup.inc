-- Synthetic fixture only; execute in an isolated disposable database.
create schema free_meter_fixture;
create function free_meter_fixture.set_identity(p_user_id uuid)
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

create table free_meter_fixture.context (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  approval_reference uuid not null,
  scope_fingerprint text,
  rollback_scope_fingerprint text,
  quote_run_id uuid
);

insert into free_meter_fixture.context values (
  '00000000-0000-4000-8000-000000008811',
  '00000000-0000-4000-8000-000000008812',
  '00000000-0000-4000-8000-000000008813',
  '00000000-0000-4000-8000-000000008814',
  '00000000-0000-4000-8000-000000008815',
  null,
  null,
  null
);

grant select, update on free_meter_fixture.context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (
  (select user_id from free_meter_fixture.context),
  'authenticated',
  'authenticated',
  'free-meter-member@example.test',
  timezone('utc', now())
);

insert into public.organizations (id, name, slug)
values (
  (select organization_id from free_meter_fixture.context),
  'Free meter Dispatch',
  'free-meter-dispatch'
);

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client'
from free_meter_fixture.context;

-- This dispatch fixture starts after an administrator confirmed its destination.
update public.organizations set shipping_same_as_billing=false, shipping_street='123 Fixture Ave',
  shipping_city='Tucson', shipping_state='AZ', shipping_zip='85701', shipping_country='US'
where id=(select organization_id from free_meter_fixture.context);
insert into private.sourcing_destination_history (organization_id, state, address)
select organization_id, 'confirmed', private.effective_sourcing_address(organization_id) from free_meter_fixture.context;

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'Free-meter local pgTAP fixture'
where capability = 'automatic_quote_collection'; -- NOSONAR: canonical rollout capability fixture is exercised across preflight states

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select job_id, organization_id, user_id, 'Free-meter validation part',
  'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote' -- NOSONAR: deterministic quote-envelope fixture
from free_meter_fixture.context;

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select '00000000-0000-4000-8000-000000008821', organization_id, user_id, -- NOSONAR: deterministic fixture identifier
  'Free-meter rollback part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote'
from free_meter_fixture.context;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select
  '00000000-0000-4000-8000-000000008816', organization_id,
  repeat('a', 64), repeat('a', 64), 'job-files', -- NOSONAR: deterministic trusted-file hash and bucket fixture
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step', -- NOSONAR: deterministic trusted storage path
  100, 'application/step' -- NOSONAR: canonical STEP MIME fixture
from free_meter_fixture.context;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select
  '00000000-0000-4000-8000-000000008817', job_id, organization_id, -- NOSONAR: deterministic fixture identifier
  user_id, '00000000-0000-4000-8000-000000008816', repeat('a', 64),
  repeat('a', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step',
  'part.step', 'part', 'cad', 'application/step', 100
from free_meter_fixture.context;

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
)
select part_id, job_id, organization_id, 'Validation part', 'validation-part',
  '00000000-0000-4000-8000-000000008817', 1
from free_meter_fixture.context;

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select part_id, organization_id, user_id, '6061-T6 Aluminum', 'As machined', -- NOSONAR: canonical controlled-beta material and finish fixture
  0.0050, 1, array[1], array['xometry']::public.vendor_name[], -- NOSONAR: canonical tolerance, quantity, provider, and transport-scale fixture
  '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb -- NOSONAR: canonical process and transport-scale fixture
from free_meter_fixture.context;


-- Synthetic fixtures only: no production allowance or enrollment selected.
insert into private.founding_beta_enrollment_events(organization_id,actor_user_id,action,reason,policy_revision,terms_path,privacy_path,idempotency_key)
select organization_id,user_id,'grant','free access fixture','founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy','free-access-grant' from free_meter_fixture.context;
insert into private.founding_beta_notice_acceptances(organization_id,user_id,policy_revision,terms_path,privacy_path)
select organization_id,user_id,'founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy' from free_meter_fixture.context;
insert into public.org_vendor_configs(organization_id,vendor,enabled_for_client_quote_requests)
select organization_id,'xometry',true from free_meter_fixture.context;


-- Keep the pre-existing request/spend guards enabled; explicit larger fixture
-- settings let this one SQL test exercise independent cases without choosing a
-- production allowance or removing any admission check.
insert into public.quote_request_guardrails(organization_id,user_max_requests_per_window,org_pending_cost_ceiling_usd)
select organization_id,100,100000 from free_meter_fixture.context;
insert into private.free_quote_policies(revision,enabled,subject_kind,completed_limit,window_start,window_end)
values ('synthetic-meter-only',true,'organization',:meter_fixture_limit,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour');

create table free_meter_fixture.spend_before(id uuid primary key, original_row jsonb not null);

create function free_meter_fixture.new_request()
returns uuid language plpgsql as $$
declare
 v_user uuid; v_org uuid; v_job uuid:=gen_random_uuid(); v_part uuid:=gen_random_uuid();
 v_file uuid:=gen_random_uuid(); v_scope jsonb; v_response jsonb;
begin
 select user_id,organization_id into v_user,v_org from free_meter_fixture.context;
 perform free_meter_fixture.set_identity(v_user);
 insert into public.jobs(id,organization_id,created_by,title,status,requested_service_kinds,primary_service_kind)
 values(v_job,v_org,v_user,'Synthetic meter case','ready_to_quote',array['manufacturing_quote'],'manufacturing_quote');
 insert into public.job_files(id,job_id,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,
 storage_bucket,storage_path,original_name,normalized_name,file_kind,mime_type,size_bytes)
 select v_file,v_job,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,
 storage_bucket,storage_path,'case.step','case','cad',mime_type,size_bytes from public.job_files
 where id='00000000-0000-4000-8000-000000008817';
 insert into public.parts(id,job_id,organization_id,name,normalized_key,cad_file_id,quantity)
 values(v_part,v_job,v_org,'Meter part','meter-part',v_file,1);
 insert into public.approved_part_requirements(part_id,organization_id,approved_by,material,finish,
 tightest_tolerance_inch,quantity,quote_quantities,applicable_vendors,spec_snapshot)
 values(v_part,v_org,v_user,'6061-T6 Aluminum','As machined',0.005,1,array[1],array['xometry']::public.vendor_name[],
 '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb);
 v_scope:=public.api_get_xometry_beta_dispatch_scope(v_job,'inch');
 v_response:=public.api_request_xometry_beta_dispatch(v_job,'inch',v_scope->>'scopeFingerprint',
 'founding-beta-2026-08-15',gen_random_uuid(),true,true,true);
 if (v_response->>'accepted')::boolean is not true then raise exception 'fixture admission failed: %',v_response->>'reasonCode'; end if;
 -- Synthetic accounting observations, not charges: prove quota outcomes never
 -- discard attempted known or unresolved spend for this exact run.
 with inserted as (
   insert into public.spend_ledger(organization_id,category,amount_usd,settled,settled_at,job_id,quote_run_id,metadata)
   values (v_org,'vendor_automation',0.025,true,clock_timestamp(),v_job,(v_response->>'quoteRunId')::uuid,'{"fixture":"free-meter-known"}'::jsonb),
          (v_org,'llm_extraction',0.5,false,null,v_job,(v_response->>'quoteRunId')::uuid,'{"fixture":"free-meter-pending"}'::jsonb)
   returning *
 ) insert into free_meter_fixture.spend_before select id,to_jsonb(inserted) from inserted;
 return (v_response->>'quoteRequestId')::uuid;
end;
$$;
create function free_meter_fixture.result_id(p_request uuid)
returns uuid language sql as $$ select vendor_quote_result_id from private.xometry_beta_dispatch_permits where quote_request_id=p_request $$;
create function free_meter_fixture.offers(p_request uuid,p_price numeric default 12,p_valid_until timestamptz default clock_timestamp()+interval '1 day',p_provenance text default 'trusted_adapter')
returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('vendor_quote_result_id',permit.vendor_quote_result_id,
 'organization_id',permit.organization_id,'offer_key','fixture-offer','supplier','Xometry','lane_label','Fixture',
 'geographic_origin','unknown','quoted_at',clock_timestamp()-interval '1 minute','valid_until',p_valid_until,
 'validity_source','vendor_date','provenance_status',p_provenance,'unit_price_usd',p_price,'total_price_usd',p_price,
 'sort_rank',0,'raw_payload','{}'::jsonb)) from private.xometry_beta_dispatch_permits permit where quote_request_id=p_request
$$;
create function free_meter_fixture.result_payload(p_status text default 'instant_quote_received')
returns jsonb language sql as $$ select jsonb_build_object('status',p_status,'unit_price_usd',12,'total_price_usd',12,
 'notes','[]'::jsonb,'dfm_issues','[]'::jsonb,'raw_payload','{}'::jsonb) $$;
