-- OVD-979 U2: committed, exclusively owned synthetic fixtures for real dblink waits.
-- Run only on a disposable local database with repository migrations applied.
-- Each RPC pair is run in both holder/waiter directions; both transactions roll back.
-- This proves contention at the RPC boundary, not every internal U5 request interleaving.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
set statement_timeout = '30s';

begin;
-- Fail on collisions rather than deleting an earlier run's resources.
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
declare result text;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"97920000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
  if p_kind = 'reuse' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('role', 'service_role', true);
    select public.api_reuse_trusted_part_version_artifacts(
      '97920000-0000-4000-8000-000000000032', '97920000-0000-4000-8000-000000000031',
      (select part_version_id from public.parts where id = '97920000-0000-4000-8000-000000000032')
    )->>'result' into result;
  elsif p_kind = 'auto' then
    perform set_config('role', 'service_role', true);
    result := public.api_auto_approve_job_requirements('97920000-0000-4000-8000-000000000010')::text;
  else
    perform set_config('role', 'authenticated', true);
    if p_kind = 'approve' then
      -- Deliberately reverse part order and repeat one part: last input still wins.
      result := public.api_approve_job_requirements('97920000-0000-4000-8000-000000000010',
        '[{"partId":"97920000-0000-4000-8000-000000000032","material":"Aluminum","quantity":2},
          {"partId":"97920000-0000-4000-8000-000000000031","material":"Aluminum","quantity":3},
          {"partId":"97920000-0000-4000-8000-000000000032","description":"Staff description","material":"Aluminum","quoteQuantities":[5,10]}]')::text;
    elsif p_kind = 'request' then
      result := public.api_request_extraction('97920000-0000-4000-8000-000000000010')::text;
    elsif p_kind = 'reset' then
      result := public.api_reset_client_part_property_overrides(
        '97920000-0000-4000-8000-000000000010', array['description'])::text;
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

create function pg_temp.u2_pair(p_holder text, p_waiter text) returns setof text language plpgsql as $$
declare
  a integer;
  b integer;
  holder_result text;
  waiter_result text;
  waited boolean := false;
