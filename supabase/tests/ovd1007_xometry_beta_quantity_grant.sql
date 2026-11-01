-- OVD-1007: the single-use, per-request quantity grant.
-- The global controlled_beta_user_quantity switch stays OFF throughout.
--   no grant: a quantity above 1 is denied and leaves nothing;
--   a grant admits only its own job (request), quantity and scope fingerprint;
--   it is consumed by the first permit and admits only that permit's replay;
--   a revoke mid-flight behaves like switching off: the worker preflight refuses;
--   the free-beta meter keeps no reservation held.
-- Rollback drill: with no grant history the rollback restores the OVD-987
-- bodies and drops the tables; with history it keeps the tables.
-- Synthetic rows only; the whole file rolls back.
begin;
select plan(58);

-- ---------------------------------------------------------------- 0. rollback drill (no history)
-- fixtures/ovd1007_xometry_beta_quantity_grant_rollback.inc is a byte copy of
-- docs/migration-drafts/ovd-1007.rollback.sql (scripts/run-supabase-policy-tests.node-test.mjs).
create schema ovd1007_drill;
create function ovd1007_drill.body_md5s() returns jsonb language sql as $$
  select pg_catalog.jsonb_object_agg(s.signature, pg_catalog.md5(p.prosrc))
  from (values
    ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'),
    ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'),
    ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)')) s(signature)
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(s.signature)
$$;

select is(ovd1007_drill.body_md5s(), '{
  "private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)": "1d482bb5747127128e041549291eae6e",
  "public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)": "be3fd395b4e84ddb118d643386a7bfde",
  "public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)": "5d7e026241a0346a6624063e86a088f7"}'::jsonb,
  'rollback drill: S1, S3 and S4 are the OVD-1007 bodies');
-- Results are captured into psql variables and asserted after the savepoint is
-- rolled back, so pgTAP's own count keeps every assertion.
savepoint ovd1007_rollback_empty;
\ir fixtures/ovd1007_xometry_beta_quantity_grant_rollback.inc
select ovd1007_drill.body_md5s()::text as rb_empty_bodies,
  (pg_catalog.to_regclass('private.xometry_beta_quantity_grants') is null
    and pg_catalog.to_regclass('private.xometry_beta_quantity_grant_events') is null
    and pg_catalog.to_regprocedure('public.api_get_quantity_scope(uuid)') is null
    and pg_catalog.to_regprocedure('public.api_grant_xometry_beta_quantity(uuid,integer,text,text,text)') is null)::text
    as rb_empty_dropped \gset
rollback to savepoint ovd1007_rollback_empty;
release savepoint ovd1007_rollback_empty;
select is(:'rb_empty_bodies'::jsonb, '{
  "private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)": "916594293cfc4e66053acf4c7414b2ba",
  "public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)": "28c932e1ccf964302ffed42d9ce4bc0b",
  "public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)": "0fef772880a4122f72475a9905b7ed19"}'::jsonb,
  'rollback drill: the rollback restores the OVD-987 bodies exactly');
select ok(:'rb_empty_dropped'::boolean,
  'rollback drill: with no grant history the tables and the new functions are gone');
select is(ovd1007_drill.body_md5s() ->> 'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)',
  '5d7e026241a0346a6624063e86a088f7', 'rollback drill: rolled back to the savepoint, the OVD-1007 bodies are live again');

\set meter_fixture_limit 20
\ir fixtures/free_quote_meter_setup.inc

create schema ovd1007_fixture;
create table ovd1007_fixture.cases (name text primary key, job_id uuid not null, request_id uuid);

