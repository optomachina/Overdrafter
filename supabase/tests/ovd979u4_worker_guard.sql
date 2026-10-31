-- OVD-979 U4: the migration refuses to apply while the pre-U3 worker (which does not write
-- drawing_extractions.source_attempt_id) is still the newest extraction writer.
-- u4g_guard holds the migration's guard block, copied verbatim; the artifact test
-- (src/features/quotes/auto-approve-migration.test.ts) fails if the two drift.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(6);

create temp table u4g_guard (sql text);
insert into u4g_guard values ($guard$do $ovd979u4_worker_guard$
declare
  v_last_unstamped timestamptz;
  v_last_stamped timestamptz;
begin
  select max(extraction.updated_at)
  into v_last_unstamped
  from public.work_queue queue
  join public.drawing_extractions extraction on extraction.part_id = queue.part_id
  where queue.task_type = 'extract_part'
    and queue.status = 'completed'
    and queue.attempt_id is not null
    and extraction.source_attempt_id is null
    and extraction.updated_at >= queue.created_at;

  select max(extraction.updated_at)
  into v_last_stamped
  from public.drawing_extractions extraction
  where extraction.source_attempt_id is not null;

  if v_last_unstamped is not null and (v_last_stamped is null or v_last_unstamped > v_last_stamped) then
    raise exception 'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id'
      using detail = format('Newest unstamped worker extraction after U3: %s; newest stamped: %s.',
                            v_last_unstamped, coalesce(v_last_stamped::text, 'none')),
            hint = 'Deploy order is U3 migration, then the worker, then U4. Deploy the worker, let one extraction complete, then apply U4.';
  end if;
end
$ovd979u4_worker_guard$$guard$);

select lives_ok((select sql from u4g_guard), 'no claim made since U3 has completed: guard is a no-op');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97942000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'u4-guard@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values ('97942000-0000-4000-8000-000000000002', 'U4 guard synthetic org', 'ovd979-u4-guard');
insert into public.jobs (id, organization_id, created_by, title, status)
values ('97942000-0000-4000-8000-000000000003', '97942000-0000-4000-8000-000000000002',
  '97942000-0000-4000-8000-000000000001', 'U4 guard synthetic job', 'extracting');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
select ('97942000-0000-4000-8000-00000000001' || n)::uuid, '97942000-0000-4000-8000-000000000003',
  '97942000-0000-4000-8000-000000000002', 'U4 guard part ' || n, 'u4-guard-part-' || n
from generate_series(0, 4) n;

-- Part n has its completed extract_part task created at day-start + n hours.
create function pg_temp.u4g_task(p_n integer, p_attempt uuid) returns void language sql as $$
  insert into public.work_queue (organization_id, job_id, part_id, task_type, status, attempt_id, payload, created_at)
  values ('97942000-0000-4000-8000-000000000002', '97942000-0000-4000-8000-000000000003',
    ('97942000-0000-4000-8000-00000000001' || p_n)::uuid, 'extract_part', 'completed', p_attempt, '{}'::jsonb,
    date_trunc('day', now()) - interval '1 day' + make_interval(hours => p_n));
$$;
create function pg_temp.u4g_extraction(p_n integer, p_attempt uuid, p_minutes integer) returns void language sql as $$
  insert into public.drawing_extractions (part_id, organization_id, source_attempt_id, extractor_version, extraction, updated_at)
  values (('97942000-0000-4000-8000-00000000001' || p_n)::uuid, '97942000-0000-4000-8000-000000000002', p_attempt,
    'worker-pdf-u4', '{}'::jsonb, date_trunc('day', now()) - interval '1 day' + make_interval(mins => p_minutes));
$$;

-- Part 0: pre-U3 history (no attempt_id). Part 1: a reused copy keeps its older source timestamp.
select pg_temp.u4g_task(0, null), pg_temp.u4g_extraction(0, null, 30);
select pg_temp.u4g_task(1, gen_random_uuid()), pg_temp.u4g_extraction(1, null, 30);
select lives_ok((select sql from u4g_guard), 'legacy claims and reused copies are not old-worker evidence');

-- Part 2: a claim made since U3 completed and its extraction, written during the task, is unstamped.
select pg_temp.u4g_task(2, gen_random_uuid()), pg_temp.u4g_extraction(2, null, 150);
select throws_ok((select sql from u4g_guard), 'P0001',
  'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id',
  'old worker still writing unstamped extractions after U3: U4 refuses');

-- Part 3: the new worker then completes a stamped extraction.
select pg_temp.u4g_task(3, '97942000-0000-4000-8000-000000000023'),
  pg_temp.u4g_extraction(3, '97942000-0000-4000-8000-000000000023', 210);
select lives_ok((select sql from u4g_guard), 'a stamped extraction newer than the old worker''s last write: U4 applies');

-- Part 4: an old worker is still writing after the new one (mixed fleet).
select pg_temp.u4g_task(4, gen_random_uuid()), pg_temp.u4g_extraction(4, null, 270);
select throws_ok((select sql from u4g_guard), 'P0001',
  'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id',
  'old worker wrote after the newest stamped extraction: U4 refuses');

-- A running (unfinished) old-worker claim is not evidence on its own.
update public.work_queue set status = 'running'
where part_id = '97942000-0000-4000-8000-000000000014';
select lives_ok((select sql from u4g_guard), 'only completed claims count as evidence');

select * from finish();
rollback;
