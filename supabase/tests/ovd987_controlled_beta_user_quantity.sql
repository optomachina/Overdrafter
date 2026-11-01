-- OVD-987 (P3): the controlled_beta_user_quantity switch.
-- Switch OFF (the seed): exactly today's quantity-1 rule and error code.
-- Switch ON: one positive quantity of any size, several quantities denied.
-- Switch turned OFF with a lane above 1 in flight: the worker preflight
-- refuses it, and the free-beta meter still settles every hold.
-- Rollback drill: with no audit event for the switch the rollback restores
-- the pre-OVD-987 schema; with one it refuses and changes nothing.
-- Synthetic rows only; the whole file rolls back.
begin;
select plan(127);

-- OVD-1007 restates S1, S3 and S4 on top of OVD-987. Its rollback (a byte copy
-- of docs/migration-drafts/ovd-1007.rollback.sql) restores the OVD-987 bodies
-- inside this rolled-back transaction, so this suite tests the OVD-987 layer.
\ir fixtures/ovd1007_xometry_beta_quantity_grant_rollback.inc

-- ---------------------------------------------------------------- 0. rollback drill
-- fixtures/ovd987_controlled_beta_user_quantity_rollback.inc is a byte copy of
-- docs/migration-drafts/ovd-987.rollback.sql (scripts/run-supabase-policy-tests.node-test.mjs).
-- Both runs sit in savepoints that are rolled back, so the rest of this file
-- starts from the migration as applied, with no audit event for the switch.
create schema ovd987_drill;
create table ovd987_drill.bodies (signature text primary key, applied_md5 text not null, previous_md5 text not null);
insert into ovd987_drill.bodies values
  ('public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', '2a2b6b6980abb0dd113b64b3dcd57041', 'eb741ed4f0be63d3189486959cdccdac'),
  ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', '916594293cfc4e66053acf4c7414b2ba', '0d4abcf48f054aced6dd3d531a1114bb'),
  ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', '28c932e1ccf964302ffed42d9ce4bc0b', 'b633e6921485eefc211ab238bab10e43'),
  ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19', 'eb659d92aa927555f4c4fe93591fa9d1'),
  ('private.record_quote_access_admission(uuid,uuid,text,uuid)', '7c5f710bccffddd8562974ae489e803c', '92b05edef3ec774fdb704e21efdc392d'),
  ('private.finalize_free_quote_job(uuid)', 'b76415a18a9bb15659ec388cc4da2880', '66021f1fc65ee7fa7d5c24666c858512'),
  ('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', 'edcca1ef0dd3cf45a7ff9c202696f185', '30208617d8ea6ec756e268d1b31ad4c9');

create function ovd987_drill.body_md5s() returns jsonb language sql as $$
  select pg_catalog.jsonb_object_agg(b.signature, pg_catalog.md5(p.prosrc))
  from ovd987_drill.bodies b
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(b.signature)
$$;

create function ovd987_drill.check_def(p_name text) returns text language sql as $$
  select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
  where c.conname = p_name and c.connamespace = 'private'::regnamespace
$$;

-- Everything the rollback could touch: audit events, both CHECKs, the control row, the helper, the bodies.
create function ovd987_drill.state() returns jsonb language sql as $$
  select pg_catalog.jsonb_build_object(
    'events', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.id), '[]'::jsonb)
               from private.commercial_rollout_control_events e where e.capability = 'controlled_beta_user_quantity'),
    'events_check', ovd987_drill.check_def('commercial_rollout_control_events_capability_check'),
    'controls_check', ovd987_drill.check_def('commercial_rollout_controls_capability_check'),
    'control', (select pg_catalog.to_jsonb(c) from private.commercial_rollout_controls c
                where c.capability = 'controlled_beta_user_quantity'),
    'helper', pg_catalog.to_regprocedure('private.xometry_beta_user_quantity_enabled()') is not null,
    'bodies', ovd987_drill.body_md5s())
$$;

create table ovd987_drill.captured (name text primary key, state jsonb not null);

