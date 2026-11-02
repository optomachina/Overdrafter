-- OVD-979 U2: committed, exclusively owned synthetic fixtures for real dblink waits.
-- Run only on a disposable local database with repository migrations applied.
-- Each RPC pair is run in both holder/waiter directions; both transactions roll back.
-- This proves contention at the RPC boundary, not every internal U5 request interleaving.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
set statement_timeout = '30s';

-- A run aborted after the setup commit leaves the LOGIN role and the work_queue
-- trigger behind. Remove those first; the end-of-file cleanup still runs on success.
begin;
drop trigger if exists ovd979u2_pause_after_insert on public.work_queue;
drop schema if exists ovd979u2_test cascade;
drop role if exists ovd979u2_tap;
commit;

begin;
-- Synthetic rows still fail on collisions rather than deleting an earlier run's data.
create schema ovd979u2_test;
create function ovd979u2_test.id(n integer) returns uuid language sql immutable as $$
  select ('97920000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (ovd979u2_test.id(2), 'authenticated', 'authenticated',
  'ovd979u2@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values (ovd979u2_test.id(1), 'OVD979 U2 synthetic', 'ovd979u2-synthetic');
insert into public.organization_memberships (organization_id, user_id, role)
values (ovd979u2_test.id(1), ovd979u2_test.id(2), 'internal_estimator');
insert into public.jobs (id, organization_id, created_by, title, status)
values (ovd979u2_test.id(10), ovd979u2_test.id(1), ovd979u2_test.id(2), 'U2 locks', 'uploaded');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind, trusted_content_sha256
)
select ovd979u2_test.id(n), ovd979u2_test.id(10), ovd979u2_test.id(1), ovd979u2_test.id(2),
  'job-files', 'ovd979u2/' || n, 'u2-' || n || '.step', 'u2-' || n, 'cad', repeat('a', 64)
from generate_series(21, 22) n;
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
select ovd979u2_test.id(n + 10), ovd979u2_test.id(10), ovd979u2_test.id(1),
  'u2-' || n, 'u2-' || n, ovd979u2_test.id(n)
from generate_series(21, 22) n;
-- Trusted identical CAD hashes create one complete version shared by both placements.
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
select ovd979u2_test.id(n), ovd979u2_test.id(1), 'ovd979u2-fixture',
  '{"description":"Auto description","partNumber":"AUTO-PN","revision":"A","material":{"normalized":"Aluminum"}}',
  'needs_review'
from generate_series(31, 32) n;
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, description, material, quantity, spec_snapshot
)
select ovd979u2_test.id(n), ovd979u2_test.id(1), ovd979u2_test.id(2), 'Existing', 'Aluminum', 1,
  '{"fieldSources":{"description":"auto"},"projectPartProperties":{"defaults":{"description":"Default description","material":"Aluminum"},"overrides":{"description":"Override description"}}}'
from generate_series(31, 32) n;

create function ovd979u2_test.call(p_kind text) returns text language plpgsql as $$
declare
  -- Evaluated on entry, before any role switch below.
  c_job constant uuid := ovd979u2_test.id(10);
  c_part_a constant uuid := ovd979u2_test.id(31);
  c_part_b constant uuid := ovd979u2_test.id(32);
  c_material constant text := 'Aluminum';
  result text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', ovd979u2_test.id(2), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  if p_kind = 'reuse' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('role', 'service_role', true);
    select public.api_reuse_trusted_part_version_artifacts(
      c_part_b, c_part_a, (select part_version_id from public.parts where id = c_part_b)
    )->>'result' into result;
  elsif p_kind = 'auto' then
    perform set_config('role', 'service_role', true);
    result := public.api_auto_approve_job_requirements(c_job)::text;
  else
    perform set_config('role', 'authenticated', true);
    if p_kind = 'approve' then
      -- Deliberately reverse part order and repeat one part: last input still wins.
      result := public.api_approve_job_requirements(c_job, jsonb_build_array(
        jsonb_build_object('partId', c_part_b, 'material', c_material, 'quantity', 2),
        jsonb_build_object('partId', c_part_a, 'material', c_material, 'quantity', 3),
        jsonb_build_object('partId', c_part_b, 'description', 'Staff description',
          'material', c_material, 'quoteQuantities', jsonb_build_array(5, 10))))::text;
    elsif p_kind = 'request' then
      result := public.api_request_extraction(c_job)::text;
    elsif p_kind = 'reset' then
      result := public.api_reset_client_part_property_overrides(c_job, array['description'])::text;
    else
      raise exception 'Unknown U2 test call %', p_kind;
    end if;
  end if;
  return result;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;