create function ovd1007_fixture.new_job(p_name text, p_quantity integer)
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
  values (v_job, v_org, v_user, 'OVD-1007 ' || p_name, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.job_files (id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes)
  select v_file, v_job, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, 'ovd1007.step', 'ovd1007', 'cad', mime_type, size_bytes
  from public.job_files where id = '00000000-0000-4000-8000-000000008817';
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
  values (v_part, v_job, v_org, 'OVD-1007 part', 'ovd1007-part', v_file, 1);
  insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, finish,
    tightest_tolerance_inch, quantity, quote_quantities, applicable_vendors, spec_snapshot)
  values (v_part, v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, p_quantity, array[p_quantity],
    array['xometry']::public.vendor_name[], '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb);
  insert into ovd1007_fixture.cases (name, job_id) values (p_name, v_job);
  return v_job;
end;
$$;

create function ovd1007_fixture.job(p_name text)
returns uuid language sql as $$ select job_id from ovd1007_fixture.cases where name = p_name $$;

create function ovd1007_fixture.request_id(p_name text)
returns uuid language sql as $$ select request_id from ovd1007_fixture.cases where name = p_name $$;

create function ovd1007_fixture.scope(p_name text)
returns jsonb language sql as $$
  select public.api_get_xometry_beta_dispatch_scope(ovd1007_fixture.job(p_name), 'inch')
$$;

create function ovd1007_fixture.read(p_name text)
returns jsonb language sql as $$
  select public.api_get_quantity_scope(ovd1007_fixture.job(p_name)) - 'jobId' - 'organizationId' - 'actorUserId'
$$;

-- The request RPC with a chosen approval reference and fingerprint (default: the preview's).
create function ovd1007_fixture.request(p_name text, p_approval_reference uuid, p_fingerprint text default null)
returns jsonb
language plpgsql
as $$
declare
  v_response jsonb;
begin
  v_response := public.api_request_xometry_beta_dispatch(ovd1007_fixture.job(p_name), 'inch',
    coalesce(p_fingerprint, ovd1007_fixture.scope(p_name) ->> 'scopeFingerprint'),
    'founding-beta-2026-08-15', p_approval_reference, true, true, true);
  update ovd1007_fixture.cases set request_id = (v_response ->> 'quoteRequestId')::uuid
  where name = p_name and request_id is null;
  return v_response;
end;
$$;

create function ovd1007_fixture.created_rows(p_name text)
returns integer language sql as $$
  select ((select count(*) from public.quote_requests where job_id = ovd1007_fixture.job(p_name))
    + (select count(*) from public.work_queue where job_id = ovd1007_fixture.job(p_name))
    + (select count(*) from private.xometry_beta_dispatch_permits where job_id = ovd1007_fixture.job(p_name))
    + (select count(*) from private.quote_access_admissions admission
       join public.quote_requests request on request.id = admission.quote_request_id
       where request.job_id = ovd1007_fixture.job(p_name)))::integer
$$;

create function ovd1007_fixture.grant_quantity(p_name text, p_quantity integer, p_key text, p_reason text default 'OVD-1000 internal quantity run')
returns jsonb
language plpgsql
as $$
declare
  v_job uuid := ovd1007_fixture.job(p_name);
  v_response jsonb;
begin
  set local role service_role;
  v_response := public.api_grant_xometry_beta_quantity(v_job, p_quantity, p_reason,
    'ovd1007-pgtap@example.test', p_key);
  reset role;
  return v_response;
exception when others then
  reset role;
  raise;
end;
$$;

create function ovd1007_fixture.revoke_grant(p_grant uuid, p_revision bigint, p_key text)
returns jsonb
language plpgsql
as $$
declare
  v_response jsonb;
begin
  set local role service_role;
  v_response := public.api_revoke_xometry_beta_quantity_grant(p_grant, p_revision, 'OVD-1007 pgTAP revoke',
    'ovd1007-pgtap@example.test', p_key);
  reset role;
  return v_response;
exception when others then
  reset role;
  raise;
end;
$$;

create function ovd1007_fixture.grant_row(p_name text)
returns private.xometry_beta_quantity_grants language sql as $$
  select g.* from private.xometry_beta_quantity_grants g
  where g.job_id = ovd1007_fixture.job(p_name) order by g.granted_at desc, g.id limit 1
$$;

create function ovd1007_fixture.permit(p_name text)
returns private.xometry_beta_dispatch_permits language sql as $$
  select p.* from private.xometry_beta_dispatch_permits p where p.quote_request_id = ovd1007_fixture.request_id(p_name)
$$;

create function ovd1007_fixture.claim(p_name text)
returns void
language plpgsql
as $$
begin
  update public.work_queue set status = 'running', locked_at = now(), locked_by = 'ovd1007-pgtap'
  where id = (ovd1007_fixture.permit(p_name)).work_queue_task_id;
  update public.vendor_quote_results set status = 'running'
  where id = (ovd1007_fixture.permit(p_name)).vendor_quote_result_id;
end;
$$;

create function ovd1007_fixture.authorize(p_name text)
returns jsonb language sql as $$
  select public.api_authorize_xometry_beta_worker_dispatch(
    permit.work_queue_task_id, permit.vendor_quote_result_id, lane.scope_snapshot, 'ovd1007-pgtap', task.locked_at)
  from private.xometry_beta_dispatch_permits permit
  join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
  join public.work_queue task on task.id = permit.work_queue_task_id
  where permit.quote_request_id = ovd1007_fixture.request_id(p_name)
$$;

create function ovd1007_fixture.admission_state(p_name text)
returns text language sql as $$
  select state from private.quote_access_admissions where quote_request_id = ovd1007_fixture.request_id(p_name)
$$;

create function ovd1007_fixture.holds_grant_share_lock(p_name text)
returns boolean language sql as $$
  select exists (
    select 1 from pg_catalog.pg_locks l,
      lateral (select pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || ovd1007_fixture.job(p_name)::text, 0) as k) key
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted and l.mode = 'ShareLock'
      and l.classid = ((key.k >> 32) & 4294967295)::oid and l.objid = (key.k & 4294967295)::oid and l.objsubid = 1)
$$;

-- ---------------------------------------------------------------- A. structure and privileges
select ok(
  (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
   where c.oid in ('private.xometry_beta_quantity_grants'::regclass, 'private.xometry_beta_quantity_grant_events'::regclass)),
  'RLS is on for the grant and audit tables');
select ok(
  not exists (
    select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role_name),
      unnest(array['private.xometry_beta_quantity_grants', 'private.xometry_beta_quantity_grant_events']) t(table_name),
      unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(privilege)
    where pg_catalog.has_table_privilege(r.role_name, t.table_name, p.privilege)),
  'no API role can read or write the grant tables directly');
