-- AUTHORED, NOT EXECUTED. Only the reviewed isolated fixture runner may run this
-- source: exclusive UUID/owner/source-labelled network-none container, owned Unix
-- socket, postgres identity, unchanged hash-bound stdin. No dblink or auth edits.
-- Every session independently bounds statements, lock waits, and idle transactions.
\set ON_ERROR_STOP on
set statement_timeout='10s';
set lock_timeout='6s';
set idle_in_transaction_session_timeout='20s';
set search_path=public,extensions,pg_catalog;
do $$ begin
 if current_user <> 'postgres' or current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'Only the reviewed postgres READ COMMITTED fixture runner is supported';
 end if;
 if exists(select 1 from private.quote_access_admissions)
   or exists(select 1 from private.free_quote_policies)
   or exists(select 1 from private.free_quote_buckets)
   or exists(select 1 from private.xometry_beta_dispatch_permits)
   or exists(select 1 from public.jobs) or exists(select 1 from public.spend_ledger)
   or exists(select 1 from auth.users) or to_regnamespace('free_meter_fixture') is not null then
   raise exception 'Requires pristine fixture after rollback-only suites; never reset existing rows';
 end if;
 if to_regprocedure('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)') is null
   or not exists(select 1 from pg_extension where extname='pgtap') then
   raise exception 'Full reviewed schema and pgTAP are required';
 end if;
