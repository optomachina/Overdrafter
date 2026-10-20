-- OVD-987 (P3): the controlled_beta_user_quantity switch.
-- Switch OFF (the seed): exactly today's quantity-1 rule and error code.
-- Switch ON: one positive quantity of any size, several quantities denied.
-- Switch turned OFF with a lane above 1 in flight: the worker preflight
-- refuses it, and the free-beta meter still settles every hold.
-- Synthetic rows only; the whole file rolls back.
begin;
select plan(92);
\set meter_fixture_limit 20
\ir fixtures/free_quote_meter_setup.inc

create schema ovd987_fixture;

create table ovd987_fixture.cases (
  name text primary key,
  job_id uuid not null,
  request_id uuid
);

create function ovd987_fixture.new_job(p_name text, p_quote_quantities integer[], p_quantity integer)
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
  values (v_job, v_org, v_user, 'OVD-987 ' || p_name, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.job_files (id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes)
  select v_file, v_job, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, 'ovd987.step', 'ovd987', 'cad', mime_type, size_bytes
  from public.job_files where id = '00000000-0000-4000-8000-000000008817';
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
  values (v_part, v_job, v_org, 'OVD-987 part', 'ovd987-part', v_file, 1);
  insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, finish,
    tightest_tolerance_inch, quantity, quote_quantities, applicable_vendors, spec_snapshot)
  values (v_part, v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, p_quantity, p_quote_quantities,
    array['xometry']::public.vendor_name[], '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb);
  insert into ovd987_fixture.cases (name, job_id) values (p_name, v_job);
  return v_job;
end;
$$;

create function ovd987_fixture.job(p_name text)
returns uuid language sql as $$ select job_id from ovd987_fixture.cases where name = p_name $$;

create function ovd987_fixture.request_id(p_name text)
returns uuid language sql as $$ select request_id from ovd987_fixture.cases where name = p_name $$;

create function ovd987_fixture.scope(p_name text)
returns jsonb language sql as $$
  select public.api_get_xometry_beta_dispatch_scope(ovd987_fixture.job(p_name), 'inch')
$$;

create function ovd987_fixture.request(p_name text)
returns jsonb
language plpgsql
as $$
declare
  v_scope jsonb;
  v_response jsonb;
begin
  v_scope := public.api_get_xometry_beta_dispatch_scope(ovd987_fixture.job(p_name), 'inch');
  v_response := public.api_request_xometry_beta_dispatch(ovd987_fixture.job(p_name), 'inch',
    v_scope ->> 'scopeFingerprint', 'founding-beta-2026-08-15', gen_random_uuid(), true, true, true);
  update ovd987_fixture.cases set request_id = (v_response ->> 'quoteRequestId')::uuid where name = p_name;
  return v_response;
end;
$$;

-- Calls the request RPC itself (not the preview first), with a placeholder
-- fingerprint: the resolver inside it runs before the fingerprint comparison.
create function ovd987_fixture.request_direct(p_name text)
returns jsonb language sql as $$
  select public.api_request_xometry_beta_dispatch(ovd987_fixture.job(p_name), 'inch', pg_catalog.repeat('f', 64),
    'founding-beta-2026-08-15', gen_random_uuid(), true, true, true)
$$;

create function ovd987_fixture.created_rows(p_name text)
returns integer language sql as $$
  select ((select count(*) from public.quote_requests where job_id = ovd987_fixture.job(p_name))
    + (select count(*) from public.work_queue where job_id = ovd987_fixture.job(p_name))
    + (select count(*) from private.xometry_beta_dispatch_permits where job_id = ovd987_fixture.job(p_name)))::integer
$$;

create function ovd987_fixture.set_switch(p_enabled boolean, p_key text)
returns jsonb language sql as $$
  select public.api_set_commercial_rollout_control(
    'controlled_beta_user_quantity', p_enabled, 'OVD-987 pgTAP fixture flip', 'ovd987-pgtap@example.test',
    (select revision from private.commercial_rollout_controls where capability = 'controlled_beta_user_quantity'),
    p_key)
$$;

create function ovd987_fixture.claim(p_name text)
returns void
language plpgsql
as $$
begin
  update public.work_queue set status = 'running', locked_at = now(), locked_by = 'ovd987-pgtap'
  where id = (select work_queue_task_id from private.xometry_beta_dispatch_permits
              where quote_request_id = ovd987_fixture.request_id(p_name));
  update public.vendor_quote_results set status = 'running'
  where id = (select vendor_quote_result_id from private.xometry_beta_dispatch_permits
              where quote_request_id = ovd987_fixture.request_id(p_name));
end;
$$;

create function ovd987_fixture.authorize(p_name text)
returns jsonb language sql as $$
  select public.api_authorize_xometry_beta_worker_dispatch(
    permit.work_queue_task_id, permit.vendor_quote_result_id, lane.scope_snapshot, 'ovd987-pgtap', task.locked_at)
  from private.xometry_beta_dispatch_permits permit
  join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
  join public.work_queue task on task.id = permit.work_queue_task_id
  where permit.quote_request_id = ovd987_fixture.request_id(p_name)
$$;

create function ovd987_fixture.lane(p_name text)
returns public.quote_request_lanes language sql as $$
  select lane.* from public.quote_request_lanes lane
  where lane.quote_request_id = ovd987_fixture.request_id(p_name)
$$;

create function ovd987_fixture.admission_state(p_name text)
returns text language sql as $$
  select state from private.quote_access_admissions where quote_request_id = ovd987_fixture.request_id(p_name)
$$;

create function ovd987_fixture.task_id(p_name text)
returns uuid language sql as $$
  select work_queue_task_id from private.xometry_beta_dispatch_permits where quote_request_id = ovd987_fixture.request_id(p_name)
$$;

create function ovd987_fixture.result_id(p_name text)
returns uuid language sql as $$
  select vendor_quote_result_id from private.xometry_beta_dispatch_permits where quote_request_id = ovd987_fixture.request_id(p_name)
$$;

-- The S4 lock key, as private.record_quote_access_admission spells advisory keys.
create function ovd987_fixture.holds_quantity_share_lock()
returns boolean language sql as $$
  select exists (
    select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted and l.mode = 'ShareLock'
      and l.classid = ((pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0) >> 32) & 4294967295)::oid
      and l.objid = (pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0) & 4294967295)::oid
      and l.objsubid = 1)
