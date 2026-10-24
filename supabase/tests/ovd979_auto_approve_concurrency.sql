-- OVD-979 fix round 7: two-session races for the migrations
--   supabase/migrations/20261020002126_ovd979_auto_approve_keep_user_corrections.sql
--   supabase/migrations/20261020002127_ovd979_request_extraction_drawing_attached.sql
-- (byte copies of docs/migration-drafts/ovd-979-a.sql and ovd-979-b.sql; notes:
-- docs/migration-drafts/ovd-979-notes.md, "Fix round 7").
--
-- ovd979_reextraction_provenance.sql is one rolled-back transaction, which a
-- second session cannot see, so the races live here, in the dblink style of the
-- other *_concurrency.sql files: the fixtures are committed and removed again at
-- the start and the end.
--
--   R1-R4  a client save that commits while auto-approval waits for it is not
--          overwritten (on the fix round 6 bytes auto-approval read the
--          requirement before the save committed and its upsert wrote the stale
--          values back, dropping the override keys: R3 and R4 fail there).
--   S1-S3  a reset that waits for auto-approval reads what auto-approval
--          committed (on the fix round 6 bytes the reset wrote back the editor
--          defaults it had read before: S3 fails there).
--   E1-E2  a request for extraction and auto-approval of the same job wait for
--          each other without a deadlock (both lock the job row first).
--   D1-D4  a drawing attached while the CAD-only extraction is still running is
--          deferred and released when that task settles, also when the
--          settlement commits while the request is still open (on the fix
--          round 6 bytes nothing is queued: D1 fails there).
--   C0-C3  two parts of one job with real clocks: a retried attach task that
--          still holds its failed attempt's extraction is not "finishing" when
--          the other part's auto-approval runs, and that run does not touch the
--          retry's old row (on the fix round 6 bytes the job went to
--          ready_to_quote: C1 and C2 fail there).
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;
-- The touch trigger and the RPCs stamp timezone('utc', now()); compare them
-- with now() in the zone Supabase sessions use.
set time zone 'UTC';
select plan(17);

create or replace function pg_temp.ovd979c_cleanup()
returns void language plpgsql set search_path = pg_catalog as $$
begin
  delete from public.work_queue where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.drawing_preview_assets where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.drawing_extractions where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.approved_part_requirements where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.parts where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.part_versions where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.canonical_parts where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.job_files where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.jobs where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.audit_events where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.organization_memberships where organization_id = '97900000-0000-4000-8000-000000000001';
  delete from public.organizations where id = '97900000-0000-4000-8000-000000000001';
  delete from auth.users where id = '97900000-0000-4000-8000-000000000002';
end;
$$;
select pg_temp.ovd979c_cleanup();

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97900000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
  'ovd979-race@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug)
values ('97900000-0000-4000-8000-000000000001', 'OVD 979 race', 'ovd979-race');
insert into public.organization_memberships (organization_id, user_id, role)
values ('97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-000000000002', 'client');

-- J1: one part with a drawing extraction and an auto-approved requirement (R, S,
-- E). J2: two parts, CAD-only first, drawings attached (C). J3: one part whose
-- CAD-only extraction is still running when its drawing is attached (D).
insert into public.jobs (id, organization_id, created_by, title, status) values
  ('97900000-0000-4000-8000-0000000001a0', '97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-000000000002', 'OVD 979 race J1', 'uploaded'),
  ('97900000-0000-4000-8000-0000000002a0', '97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-000000000002', 'OVD 979 race J2', 'ready_to_quote'),
  ('97900000-0000-4000-8000-0000000003a0', '97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-000000000002', 'OVD 979 race J3', 'extracting');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
)
select file.id, file.job_id, '97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-000000000002',
  'job-files', 'org/ovd979-race/' || file.id::text, file.original_name, file.normalized_name, file.kind::public.job_file_kind