-- deny: anon private.xometry_beta_quantity_grants
-- deny: anon private.xometry_beta_quantity_grant_events
set local role anon;
select throws_ok(
  $$select g.id, e.id from private.xometry_beta_quantity_grants g, private.xometry_beta_quantity_grant_events e$$,
  '42501', null, 'anon cannot read grants or their audit events');
reset role;

-- deny: other_user private.xometry_beta_quantity_grants
-- deny: other_user private.xometry_beta_quantity_grant_events
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select throws_ok(
  $$select g.id, e.id from private.xometry_beta_quantity_grants g, private.xometry_beta_quantity_grant_events e$$,
  '42501', null, 'another signed-in user cannot read grants or their audit events');
reset role;

-- deny: role_boundary private.xometry_beta_quantity_grants
-- deny: role_boundary private.xometry_beta_quantity_grant_events
set local role service_role;
select throws_ok(
  $$insert into private.xometry_beta_quantity_grant_events (grant_id, job_id, action, idempotency_key, previous_revision,
      revision, reason, actor, actor_role)
    select g.id, g.job_id, 'grant', 'ovd1007-direct-0001', 0, 1, 'direct write', 'service-role', 'service_role'
    from private.xometry_beta_quantity_grants g$$,
  '42501', null, 'even the service role writes grants only through the audited setters, never directly');