-- (a) No audit event names the switch: the rollback restores the previous schema.
select is(
  (select count(*)::integer from private.commercial_rollout_control_events where capability = 'controlled_beta_user_quantity'),
  0, 'rollback drill (a): no audit event names the switch yet');
select is(ovd987_drill.body_md5s(),
  (select pg_catalog.jsonb_object_agg(signature, applied_md5) from ovd987_drill.bodies),
  'rollback drill (a): the seven bodies are this migration''s');
insert into ovd987_drill.captured values ('applied', ovd987_drill.state());

savepoint ovd987_rollback_restores;
\ir fixtures/ovd987_controlled_beta_user_quantity_rollback.inc
select is(ovd987_drill.check_def('commercial_rollout_control_events_capability_check'),
  'CHECK ((capability = ANY (ARRAY[''commercial_admin_mutations''::text, ''automatic_quote_collection''::text, ''promotion_codes''::text, ''order_administration''::text])))',
  'rollback drill (a): the events CHECK is its pre-OVD-987 definition again');
select is(ovd987_drill.check_def('commercial_rollout_controls_capability_check'),
  'CHECK ((capability = ANY (ARRAY[''commercial_admin_mutations''::text, ''automatic_quote_collection''::text, ''promotion_codes''::text, ''order_administration''::text])))',
  'rollback drill (a): the controls CHECK is its pre-OVD-987 definition again');
select is(
  (select count(*)::integer from private.commercial_rollout_controls where capability = 'controlled_beta_user_quantity'),
  0, 'rollback drill (a): the disabled control row is deleted');
select ok(pg_catalog.to_regprocedure('private.xometry_beta_user_quantity_enabled()') is null,
  'rollback drill (a): the helper is dropped');
select is(ovd987_drill.body_md5s(),
  (select pg_catalog.jsonb_object_agg(signature, previous_md5) from ovd987_drill.bodies),
  'rollback drill (a): the seven bodies are the previous definitions byte for byte');
select throws_ok(
  $$insert into private.commercial_rollout_control_events (capability, idempotency_key, previous_enabled, enabled,
      changed, previous_revision, revision, change_reason, changed_by_actor, changed_by_role)
    values ('controlled_beta_user_quantity', 'ovd987-pgtap-probe-0001', false, false, false, 0, 0,
      'OVD-987 rollback probe', 'ovd987-pgtap@example.test', 'service_role')$$,
  '23514', null, 'rollback drill (a): the restored events CHECK rejects the capability again');
rollback to savepoint ovd987_rollback_restores;
select is(ovd987_drill.state(), (select state from ovd987_drill.captured where name = 'applied'),
  'rollback drill (a): the savepoint puts the migration back for the rest of this file');

-- (b) An audit event names the switch: the rollback refuses before any change.
-- A no-op setter call is enough (the operator "making sure" the switch is off).
savepoint ovd987_rollback_audit_history;
set local role service_role;
select is(
  public.api_set_commercial_rollout_control('controlled_beta_user_quantity', false,
    'OVD-987 pgTAP no-op before a rollback', 'ovd987-pgtap@example.test', 0, 'ovd987-pgtap-noop-0001') ->> 'changed',
  'false', 'rollback drill (b): a no-op setter call for the switch changes nothing');
reset role;
select is(
  (select count(*)::integer from private.commercial_rollout_control_events
   where capability = 'controlled_beta_user_quantity' and not changed and revision = 0),
  1, 'rollback drill (b): the no-op call is still an immutable audit event');
-- Every other guard check passes here, so only the audit-history check can refuse.
select ok(
  not private.commercial_rollout_enabled('controlled_beta_user_quantity')
  and not exists (
    select 1 from private.xometry_beta_dispatch_permits permit
    join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
    where lane.requested_quantity <> 1)
  and ovd987_drill.body_md5s() = (select pg_catalog.jsonb_object_agg(signature, applied_md5) from ovd987_drill.bodies),
  'rollback drill (b): the switch is off, no permit above quantity 1 exists and the bodies are this migration''s');
insert into ovd987_drill.captured values ('audit_history', ovd987_drill.state());