-- The invoker switches to the real caller role. Helpers hold no elevated privilege.
grant usage on schema ovd979u2_test to authenticated, service_role;
-- dblink sessions log in as a fixture role whose password is generated here and
-- never written down. ovd.test_conninfo still picks the host, port and database.
select set_config('ovd979u2.password', encode(extensions.gen_random_bytes(24), 'hex'), false);
do $$
begin
  execute format('create role ovd979u2_tap login password %L in role authenticated, service_role',
    current_setting('ovd979u2.password'));
end;
$$;
-- Test-only hook: pause api_request_extraction right after its queue insert,
-- holding whatever it locked so far, while a session-level advisory lock is held.
create function ovd979u2_test.pause_after_insert() returns trigger language plpgsql as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(979, 2);
  return null;
end;
$$;
create trigger ovd979u2_pause_after_insert after insert on public.work_queue
for each row when (current_setting('ovd979u2.pause', true) = 'on')
execute function ovd979u2_test.pause_after_insert();
commit;

select plan(53);

create function pg_temp.u2_connect(p_name text) returns void language plpgsql as $$
begin
  perform extensions.dblink_connect(p_name,
    coalesce(nullif(current_setting('ovd.test_conninfo', true), ''),
      'host=host.docker.internal port=54322 dbname=postgres')
    || format(' user=ovd979u2_tap password=%s', current_setting('ovd979u2.password')));
  -- service_role bypasses RLS like the worker; call() switches roles per RPC.
  perform extensions.dblink_exec(p_name, 'set role service_role');
end;
$$;

-- Session names, transaction settings, the error-result pattern and cleanup are defined once.
create function pg_temp.u2_a() returns text language sql immutable as $$ select 'ovd979u2_a' $$;
create function pg_temp.u2_b() returns text language sql immutable as $$ select 'ovd979u2_b' $$;
create function pg_temp.u2_pid(p_name text) returns integer language sql as $$
  select pid from extensions.dblink(p_name, 'select pg_backend_pid()') as r(pid integer)
$$;
-- Opens both sessions and returns their backend pids as (a, b).
create function pg_temp.u2_open(out a integer, out b integer) language plpgsql as $$
begin
  perform pg_temp.u2_connect(pg_temp.u2_a());
  perform pg_temp.u2_connect(pg_temp.u2_b());
  a := pg_temp.u2_pid(pg_temp.u2_a());
  b := pg_temp.u2_pid(pg_temp.u2_b());
