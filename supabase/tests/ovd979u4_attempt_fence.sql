-- OVD-979 U4: the worker's extraction write is fenced to the attempt that claimed the task.
-- api_save_drawing_extraction_for_attempt writes, then holds the task's work_queue row
-- FOR SHARE until commit. Two real sessions show that a reap cannot land between the
-- write and the check, and that a late write from the reaped attempt is refused.
-- Committed, exclusively owned synthetic fixtures (an independent session cannot
-- see uncommitted ones); run only on a disposable local database with repository
-- migrations applied. Statements autocommit so each step is visible to the other session.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
set statement_timeout = '30s';

begin;
-- Fixed ids fail on collision rather than reusing an earlier run's rows.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97942000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'u4-fence@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values ('97942000-0000-4000-8000-000000000002', 'U4 fence synthetic org', 'ovd979-u4-fence');
insert into public.jobs (id, organization_id, created_by, title, status)
values ('97942000-0000-4000-8000-000000000003', '97942000-0000-4000-8000-000000000002',
  '97942000-0000-4000-8000-000000000001', 'U4 fence synthetic job', 'extracting');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('97942000-0000-4000-8000-000000000004', '97942000-0000-4000-8000-000000000003',
  '97942000-0000-4000-8000-000000000002', 'U4 fence part', 'u4-fence-part');
-- Attempt A (…0011) holds the claim.
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, attempt_id, locked_at, locked_by, payload)
values ('97942000-0000-4000-8000-000000000010', '97942000-0000-4000-8000-000000000002',
  '97942000-0000-4000-8000-000000000003', '97942000-0000-4000-8000-000000000004', 'extract_part', 'running',
  '97942000-0000-4000-8000-000000000011', now(), 'u4-fence-worker', '{}'::jsonb);
-- dblink sessions log in as a fixture role whose password is generated here and
-- never written down. ovd.test_conninfo still picks the host, port and database.
select set_config('ovd979u4f.password', encode(extensions.gen_random_bytes(24), 'hex'), false) is not null as password_generated;
do $$
begin
  execute format('create role ovd979u4f_tap login password %L in role service_role',
    current_setting('ovd979u4f.password'));
end;
$$;
commit;

select plan(9);

-- Reaps the task (requeue) under a short lock_timeout; returns 'ok' or the SQLSTATE.
create function pg_temp.u4_reap() returns text language plpgsql as $$
begin
  perform set_config('lock_timeout', '1s', true);
  update public.work_queue set status = 'queued', attempt_id = null
  where id = '97942000-0000-4000-8000-000000000010';
  perform set_config('lock_timeout', '0', true);
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

select is(extensions.dblink_connect('ovd979u4f',
  coalesce(nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres')
  || format(' user=ovd979u4f_tap password=%s', current_setting('ovd979u4f.password'))), 'OK',
  'independent worker session connected');
select is(extensions.dblink_exec('ovd979u4f', 'set role service_role'), 'SET', 'independent worker session runs as service_role');
select is(extensions.dblink_exec('ovd979u4f', 'set request.jwt.claim.role = ''service_role'''), 'SET',
  'independent worker session carries the service_role claim');

-- Attempt A saves inside an open transaction: written and fenced, not yet committed.
select extensions.dblink_exec('ovd979u4f', 'begin');
select is((select saved from extensions.dblink('ovd979u4f', $sql$
  select public.api_save_drawing_extraction_for_attempt('97942000-0000-4000-8000-000000000010',
    '97942000-0000-4000-8000-000000000011',
    '{"extractor_version": "u4-fence-a", "extraction": {"attempt": "a"}, "warnings": [], "evidence": [], "status": "approved"}')
$sql$) as remote(saved boolean)), true, 'attempt A writes while it is the running attempt');
select is(pg_temp.u4_reap(), '55P03', 'a reap cannot land between attempt A''s write and its commit');
select extensions.dblink_exec('ovd979u4f', 'commit');

-- The reap now goes through and attempt B (…0012) reclaims the task.
update public.work_queue set status = 'running', attempt_id = '97942000-0000-4000-8000-000000000012'
where id = '97942000-0000-4000-8000-000000000010';
select is((select source_attempt_id from public.drawing_extractions where part_id = '97942000-0000-4000-8000-000000000004'),
  '97942000-0000-4000-8000-000000000011'::uuid, 'attempt A''s committed write carries attempt A');

-- Attempt A's late second write (its own retry of the save) is refused and rolled back.
select is((select saved from extensions.dblink('ovd979u4f', $sql$
  select public.api_save_drawing_extraction_for_attempt('97942000-0000-4000-8000-000000000010',
    '97942000-0000-4000-8000-000000000011',
    '{"extractor_version": "u4-fence-a-late", "extraction": {"attempt": "a-late"}, "warnings": [], "evidence": [], "status": "approved"}')
$sql$) as remote(saved boolean)), false, 'the reaped attempt A is refused after B reclaims');
select is((select extractor_version from public.drawing_extractions where part_id = '97942000-0000-4000-8000-000000000004'),
  'u4-fence-a', 'the refused late write left nothing behind');
select is(extensions.dblink_disconnect('ovd979u4f'), 'OK', 'independent worker session closed');

select * from finish();

-- Cleanup only rows created above; a failed run requires its owning disposable fixture cleanup.
begin;
delete from public.drawing_extractions where part_id = '97942000-0000-4000-8000-000000000004';
delete from public.work_queue where id = '97942000-0000-4000-8000-000000000010';
delete from public.parts where id = '97942000-0000-4000-8000-000000000004';
delete from public.jobs where id = '97942000-0000-4000-8000-000000000003';
delete from public.organizations where id = '97942000-0000-4000-8000-000000000002';
delete from auth.users where id = '97942000-0000-4000-8000-000000000001';
drop role ovd979u4f_tap;
commit;