end $$;
begin;
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
values ('synthetic-meter-only',true,'organization',2,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour');

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

-- Everything below is fixture-only and SECURITY INVOKER. Protected business
-- operations still execute under their actual authenticated/service_role role.
create table free_meter_fixture.race_cases (
 name text primary key,request_id uuid,job_id uuid not null,receipt_id uuid,result_id uuid,task_id uuid
);
create table free_meter_fixture.current_race (
 singleton boolean primary key default true check(singleton),name text not null,kind text not null,
 isolation_level text not null,constraints_mode text not null,acquire_role text not null,contender_role text not null,
 acquire_sql text not null,contender_sql text not null,probe_sql text,
 before_receipts integer not null,before_spend integer not null,before_consumed integer not null,
 expected_new_receipts integer not null,done boolean not null default false
);
create table free_meter_fixture.race_outcomes (
 case_name text not null,actor text not null,response jsonb not null,primary key(case_name,actor)
);
create table free_meter_fixture.receipts_before(id uuid primary key,identity_row jsonb not null);
create table free_meter_fixture.permits_before(id uuid primary key,original_row jsonb not null);
create table free_meter_fixture.terminals_before(id uuid primary key,original_row jsonb not null);

create function free_meter_fixture.capture(p_sql text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare v_response jsonb;
begin
 execute p_sql into v_response;
 return coalesce(v_response,'{}'::jsonb)||jsonb_build_object('sqlstate','00000');
exception when others then
 return jsonb_build_object('error',sqlerrm,'sqlstate',sqlstate);
end $$;
create function free_meter_fixture.complete(p_result uuid,p_payload jsonb,p_offers jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform public.reconcile_vendor_quote_offers(p_result,p_payload,p_offers);
 return jsonb_build_object('completed',true);
end $$;
-- Discard the settling RPC response inside the caller. This models an unknown
-- client outcome without pretending that a real transport connection was lost.
create function free_meter_fixture.discard_sweep(p_after uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform public.api_reconcile_terminal_free_quote_tasks(p_after,1);
 return jsonb_build_object('discarded',true);
end $$;
create function free_meter_fixture.confirm(p_job uuid,p_approval uuid,p_scope text) returns jsonb
language sql security invoker set search_path=pg_catalog as $$
 select public.api_request_xometry_beta_dispatch(p_job,'inch',p_scope,
  'founding-beta-2026-08-15',p_approval,true,true,true)
$$;
create function free_meter_fixture.remember() returns void language plpgsql as $$
begin
 insert into free_meter_fixture.receipts_before
  select id,to_jsonb(a)-array['state','terminal_at','outcome_reason','qualifying_offer_id','qualifying_evidence']
  from private.quote_access_admissions a on conflict do nothing;
 insert into free_meter_fixture.permits_before
  select id,to_jsonb(p) from private.xometry_beta_dispatch_permits p on conflict do nothing;
 insert into free_meter_fixture.terminals_before
  select id,to_jsonb(a) from private.quote_access_admissions a where state in('consumed','released') on conflict do nothing;
 insert into free_meter_fixture.spend_before
  select id,to_jsonb(s) from public.spend_ledger s on conflict do nothing;
end $$;
create function free_meter_fixture.register_request(p_name text,p_request uuid) returns void language plpgsql as $$
declare v_row private.quote_access_admissions%rowtype;
begin
 select * into strict v_row from private.quote_access_admissions where quote_request_id=p_request;
 insert into free_meter_fixture.race_cases
  select p_name,v_row.quote_request_id,v_row.job_id,v_row.id,p.vendor_quote_result_id,p.work_queue_task_id
  from private.xometry_beta_dispatch_permits p where p.id=v_row.permit_id
  on conflict(name) do update set request_id=excluded.request_id,receipt_id=excluded.receipt_id,
   result_id=excluded.result_id,task_id=excluded.task_id;
 if not exists(select 1 from public.spend_ledger where quote_run_id=v_row.quote_run_id) then
  insert into public.spend_ledger(organization_id,category,amount_usd,settled,settled_at,job_id,quote_run_id,metadata)
   values(v_row.organization_id,'vendor_automation',0.025,true,clock_timestamp(),v_row.job_id,v_row.quote_run_id,'{"fixture":"lifecycle-known"}'),
    (v_row.organization_id,'llm_extraction',0.5,false,null,v_row.job_id,v_row.quote_run_id,'{"fixture":"lifecycle-pending"}');
 end if;
 perform free_meter_fixture.remember();
end $$;
create function free_meter_fixture.prepare_case(p_name text,p_failed boolean default true) returns void language plpgsql as $$
declare v_request uuid:=free_meter_fixture.new_request();
begin
 perform free_meter_fixture.register_request(p_name,v_request);
 if p_failed then
  update public.work_queue set status='failed',locked_at=null,locked_by=null,last_error='synthetic_queue_commit'
   where id=(select task_id from free_meter_fixture.race_cases where name=p_name);
 end if;
end $$;
create function free_meter_fixture.prepare_job(p_name text) returns void language plpgsql as $$
declare v_job uuid:=gen_random_uuid();v_file uuid:=gen_random_uuid();v_part uuid:=gen_random_uuid();v_user uuid;v_org uuid;
begin
 select user_id,organization_id into strict v_user,v_org from free_meter_fixture.context;
 insert into public.jobs(id,organization_id,created_by,title,status,requested_service_kinds,primary_service_kind)
  values(v_job,v_org,v_user,'Synthetic lifecycle race','ready_to_quote',array['manufacturing_quote'],'manufacturing_quote');
 insert into public.job_files(id,job_id,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,
  storage_bucket,storage_path,original_name,normalized_name,file_kind,mime_type,size_bytes)
  select v_file,v_job,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,
   storage_bucket,storage_path,'race.step','race','cad',mime_type,size_bytes
   from public.job_files where id='00000000-0000-4000-8000-000000008817';
 insert into public.parts(id,job_id,organization_id,name,normalized_key,cad_file_id,quantity)
  values(v_part,v_job,v_org,'Synthetic race part','race-part',v_file,1);
 insert into public.approved_part_requirements(part_id,organization_id,approved_by,material,finish,
  tightest_tolerance_inch,quantity,quote_quantities,applicable_vendors,spec_snapshot)
  values(v_part,v_org,v_user,'6061-T6 Aluminum','As machined',0.005,1,array[1],array['xometry']::public.vendor_name[],
   '{"process":"CNC milling","tightestToleranceInch":0.0050}');
 insert into free_meter_fixture.race_cases(name,job_id) values(p_name,v_job);
end $$;
create function free_meter_fixture.sweep_sql(p_name text) returns text language plpgsql as $$
declare v_id uuid;v_previous uuid;
begin
 select receipt_id into strict v_id from free_meter_fixture.race_cases where name=p_name;
 select id into v_previous from private.quote_access_admissions where state='reserved' and id<v_id order by id desc limit 1;
 return format('select public.api_reconcile_terminal_free_quote_tasks(%L::uuid,1)',v_previous);
end $$;
create function free_meter_fixture.complete_sql(p_name text) returns text language sql as $$
 select format('select free_meter_fixture.complete(%L::uuid,%L::jsonb,%L::jsonb)',result_id,
  free_meter_fixture.result_payload(),free_meter_fixture.offers(request_id))
 from free_meter_fixture.race_cases where name=p_name
$$;
create function free_meter_fixture.cancel_sql(p_name text) returns text language sql as $$
 select format('select public.api_cancel_quote_request(%L::uuid)',request_id)
 from free_meter_fixture.race_cases where name=p_name
$$;
create function free_meter_fixture.confirm_sql(p_name text) returns text language plpgsql as $$
declare v_job uuid;v_scope jsonb;
begin
 select job_id into strict v_job from free_meter_fixture.race_cases where name=p_name;
 perform free_meter_fixture.set_identity((select user_id from free_meter_fixture.context));
 v_scope:=public.api_get_xometry_beta_dispatch_scope(v_job,'inch');
 return format('select free_meter_fixture.confirm(%L::uuid,%L::uuid,%L)',v_job,gen_random_uuid(),v_scope->>'scopeFingerprint');
end $$;

-- Fixture-owner helper selects LOWER-privilege roles for verify-time real API
-- calls, then restores the original fixture role. No SECURITY DEFINER or grants
-- on application tables are added. Clients cannot execute this helper.
create function free_meter_fixture.set_caller_identity(p_role text) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if p_role='authenticated' then
  perform free_meter_fixture.set_identity((select user_id from free_meter_fixture.context));
 elsif p_role in('service_role','postgres') then
  perform set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role',p_role,true);
 else raise exception 'Unknown fixture caller role';
 end if;
end $$;
create function free_meter_fixture.as_role(p_role text,p_sql text) returns jsonb language plpgsql security invoker as $$
declare v_response jsonb;
begin
 if current_user<>'postgres' or p_role not in('authenticated','service_role') then
  raise exception 'Fixture owner and exact caller role required';
 end if;
 perform free_meter_fixture.set_caller_identity(p_role);
 execute format('set local role %I',p_role);
 v_response:=free_meter_fixture.capture(p_sql);
 execute 'reset role';
 return v_response;
end $$;

create function free_meter_fixture.prepare_race(p_name text,p_kind text,p_isolation text,p_constraints text)
returns void language plpgsql as $$
declare v_main free_meter_fixture.race_cases%rowtype;v_second free_meter_fixture.race_cases%rowtype;
 v_acquire text;v_contend text;v_probe text;v_arole text:='service_role';v_crole text:='service_role';
 v_receipts integer;v_spend integer;v_consumed integer;v_new integer:=1;v_first_name text;
begin
 if exists(select 1 from free_meter_fixture.current_race where not done) then raise exception 'Prior race not verified';end if;
 if p_isolation not in('read committed','repeatable read','serializable') or p_constraints not in('immediate','deferred') then
  raise exception 'Unknown race options';end if;
 if exists(select 1 from private.quote_access_admissions where state='reserved') then raise exception 'Prior hold not drained';end if;
 select count(*) into v_receipts from private.quote_access_admissions;
 select count(*) into v_spend from public.spend_ledger;
 select count(*) into v_consumed from private.quote_access_admissions where state='consumed';
 if p_kind in('meter-replay','meter-last-slot') then
  if v_consumed<>0 then raise exception 'Meter races must run before consumed cases';end if;
  perform free_meter_fixture.prepare_case(p_name||'-filler',false);
  perform free_meter_fixture.prepare_job(p_name);
  v_acquire:=free_meter_fixture.confirm_sql(p_name);
  if p_kind='meter-replay' then v_contend:=v_acquire;
  else
   perform free_meter_fixture.prepare_job(p_name||'-denied');
   v_contend:=free_meter_fixture.confirm_sql(p_name||'-denied');
  end if;
  v_arole:='authenticated';v_crole:='authenticated';v_new:=2;
 elsif p_kind in('admission-delete','delete-admission') then
  perform free_meter_fixture.prepare_job(p_name);
  select * into strict v_main from free_meter_fixture.race_cases where name=p_name;
  if p_kind='admission-delete' then
   v_acquire:=free_meter_fixture.confirm_sql(p_name);v_arole:='authenticated';v_crole:='postgres';
   v_contend:=format('delete from public.jobs where id=%L::uuid returning jsonb_build_object(''deleted'',id)',v_main.job_id);
  else
   v_acquire:=format('delete from public.jobs where id=%L::uuid returning jsonb_build_object(''deleted'',id)',v_main.job_id);
   v_contend:=free_meter_fixture.confirm_sql(p_name);v_arole:='postgres';v_crole:='authenticated';v_new:=0;
   v_probe:=format('select jsonb_build_object(''locked'',%L::uuid,''remaining'',(select count(*) from (select 1 from public.jobs where id=%L::uuid for update) target))',v_main.job_id,v_main.job_id);
  end if;
 else
  perform free_meter_fixture.prepare_case(p_name);
  select * into strict v_main from free_meter_fixture.race_cases where name=p_name;
  if p_kind='sweep-success' then v_acquire:=free_meter_fixture.sweep_sql(p_name);v_contend:=free_meter_fixture.complete_sql(p_name);
  elsif p_kind='sweep-cancel' then
   v_acquire:=free_meter_fixture.sweep_sql(p_name);v_contend:=free_meter_fixture.cancel_sql(p_name);v_crole:='authenticated';
  elsif p_kind='success-sweep' then
   v_acquire:=free_meter_fixture.complete_sql(p_name);v_contend:=free_meter_fixture.sweep_sql(p_name);
   v_probe:=format('select jsonb_build_object(''locked'',id) from public.vendor_quote_results where id=%L::uuid for update',v_main.result_id);
  elsif p_kind='cancel-sweep' then
   v_acquire:=free_meter_fixture.cancel_sql(p_name);v_arole:='authenticated';v_contend:=free_meter_fixture.sweep_sql(p_name);
   v_probe:=format('select jsonb_build_object(''locked'',id) from public.quote_requests where id=%L::uuid for update',v_main.request_id);
  elsif p_kind='revival' then
   v_arole:='postgres';
   v_acquire:=format('update public.work_queue set status=''running'',locked_by=''synthetic-reclaimer'',locked_at=clock_timestamp() where id=%L::uuid returning jsonb_build_object(''revived'',id)',v_main.task_id);
   v_contend:=free_meter_fixture.sweep_sql(p_name);
   v_probe:=format('select jsonb_build_object(''locked'',id) from public.work_queue where id=%L::uuid for update',v_main.task_id);
  elsif p_kind='two-sweepers' then
   perform free_meter_fixture.prepare_case(p_name||'-second');v_new:=2;
   select * into strict v_main from free_meter_fixture.race_cases where name in(p_name,p_name||'-second') order by receipt_id limit 1;
   v_acquire:=free_meter_fixture.sweep_sql(v_main.name);v_contend:=v_acquire;
   v_probe:=format('select jsonb_build_object(''locked'',id) from public.vendor_quote_results where id=%L::uuid for update',v_main.result_id);
  else raise exception 'Unknown race kind %',p_kind;
  end if;
 end if;
 delete from free_meter_fixture.current_race;
 insert into free_meter_fixture.current_race(name,kind,isolation_level,constraints_mode,acquire_role,contender_role,
  acquire_sql,contender_sql,probe_sql,before_receipts,before_spend,before_consumed,expected_new_receipts)
 values(p_name,p_kind,p_isolation,p_constraints,v_arole,v_crole,v_acquire,v_contend,v_probe,v_receipts,v_spend,v_consumed,v_new);
 perform free_meter_fixture.remember();
end $$;

create function free_meter_fixture.require_acquired(p_response jsonb) returns void language plpgsql as $$
declare v_race free_meter_fixture.current_race%rowtype;v_expected text;
begin
 select * into strict v_race from free_meter_fixture.current_race;
 if p_response->>'sqlstate' is distinct from '00000' then raise exception 'Acquire failed: %',p_response;end if;
 v_expected:=case v_race.kind
  when 'success-sweep' then p_response->>'completed'
  when 'cancel-sweep' then p_response->>'canceled'
  when 'sweep-success' then ((p_response->>'reconciled')='1')::text
  when 'sweep-cancel' then ((p_response->>'reconciled')='1')::text
  when 'two-sweepers' then ((p_response->>'reconciled')='1')::text
  when 'revival' then (p_response ? 'revived')::text
  when 'delete-admission' then (p_response ? 'deleted')::text
  else p_response->>'accepted' end;
 if v_expected is distinct from 'true' then raise exception 'Acquire did not establish expected operation: %',p_response;end if;
 if v_race.kind in('meter-replay','meter-last-slot','admission-delete') then
  perform free_meter_fixture.register_request(v_race.name,(p_response->>'quoteRequestId')::uuid);
 end if;
 insert into free_meter_fixture.race_outcomes values(v_race.name,'coordinator',p_response);
 perform free_meter_fixture.remember();
end $$;
create function free_meter_fixture.assert_contender(p_response jsonb) returns setof text language plpgsql as $$
declare v_race free_meter_fixture.current_race%rowtype;v_first uuid;
begin
 select * into strict v_race from free_meter_fixture.current_race;
 return next diag(v_race.name||': contender response '||p_response::text);
 if v_race.kind='sweep-success' then
  return next is(p_response->>'sqlstate','P0001',v_race.name||': late canonical SQLSTATE');
  return next is(p_response->>'error','free_quote_terminal_fenced',v_race.name||': late canonical fenced');
 elsif v_race.kind='sweep-cancel' then
  return next is(p_response->>'sqlstate','00000',v_race.name||': cancellation completed after wait');
  return next is(p_response->>'reasonCode','not_cancelable',v_race.name||': cancellation observes terminal failure');
 elsif v_race.kind='admission-delete' then
  return next is(p_response->>'sqlstate',case when v_race.isolation_level='read committed' then 'P0001' else '40001' end,v_race.name||': delete exact isolation outcome');
  if v_race.isolation_level='read committed' then
   return next is(p_response->>'error','free_quote_reservation_unresolved',v_race.name||': fresh trigger query observes reserved admission');
  end if;
 elsif v_race.kind='delete-admission' then
  -- OVD-598: admission takes its job-row lock FOR SHARE NOWAIT before
  -- validation, so it fails fast on the uncommitted DELETE's row lock, before
  -- any insert and before the coordinator releases.
  return next is(p_response->>'sqlstate','P0001',v_race.name||': admission fails fast on the job row held by the DELETE');
  return next is(p_response->>'error','xometry_beta_job_busy',v_race.name||': busy job rejected before any admission write');
 elsif v_race.kind='meter-last-slot' then
  return next is(p_response->>'sqlstate','P0001',v_race.name||': distinct admission SQLSTATE');
  return next is(p_response->>'error','free_allowance_unavailable',v_race.name||': distinct request loses last slot');
 elsif v_race.kind='meter-replay' then
  return next is(p_response->>'sqlstate','00000',v_race.name||': exact replay accepted at full capacity');
  return next is(p_response->>'accepted','true',v_race.name||': replay accepted');
  return next is(p_response->>'deduplicated','true',v_race.name||': replay deduplicated');
 else
  return next is(p_response->>'sqlstate','00000',v_race.name||': SKIP LOCKED completes before release');
  return next is(p_response->>'scanned','1',v_race.name||': bounded candidate scanned');
  return next is(p_response->>'deferred','1',v_race.name||': actual target lock deferred');
  return next is(p_response->>'reconciled','0',v_race.name||': locked candidate not settled');
  if v_race.kind='two-sweepers' then
   select receipt_id into strict v_first from free_meter_fixture.race_cases
    where name in(v_race.name,v_race.name||'-second') order by receipt_id limit 1;
   return next is(p_response->>'nextCursor',v_first::text,v_race.name||': busy first page advances cursor');
  end if;
 end if;
 insert into free_meter_fixture.race_outcomes values(v_race.name,'contender',p_response);
end $$;
create function free_meter_fixture.second_page_sql(p_response jsonb) returns text language plpgsql as $$
begin
 if p_response->>'nextCursor' is null then raise exception 'Missing two-sweeper cursor';end if;
 return format('select free_meter_fixture.discard_sweep(%L::uuid)',p_response->>'nextCursor');
end $$;
create function free_meter_fixture.assert_second_page(p_response jsonb) returns setof text language plpgsql as $$
declare v_name text;v_first uuid;v_second uuid;
begin
 select name into strict v_name from free_meter_fixture.current_race;
 select receipt_id into strict v_first from free_meter_fixture.race_cases where name in(v_name,v_name||'-second') order by receipt_id limit 1;
 select receipt_id into strict v_second from free_meter_fixture.race_cases where name in(v_name,v_name||'-second') order by receipt_id desc limit 1;
 return next is(p_response->>'discarded','true',v_name||': settling response intentionally discarded');
 return next is((select state from private.quote_access_admissions where id=v_second),'released',v_name||': second page settled despite discarded response');
 return next is((select state from private.quote_access_admissions where id=v_first),'reserved',v_name||': coordinator settlement still uncommitted while page two completes');
 insert into free_meter_fixture.race_outcomes values(v_name,'second-page',p_response);
end $$;

create function free_meter_fixture.verify_race() returns setof text language plpgsql as $$
declare v_race free_meter_fixture.current_race%rowtype;v_case free_meter_fixture.race_cases%rowtype;
 v_coordinator jsonb;v_contender jsonb;v_response jsonb;v_other uuid;v_first uuid;v_second uuid;v_name text;
begin
 select * into strict v_race from free_meter_fixture.current_race;
 select * into strict v_case from free_meter_fixture.race_cases where name=v_race.name;
 select response into strict v_coordinator from free_meter_fixture.race_outcomes where case_name=v_race.name and actor='coordinator';
 select response into strict v_contender from free_meter_fixture.race_outcomes where case_name=v_race.name and actor='contender';
 if v_race.kind in('meter-replay','meter-last-slot') then
  return next is((select count(*)::integer from private.quote_access_admissions where state in('reserved','consumed')),2,v_race.name||': shared subject was actually full');
  if v_race.kind='meter-replay' then
   return next is(v_contender->>'quoteRequestId',v_coordinator->>'quoteRequestId',v_race.name||': concurrent replay uses identical request');
   return next is(v_contender->>'permitId',v_coordinator->>'permitId',v_race.name||': concurrent replay uses identical permit');
  else
   select job_id into strict v_other from free_meter_fixture.race_cases where name=v_race.name||'-denied';
   return next is((select count(*)::integer from private.quote_access_admissions where job_id=v_other),0,v_race.name||': denied request has no receipt');
   return next is((select count(*)::integer from private.xometry_beta_dispatch_permits where job_id=v_other),0,v_race.name||': denied request has no permit');
   return next is((select count(*)::integer from public.quote_requests where job_id=v_other),0,v_race.name||': denied request has no orphan request');
   return next is((select count(*)::integer from public.work_queue where job_id=v_other),0,v_race.name||': denied request has no provider task');
  end if;
  foreach v_name in array array[v_race.name,v_race.name||'-filler'] loop
   v_response:=free_meter_fixture.as_role('authenticated',free_meter_fixture.cancel_sql(v_name));
   return next is(v_response->>'canceled','true',v_name||': synthetic hold drained through normal cancellation');
  end loop;
 elsif v_race.kind in('sweep-success','sweep-cancel') then
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'released',v_race.name||': one released receipt');
  return next is((select status::text from public.vendor_quote_results where id=v_case.result_id),'failed',v_race.name||': failed canonical result retained');
  return next is((select status::text from public.quote_requests where id=v_case.request_id),'failed',v_race.name||': request reducer stayed failed');
  return next is((select count(*)::integer from public.vendor_quote_offers where vendor_quote_result_id=v_case.result_id),0,v_race.name||': no offer leakage');
 elsif v_race.kind='cancel-sweep' then
  return next is((select status::text from public.quote_requests where id=v_case.request_id),'canceled',v_race.name||': cancel remains canonical');
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'released',v_race.name||': cancellation releases once');
  v_response:=free_meter_fixture.as_role('service_role',free_meter_fixture.complete_sql(v_race.name));
  return next is(v_response->>'error','free_quote_terminal_fenced',v_race.name||': later canonical success remains fenced');
 elsif v_race.kind='revival' then
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'reserved',v_race.name||': revival retains capacity');
  return next ok(exists(select 1 from public.work_queue where id=v_case.task_id and status='running' and locked_at is not null and locked_by='synthetic-reclaimer'),v_race.name||': fresh running lease committed');
  v_response:=free_meter_fixture.as_role('service_role',free_meter_fixture.sweep_sql(v_race.name));
  return next is(v_response->>'deferred','1',v_race.name||': fresh snapshot defers revived task');
  return next is((select status::text from public.vendor_quote_results where id=v_case.result_id),'queued',v_race.name||': revived result was not failed');
  update public.work_queue set status='failed',locked_at=null,locked_by=null where id=v_case.task_id;
  v_response:=free_meter_fixture.as_role('service_role',free_meter_fixture.sweep_sql(v_race.name));
  return next is(v_response->>'reconciled','1',v_race.name||': genuinely terminal synthetic task drains normally');
 elsif v_race.kind='two-sweepers' then
  select receipt_id into strict v_first from free_meter_fixture.race_cases where name in(v_race.name,v_race.name||'-second') order by receipt_id limit 1;
  select receipt_id into strict v_second from free_meter_fixture.race_cases where name in(v_race.name,v_race.name||'-second') order by receipt_id desc limit 1;
  return next is((select count(*)::integer from private.quote_access_admissions where id in(v_first,v_second) and state='released'),2,v_race.name||': independent sweepers each settle one receipt');
  v_response:=free_meter_fixture.as_role('service_role',format('select public.api_reconcile_terminal_free_quote_tasks(%L::uuid,1)',v_first));
  return next is(v_response->>'reconciled','0',v_race.name||': exact second-page retry settles nothing twice');
 elsif v_race.kind='admission-delete' then
  return next ok(exists(select 1 from public.jobs where id=v_case.job_id),v_race.name||': rejected delete preserves job');
  return next is((select count(*)::integer from private.quote_access_admissions where job_id=v_case.job_id and state='reserved'),1,v_race.name||': exactly one held receipt retained');
  v_response:=free_meter_fixture.as_role('authenticated',free_meter_fixture.cancel_sql(v_race.name));
  return next is(v_response->>'canceled','true',v_race.name||': cancellation makes job terminal');
  perform free_meter_fixture.remember();
  delete from public.jobs where id=v_case.job_id;
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'released',v_race.name||': history survives terminal deletion');
 elsif v_race.kind='delete-admission' then
  return next ok(not exists(select 1 from public.jobs where id=v_case.job_id),v_race.name||': job deletion committed');
  return next is((select count(*)::integer from private.quote_access_admissions where job_id=v_case.job_id),0,v_race.name||': no dangling receipt');
  return next is((select count(*)::integer from private.xometry_beta_dispatch_permits where job_id=v_case.job_id),0,v_race.name||': no dangling permit');
  return next is((select count(*)::integer from public.quote_requests where job_id=v_case.job_id),0,v_race.name||': no orphan request');
  return next is((select count(*)::integer from public.work_queue where job_id=v_case.job_id),0,v_race.name||': no orphan task');
 elsif v_race.kind='success-sweep' then
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'consumed',v_race.name||': canonical success consumes exactly once');
  return next is((select status::text from public.vendor_quote_results where id=v_case.result_id),'instant_quote_received',v_race.name||': canonical success not overwritten');
  return next ok(exists(select 1 from private.quote_access_admissions where id=v_case.receipt_id and qualifying_offer_id is not null and qualifying_evidence is not null),v_race.name||': qualifying immutable evidence exists');
  perform free_meter_fixture.remember();
  delete from public.jobs where id=v_case.job_id;
  return next is((select state from private.quote_access_admissions where id=v_case.receipt_id),'consumed',v_race.name||': consumed history survives deletion without refund');
 end if;
 perform free_meter_fixture.remember();
 v_response:=free_meter_fixture.as_role('service_role','select public.api_reconcile_terminal_free_quote_tasks(null,100)');
 return next is(v_response->>'scanned','0',v_race.name||': cursor wrap leaves no stranded holds');
 return next is((select count(*)::integer from private.quote_access_admissions),v_race.before_receipts+v_race.expected_new_receipts,v_race.name||': exact admission count');
 return next is((select count(*)::integer from public.spend_ledger),v_race.before_spend+2*v_race.expected_new_receipts,v_race.name||': no unexpected spend rows');
 return next is((select count(*)::integer from private.quote_access_admissions where state='consumed'),v_race.before_consumed+case when v_race.kind='success-sweep' then 1 else 0 end,v_race.name||': exact completed-capacity debit');
 return next is((select count(*)::integer from private.quote_access_admissions where state='reserved'),0,v_race.name||': all case reservations drained');
 return next ok(not exists(select 1 from free_meter_fixture.receipts_before b left join private.quote_access_admissions a on a.id=b.id
  where (to_jsonb(a)-array['state','terminal_at','outcome_reason','qualifying_offer_id','qualifying_evidence']) is distinct from b.identity_row),v_race.name||': all receipt identities immutable');
 return next ok(not exists(select 1 from free_meter_fixture.permits_before b left join private.xometry_beta_dispatch_permits p on p.id=b.id
  where to_jsonb(p) is distinct from b.original_row),v_race.name||': all immutable permits retained');
 return next ok(not exists(select 1 from free_meter_fixture.terminals_before b left join private.quote_access_admissions a on a.id=b.id
  where to_jsonb(a) is distinct from b.original_row),v_race.name||': all terminal receipts and evidence retained byte-for-byte');
 return next ok(not exists(select 1 from free_meter_fixture.spend_before b left join public.spend_ledger s on s.id=b.id
  where to_jsonb(s) is distinct from b.original_row),v_race.name||': all known/unresolved spend retained byte-for-byte');
 update free_meter_fixture.current_race set done=true;
end $$;

revoke execute on all functions in schema free_meter_fixture from public;
grant usage on schema free_meter_fixture to authenticated,service_role;
grant execute on function free_meter_fixture.capture(text) to authenticated,service_role;
grant execute on function free_meter_fixture.complete(uuid,jsonb,jsonb) to service_role;
grant execute on function free_meter_fixture.discard_sweep(uuid) to service_role;
grant execute on function free_meter_fixture.confirm(uuid,uuid,text) to authenticated;
commit;