reset role;
-- end deny

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.api_grant_xometry_beta_quantity(uuid,integer,text,text,text)', 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', 'public.api_revoke_xometry_beta_quantity_grant(uuid,bigint,text,text,text)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.api_grant_xometry_beta_quantity(uuid,integer,text,text,text)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.api_revoke_xometry_beta_quantity_grant(uuid,bigint,text,text,text)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.api_grant_xometry_beta_quantity(uuid,integer,text,text,text)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.api_revoke_xometry_beta_quantity_grant(uuid,bigint,text,text,text)', 'EXECUTE'),
  'only the service role can grant or revoke');
select ok(
  pg_catalog.has_function_privilege('authenticated', 'public.api_get_quantity_scope(uuid)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.api_get_quantity_scope(uuid)', 'EXECUTE')
    and not exists (
      select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role_name),
        unnest(array['private.xometry_beta_quantity_grant_id(uuid,uuid,text,integer)',
                     'private.consume_xometry_beta_quantity_grant(uuid,uuid,uuid,uuid)']) f(fn)
      where pg_catalog.has_function_privilege(r.role_name, f.fn, 'EXECUTE')),
  'signed-in users can read the quantity scope; no API role reaches the grant reader or consumer');
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=pg_catalog']) from pg_catalog.pg_proc p
   where p.oid in ('public.api_grant_xometry_beta_quantity(uuid,integer,text,text,text)'::regprocedure,
     'public.api_revoke_xometry_beta_quantity_grant(uuid,bigint,text,text,text)'::regprocedure,
     'public.api_get_quantity_scope(uuid)'::regprocedure)),
  'the setters and the read are security definers pinned to search_path=pg_catalog');

select ovd1007_fixture.new_job('ten', 10);
select ovd1007_fixture.new_job('other', 10);
select ovd1007_fixture.new_job('five', 5);
select ovd1007_fixture.new_job('revoked-early', 10);
select ovd1007_fixture.new_job('one', 1);

-- ---------------------------------------------------------------- B. no grant: quantity above 1 denied
select is(private.xometry_beta_user_quantity_enabled(), false, 'the global switch stays off');
select is(ovd1007_fixture.read('ten'), '{"schema": "quantity-scope.v1", "state": "single_only", "grant": null}'::jsonb,
  'no grant: the quantity-scope read says single_only with no grant');
select is(
  (select pg_catalog.jsonb_build_object('jobId', r -> 'jobId', 'organizationId', r -> 'organizationId', 'actorUserId', r -> 'actorUserId')
   from (select public.api_get_quantity_scope(ovd1007_fixture.job('ten')) as r) x),
  (select pg_catalog.jsonb_build_object('jobId', ovd1007_fixture.job('ten'), 'organizationId', organization_id, 'actorUserId', user_id)
   from free_meter_fixture.context),
  'the read echoes the job, organization and signed-in caller it checked');
select throws_ok($$select ovd1007_fixture.scope('ten')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'no grant: a quantity-10 preview is denied');
select throws_ok($$select ovd1007_fixture.request('ten', gen_random_uuid(), pg_catalog.repeat('f', 64))$$, 'P0001',
  'xometry_beta_quantity_one_required', 'no grant: a quantity-10 request is denied');
select is(ovd1007_fixture.created_rows('ten'), 0, 'no grant: the denied request left no request, task, permit or meter row');
select ok((ovd1007_fixture.request('one', gen_random_uuid()) ->> 'created')::boolean, 'a quantity-1 request still needs no grant');

-- ---------------------------------------------------------------- C. the audited, revisioned grant setter
create temporary table ovd1007_ten_job on commit drop as select ovd1007_fixture.job('ten') as job_id;
grant select on ovd1007_ten_job to authenticated;
set local role authenticated;
select throws_ok(
  $$select public.api_grant_xometry_beta_quantity((select job_id from ovd1007_ten_job), 10, 'self grant', 'customer@example.test', 'ovd1007-self-0001')$$,
  '42501', null, 'a signed-in customer cannot grant');