from (values
  ('97900000-0000-4000-8000-0000000001a1'::uuid, '97900000-0000-4000-8000-0000000001a0'::uuid, 'p1.step', 'ovd979-race-p1', 'cad'),
  ('97900000-0000-4000-8000-0000000001a2'::uuid, '97900000-0000-4000-8000-0000000001a0'::uuid, 'p1.pdf', 'ovd979-race-p1', 'drawing'),
  ('97900000-0000-4000-8000-0000000002a1'::uuid, '97900000-0000-4000-8000-0000000002a0'::uuid, 'q1.step', 'ovd979-race-q1', 'cad'),
  ('97900000-0000-4000-8000-0000000002a2'::uuid, '97900000-0000-4000-8000-0000000002a0'::uuid, 'q1.pdf', 'ovd979-race-q1', 'drawing'),
  ('97900000-0000-4000-8000-0000000002b1'::uuid, '97900000-0000-4000-8000-0000000002a0'::uuid, 'q2.step', 'ovd979-race-q2', 'cad'),
  ('97900000-0000-4000-8000-0000000002b2'::uuid, '97900000-0000-4000-8000-0000000002a0'::uuid, 'q2.pdf', 'ovd979-race-q2', 'drawing'),
  ('97900000-0000-4000-8000-0000000003a1'::uuid, '97900000-0000-4000-8000-0000000003a0'::uuid, 'd1.step', 'ovd979-race-d1', 'cad'),
  ('97900000-0000-4000-8000-0000000003a2'::uuid, '97900000-0000-4000-8000-0000000003a0'::uuid, 'd1.pdf', 'ovd979-race-d1', 'drawing')
) as file(id, job_id, original_name, normalized_name, kind);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id) values
  ('97900000-0000-4000-8000-0000000001a3', '97900000-0000-4000-8000-0000000001a0', '97900000-0000-4000-8000-000000000001',
    'ovd979-race-p1', 'ovd979-race-p1', '97900000-0000-4000-8000-0000000001a1', '97900000-0000-4000-8000-0000000001a2'),
  ('97900000-0000-4000-8000-0000000002a3', '97900000-0000-4000-8000-0000000002a0', '97900000-0000-4000-8000-000000000001',
    'ovd979-race-q1', 'ovd979-race-q1', '97900000-0000-4000-8000-0000000002a1', '97900000-0000-4000-8000-0000000002a2'),
  ('97900000-0000-4000-8000-0000000002b3', '97900000-0000-4000-8000-0000000002a0', '97900000-0000-4000-8000-000000000001',
    'ovd979-race-q2', 'ovd979-race-q2', '97900000-0000-4000-8000-0000000002b1', '97900000-0000-4000-8000-0000000002b2'),
  ('97900000-0000-4000-8000-0000000003a3', '97900000-0000-4000-8000-0000000003a0', '97900000-0000-4000-8000-000000000001',
    'ovd979-race-d1', 'ovd979-race-d1', '97900000-0000-4000-8000-0000000003a1', '97900000-0000-4000-8000-0000000003a2');

-- The worker's steps, each its own transaction in this session (real clocks).
-- Claim: api_claim_next_task's update (it would claim any task of the database).
create function pg_temp.ovd979c_claim(p_part uuid) returns void language sql as $$
  update public.work_queue
  set status = 'running', locked_at = now(), locked_by = 'ovd979-race-worker', attempts = attempts + 1
  where part_id = p_part and task_type = 'extract_part' and status = 'queued' and available_at <= now();
$$;
-- Store: the worker's drawing_extractions upsert (no timestamps; the touch
-- trigger stamps updated_at on the update path).
create function pg_temp.ovd979c_store(p_part uuid, p_version text, p_tag text) returns void language sql as $$
  insert into public.drawing_extractions (part_id, organization_id, extractor_version, extraction, status)
  values (p_part, '97900000-0000-4000-8000-000000000001', p_version,
    jsonb_build_object(
      'description', 'EXTRACTED DESC ' || p_tag, 'quoteDescription', 'EXTRACTED DESC ' || p_tag,
      'partNumber', 'EX-PN-' || p_tag, 'revision', 'R' || p_tag, 'quoteFinish', 'EXTRACTED FINISH ' || p_tag)
    || case when p_version like 'worker-sim-%' then '{}'::jsonb
       else jsonb_build_object('material', jsonb_build_object('normalized', 'Aluminum 6061-T6')) end,
    'needs_review')
  on conflict (part_id) do update
  set extractor_version = excluded.extractor_version, extraction = excluded.extraction, status = excluded.status;
