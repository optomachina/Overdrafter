-- OVD-1000: the fenced acceptance takes a Xometry beta permit's quantity from
-- its lane (public.quote_request_lanes.requested_quantity), not a literal 1.
--   a quantity-10 result on a lane at 10 (per-request grant consumed) is accepted;
--   a result whose quantity disagrees with its lane is still stale;
--   quantity 1 behaves as before (accepted; a mismatch is stale);
--   with the global switch on, a quantity-5 result is accepted without a grant;
--   security attributes, search_path and ACL are unchanged.
-- Rollback drill: the rollback restores the reconcile-claim-fence body, under
-- which the same quantity-10 result is stale again.
-- Synthetic rows only; the whole file rolls back.
begin;
select plan(25);

\set meter_fixture_limit 20
\ir fixtures/free_quote_meter_setup.inc

create schema ovd1000_fixture;
create table ovd1000_fixture.cases (name text primary key, job_id uuid not null, request_id uuid);

create function ovd1000_fixture.body_md5()
returns text language sql as $$
  select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)')
$$;

create function ovd1000_fixture.new_job(p_name text, p_quantity integer)
returns uuid
language plpgsql
as $$
declare
  v_user uuid;
  v_org uuid;
  v_job uuid := gen_random_uuid();
  v_part uuid := gen_random_uuid();
  v_file uuid := gen_random_uuid();
begin
  select user_id, organization_id into v_user, v_org from free_meter_fixture.context;
  perform free_meter_fixture.set_identity(v_user);
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (v_job, v_org, v_user, 'OVD-1000 ' || p_name, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.job_files (id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes)
  select v_file, v_job, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, 'ovd1000.step', 'ovd1000', 'cad', mime_type, size_bytes
  from public.job_files where id = '00000000-0000-4000-8000-000000008817';
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
  values (v_part, v_job, v_org, 'OVD-1000 part', 'ovd1000-part', v_file, 1);
  insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, finish,
    tightest_tolerance_inch, quantity, quote_quantities, applicable_vendors, spec_snapshot)
  values (v_part, v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, p_quantity, array[p_quantity],
    array['xometry']::public.vendor_name[], '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb);
  insert into ovd1000_fixture.cases (name, job_id) values (p_name, v_job);
  return v_job;
end;
$$;

create function ovd1000_fixture.job(p_name text)
returns uuid language sql as $$ select job_id from ovd1000_fixture.cases where name = p_name $$;

create function ovd1000_fixture.permit(p_name text)
returns private.xometry_beta_dispatch_permits language sql as $$
  select p.* from private.xometry_beta_dispatch_permits p
  where p.quote_request_id = (select request_id from ovd1000_fixture.cases where name = p_name)
$$;

-- The OVD-1007 per-request grant, issued as the service role.
create function ovd1000_fixture.grant_quantity(p_name text, p_quantity integer)
returns jsonb
language plpgsql
as $$
declare
  v_job uuid := ovd1000_fixture.job(p_name);
  v_response jsonb;
begin
  set local role service_role;
  v_response := public.api_grant_xometry_beta_quantity(v_job, p_quantity,
    'OVD-1000 quantity acceptance pgTAP', 'ovd1000-pgtap@example.test', 'ovd1000-grant-' || p_name);
  reset role;
  return v_response;
exception when others then
  reset role;
  raise;
end;
$$;

-- Requests the job's current scope, then claims its task like the worker does.
create function ovd1000_fixture.request_and_claim(p_name text)
returns void
language plpgsql
as $$
declare
  v_job uuid := ovd1000_fixture.job(p_name);
  v_scope jsonb;
  v_response jsonb;
begin
  perform free_meter_fixture.set_identity((select user_id from free_meter_fixture.context));
  v_scope := public.api_get_xometry_beta_dispatch_scope(v_job, 'inch');
  v_response := public.api_request_xometry_beta_dispatch(v_job, 'inch', v_scope ->> 'scopeFingerprint',
    'founding-beta-2026-08-15', gen_random_uuid(), true, true, true);
  if (v_response ->> 'accepted')::boolean is not true then
    raise exception 'fixture admission failed: %', v_response ->> 'reasonCode';
  end if;
  update ovd1000_fixture.cases set request_id = (v_response ->> 'quoteRequestId')::uuid where name = p_name;
  update public.work_queue set status = 'running', locked_by = 'ovd1000-worker',
    locked_at = '2026-11-04 01:00:00+00', attempts = 1
  where id = (ovd1000_fixture.permit(p_name)).work_queue_task_id;
  update public.vendor_quote_results set status = 'running'
  where id = (ovd1000_fixture.permit(p_name)).vendor_quote_result_id;
end;
$$;

create function ovd1000_fixture.accept(p_name text, p_quantity integer)
returns jsonb language sql as $$
  select public.accept_vendor_quote_result(permit.work_queue_task_id, 'ovd1000-worker', '2026-11-04 01:00:00+00', 1,
    permit.vendor_quote_result_id,
    pg_catalog.jsonb_build_object('status', 'instant_quote_received', 'unit_price_usd', 12,
      'total_price_usd', 12 * p_quantity, 'notes', '[]'::jsonb, 'dfm_issues', '[]'::jsonb, 'raw_payload', '{}'::jsonb),
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('vendor_quote_result_id', permit.vendor_quote_result_id,
      'organization_id', permit.organization_id, 'offer_key', 'ovd1000-offer', 'supplier', 'Xometry', 'lane_label', 'Fixture',
      'geographic_origin', 'unknown', 'quoted_at', pg_catalog.now() - interval '1 minute',
      'valid_until', pg_catalog.now() + interval '1 day', 'validity_source', 'vendor_date',
      'provenance_status', 'trusted_adapter', 'unit_price_usd', 12, 'total_price_usd', 12 * p_quantity,
      'sort_rank', 0, 'raw_payload', '{}'::jsonb)),
    '{"settled":true}'::jsonb)
  from ovd1000_fixture.permit(p_name) permit