$$;

-- OVD-723 window-1 dispatch check: clean declaration plus verified, scanned files.
create function ovd987_fixture.clear_export(p_name text)
returns void
language plpgsql
as $$
begin
  insert into private.job_export_declarations (job_id, organization_id, declared_by, answer, terms_version)
  select job.id, job.organization_id, job.created_by, 'not_controlled', 'ovd-beta-export-control.v1'
  from public.jobs job where job.id = ovd987_fixture.job(p_name);
  insert into private.job_file_export_scans (job_file_id, job_id, organization_id, source, content_sha256)
  select file.id, file.job_id, file.organization_id, source.name, pg_catalog.lower(file.content_sha256)
  from public.job_files file
  cross join (values ('drawing_text'), ('step_header')) as source(name)
  where file.job_id = ovd987_fixture.job(p_name) and file.content_sha256 ~ '^[0-9a-f]{64}$';
end;
$$;

-- ---------------------------------------------------------------- A. structure and privileges
select is(
  (select pg_catalog.jsonb_build_object('enabled', enabled, 'revision', revision)
   from private.commercial_rollout_controls where capability = 'controlled_beta_user_quantity'),
  '{"enabled": false, "revision": 0}'::jsonb,
  'the controlled_beta_user_quantity control is seeded off at revision 0');
select is(private.xometry_beta_user_quantity_enabled(), false, 'the switch helper reads off by default');
select is(
  (select array_agg(capability order by capability) from private.commercial_rollout_controls),
  array['automatic_quote_collection', 'commercial_admin_mutations', 'controlled_beta_user_quantity',
        'order_administration', 'promotion_codes'],
  'the registry holds the four commercial controls plus controlled_beta_user_quantity');
select ok(
  (select not p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=pg_catalog']
   from pg_catalog.pg_proc p where p.oid = 'private.xometry_beta_user_quantity_enabled()'::regprocedure),
  'the helper is a stable SECURITY INVOKER function with a pinned search_path');