$$;
-- Settle: markTaskCompleted / markTaskFailed.
create function pg_temp.ovd979c_settle(p_part uuid, p_status text) returns void language sql as $$
  update public.work_queue
  set status = p_status::public.queue_task_status, locked_at = null, locked_by = null
  where part_id = p_part and task_type = 'extract_part' and status = 'running';
$$;
create function pg_temp.ovd979c_as_owner(p_on boolean) returns void language sql as $$
  select set_config('request.jwt.claims', case when p_on then
    '{"sub":"97900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}' else '' end, false);
$$;

-- The second session runs these (pg_temp is per session, so they live in public
-- for the duration of the file and are dropped at the end). An error, including
-- a deadlock (40P01), comes back as its SQLSTATE and message.
create or replace function public.ovd979_race_attempt(p_kind text, p_id uuid) returns text language plpgsql as $$
declare
  v_count integer;
begin
  if p_kind = 'auto_approve' then
    v_count := public.api_auto_approve_job_requirements(p_id);
    return 'approved:' || v_count;
  elsif p_kind = 'reset_description' then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      '{"sub":"97900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
    perform public.api_reset_client_part_property_overrides(p_id, array['description']);
    return 'reset';
  elsif p_kind = 'settle' then
    update public.work_queue set status = 'completed', locked_at = null, locked_by = null where id = p_id;
    return 'settled';
  end if;
  return 'unknown kind';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;

create function pg_temp.ovd979c_wait_for_lock() returns boolean language plpgsql as $$
begin
  for attempt in 1..150 loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = 'ovd979-race' and wait_event_type = 'Lock') then
      return true;
    end if;
    perform pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

select extensions.dblink_connect('ovd979-race', coalesce(
  nullif(current_setting('ovd.test_conninfo', true), ''),
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
) || ' application_name=ovd979-race');
select extensions.dblink_exec('ovd979-race', 'set statement_timeout = ''10s''');
select extensions.dblink_exec('ovd979-race', 'set time zone ''UTC''');

-- ---------------------------------------------------------------- J1 setup
-- A drawing extraction, approved once (no client save yet), then a newer
-- extraction that auto-approval would refresh the auto fields from.
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000001a3', 'worker-pdf-v3', '1');
select public.api_auto_approve_job_requirements('97900000-0000-4000-8000-0000000001a0');
select pg_sleep(0.01);
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000001a3', 'worker-pdf-v3', '2');

-- ---------------------------------------------------------------- R: save vs auto-approval
-- The user's save is in flight (written, not committed) when auto-approval
-- starts in the other session; the save then commits while auto-approval waits.
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"97900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select public.api_update_client_part_request(
  p_job_id => '97900000-0000-4000-8000-0000000001a0',
  p_description => 'USER DESC RACE', p_part_number => 'USER-PN-RACE', p_revision => 'U',
  p_material => 'Aluminum 6061-T6', p_finish => 'USER FINISH RACE'
);
reset role;
select extensions.dblink_send_query('ovd979-race',
  $$select public.ovd979_race_attempt('auto_approve', '97900000-0000-4000-8000-0000000001a0')$$);
select ok(pg_temp.ovd979c_wait_for_lock(), 'R1 auto-approval waits for the save that is in flight');
commit;
select is((select result from extensions.dblink_get_result('ovd979-race') as response(result text)),
  'approved:1', 'R2 auto-approval then completes, with no deadlock');
select * from extensions.dblink_get_result('ovd979-race') as response(result text);
select is(
  (select array[description, part_number, revision, finish]
   from public.approved_part_requirements where part_id = '97900000-0000-4000-8000-0000000001a3'),
  array['USER DESC RACE', 'USER-PN-RACE', 'U', 'USER FINISH RACE'],
  'R3 a save that committed while auto-approval was running is not overwritten'
);
select ok(
  (select spec_snapshot #> '{projectPartProperties,overrides}' ?& array['description', 'partNumber', 'revision', 'finish']
   from public.approved_part_requirements where part_id = '97900000-0000-4000-8000-0000000001a3'),
  'R4 its override keys survive the auto-approval'
);