$$;

create function ovd1000_fixture.settled(p_name text)
returns jsonb language sql as $$
  select pg_catalog.jsonb_build_object(
    'task', (select status::text from public.work_queue where id = permit.work_queue_task_id),
    'receipts', (select pg_catalog.count(*) from private.vendor_quote_acceptance_receipts
      where work_queue_task_id = permit.work_queue_task_id),
    'offers', (select pg_catalog.count(*) from public.vendor_quote_offers
      where vendor_quote_result_id = permit.vendor_quote_result_id))
  from ovd1000_fixture.permit(p_name) permit
$$;

-- ---------------------------------------------------------------- A. the definition
select is(ovd1000_fixture.body_md5(), 'c79ef7028326dbe470428af844af1bbd',
  'accept_vendor_quote_result is the OVD-1000 body');
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""', 'lock_timeout=1s'] and p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
   from pg_catalog.pg_proc p
   where p.oid = 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)'::regprocedure),
  'it is still a plpgsql security definer with an empty search_path and a 1s lock timeout');
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    and not exists (
      select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) acl
      where p.oid = 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)'::regprocedure
        and acl.grantee = 0),
  'only the service role can execute it (no PUBLIC, anon or authenticated grant)');

-- ---------------------------------------------------------------- B. quantity 10 on a lane at 10
select is(private.xometry_beta_user_quantity_enabled(), false, 'the global controlled_beta_user_quantity switch stays off');
select ovd1000_fixture.new_job('ten', 10);
select is(ovd1000_fixture.grant_quantity('ten', 10) ->> 'requestedQuantity', '10', 'a per-request grant names quantity 10');
select ovd1000_fixture.request_and_claim('ten');
select is(
  (select pg_catalog.jsonb_build_object('lane', lane.requested_quantity, 'result', result.requested_quantity,
     'grantConsumed', grant_row.consumed_permit_id = permit.id)
   from ovd1000_fixture.permit('ten') permit
   join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
   join public.vendor_quote_results result on result.id = permit.vendor_quote_result_id
   join private.xometry_beta_quantity_grants grant_row on grant_row.job_id = permit.job_id),
  '{"lane": 10, "result": 10, "grantConsumed": true}'::jsonb,
  'the lane and its result are at quantity 10 and the grant was consumed by this permit');