reset role;
select throws_ok($$select ovd1007_fixture.grant_quantity('five', 10, 'ovd1007-wrong-qty-0001')$$, 'P0001',
  'The job''s current Xometry scope is not one candidate at quantity 10.',
  'a grant must name the job''s current quantity');
select throws_ok($$select ovd1007_fixture.grant_quantity('one', 1, 'ovd1007-qty-one-0001')$$, 'P0001',
  'A quantity grant is for a quantity above 1.', 'there is nothing to grant at quantity 1');

create temporary table ovd1007_granted on commit drop as
select ovd1007_fixture.grant_quantity('ten', 10, 'ovd1007-grant-ten-0001') as r;
select is(
  (select pg_catalog.jsonb_build_object('revision', r -> 'revision', 'replayed', r -> 'replayed', 'requestedQuantity', r -> 'requestedQuantity')
   from ovd1007_granted),
  '{"revision": 1, "replayed": false, "requestedQuantity": 10}'::jsonb,
  'the service role grants quantity 10 for one job at revision 1');
select is((select r ->> 'scopeFingerprint' from ovd1007_granted), (ovd1007_fixture.grant_row('ten')).scope_fingerprint,
  'the grant binds the job''s current scope fingerprint');
select is(
  (select r -> 'grantId' from (select ovd1007_fixture.grant_quantity('ten', 10, 'ovd1007-grant-ten-0001') as r) x),
  (select r -> 'grantId' from ovd1007_granted), 'an exact replay returns the same grant');
select throws_ok($$select ovd1007_fixture.grant_quantity('ten', 10, 'ovd1007-grant-ten-0001', 'a different reason')$$, 'P0001',
  'Idempotency key has already been used for a different quantity-grant action.', 'a reused key with another reason is refused');
select throws_ok($$select ovd1007_fixture.grant_quantity('ten', 10, 'ovd1007-grant-ten-0002')$$, 'P0001',
  'This job already has a live quantity grant; revoke it first.', 'one live grant per job');
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('action', action, 'revision', revision, 'actor', actor))
   from private.xometry_beta_quantity_grant_events where job_id = ovd1007_fixture.job('ten')),
  '[{"action": "grant", "revision": 1, "actor": "ovd1007-pgtap@example.test"}]'::jsonb,
  'the grant is in the audit log with its actor');

-- ---------------------------------------------------------------- D. a grant admits only that request and fingerprint
select is(ovd1007_fixture.read('ten'), '{"schema": "quantity-scope.v1", "state": "multiple_allowed", "grant": "request"}'::jsonb,
  'granted: the read says multiple_allowed through a request grant');
select is(ovd1007_fixture.read('other'), '{"schema": "quantity-scope.v1", "state": "single_only", "grant": null}'::jsonb,
  'granted: another job still reads single_only');
select throws_ok($$select ovd1007_fixture.scope('other')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'granted: another job at the same quantity is still denied');
select is(ovd1007_fixture.scope('ten') ->> 'scopeFingerprint', (ovd1007_fixture.grant_row('ten')).scope_fingerprint,
  'granted: the job previews at the granted fingerprint');
select is((ovd1007_fixture.scope('ten') ->> 'requestedQuantity')::integer, 10, 'granted: the job previews at quantity 10');
savepoint ovd1007_fingerprint;
update public.approved_part_requirements set tightest_tolerance_inch = 0.010
where part_id = (select id from public.parts where job_id = ovd1007_fixture.job('ten'));
select throws_ok($$select ovd1007_fixture.scope('ten')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'granted: once the scope changes (another fingerprint) the grant no longer admits it');
rollback to savepoint ovd1007_fingerprint;
release savepoint ovd1007_fingerprint;