begin
  perform pg_temp.u2_connect('ovd979u2_a');
  perform pg_temp.u2_connect('ovd979u2_b');
  select pid into a from extensions.dblink('ovd979u2_a', 'select pg_backend_pid()') as r(pid integer);
  select pid into b from extensions.dblink('ovd979u2_b', 'select pg_backend_pid()') as r(pid integer);
  perform extensions.dblink_exec('ovd979u2_a', 'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
  perform extensions.dblink_exec('ovd979u2_b', 'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
  select result into holder_result from extensions.dblink('ovd979u2_a',
    format('select ovd979u2_test.call(%L)', p_holder)) as r(result text);
  perform extensions.dblink_send_query('ovd979u2_b', format('select ovd979u2_test.call(%L)', p_waiter));
  for i in 1..100 loop
    -- Observe a real ungranted lock and its actual blocker, not just a busy connection.
    select exists (select 1 from pg_catalog.pg_locks
      where pid = b and not granted and a = any(pg_catalog.pg_blocking_pids(b))) into waited;
    exit when waited or extensions.dblink_is_busy('ovd979u2_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  return next ok(waited, p_holder || ' x ' || p_waiter || ': second session observed waiting in pg_locks');
  perform extensions.dblink_exec('ovd979u2_a', 'rollback');
  select result into waiter_result from extensions.dblink_get_result('ovd979u2_b') as r(result text);
  perform * from extensions.dblink_get_result('ovd979u2_b') as r(result text);
  perform extensions.dblink_exec('ovd979u2_b', 'rollback');
  return next ok(holder_result !~ '^[0-9A-Z]{5}:' and waiter_result !~ '^[0-9A-Z]{5}:',
    p_holder || ' x ' || p_waiter || ': both RPCs succeed, no 40P01 or lock timeout (' || holder_result || ', ' || waiter_result || ')');
  perform extensions.dblink_disconnect('ovd979u2_a');
  perform extensions.dblink_disconnect('ovd979u2_b');
exception when others then
  if 'ovd979u2_a' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_a');
  end if;
  if 'ovd979u2_b' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_b');
  end if;
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
  a integer;
  b integer;
  waited boolean := false;
  probe text;
  result text;
begin
  perform pg_temp.u2_connect('ovd979u2_a');
  perform pg_temp.u2_connect('ovd979u2_b');
  select pid into a from extensions.dblink('ovd979u2_a', 'select pg_backend_pid()') as r(pid integer);
  select pid into b from extensions.dblink('ovd979u2_b', 'select pg_backend_pid()') as r(pid integer);
  perform extensions.dblink_exec('ovd979u2_a', 'begin; set local lock_timeout = ''250ms''');
  perform * from extensions.dblink('ovd979u2_a',
    'select id from public.jobs where id = ''97920000-0000-4000-8000-000000000010'' for no key update') as r(id uuid);
  perform extensions.dblink_exec('ovd979u2_b', 'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
  perform extensions.dblink_send_query('ovd979u2_b', format('select ovd979u2_test.call(%L)', p_kind));
  for i in 1..100 loop
    select exists (select 1 from pg_catalog.pg_locks
      where pid = b and not granted and a = any(pg_catalog.pg_blocking_pids(b))) into waited;
    exit when waited or extensions.dblink_is_busy('ovd979u2_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  return next ok(waited, p_kind || ': RPC waits behind the held job lock');
  select outcome into probe from extensions.dblink('ovd979u2_a',
    'select ovd979u2_test.probe_lower()') as r(outcome text);
  return next is(probe, 'clear', p_kind || ': waiting RPC holds no L2/L3/L4 row');
  perform extensions.dblink_exec('ovd979u2_a', 'rollback');
  select outcome into result from extensions.dblink_get_result('ovd979u2_b') as r(outcome text);
  perform * from extensions.dblink_get_result('ovd979u2_b') as r(outcome text);
  perform extensions.dblink_exec('ovd979u2_b', 'rollback');
  return next ok(result !~ '^[0-9A-Z]{5}:', p_kind || ': completes after L1 release (' || result || ')');
  perform extensions.dblink_disconnect('ovd979u2_a');
  perform extensions.dblink_disconnect('ovd979u2_b');
exception when others then
  if 'ovd979u2_a' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_a');
  end if;
  if 'ovd979u2_b' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_b');
  end if;
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
  a integer;
  b integer;
  paused boolean := false;
  waited boolean := false;
  request_result text;
  second_result text;
begin
  perform pg_catalog.pg_advisory_lock(979, 2);
  perform pg_temp.u2_connect('ovd979u2_a');
  perform pg_temp.u2_connect('ovd979u2_b');
  select pid into a from extensions.dblink('ovd979u2_a', 'select pg_backend_pid()') as r(pid integer);
  select pid into b from extensions.dblink('ovd979u2_b', 'select pg_backend_pid()') as r(pid integer);
  perform extensions.dblink_exec('ovd979u2_b',
    'begin; set local ovd979u2.pause = ''on''; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
  perform extensions.dblink_send_query('ovd979u2_b', 'select ovd979u2_test.call(''request'')');
  for i in 1..200 loop
    select exists (select 1 from pg_catalog.pg_locks
      where pid = b and locktype = 'advisory' and not granted) into paused;
    exit when paused or extensions.dblink_is_busy('ovd979u2_b') = 0;
    perform pg_sleep(0.01);
  end loop;
  return next ok(paused, p_second || ' interleave: request paused after its queue insert');
  perform extensions.dblink_exec('ovd979u2_a',
    'begin; set local lock_timeout = ''5s''; set local statement_timeout = ''10s''');
  perform extensions.dblink_send_query('ovd979u2_a', format('select ovd979u2_test.call(%L)', p_second));
  for i in 1..200 loop
    select exists (select 1 from pg_catalog.pg_locks
      where pid = a and not granted and b = any(pg_catalog.pg_blocking_pids(a))) into waited;
    exit when waited or extensions.dblink_is_busy('ovd979u2_a') = 0;
    perform pg_sleep(0.01);
  end loop;
  return next ok(waited, p_second || ' interleave: second RPC waits behind the paused request');
  perform pg_catalog.pg_advisory_unlock(979, 2);
  select result into request_result from extensions.dblink_get_result('ovd979u2_b') as r(result text);
  perform * from extensions.dblink_get_result('ovd979u2_b') as r(result text);
  perform extensions.dblink_exec('ovd979u2_b', 'rollback');
  select result into second_result from extensions.dblink_get_result('ovd979u2_a') as r(result text);
  perform * from extensions.dblink_get_result('ovd979u2_a') as r(result text);
  perform extensions.dblink_exec('ovd979u2_a', 'rollback');
  return next ok(request_result !~ '^[0-9A-Z]{5}:' and second_result !~ '^[0-9A-Z]{5}:',
    p_second || ' interleave: both finish, no 40P01 or lock timeout (' || request_result || ', ' || second_result || ')');
  perform extensions.dblink_disconnect('ovd979u2_a');
  perform extensions.dblink_disconnect('ovd979u2_b');
exception when others then
  perform pg_catalog.pg_advisory_unlock_all();
  if 'ovd979u2_a' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_a');
  end if;
  if 'ovd979u2_b' = any(extensions.dblink_get_connections()) then
    perform extensions.dblink_disconnect('ovd979u2_b');
  end if;
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