-- ---------------------------------------------------------------- S: reset vs auto-approval
-- A newer extraction: auto-approval keeps the owned description and moves its
-- editor default to the drawing value (review r2, M1). A reset that waited for
-- it must resolve to that default, not to the one it would have read before.
select pg_sleep(0.01);
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000001a3', 'worker-pdf-v3', 'S');
begin;
select public.api_auto_approve_job_requirements('97900000-0000-4000-8000-0000000001a0');
select extensions.dblink_send_query('ovd979-race',
  $$select public.ovd979_race_attempt('reset_description', '97900000-0000-4000-8000-0000000001a0')$$);
select ok(pg_temp.ovd979c_wait_for_lock(), 'S1 a reset waits for the auto-approval that is in flight');
commit;
select is((select result from extensions.dblink_get_result('ovd979-race') as response(result text)),
  'reset', 'S2 the reset then completes, with no deadlock');
select * from extensions.dblink_get_result('ovd979-race') as response(result text);
select ok(
  (select description = 'EXTRACTED DESC S'
     and not (spec_snapshot #> '{projectPartProperties,overrides}' ? 'description')
     and spec_snapshot #> '{projectPartProperties,overrides}' ?& array['partNumber', 'revision', 'finish']
   from public.approved_part_requirements where part_id = '97900000-0000-4000-8000-0000000001a3'),
  'S3 the reset reads what auto-approval committed: the description returns to the drawing value'
);

-- ---------------------------------------------------------------- E: request vs auto-approval
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"97900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select public.api_request_extraction('97900000-0000-4000-8000-0000000001a0');
reset role;
select extensions.dblink_send_query('ovd979-race',
  $$select public.ovd979_race_attempt('auto_approve', '97900000-0000-4000-8000-0000000001a0')$$);
select ok(pg_temp.ovd979c_wait_for_lock(), 'E1 auto-approval waits for a request for extraction of the same job');
commit;
select is((select result from extensions.dblink_get_result('ovd979-race') as response(result text)),
  'approved:1', 'E2 both finish: the two paths take the job row first, so they cannot deadlock');
select * from extensions.dblink_get_result('ovd979-race') as response(result text);

-- ---------------------------------------------------------------- D: deferred drawing extraction
-- D1's CAD-only extraction is claimed before its drawing exists and has stored
-- its worker-sim row; the drawing is attached and extraction requested while
-- that task still runs.
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, payload, status, locked_at, locked_by, attempts)
values ('97900000-0000-4000-8000-0000000003b0', '97900000-0000-4000-8000-000000000001',
  '97900000-0000-4000-8000-0000000003a0', '97900000-0000-4000-8000-0000000003a3', 'extract_part',
  '{"partId":"97900000-0000-4000-8000-0000000003a3","jobId":"97900000-0000-4000-8000-0000000003a0"}'::jsonb,
  'running', now(), 'ovd979-race-worker', 1);
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000003a3', 'worker-sim-v1', 'cad');
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"97900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select is(public.api_request_extraction('97900000-0000-4000-8000-0000000003a0'), 1,
  'D1 a drawing attached while the CAD-only task runs queues one deferred drawing task');
reset role;
-- The worker completes the CAD-only task while the request is still open.
select extensions.dblink_send_query('ovd979-race',
  $$select public.ovd979_race_attempt('settle', '97900000-0000-4000-8000-0000000003b0')$$);
select ok(pg_temp.ovd979c_wait_for_lock(), 'D2 the settlement waits for the request that deferred a task behind it');
commit;
select is((select result from extensions.dblink_get_result('ovd979-race') as response(result text)),
  'settled', 'D3 the settlement then completes');
select * from extensions.dblink_get_result('ovd979-race') as response(result text);
select ok(
  (select count(*) = 1 and bool_and(status = 'queued' and available_at <= now()
       and payload ->> 'reason' = 'drawing_attached'
       and payload ->> 'awaitingTaskId' = '97900000-0000-4000-8000-0000000003b0'
       and payload ->> 'drawingFileId' = '97900000-0000-4000-8000-0000000003a2')
   from public.work_queue
   where part_id = '97900000-0000-4000-8000-0000000003a3' and status <> 'completed'),
  'D4 the settlement released the deferred drawing task: it is claimable now'
);