-- The first error must be the audit-history refusal itself. The guard block below is a
-- byte copy of the rollback's $ovd987_rollback_guard$ block (pinned by
-- scripts/run-supabase-policy-tests.node-test.mjs); throws_ok runs it in a subtransaction
-- and captures the first error, which the include below cannot (its later statements
-- overwrite LAST_ERROR_* with 25P02).
select throws_ok($ovd987_guard_drill$
do $ovd987_rollback_guard$
declare
  v_expected record;
  v_md5 text;
begin
  if exists (
    select 1 from private.commercial_rollout_control_events
    where capability = 'controlled_beta_user_quantity'
  ) then
    raise exception 'OVD-987 rollback refused: immutable audit events exist for controlled_beta_user_quantity; the restored events CHECK would reject them and audit history is never deleted or rewritten. Nothing changed: keep the migration applied with the switch off, or decide on a separate schema removal'
      using errcode = '55000';
  end if;

  if private.commercial_rollout_enabled('controlled_beta_user_quantity') then
    raise exception 'OVD-987 rollback refused: controlled_beta_user_quantity is on; turn it off through public.api_set_commercial_rollout_control first'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from private.xometry_beta_dispatch_permits permit
    join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
    left join public.quote_requests request_row on request_row.id = permit.quote_request_id
    left join public.work_queue task on task.id = permit.work_queue_task_id
    left join private.quote_access_admissions admission on admission.permit_id = permit.id
    where lane.requested_quantity <> 1
      and (admission.state = 'reserved'
        or request_row.status::text in ('queued', 'requesting')
        or task.status::text in ('queued', 'running'))
  ) then
    raise exception 'OVD-987 rollback refused: a Xometry beta permit above quantity 1 is still in flight; drain it first'
      using errcode = 'P0001';
  end if;

  for v_expected in
    select * from (values
      ('public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)', '2a2b6b6980abb0dd113b64b3dcd57041', 'eb741ed4f0be63d3189486959cdccdac'),
      ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', '916594293cfc4e66053acf4c7414b2ba', '0d4abcf48f054aced6dd3d531a1114bb'),
      ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', '28c932e1ccf964302ffed42d9ce4bc0b', 'b633e6921485eefc211ab238bab10e43'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19', 'eb659d92aa927555f4c4fe93591fa9d1'),
      ('private.record_quote_access_admission(uuid,uuid,text,uuid)', '7c5f710bccffddd8562974ae489e803c', '92b05edef3ec774fdb704e21efdc392d'),
      ('private.finalize_free_quote_job(uuid)', 'b76415a18a9bb15659ec388cc4da2880', '66021f1fc65ee7fa7d5c24666c858512'),
      ('public.api_reconcile_terminal_free_quote_tasks(uuid,integer)', 'edcca1ef0dd3cf45a7ff9c202696f185', '30208617d8ea6ec756e268d1b31ad4c9')
    ) as expected(signature, applied_md5, previous_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is null or v_md5 not in (v_expected.applied_md5, v_expected.previous_md5) then
      raise exception 'OVD-987 rollback refused: % was replaced by a later migration (md5 %); roll that back first',
        v_expected.signature, coalesce(v_md5, 'missing')
        using errcode = 'P0001';
    end if;
  end loop;
end;
$ovd987_rollback_guard$
$ovd987_guard_drill$,
  '55000',
  'OVD-987 rollback refused: immutable audit events exist for controlled_beta_user_quantity; the restored events CHECK would reject them and audit history is never deleted or rewritten. Nothing changed: keep the migration applied with the switch off, or decide on a separate schema removal',
  'rollback drill (b): the first error is the audit-history refusal (SQLSTATE 55000) with its message');

-- psql keeps going after the guard's exception so this file can assert that
-- nothing changed. Every later statement of the rollback then fails with 25P02
-- (transaction aborted); the savepoint clears that. Expected on stderr: the
-- refusal message, then one 25P02 line per remaining statement.
savepoint ovd987_rollback_refuses;
\set LAST_ERROR_SQLSTATE none
\set ON_ERROR_ROLLBACK off
\set VERBOSITY terse
\set ON_ERROR_STOP off
\ir fixtures/ovd987_controlled_beta_user_quantity_rollback.inc
\set ON_ERROR_STOP on
\set VERBOSITY default
rollback to savepoint ovd987_rollback_refuses;
-- 25P02 on the file's last statement (the events CHECK) means an earlier statement
-- aborted the run; without the guard check that statement would fail with 23514.
select is(:'LAST_ERROR_SQLSTATE'::text, '25P02',
  'rollback drill (b): the rollback aborted before its last statement (the events CHECK) ran');
