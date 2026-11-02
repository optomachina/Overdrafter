-- OVD-979 U4: auto approval's L2/L3/L4 write-phase prelocks stay FOR NO KEY UPDATE
-- (docs/ovd979-lock-order.md), so foreign-key checks (KEY SHARE) from concurrent
-- child inserts do not wait on them.
-- Committed, exclusively owned synthetic fixtures (an independent session cannot
-- see uncommitted ones); run only on a disposable local database with repository
-- migrations applied. Against a FOR UPDATE body both probes fail with 55P03.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
set statement_timeout = '30s';

begin;
-- Fixed ids fail on collision rather than reusing an earlier run's rows.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97941000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'u4-lock@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values ('97941000-0000-4000-8000-000000000002', 'U4 lock synthetic org', 'ovd979-u4-lock');
insert into public.jobs (id, organization_id, created_by, title, status)
values ('97941000-0000-4000-8000-000000000003', '97941000-0000-4000-8000-000000000002',
  '97941000-0000-4000-8000-000000000001', 'U4 lock synthetic job', 'extracting');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('97941000-0000-4000-8000-000000000004', '97941000-0000-4000-8000-000000000003',
  '97941000-0000-4000-8000-000000000002', 'U4 lock part', 'u4-lock-part');
insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction)
values ('97941000-0000-4000-8000-000000000004', '97941000-0000-4000-8000-000000000002', 'worker-pdf-u4',
  '{"description":"LOCK DESC","partNumber":"LOCK-PN","revision":"A","quoteFinish":"LOCK FINISH","material":{"normalized":"Aluminum 6061-T6"}}'::jsonb);
-- dblink sessions log in as a fixture role whose password is generated here and
-- never written down. ovd.test_conninfo still picks the host, port and database.
select set_config('ovd979u4.password', encode(extensions.gen_random_bytes(24), 'hex'), false);
do $$
begin
  execute format('create role ovd979u4_tap login password %L in role service_role',
    current_setting('ovd979u4.password'));
end;
$$;
commit;

-- With no active task, the stored extraction is ordinary evidence: this commits
-- the requirement so the checked call below prelocks a row in every phase.
do $$ begin perform public.api_auto_approve_job_requirements('97941000-0000-4000-8000-000000000003'); end $$;

begin;
select plan(6);

select is((select count(*)::integer from public.approved_part_requirements
  where part_id = '97941000-0000-4000-8000-000000000004'), 1, 'fixture requirement committed');

do $$ begin perform public.api_auto_approve_job_requirements('97941000-0000-4000-8000-000000000003'); end $$;

-- A concurrent child insert takes KEY SHARE on the part (and the job) for its
-- foreign keys. It must not wait on the locks this transaction now holds.
create function pg_temp.u4_remote(p_sql text) returns text language plpgsql as $$
begin
  perform extensions.dblink_exec('ovd979u4', 'begin');
  perform extensions.dblink_exec('ovd979u4', 'set local lock_timeout = ''2s''');
  perform extensions.dblink_exec('ovd979u4', p_sql);
  perform extensions.dblink_exec('ovd979u4', 'rollback');
  return 'ok';
exception when others then
  perform extensions.dblink_exec('ovd979u4', 'rollback');
  return sqlstate || ': ' || sqlerrm;
end;
$$;
select is(extensions.dblink_connect('ovd979u4',
  coalesce(nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres')
  || format(' user=ovd979u4_tap password=%s', current_setting('ovd979u4.password'))), 'OK',
  'independent session connected');
select is(extensions.dblink_exec('ovd979u4', 'set role service_role'), 'SET', 'independent session runs as service_role');
select is(pg_temp.u4_remote($sql$
  insert into public.work_queue (organization_id, job_id, part_id, task_type)
  values ('97941000-0000-4000-8000-000000000002', '97941000-0000-4000-8000-000000000003',
    '97941000-0000-4000-8000-000000000004', 'extract_part')
$sql$), 'ok', 'concurrent work_queue insert for the part does not wait on approval locks');
select is(pg_temp.u4_remote($sql$
  insert into public.drawing_preview_assets (part_id, organization_id, storage_path)
  values ('97941000-0000-4000-8000-000000000004', '97941000-0000-4000-8000-000000000002', 'synthetic/u4-lock/page-1.png')
$sql$), 'ok', 'concurrent preview insert for the part does not wait on approval locks');
select is(extensions.dblink_disconnect('ovd979u4'), 'OK', 'independent session closed');

select * from finish();
rollback;

-- Cleanup only rows created above; a failed run requires its owning disposable fixture cleanup.
begin;
delete from public.audit_events where organization_id = '97941000-0000-4000-8000-000000000002';
delete from public.approved_part_requirements where part_id = '97941000-0000-4000-8000-000000000004';
delete from public.drawing_extractions where part_id = '97941000-0000-4000-8000-000000000004';
delete from public.parts where id = '97941000-0000-4000-8000-000000000004';
delete from public.jobs where id = '97941000-0000-4000-8000-000000000003';
delete from public.organizations where id = '97941000-0000-4000-8000-000000000002';
delete from auth.users where id = '97941000-0000-4000-8000-000000000001';
drop role ovd979u4_tap;
commit;