-- ---------------------------------------------------------------- E. single use
create temporary table ovd1007_refs on commit drop as select gen_random_uuid() as first_ref;
select ok((ovd1007_fixture.request('ten', (select first_ref from ovd1007_refs)) ->> 'created')::boolean,
  'granted: the quantity-10 request is created');
select is(
  (select lane.requested_quantity from public.quote_request_lanes lane where lane.quote_request_id = ovd1007_fixture.request_id('ten')),
  10, 'granted: the lane is at quantity 10');
select is(ovd1007_fixture.admission_state('ten'), 'reserved', 'granted: the free-beta admission is reserved');
select is(
  (select pg_catalog.jsonb_build_object('consumed', g.consumed_at is not null, 'permit', g.consumed_permit_id = (ovd1007_fixture.permit('ten')).id,
     'approval', g.consumed_approval_reference = (select first_ref from ovd1007_refs),
     'request', g.consumed_quote_request_id = ovd1007_fixture.request_id('ten'), 'revision', g.revision)
   from ovd1007_fixture.grant_row('ten') g),
  '{"consumed": true, "permit": true, "approval": true, "request": true, "revision": 2}'::jsonb,
  'the grant is consumed by that permit, approval reference and request (revision 2)');
select is(
  (select count(*)::integer from private.xometry_beta_quantity_grant_events
   where job_id = ovd1007_fixture.job('ten') and action = 'consume' and permit_id = (ovd1007_fixture.permit('ten')).id and revision = 2),
  1, 'the consumption is in the audit log');
select is(ovd1007_fixture.read('ten'), '{"schema": "quantity-scope.v1", "state": "single_only", "grant": null}'::jsonb,
  'consumed: the read is single_only again');
select is(ovd1007_fixture.request('ten', (select first_ref from ovd1007_refs), (ovd1007_fixture.grant_row('ten')).scope_fingerprint) ->> 'deduplicated',
  'true', 'consumed: the exact replay of the committed request is deduplicated');
select throws_ok(
  format($$select ovd1007_fixture.request('ten', gen_random_uuid(), %L)$$, (ovd1007_fixture.grant_row('ten')).scope_fingerprint),
  'P0001', 'xometry_beta_quantity_one_required', 'consumed: a second request under another approval reference is denied');
select throws_ok(
  $$update private.xometry_beta_quantity_grants set consumed_at = null, consumed_permit_id = null,
      consumed_approval_reference = null, consumed_quote_request_id = null, revision = revision + 1
    where job_id = ovd1007_fixture.job('ten')$$,
  'P0001', 'A Xometry beta quantity grant changes only by one consume or one revoke.', 'a consumed grant cannot be reset');

-- ---------------------------------------------------------------- F. worker preflight
select ovd1007_fixture.claim('ten');
select is(ovd1007_fixture.authorize('ten') ->> 'authorized', 'true', 'the worker preflight admits the lane its grant admitted');
select ok(ovd1007_fixture.holds_grant_share_lock('ten'), 'the preflight took the shared grant lock');

-- ---------------------------------------------------------------- G. revoke mid-flight behaves like switch-off
select throws_ok(format($$select ovd1007_fixture.revoke_grant(%L, 1, 'ovd1007-revoke-ten-0001')$$, (ovd1007_fixture.grant_row('ten')).id),
  'P0001', 'Quantity grant changed; refresh and retry.', 'a revoke at a stale revision is refused');
select is(
  (select pg_catalog.jsonb_build_object('revoked', r -> 'revoked', 'consumed', r -> 'consumed', 'revision', r -> 'revision', 'replayed', r -> 'replayed')
   from (select ovd1007_fixture.revoke_grant((ovd1007_fixture.grant_row('ten')).id, 2, 'ovd1007-revoke-ten-0001') as r) x),
  '{"revoked": true, "consumed": true, "revision": 3, "replayed": false}'::jsonb,
  'the service role revokes the consumed grant mid-flight (revision 3)');