select ok(
  not has_function_privilege('anon', 'private.xometry_beta_user_quantity_enabled()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.xometry_beta_user_quantity_enabled()', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.xometry_beta_user_quantity_enabled()', 'EXECUTE'),
  'no API role may execute the switch helper');
set local role authenticated;
select throws_ok($$select private.xometry_beta_user_quantity_enabled()$$, '42501', null,
  'an authenticated caller cannot read the switch through the helper');
reset role;
select ok(
  has_function_privilege('service_role', 'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', 'EXECUTE'),
  'only the service role can flip the switch, through the audited setter');
select throws_ok(
  $$insert into private.commercial_rollout_controls (capability, enabled, revision, change_reason)
    values ('ovd987_unknown_capability', false, 0, 'not a capability')$$,
  '23514', null, 'the capability CHECK still refuses unknown capabilities');
select throws_ok(
  $$select public.api_set_commercial_rollout_control('ovd987_unknown_capability', true, 'not a capability',
    'ovd987-pgtap@example.test', 0, 'ovd987-unknown-capability')$$,
  'P0001', 'Unknown commercial rollout capability.', 'the setter still refuses unknown capabilities');
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=pg_catalog'])
   from pg_catalog.pg_proc p
   where p.oid in (
     'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'::regprocedure,
     'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::regprocedure,
     'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)'::regprocedure,
     'private.record_quote_access_admission(uuid,uuid,text,uuid)'::regprocedure,
     'private.finalize_free_quote_job(uuid)'::regprocedure,
     'public.api_reconcile_terminal_free_quote_tasks(uuid,integer)'::regprocedure,
     'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)'::regprocedure)),
  'every restated function is still SECURITY DEFINER with search_path = pg_catalog');