-- Rollback drill. fixtures/ovd1000_accept_result_lane_quantity_rollback.inc is
-- a byte copy of docs/migration-drafts/ovd-1000.rollback.sql
-- (scripts/run-supabase-policy-tests.node-test.mjs). Results are captured into
-- psql variables and asserted after the savepoint is rolled back.
savepoint ovd1000_rollback;
\ir fixtures/ovd1000_accept_result_lane_quantity_rollback.inc
select ovd1000_fixture.body_md5() as rb_md5,
  ovd1000_fixture.accept('ten', 10) ->> 'outcome' as rb_outcome,
  (select pg_catalog.array_to_string(p.proconfig, ',') || '|' || p.prosecdef::text
   from pg_catalog.pg_proc p
   where p.oid = 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)'::regprocedure) as rb_attrs,
  (pg_catalog.has_function_privilege('service_role', 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'))::text as rb_acl \gset
rollback to savepoint ovd1000_rollback;
release savepoint ovd1000_rollback;
select is(:'rb_md5'::text, 'c72d8ca87d6da4d3ae0448497b14e52f', 'rollback drill: the rollback restores the reconcile-claim-fence body exactly');
select is(:'rb_outcome'::text, 'stale', 'rollback drill: under the restored body the quantity-10 result is stale (the OVD-1000 defect)');
select is(:'rb_attrs'::text, 'search_path="",lock_timeout=1s|true', 'rollback drill: the restored body keeps its security attributes');
select ok(:'rb_acl'::boolean, 'rollback drill: the restored body keeps its grants');
select is(ovd1000_fixture.body_md5(), 'c79ef7028326dbe470428af844af1bbd',
  'rollback drill: rolled back to the savepoint, the OVD-1000 body is live again');

-- Mismatches stay stale: the result disagrees with its lane, either way round.
savepoint ovd1000_result_mismatch;
update public.vendor_quote_results set requested_quantity = 9 where id = (ovd1000_fixture.permit('ten')).vendor_quote_result_id;
select ovd1000_fixture.accept('ten', 9) ->> 'outcome' as mm_result_outcome, ovd1000_fixture.settled('ten')::text as mm_result_settled \gset
rollback to savepoint ovd1000_result_mismatch;
release savepoint ovd1000_result_mismatch;
select is(:'mm_result_outcome'::text, 'stale', 'a quantity-9 result on a lane at 10 is stale');
select is(:'mm_result_settled'::jsonb, '{"task": "running", "receipts": 0, "offers": 0}'::jsonb,
  'the stale quantity-9 result left the task claimed, with no receipt and no offer');

savepoint ovd1000_lane_mismatch;
update public.quote_request_lanes set requested_quantity = 1 where id = (ovd1000_fixture.permit('ten')).quote_request_lane_id;
select ovd1000_fixture.accept('ten', 10) ->> 'outcome' as mm_lane_outcome \gset
rollback to savepoint ovd1000_lane_mismatch;
release savepoint ovd1000_lane_mismatch;
select is(:'mm_lane_outcome'::text, 'stale', 'a quantity-10 result whose lane is at 1 is stale (the literal 1 no longer passes it)');

select is(ovd1000_fixture.accept('ten', 10) ->> 'outcome', 'accepted', 'the quantity-10 result on its lane at 10 is accepted');
select is(ovd1000_fixture.settled('ten'), '{"task": "completed", "receipts": 1, "offers": 1}'::jsonb,
  'the accepted quantity-10 result completed its task with one receipt and its offer');
select is(
  (select admission.state from private.quote_access_admissions admission
   where admission.quote_request_id = (ovd1000_fixture.permit('ten')).quote_request_id),
  'consumed', 'the free-beta admission is finalized as consumed, not left reserved');
select is(ovd1000_fixture.accept('ten', 10) ->> 'outcome', 'replayed', 'a lost acknowledgement replays the acceptance');

-- ---------------------------------------------------------------- C. quantity 1 unchanged
select ovd1000_fixture.new_job('one', 1);
select ovd1000_fixture.request_and_claim('one');
select is(
  (select lane.requested_quantity from public.quote_request_lanes lane
   where lane.id = (ovd1000_fixture.permit('one')).quote_request_lane_id),
  1, 'quantity 1 needs no grant and its lane is at 1');

savepoint ovd1000_one_mismatch;
update public.vendor_quote_results set requested_quantity = 2 where id = (ovd1000_fixture.permit('one')).vendor_quote_result_id;
select ovd1000_fixture.accept('one', 2) ->> 'outcome' as mm_one_outcome \gset
rollback to savepoint ovd1000_one_mismatch;
release savepoint ovd1000_one_mismatch;
select is(:'mm_one_outcome'::text, 'stale', 'a quantity-2 result on a lane at 1 is stale');

select is(ovd1000_fixture.accept('one', 1) ->> 'outcome', 'accepted', 'a quantity-1 result on its lane at 1 is still accepted');
select is(ovd1000_fixture.settled('one'), '{"task": "completed", "receipts": 1, "offers": 1}'::jsonb,
  'the accepted quantity-1 result completed its task with one receipt and its offer');

-- ---------------------------------------------------------------- D. quantity 5 with the global switch on
-- docs/migration-drafts/ovd-987-notes.md ("Known findings") names this case.
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-1000 local pgTAP fixture'
where capability = 'controlled_beta_user_quantity';
select is(private.xometry_beta_user_quantity_enabled(), true, 'the switch is on for this case only (the file rolls back)');
select ovd1000_fixture.new_job('five', 5);
select ovd1000_fixture.request_and_claim('five');
select is(ovd1000_fixture.accept('five', 5) ->> 'outcome', 'accepted',
  'with the switch on and no grant, a quantity-5 result on its lane at 5 is accepted');

-- ---------------------------------------------------------------- E. only the accepted results hold receipts
select is(
  (select pg_catalog.count(*)::integer from private.vendor_quote_acceptance_receipts receipt
   join ovd1000_fixture.cases c on c.job_id = receipt.job_id),
  3, 'exactly the three accepted results hold receipts');

select * from finish();
rollback;