-- ---------------------------------------------------------------- C: concurrent parts, real clocks
-- Q1 and Q2 were extracted CAD-only by tasks that completed; their drawings are
-- attached and one request queues both drawing tasks.
insert into public.work_queue (organization_id, job_id, part_id, task_type, payload, status)
select '97900000-0000-4000-8000-000000000001', '97900000-0000-4000-8000-0000000002a0', part.id, 'extract_part',
  jsonb_build_object('partId', part.id, 'jobId', '97900000-0000-4000-8000-0000000002a0'), 'completed'
from public.parts part where part.job_id = '97900000-0000-4000-8000-0000000002a0';
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000002a3', 'worker-sim-v1', 'cad-q1');
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000002b3', 'worker-sim-v1', 'cad-q2');
select public.api_auto_approve_job_requirements('97900000-0000-4000-8000-0000000002a0');
select pg_temp.ovd979c_as_owner(true);
set role authenticated;
select public.api_request_extraction('97900000-0000-4000-8000-0000000002a0');
reset role;
-- Q1's first attempt stores its drawing extraction and fails before it is done.
select pg_temp.ovd979c_claim('97900000-0000-4000-8000-0000000002a3');
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000002a3', 'worker-pdf-v3', 'q1-try1');
select pg_temp.ovd979c_settle('97900000-0000-4000-8000-0000000002a3', 'failed');
select pg_sleep(0.01);
set role authenticated;
select is(public.api_request_extraction('97900000-0000-4000-8000-0000000002a0'), 1,
  'C0 the failed attach task of Q1 is retried');
reset role;
select pg_temp.ovd979c_as_owner(false);
select pg_sleep(0.01);
-- The retry is claimed: Q1 still holds the row its failed attempt stored.
select pg_temp.ovd979c_claim('97900000-0000-4000-8000-0000000002a3');
create temporary table ovd979c_q1_before on commit preserve rows as
select status::text as status, updated_at from public.drawing_extractions
where part_id = '97900000-0000-4000-8000-0000000002a3';
select pg_sleep(0.01);
-- Meanwhile Q2's task runs to its auto-approval, in the worker's order.
select pg_temp.ovd979c_claim('97900000-0000-4000-8000-0000000002b3');
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000002b3', 'worker-pdf-v3', 'q2');
select public.api_auto_approve_job_requirements('97900000-0000-4000-8000-0000000002a0');
select is((select status::text from public.jobs where id = '97900000-0000-4000-8000-0000000002a0'), 'extracting',
  'C1 another part''s auto-approval does not treat a retry that holds its failed attempt''s row as finishing');
select ok(
  (select extraction.status::text = before.status and extraction.updated_at = before.updated_at
   from public.drawing_extractions extraction, ovd979c_q1_before before
   where extraction.part_id = '97900000-0000-4000-8000-0000000002a3'),
  'C2 and leaves that row untouched, so its timestamp cannot pass for the retry''s own result'
);
select pg_temp.ovd979c_settle('97900000-0000-4000-8000-0000000002b3', 'completed');
-- The retry stores its own extraction and auto-approves while still running.
select pg_sleep(0.01);
select pg_temp.ovd979c_store('97900000-0000-4000-8000-0000000002a3', 'worker-pdf-v3', 'q1-try2');
select public.api_auto_approve_job_requirements('97900000-0000-4000-8000-0000000002a0');
select is((select status::text from public.jobs where id = '97900000-0000-4000-8000-0000000002a0'), 'ready_to_quote',
  'C3 once the retry has stored its own result in its claim, it is finishing and the job is ready to quote');
select pg_temp.ovd979c_settle('97900000-0000-4000-8000-0000000002a3', 'completed');

select extensions.dblink_disconnect('ovd979-race');
drop function public.ovd979_race_attempt(text, uuid);
drop table ovd979c_q1_before;
select pg_temp.ovd979c_cleanup();
select * from finish();