select is(ovd987_drill.state(), (select state from ovd987_drill.captured where name = 'audit_history'),
  'rollback drill (b): the audit events, both CHECKs, the control row, the helper and the seven bodies are untouched');
rollback to savepoint ovd987_rollback_audit_history;
select is(
  (select count(*)::integer from private.commercial_rollout_control_events where capability = 'controlled_beta_user_quantity'),
  0, 'rollback drill: the rest of this file starts with no audit event for the switch');

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

-- Defence-in-depth drills: rows edited inside the request transaction, as a racing
-- writer or a direct edit by the owner would. Each trigger lives in a savepoint.
create function ovd987_fixture.tamper_lane_snapshot()
returns trigger
language plpgsql
as $$
begin
  -- Fires on the permit insert, after S3 checked the lane and before S5 reserves.
  update public.quote_request_lanes
  set scope_snapshot = pg_catalog.jsonb_set(scope_snapshot, '{quantity}', pg_catalog.to_jsonb(requested_quantity + 1))
  where id = new.quote_request_lane_id;
  return new;
end;
$$;

create function ovd987_fixture.flip_switch_off()
returns trigger
language plpgsql
as $$
begin
  -- Fires once the lanes exist, after S1 read the switch as on: the switch-off race.
  update private.commercial_rollout_controls set enabled = false
  where capability = 'controlled_beta_user_quantity';
  return null;
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

-- S4 binds what the worker browses with: the result row and the payload key it reads.
select is(
  (select payload ->> 'requestedQuantity' from public.work_queue where id = ovd987_fixture.task_id('five')),
  '5', 'on: the server-written payload names the lane quantity');
savepoint ovd987_binding;
update public.work_queue set payload = pg_catalog.jsonb_set(payload, '{requestedQuantity}', '999999'::jsonb)
where id = ovd987_fixture.task_id('five');
select is(ovd987_fixture.authorize('five') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'on: a task payload naming another quantity is refused');
rollback to savepoint ovd987_binding;
update public.vendor_quote_results set requested_quantity = 999999 where id = ovd987_fixture.result_id('five');
select is(ovd987_fixture.authorize('five') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'on: a result row at another quantity is refused');
rollback to savepoint ovd987_binding;
update public.work_queue set payload = pg_catalog.jsonb_set(payload, '{requestedQuantity}', '999999'::jsonb)
where id = ovd987_fixture.task_id('five');
update public.vendor_quote_results set requested_quantity = 999999 where id = ovd987_fixture.result_id('five');
select is(ovd987_fixture.authorize('five') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'on: payload and result both rewritten to another quantity are refused');
rollback to savepoint ovd987_binding;
update public.work_queue set payload = payload - 'requestedQuantity' where id = ovd987_fixture.task_id('five');
select is(ovd987_fixture.authorize('five') ->> 'authorized', 'true',
  'on: a payload without requestedQuantity still authorizes (the worker then reads the bound result)');
rollback to savepoint ovd987_binding;
update public.work_queue set payload = pg_catalog.jsonb_set(payload, '{requestedQuantity}', '"5"'::jsonb)
where id = ovd987_fixture.task_id('five');
select is(ovd987_fixture.authorize('five') ->> 'authorized', 'true',
  'on: a payload naming the lane quantity as a string still authorizes');
rollback to savepoint ovd987_binding;
release savepoint ovd987_binding;
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

-- S5 refuses to reserve for a lane whose quantity differs from its own snapshot.
select ovd987_fixture.new_job('s5-tamper', array[5], 5);
savepoint ovd987_s5;
create trigger ovd987_tamper_lane_snapshot before insert on private.xometry_beta_dispatch_permits
  for each row execute function ovd987_fixture.tamper_lane_snapshot();