select ok(
  has_function_privilege('authenticated', 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE'),
  'S3 grants are unchanged: authenticated only');
select ok(
  has_function_privilege('service_role', 'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', 'EXECUTE'),
  'S4 and S7 grants are unchanged: service role only');
select ok(
  not has_function_privilege('authenticated', 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.record_quote_access_admission(uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.record_quote_access_admission(uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.finalize_free_quote_job(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.finalize_free_quote_job(uuid)', 'EXECUTE'),
  'S1, S5 and S6 stay owner only');

-- ---------------------------------------------------------------- B. switch OFF: today's behaviour
select ovd987_fixture.new_job('one', array[1], 1);
select ovd987_fixture.new_job('five', array[5], 5);
select ovd987_fixture.new_job('multi', array[1, 3], 1);
select ovd987_fixture.new_job('zero', array[0], 0);
select ovd987_fixture.new_job('negative', array[-1], -1);
select ovd987_fixture.new_job('empty-seven', '{}'::integer[], 7);
select ovd987_fixture.new_job('million', array[1000000], 1000000);

select is((ovd987_fixture.scope('one') ->> 'requestedQuantity')::integer, 1, 'off: quantity [1] previews at 1');
select is((ovd987_fixture.scope('one') #>> '{scope,quantity}')::integer, 1, 'off: the quantity-1 scope snapshot states 1');
select is(
  (select array_agg(key order by key) from pg_catalog.jsonb_object_keys(ovd987_fixture.scope('one')) key),
  array['declaredModelUnits', 'envelopeRevision', 'jobId', 'organizationId', 'partId', 'policyRevision',
        'provider', 'requestedQuantity', 'scope', 'scopeFingerprint', 'scopeVersion'],
  'off: the preview response keys are unchanged');
select is(
  ovd987_fixture.scope('one') ->> 'scopeFingerprint',
  private.quote_scope_fingerprint(ovd987_fixture.scope('one') -> 'scope'),
  'off: the fingerprint is the hash of the scope snapshot');
select throws_ok($$select ovd987_fixture.scope('five')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off: quantity [5] keeps the quantity-one denial');
select throws_ok($$select ovd987_fixture.request_direct('five')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off: the request RPC itself denies [5] with the same code');
select is(ovd987_fixture.created_rows('five'), 0, 'off: the denied request created no request, task or permit');
select throws_ok($$select ovd987_fixture.scope('multi')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off: quantities [1,3] keep the quantity-one denial');
select throws_ok($$select ovd987_fixture.scope('zero')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off: quantity [0] keeps the quantity-one denial');
select throws_ok($$select ovd987_fixture.scope('empty-seven')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off: an empty list falls back to Qty 7 and keeps the quantity-one denial');

select ok((ovd987_fixture.request('one') ->> 'created')::boolean, 'off: a quantity-1 request is created as before');
select is((ovd987_fixture.lane('one')).requested_quantity, 1, 'off: the quantity-1 lane is at 1');
select is(ovd987_fixture.admission_state('one'), 'reserved', 'off: the quantity-1 free-beta admission is reserved');
select ovd987_fixture.claim('one');
select is(ovd987_fixture.authorize('one') ->> 'authorized', 'true', 'off: a quantity-1 lane authorizes as before');
select ok(not ovd987_fixture.holds_quantity_share_lock(), 'off: a quantity-1 authorization takes no OVD-987 lock');

-- ---------------------------------------------------------------- C. switch ON
set local role service_role;
select is(
  (select pg_catalog.jsonb_build_object('enabled', r -> 'enabled', 'changed', r -> 'changed', 'revision', r -> 'revision')
   from (select public.api_set_commercial_rollout_control('controlled_beta_user_quantity', true,
     'OVD-987 pgTAP fixture flip', 'ovd987-pgtap@example.test', 0, 'ovd987-pgtap-enable-0001') as r) flip),
  '{"enabled": true, "changed": true, "revision": 1}'::jsonb,
  'the service role turns the switch on through the audited, revisioned setter');
reset role;
select is(
  (select count(*)::integer from private.commercial_rollout_control_events
   where capability = 'controlled_beta_user_quantity' and enabled and changed and revision = 1),
  1, 'the flip is recorded as an immutable audit event');
select is(private.xometry_beta_user_quantity_enabled(), true, 'on: the helper reads the switch');

select is((ovd987_fixture.scope('one') ->> 'requestedQuantity')::integer, 1, 'on: quantity [1] still previews at 1');
select is((ovd987_fixture.scope('five') ->> 'requestedQuantity')::integer, 5, 'on: quantity [5] previews at 5');
select is((ovd987_fixture.scope('five') #>> '{scope,quantity}')::integer, 5, 'on: the scope snapshot states quantity 5');
select is(
  ovd987_fixture.scope('five') ->> 'scopeFingerprint',
  private.quote_scope_fingerprint(ovd987_fixture.scope('five') -> 'scope'),
  'on: the fingerprint is the hash of the quantity-5 snapshot');
select is((ovd987_fixture.scope('empty-seven') ->> 'requestedQuantity')::integer, 7,
  'on: an empty list falls back to Qty 7 (normalize_positive_integer_array fallback)');
select is((ovd987_fixture.scope('million') ->> 'requestedQuantity')::integer, 1000000,
  'on: there is no upper bound (Blaine 2026-10-19)');
select throws_ok($$select ovd987_fixture.scope('multi')$$, 'P0001', 'xometry_beta_single_quantity_required',
  'on: several quantities [1,3] are denied by name');
select throws_ok($$select ovd987_fixture.request_direct('multi')$$, 'P0001', 'xometry_beta_single_quantity_required',
  'on: the request RPC itself denies several quantities by name');
select is(ovd987_fixture.created_rows('multi'), 0, 'on: the denied multi-quantity request created nothing');
select throws_ok($$select ovd987_fixture.scope('zero')$$, 'P0001', 'xometry_beta_single_quantity_required',
  'on: quantity [0] with Qty 0 normalizes to no quantity and is denied');
select throws_ok($$select ovd987_fixture.scope('negative')$$, 'P0001', 'xometry_beta_single_quantity_required',
  'on: quantity [-1] with Qty -1 normalizes to no quantity and is denied');

-- The fingerprint binds the quantity: the same part at another quantity is another scope.
create temporary table ovd987_fingerprints on commit drop as
select ovd987_fixture.scope('five') ->> 'scopeFingerprint' as at_five;
update public.approved_part_requirements set quote_quantities = array[6], quantity = 6
where part_id = (select id from public.parts where job_id = ovd987_fixture.job('five'));
select isnt(ovd987_fixture.scope('five') ->> 'scopeFingerprint', (select at_five from ovd987_fingerprints),
  'on: changing the quantity changes the scope fingerprint');
select throws_ok(
  format($$select public.api_request_xometry_beta_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15',
    gen_random_uuid(), true, true, true)$$, ovd987_fixture.job('five'), (select at_five from ovd987_fingerprints)),
  'P0001', 'xometry_beta_scope_changed', 'on: a request confirmed at 5 but saved at 6 fails closed');
update public.approved_part_requirements set quote_quantities = array[5], quantity = 5
where part_id = (select id from public.parts where job_id = ovd987_fixture.job('five'));
select is(ovd987_fixture.scope('five') ->> 'scopeFingerprint', (select at_five from ovd987_fingerprints),
  'on: back at 5 the fingerprint is the same again');

-- Every other gate is still evaluated, in its existing order.
savepoint ovd987_gate;
update public.jobs set requested_service_kinds = array['manufacturing_quote', 'dfm_review'] where id = ovd987_fixture.job('multi');
select throws_ok($$select ovd987_fixture.scope('multi')$$, 'P0001', 'xometry_beta_manufacturing_quote_only',
  'on: the service-kind gate still runs before the quantity gate');
rollback to savepoint ovd987_gate;
update public.approved_part_requirements set tightest_tolerance_inch = 0.001
where part_id in (select id from public.parts where job_id in (ovd987_fixture.job('multi'), ovd987_fixture.job('five')));
select throws_ok($$select ovd987_fixture.scope('multi')$$, 'P0001', 'xometry_beta_single_quantity_required',
  'on: the quantity gate still runs before the tolerance gate');
select throws_ok($$select ovd987_fixture.scope('five')$$, 'P0001', 'xometry_beta_standard_tolerance_required',
  'on: a single quantity 5 still meets the tolerance gate (OVD-683)');
rollback to savepoint ovd987_gate;
update public.approved_part_requirements set requested_by_date = current_date + 10
where part_id = (select id from public.parts where job_id = ovd987_fixture.job('five'));
select throws_ok($$select ovd987_fixture.scope('five')$$, 'P0001', 'xometry_beta_special_delivery_date_not_supported',
  'on: quantity 5 still meets the need-by gate');
rollback to savepoint ovd987_gate;
update public.approved_part_requirements
set spec_snapshot = '{"process":"CNC milling","tightestToleranceInch":0.0050,"notes":"deburr"}'::jsonb
where part_id = (select id from public.parts where job_id = ovd987_fixture.job('five'));
select throws_ok($$select ovd987_fixture.scope('five')$$, 'P0001', 'xometry_beta_special_requirements_not_supported',
  'on: quantity 5 still meets the special-requirements gate');
rollback to savepoint ovd987_gate;
update public.organizations set shipping_zip = '85702' where id = (select organization_id from free_meter_fixture.context);
select throws_ok($$select ovd987_fixture.scope('five')$$, 'P0001', 'xometry_beta_confirmed_sourcing_address_required',
  'on: quantity 5 still meets the confirmed-destination gate');
rollback to savepoint ovd987_gate;
update private.provider_kill_switches set engaged = true where provider = 'xometry';
select throws_ok($$select ovd987_fixture.request('five')$$, 'P0001', 'provider_kill_switch_engaged',
  'on: the provider kill switch still refuses a quantity-5 enqueue (OVD-722)');
rollback to savepoint ovd987_gate;
release savepoint ovd987_gate;

-- One lane, one result, one task, one permit, one reserved allowance at quantity 5.
select ok((ovd987_fixture.request('five') ->> 'created')::boolean, 'on: a quantity-5 request is created');
select is(
  (select count(*)::integer from public.quote_request_lanes where quote_request_id = ovd987_fixture.request_id('five')),
  1, 'on: exactly one lane');
select is((ovd987_fixture.lane('five')).requested_quantity, 5, 'on: the lane is at quantity 5');
select is(((ovd987_fixture.lane('five')).scope_snapshot ->> 'quantity')::integer, 5, 'on: the lane snapshot states 5');
select is(
  (select requested_quantity from public.vendor_quote_results where id = ovd987_fixture.result_id('five')),
  5, 'on: the result is at quantity 5');
select is(
  (select count(*)::integer from public.work_queue where job_id = ovd987_fixture.job('five') and task_type = 'run_vendor_quote'),
  1, 'on: exactly one provider task');
select is(
  (select payload ->> 'requestedQuantity' from public.work_queue where id = ovd987_fixture.task_id('five')),
  '5', 'on: the task asks the worker for quantity 5');
select is(
  (select count(*)::integer from private.xometry_beta_dispatch_permits where job_id = ovd987_fixture.job('five')),
  1, 'on: exactly one immutable permit');
select is(ovd987_fixture.admission_state('five'), 'reserved', 'on: the free-beta admission (S5) reserves at quantity 5');

-- Worker preflight at quantity 5.
select ovd987_fixture.claim('five');
select is(ovd987_fixture.authorize('five') ->> 'authorized', 'true', 'on: a quantity-5 lane authorizes');
select ok(ovd987_fixture.holds_quantity_share_lock(), 'on: the quantity-5 authorization took the shared OVD-987 lock');
savepoint ovd987_lane_identity;
update public.quote_request_lanes set scope_snapshot = pg_catalog.jsonb_set(scope_snapshot, '{quantity}', '6'::jsonb)
where quote_request_id = ovd987_fixture.request_id('five');
select is(ovd987_fixture.authorize('five') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'on: a lane whose quantity differs from its own snapshot is refused');
rollback to savepoint ovd987_lane_identity;
release savepoint ovd987_lane_identity;
select is(
  (select public.api_check_export_control_dispatch(ovd987_fixture.task_id('five'), 'xometry') ->> 'allowed'),
  'false', 'on: the export-control dispatch check still refuses an undeclared quantity-5 job (OVD-723)');
select ovd987_fixture.clear_export('five');
select is(
  (select public.api_check_export_control_dispatch(ovd987_fixture.task_id('five'), 'xometry') ->> 'allowed'),
  'true', 'on: a clean, scanned quantity-5 job passes the export-control check');

-- Requests that stay in flight when the switch is turned off.
select ovd987_fixture.new_job('queued', array[5], 5);
select ovd987_fixture.new_job('success', array[5], 5);
select ovd987_fixture.new_job('failure', array[5], 5);
select ovd987_fixture.new_job('crash', array[5], 5);
select ovd987_fixture.new_job('tampered-lane', array[5], 5);
select ovd987_fixture.new_job('tampered-result', array[5], 5);
select ovd987_fixture.new_job('cancel', array[5], 5);
select ok(
  (select bool_and((ovd987_fixture.request(name) ->> 'created')::boolean)
   from unnest(array['queued', 'success', 'failure', 'crash', 'tampered-lane', 'tampered-result', 'cancel']) name),
  'on: seven more quantity-5 requests are created');
select is(
  (select count(*)::integer from private.quote_access_admissions admission
   join ovd987_fixture.cases c on c.request_id = admission.quote_request_id
   where c.name in ('queued', 'success', 'failure', 'crash', 'tampered-lane', 'tampered-result', 'cancel')
     and admission.state = 'reserved'),
  7, 'on: each holds one reserved allowance');

-- ---------------------------------------------------------------- D. switch turned OFF with quantity-5 work in flight
select is(
  ovd987_fixture.set_switch(false, 'ovd987-pgtap-disable-0001') -> 'revision',
  '2'::jsonb, 'the switch is turned off again (revision 2)');
select is(private.xometry_beta_user_quantity_enabled(), false, 'off again: the helper reads off');
select throws_ok($$select ovd987_fixture.scope('success')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'off again: a new quantity-5 preview is denied with the old code');

select ovd987_fixture.claim('queued');
select is(ovd987_fixture.authorize('queued') ->> 'reasonCode', 'dispatch_quantity_not_admitted',
  'off again: a queued quantity-5 lane is refused before browser launch');
select is(ovd987_fixture.authorize('queued') ->> 'authorized', 'false', 'off again: the refusal is a denial');
select is(ovd987_fixture.authorize('five') ->> 'reasonCode', 'dispatch_quantity_not_admitted',
  'off again: an already authorized quantity-5 lane is refused on its next preflight');
select is(ovd987_fixture.authorize('one') ->> 'authorized', 'true', 'off again: a quantity-1 lane still authorizes');

-- Cancellation is quantity-agnostic and still releases.
select is(public.api_cancel_quote_request(ovd987_fixture.request_id('cancel')) ->> 'canceled', 'true',
  'off again: the customer can still cancel a queued quantity-5 request');
select is(ovd987_fixture.admission_state('cancel'), 'released', 'off again: canceling releases the quantity-5 allowance');

-- The meter (S5 to S7) does not read the switch: every quantity-5 hold settles.
set constraints public.settle_terminal_free_quote_result immediate;
select public.reconcile_vendor_quote_offers(free_meter_fixture.result_id(ovd987_fixture.request_id('success')),
  free_meter_fixture.result_payload(), free_meter_fixture.offers(ovd987_fixture.request_id('success')));
select is(ovd987_fixture.admission_state('success'), 'consumed',
  'off again: a usable quantity-5 quote consumes its allowance (S6, no reservation leak)');
select is(
  (select qualifying_evidence ->> 'scopeFingerprint' from private.quote_access_admissions
   where quote_request_id = ovd987_fixture.request_id('success')),
  (ovd987_fixture.lane('success')).scope_fingerprint,
  'off again: the completion evidence pins the quantity-5 scope fingerprint');
select is(private.finalize_free_quote_job(ovd987_fixture.request_id('success')) ->> 'changed', 'false',
  'off again: settlement is idempotent');

update public.vendor_quote_results set status = 'failed' where id = ovd987_fixture.result_id('failure');
select is(ovd987_fixture.admission_state('failure'), 'released', 'off again: a failed quantity-5 result releases its allowance');
select is(
  (select outcome_reason from private.quote_access_admissions where quote_request_id = ovd987_fixture.request_id('failure')),
  'failed', 'off again: the release is recorded as failed');

update public.vendor_quote_results set status = 'failed' where id = ovd987_fixture.result_id('queued');
select is(ovd987_fixture.admission_state('queued'), 'released',
  'off again: the lane refused at dispatch releases its allowance when its result fails');

update public.quote_request_lanes set scope_snapshot = pg_catalog.jsonb_set(scope_snapshot, '{quantity}', '6'::jsonb)
where quote_request_id = ovd987_fixture.request_id('tampered-lane');
select is(private.finalize_free_quote_job(ovd987_fixture.request_id('tampered-lane')) ->> 'reasonCode', 'identity_indeterminate',
  'S6 still refuses to settle a lane whose quantity differs from its own snapshot');
update public.vendor_quote_results set requested_quantity = 6 where id = ovd987_fixture.result_id('tampered-result');

update public.work_queue set status = 'failed', locked_at = null, locked_by = null, last_error = 'worker_crash_recovery'
where id in (ovd987_fixture.task_id('crash'), ovd987_fixture.task_id('tampered-lane'), ovd987_fixture.task_id('tampered-result'));
create temporary table ovd987_reconcile on commit drop as
select public.api_reconcile_terminal_free_quote_tasks() as summary;
select is(ovd987_fixture.admission_state('crash'), 'released',
  'off again: reconciliation (S7) releases a crashed quantity-5 task');
select is(
  (select status::text from public.vendor_quote_results where id = ovd987_fixture.result_id('crash')),
  'failed', 'off again: reconciliation terminalizes the pinned quantity-5 result');
select is(ovd987_fixture.admission_state('tampered-lane'), 'reserved',
  'S7 keeps the hold of a lane whose quantity differs from its snapshot');
select is(ovd987_fixture.admission_state('tampered-result'), 'reserved',
  'S7 keeps the hold of a result whose quantity differs from its lane');
select is(
  (select pg_catalog.jsonb_build_object('reconciled', summary -> 'reconciled', 'indeterminate', summary -> 'indeterminate',
     'deferred', summary -> 'deferred') from ovd987_reconcile),
  '{"reconciled": 1, "indeterminate": 2, "deferred": 2}'::jsonb,
  'reconciliation: one settled, the two tampered holds indeterminate, the two running quantity-1 and quantity-5 tasks deferred');
select is(
  (select count(*)::integer from private.quote_access_admissions admission
   join ovd987_fixture.cases c on c.request_id = admission.quote_request_id
   where admission.state = 'reserved'
     and c.name not in ('one', 'five', 'tampered-lane', 'tampered-result')),
  0, 'no quantity-5 allowance is left reserved except the running task and the two deliberately broken bindings');

-- ---------------------------------------------------------------- E. audit trail
select is(
  (select array_agg(revision order by revision) from private.commercial_rollout_control_events
   where capability = 'controlled_beta_user_quantity'),
  array[1, 2]::bigint[], 'both flips are in the immutable audit log');
select throws_ok(
  $$delete from private.commercial_rollout_control_events where capability = 'controlled_beta_user_quantity'$$,
  'P0001', 'Commercial rollout control events are immutable.', 'the OVD-987 audit events cannot be deleted');

select * from finish();
rollback;