end;
$$;
create function pg_temp.u2_begin(p_name text, p_settings text default '') returns void language plpgsql as $$
begin
  perform extensions.dblink_exec(p_name,
    'begin; ' || p_settings || 'set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
end;
$$;
create function pg_temp.u2_send_call(p_name text, p_kind text) returns void language plpgsql as $$
begin
  perform extensions.dblink_send_query(p_name, format('select ovd979u2_test.call(%L)', p_kind));
end;
$$;
-- Waits until session p_waiter is observed with an ungranted lock blocked by p_blocker
-- (a real lock wait, not just a busy connection), or until its query finished.
create function pg_temp.u2_wait_blocked(p_name text, p_waiter integer, p_blocker integer, p_tries integer)
returns boolean language plpgsql as $$
declare
  waited boolean := false;
begin
  for i in 1..p_tries loop
    select exists (select 1 from pg_catalog.pg_locks
      where pid = p_waiter and not granted and p_blocker = any(pg_catalog.pg_blocking_pids(p_waiter))) into waited;
    exit when waited or extensions.dblink_is_busy(p_name) = 0;
    perform pg_sleep(0.01);
  end loop;
  return waited;
end;
$$;
-- The result of the session's pending query, after which the session is rolled back.
create function pg_temp.u2_finish(p_name text) returns text language plpgsql as $$
declare
  outcome text;
begin
  select result into outcome from extensions.dblink_get_result(p_name) as r(result text);
  perform * from extensions.dblink_get_result(p_name) as r(result text);
  perform extensions.dblink_exec(p_name, 'rollback');
  return outcome;
end;
$$;
-- call() returns every error as "SQLSTATE: message".
create function pg_temp.u2_failed(p_result text) returns boolean language sql immutable as $$
  select p_result ~ '^[0-9A-Z]{5}:'
$$;
create function pg_temp.u2_disconnect_all() returns void language plpgsql as $$
declare
  name text;
begin
  foreach name in array array[pg_temp.u2_a(), pg_temp.u2_b()] loop
    if name = any(coalesce(extensions.dblink_get_connections(), '{}')) then
      perform extensions.dblink_disconnect(name);
    end if;
  end loop;
end;
$$;

create function pg_temp.u2_pair(p_holder text, p_waiter text) returns setof text language plpgsql as $$
declare
  s record;
  label constant text := p_holder || ' x ' || p_waiter;
  holder_result text;
  waiter_result text;
begin
  select * into s from pg_temp.u2_open();
  perform pg_temp.u2_begin(pg_temp.u2_a());
  perform pg_temp.u2_begin(pg_temp.u2_b());
  select result into holder_result from extensions.dblink(pg_temp.u2_a(),
    format('select ovd979u2_test.call(%L)', p_holder)) as r(result text);
  perform pg_temp.u2_send_call(pg_temp.u2_b(), p_waiter);
  return next ok(pg_temp.u2_wait_blocked(pg_temp.u2_b(), s.b, s.a, 100),
    label || ': second session observed waiting in pg_locks');
  perform extensions.dblink_exec(pg_temp.u2_a(), 'rollback');
  waiter_result := pg_temp.u2_finish(pg_temp.u2_b());
  return next ok(not pg_temp.u2_failed(holder_result) and not pg_temp.u2_failed(waiter_result),
    label || ': both RPCs succeed, no 40P01 or lock timeout (' || holder_result || ', ' || waiter_result || ')');
  perform pg_temp.u2_disconnect_all();
exception when others then
  perform pg_temp.u2_disconnect_all();
  raise;
end;
$$;
-- A job-lock holder must still be able to take every lower-level row while
-- each changed RPC waits at L1. These assertions fail on the prior bodies,
-- unlike tests that only call an RPC after another RPC has finished its writes.
create function ovd979u2_test.probe_lower() returns text language plpgsql as $$
begin
  perform 1 from public.parts where job_id = ovd979u2_test.id(10) order by id for update;
  perform 1 from public.approved_part_requirements
  where organization_id = ovd979u2_test.id(1) order by part_id for update;
  perform 1 from public.drawing_extractions
  where organization_id = ovd979u2_test.id(1) order by part_id for update;
  return 'clear';
exception when lock_not_available then return sqlstate;
end;
$$;
create function pg_temp.u2_first_lock(p_kind text) returns setof text language plpgsql as $$
declare
  s record;
  probe text;
  result text;
begin
  select * into s from pg_temp.u2_open();
  perform extensions.dblink_exec(pg_temp.u2_a(), 'begin; set local lock_timeout = ''250ms''');
  perform * from extensions.dblink(pg_temp.u2_a(), format(
    'select id from public.jobs where id = %L for no key update', ovd979u2_test.id(10))) as r(id uuid);
  perform pg_temp.u2_begin(pg_temp.u2_b());
  perform pg_temp.u2_send_call(pg_temp.u2_b(), p_kind);
  return next ok(pg_temp.u2_wait_blocked(pg_temp.u2_b(), s.b, s.a, 100),
    p_kind || ': RPC waits behind the held job lock');
  select outcome into probe from extensions.dblink(pg_temp.u2_a(),
    'select ovd979u2_test.probe_lower()') as r(outcome text);
  return next is(probe, 'clear', p_kind || ': waiting RPC holds no L2/L3/L4 row');
  perform extensions.dblink_exec(pg_temp.u2_a(), 'rollback');
  result := pg_temp.u2_finish(pg_temp.u2_b());
  return next ok(not pg_temp.u2_failed(result), p_kind || ': completes after L1 release (' || result || ')');
  perform pg_temp.u2_disconnect_all();
exception when others then
  perform pg_temp.u2_disconnect_all();
  raise;
end;
$$;
select * from pg_temp.u2_first_lock('approve');
select * from pg_temp.u2_first_lock('auto');
select * from pg_temp.u2_first_lock('reset');
select * from pg_temp.u2_first_lock('reuse');

select * from pg_temp.u2_pair('approve', 'request');
select * from pg_temp.u2_pair('request', 'approve');
select * from pg_temp.u2_pair('approve', 'auto');
select * from pg_temp.u2_pair('auto', 'approve');
select * from pg_temp.u2_pair('approve', 'reset');
select * from pg_temp.u2_pair('reset', 'approve');
select * from pg_temp.u2_pair('reuse', 'request');
select * from pg_temp.u2_pair('request', 'reuse');

-- Mid-function interleaving: request pauses after its queue insert (holding its
-- parts key-share and reconcile locks), then approval or auto approval starts.
-- Before U2 approval took L1 and then waited on those parts while request's final
-- jobs update waited on L1: 40P01. Now the second RPC waits at L1 behind request.
create function pg_temp.u2_interleave(p_second text) returns setof text language plpgsql as $$
declare
  s record;
  label constant text := p_second || ' interleave';
  paused boolean := false;
  request_result text;
  second_result text;
begin
  perform pg_catalog.pg_advisory_lock(979, 2);
  select * into s from pg_temp.u2_open();
  perform pg_temp.u2_begin(pg_temp.u2_b(), 'set local ovd979u2.pause = ''on''; ');
  perform pg_temp.u2_send_call(pg_temp.u2_b(), 'request');
  for i in 1..200 loop
    select exists (select 1 from pg_catalog.pg_locks
      where pid = s.b and locktype = 'advisory' and not granted) into paused;
    exit when paused or extensions.dblink_is_busy(pg_temp.u2_b()) = 0;
    perform pg_sleep(0.01);
  end loop;
  return next ok(paused, label || ': request paused after its queue insert');
  perform pg_temp.u2_begin(pg_temp.u2_a());
  perform pg_temp.u2_send_call(pg_temp.u2_a(), p_second);
  return next ok(pg_temp.u2_wait_blocked(pg_temp.u2_a(), s.a, s.b, 200),
    label || ': second RPC waits behind the paused request');
  perform pg_catalog.pg_advisory_unlock(979, 2);
  request_result := pg_temp.u2_finish(pg_temp.u2_b());
  second_result := pg_temp.u2_finish(pg_temp.u2_a());
  return next ok(not pg_temp.u2_failed(request_result) and not pg_temp.u2_failed(second_result),
    label || ': both finish, no 40P01 or lock timeout (' || request_result || ', ' || second_result || ')');
  perform pg_temp.u2_disconnect_all();
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  perform pg_temp.u2_disconnect_all();
  raise;
end;
$$;
-- Committed so the dblink sessions see it: part 31 has no extraction, so request
-- queues a task and fires the hook. Both sessions roll back; the row returns below.
create temp table u2_extraction as
select * from public.drawing_extractions where part_id = ovd979u2_test.id(31);
delete from public.drawing_extractions where part_id = ovd979u2_test.id(31);
select * from pg_temp.u2_interleave('approve');
select * from pg_temp.u2_interleave('auto');
insert into public.drawing_extractions select * from u2_extraction;

-- Observable behavior, including both auto-approval branches, quantities and ACLs.
begin;
select is(ovd979u2_test.call('approve'), '3', 'staff approval still counts duplicate inputs');
reset role;
select is((select quantity from public.parts where id = ovd979u2_test.id(32)), 5,
  'last duplicate quantity wins');
select is((select description from public.approved_part_requirements where part_id = ovd979u2_test.id(32)),
  'Staff description', 'last duplicate requirement wins');
select is((select count(*)::integer from public.drawing_extractions
  where organization_id = ovd979u2_test.id(1) and status = 'approved'), 2, 'staff approval approves both extractions');
rollback;
begin;
select is(ovd979u2_test.call('reset'), ovd979u2_test.id(10)::text, 'reset returns its job');
reset role;
select is((select description from public.approved_part_requirements where part_id = ovd979u2_test.id(31)),
  'Default description', 'reset restores the property default');
rollback;
begin;
delete from public.approved_part_requirements where organization_id = ovd979u2_test.id(1);
update public.drawing_extractions set extraction = '{"extractedDescriptionRaw":{"reviewNeeded":true}}'
where part_id = ovd979u2_test.id(31);
select is(ovd979u2_test.call('auto'), '1', 'auto approval retains its review blocker branch');
reset role;
select is((select status::text from public.jobs where id = ovd979u2_test.id(10)), 'needs_spec_review',
  'unapproved parts still require review');
select is((select status::text from public.drawing_extractions where part_id = ovd979u2_test.id(31)),
  'needs_review', 'review-blocked extraction remains unapproved');
rollback;
begin;
delete from public.approved_part_requirements where organization_id = ovd979u2_test.id(1);
select is(ovd979u2_test.call('auto'), '2', 'auto approval still creates both missing requirements');
reset role;
select is((select status::text from public.jobs where id = ovd979u2_test.id(10)), 'ready_to_quote',
  'status rollup counts the staged inserts as approved');
rollback;
select ok(not has_function_privilege('anon', 'public.api_approve_job_requirements(uuid,jsonb)', 'execute'),
  'anon cannot approve');
select ok(not has_function_privilege('authenticated', 'public.api_auto_approve_job_requirements(uuid)', 'execute'),
  'authenticated cannot call worker auto approval');
select ok(not has_function_privilege('authenticated', 'public.api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)', 'execute'),
  'authenticated cannot call trusted worker reuse');
select ok(has_function_privilege('authenticated', 'public.api_reset_client_part_property_overrides(uuid,text[])', 'execute'),
  'authenticated retains reset execute');
select ok(has_function_privilege('authenticated', 'public.api_request_extraction(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_request_extraction(uuid)', 'execute'),
  'request keeps authenticated execute and stays closed to anon');
select ok((select bool_and(proconfig = array['search_path=pg_catalog, public']) from pg_catalog.pg_proc
  where oid in ('public.api_approve_job_requirements(uuid,jsonb)'::regprocedure,
    'public.api_auto_approve_job_requirements(uuid)'::regprocedure,
    'public.api_request_extraction(uuid)'::regprocedure,
    'public.api_reset_client_part_property_overrides(uuid,text[])'::regprocedure)),
  'approve, auto approve, request and reset pin pg_catalog, public');
select is((select proconfig from pg_catalog.pg_proc
  where oid = 'public.api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)'::regprocedure),
  array['search_path=pg_catalog'], 'reuse keeps its pg_catalog-only path');

-- Cleanup only rows created above; a failed run requires its owning disposable fixture cleanup.
begin;
delete from public.work_queue where organization_id = ovd979u2_test.id(1);
delete from public.parts where organization_id = ovd979u2_test.id(1);
delete from public.part_versions where organization_id = ovd979u2_test.id(1);
delete from public.canonical_parts where organization_id = ovd979u2_test.id(1);
delete from public.jobs where organization_id = ovd979u2_test.id(1);
delete from public.audit_events where organization_id = ovd979u2_test.id(1);
delete from public.organizations where id = ovd979u2_test.id(1);
delete from auth.users where id = ovd979u2_test.id(2);
drop schema ovd979u2_test cascade;
drop role ovd979u2_tap;
commit;
select ok(not exists(select 1 from public.organizations where id = '97920000-0000-4000-8000-000000000001'),
  'committed synthetic fixture removed');
select * from finish();