select throws_ok($$select ovd987_fixture.request('s5-tamper')$$, 'P0001', 'quote_access_identity_mismatch',
  'on: S5 refuses to reserve for a quantity-5 lane whose snapshot was edited to 6');
rollback to savepoint ovd987_s5;
release savepoint ovd987_s5;
select is(ovd987_fixture.created_rows('s5-tamper'), 0, 'on: the refused S5 reservation left no request, task or permit');

-- S3 refuses a lane above 1 if the switch reads off by the time the lane exists.
select ovd987_fixture.new_job('s3-flip', array[5], 5);
savepoint ovd987_s3;
create trigger ovd987_flip_switch_off after insert on public.quote_request_lanes
  for each statement execute function ovd987_fixture.flip_switch_off();
select throws_ok($$select ovd987_fixture.request('s3-flip')$$, 'P0001', 'xometry_beta_created_lane_mismatch',
  'on: S3 refuses a quantity-5 lane when the switch was turned off after the resolver read it');
rollback to savepoint ovd987_s3;
release savepoint ovd987_s3;
select is(private.xometry_beta_user_quantity_enabled(), true, 'on: the drill left the switch on');
select is(ovd987_fixture.created_rows('s3-flip'), 0, 'on: the refused request left no request, task or permit');

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

-- With the switch off the S4 binding is a tightening that only edited rows meet.
select is(
  (select payload ->> 'requestedQuantity' from public.work_queue where id = ovd987_fixture.task_id('one')),
  '1', 'off: the server-written quantity-1 payload names 1');
savepoint ovd987_binding_one;
update public.work_queue set payload = pg_catalog.jsonb_set(payload, '{requestedQuantity}', '999999'::jsonb)
where id = ovd987_fixture.task_id('one');
select is(ovd987_fixture.authorize('one') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'off: a quantity-1 lane whose payload was rewritten to 999999 is refused');
rollback to savepoint ovd987_binding_one;
update public.vendor_quote_results set requested_quantity = 999999 where id = ovd987_fixture.result_id('one');
select is(ovd987_fixture.authorize('one') ->> 'reasonCode', 'dispatch_lane_identity_mismatch',
  'off: a quantity-1 lane whose result was rewritten to 999999 is refused');
rollback to savepoint ovd987_binding_one;
update public.work_queue set payload = payload - 'requestedQuantity' where id = ovd987_fixture.task_id('one');
select is(ovd987_fixture.authorize('one') ->> 'authorized', 'true',
  'off: a quantity-1 payload without requestedQuantity still authorizes');
rollback to savepoint ovd987_binding_one;
release savepoint ovd987_binding_one;

-- With the switch off S5 now also binds a quantity-1 lane to its snapshot (edited rows only).
select ovd987_fixture.new_job('s5-tamper-one', array[1], 1);
savepoint ovd987_s5_one;
create trigger ovd987_tamper_lane_snapshot before insert on private.xometry_beta_dispatch_permits
  for each row execute function ovd987_fixture.tamper_lane_snapshot();
select throws_ok($$select ovd987_fixture.request('s5-tamper-one')$$, 'P0001', 'quote_access_identity_mismatch',
  'off: S5 refuses to reserve for a quantity-1 lane whose snapshot was edited to 2');
rollback to savepoint ovd987_s5_one;
select ok((ovd987_fixture.request('s5-tamper-one') ->> 'created')::boolean,
  'off: the same quantity-1 request without the edit is created (then rolled back)');
rollback to savepoint ovd987_s5_one;
release savepoint ovd987_s5_one;

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
-- S6 would also refuse these two, so only the untouched result status proves S7 stopped first.
select is(
  (select status::text from public.vendor_quote_results where id = ovd987_fixture.result_id('tampered-lane')),
  'queued', 'S7 does not terminalize the result of a lane whose quantity differs from its snapshot');
select is(
  (select status::text from public.vendor_quote_results where id = ovd987_fixture.result_id('tampered-result')),
  'queued', 'S7 does not terminalize a result whose quantity differs from its lane');
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