select is(ovd1007_fixture.revoke_grant((ovd1007_fixture.grant_row('ten')).id, 2, 'ovd1007-revoke-ten-0001') ->> 'replayed', 'true',
  'an exact revoke replay is idempotent');
select is(ovd1007_fixture.authorize('ten') ->> 'reasonCode', 'dispatch_quantity_not_admitted',
  'revoked: the worker preflight refuses the lane, as with the switch off');
select throws_ok(
  format($$select ovd1007_fixture.request('ten', %L, %L)$$, (select first_ref from ovd1007_refs), (ovd1007_fixture.grant_row('ten')).scope_fingerprint),
  'P0001', 'xometry_beta_quantity_one_required', 'revoked: replaying the committed request is denied, as with the switch off');
select throws_ok(
  $$update private.xometry_beta_quantity_grants set revoked = false, revoked_at = null, revoke_reason = null,
      revoked_by_actor = null, revision = revision + 1 where job_id = ovd1007_fixture.job('ten')$$,
  'P0001', 'A Xometry beta quantity grant changes only by one consume or one revoke.', 'a revoked grant cannot be restored');

-- A grant revoked before use admits nothing.
select ovd1007_fixture.grant_quantity('revoked-early', 10, 'ovd1007-grant-early-0001');
select ovd1007_fixture.revoke_grant((ovd1007_fixture.grant_row('revoked-early')).id, 1, 'ovd1007-revoke-early-0001');
select throws_ok($$select ovd1007_fixture.scope('revoked-early')$$, 'P0001', 'xometry_beta_quantity_one_required',
  'revoked before use: the preview is denied');
select is(ovd1007_fixture.created_rows('revoked-early'), 0, 'revoked before use: nothing was created');

-- ---------------------------------------------------------------- H. never deleted; no held reservation on the meter
select throws_ok($$delete from private.xometry_beta_quantity_grants$$, 'P0001',
  'Xometry beta quantity grants are never deleted; revoke them.', 'grants cannot be deleted');
select throws_ok($$delete from private.xometry_beta_quantity_grant_events$$, 'P0001',
  'Xometry beta quantity grant events are immutable.', 'grant audit events cannot be deleted');

set constraints public.settle_terminal_free_quote_result immediate;
update public.vendor_quote_results set status = 'failed' where id = (ovd1007_fixture.permit('ten')).vendor_quote_result_id;
select is(ovd1007_fixture.admission_state('ten'), 'released',
  'the lane refused after the revoke releases its allowance when its result fails');
select is(
  (select count(*)::integer from private.quote_access_admissions admission
   join ovd1007_fixture.cases c on c.request_id = admission.quote_request_id
   where admission.state = 'reserved' and c.name <> 'one'),
  0, 'no quantity-10 allowance is left reserved on the free-beta meter');

-- ---------------------------------------------------------------- I. rollback drill (with history)
savepoint ovd1007_rollback_history;
\ir fixtures/ovd1007_xometry_beta_quantity_grant_rollback.inc
select (pg_catalog.to_regclass('private.xometry_beta_quantity_grants') is not null
    and (select count(*) from private.xometry_beta_quantity_grants) = 2
    and (select count(*) from private.xometry_beta_quantity_grant_events) = 5
    and pg_catalog.to_regprocedure('public.api_get_quantity_scope(uuid)') is null
    and not pg_catalog.has_table_privilege('service_role', 'private.xometry_beta_quantity_grants', 'SELECT'))::text
    as rb_history_kept \gset
rollback to savepoint ovd1007_rollback_history;
release savepoint ovd1007_rollback_history;
select ok(:'rb_history_kept'::boolean,
  'rollback drill: with grant history the rollback keeps every grant and audit row and drops the functions');

select * from finish();
rollback;
