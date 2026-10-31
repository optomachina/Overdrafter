-- OVD-979 U4: the migration refuses to apply until the worker that writes
-- drawing_extractions.source_attempt_id has completed an extraction (deploy order
-- U3 migration -> worker -> U4). u4g_guard holds the migration's guard block, copied
-- verbatim; the artifact test (src/features/quotes/auto-approve-migration.test.ts)
-- fails if the two drift.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(8);

create temp table u4g_guard (sql text);
insert into u4g_guard values ($guard$do $ovd979u4_worker_guard$
declare
  v_has_history boolean;
  v_last_stamped timestamptz;
  v_last_unstamped timestamptz;
begin
  select count(*) > 0,
         max(task.completed_at) filter (where task.stamped),
         max(task.completed_at) filter (where task.unstamped)
  into v_has_history, v_last_stamped, v_last_unstamped
  from (
    select case when queue.status = 'completed' then queue.updated_at end as completed_at,
           extraction.source_attempt_id = queue.attempt_id as stamped,
           queue.attempt_id is not null
             and extraction.source_attempt_id is null
             and extraction.updated_at >= queue.created_at
             and not coalesce(queue.payload @> '{"reusedCanonicalPartVersion": true}', false) as unstamped
    from public.work_queue queue
    left join public.drawing_extractions extraction on extraction.part_id = queue.part_id
    where queue.task_type = 'extract_part'
  ) task;

  if v_has_history and (v_last_stamped is null or v_last_unstamped > v_last_stamped) then
    raise exception 'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id'
      using detail = format('Newest completed extraction with a stamp: %s; newest unstamped one from a claim made since U3: %s.',
                            coalesce(v_last_stamped::text, 'none'), coalesce(v_last_unstamped::text, 'none')),
            hint = 'Deploy order is U3 migration, then the worker, then U4. Deploy the worker everywhere, let one extraction complete, then apply U4.';
  end if;
end
$ovd979u4_worker_guard$$guard$);

select lives_ok((select sql from u4g_guard), 'no extract_part history (fresh database): guard is a no-op');

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
from generate_series(0, 5) n;

-- Part n's extract_part task is created at day-start + n hours and completes 30 minutes later.
create function pg_temp.u4g_task(p_n integer, p_attempt uuid, p_payload jsonb default '{}') returns void language sql as $$
  insert into public.work_queue (organization_id, job_id, part_id, task_type, status, attempt_id, payload, created_at, updated_at)
  values ('97942000-0000-4000-8000-000000000002', '97942000-0000-4000-8000-000000000003',
    ('97942000-0000-4000-8000-00000000001' || p_n)::uuid, 'extract_part', 'completed', p_attempt, p_payload,
    date_trunc('day', now()) - interval '1 day' + make_interval(hours => p_n),
    date_trunc('day', now()) - interval '1 day' + make_interval(hours => p_n, mins => 30));
$$;
create function pg_temp.u4g_extraction(p_n integer, p_attempt uuid, p_updated_at timestamptz) returns void language sql as $$
  insert into public.drawing_extractions (part_id, organization_id, source_attempt_id, extractor_version, extraction, updated_at)
  values (('97942000-0000-4000-8000-00000000001' || p_n)::uuid, '97942000-0000-4000-8000-000000000002', p_attempt,
    'worker-pdf-u4', '{}'::jsonb, p_updated_at);
$$;
create function pg_temp.u4g_at(p_n integer, p_minutes integer) returns timestamptz language sql as $$
  select date_trunc('day', now()) - interval '1 day' + make_interval(hours => p_n, mins => p_minutes);
$$;

-- Part 0: pre-U3 history only (no attempt_id), as when U3 and U4 are applied back to back.
select pg_temp.u4g_task(0, null), pg_temp.u4g_extraction(0, null, pg_temp.u4g_at(0, 20));
select throws_ok((select sql from u4g_guard), 'P0001',
  'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id',
  'extraction history but no stamped extraction yet (worker not deployed): U4 refuses');

-- Part 1: a claim made since U3 completed by the old worker, extraction unstamped.
select pg_temp.u4g_task(1, gen_random_uuid()), pg_temp.u4g_extraction(1, null, pg_temp.u4g_at(1, 20));
select throws_ok((select sql from u4g_guard), 'P0001',
  'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id',
  'old worker completing claims made since U3: U4 refuses');

-- Part 2: the new worker then completes a stamped extraction.
select pg_temp.u4g_task(2, '97942000-0000-4000-8000-000000000022'),
  pg_temp.u4g_extraction(2, '97942000-0000-4000-8000-000000000022', pg_temp.u4g_at(2, 20));
select lives_ok((select sql from u4g_guard), 'newest completed extraction is stamped: U4 applies');

-- Part 3: a trusted reuse (unstamped U2 copy, touched later by auto approval) is not old-worker evidence.
select pg_temp.u4g_task(3, gen_random_uuid(), '{"reusedCanonicalPartVersion": true}'),
  pg_temp.u4g_extraction(3, null, now());
select lives_ok((select sql from u4g_guard), 'a later trusted reuse with an unstamped copy: U4 applies');

-- Part 4: an extraction row last written before the claim (not by it) is not evidence.
select pg_temp.u4g_extraction(4, null, pg_temp.u4g_at(0, 0)), pg_temp.u4g_task(4, gen_random_uuid());
select lives_ok((select sql from u4g_guard), 'an unstamped row older than the claim: U4 applies');

-- Part 5: an old worker is still completing claims after the new one (mixed fleet).
select pg_temp.u4g_task(5, gen_random_uuid()), pg_temp.u4g_extraction(5, null, pg_temp.u4g_at(5, 20));
select throws_ok((select sql from u4g_guard), 'P0001',
  'OVD-979 U4 requires the worker that writes drawing_extractions.source_attempt_id',
  'old worker completed after the newest stamped extraction: U4 refuses');

-- A running (unfinished) old-worker claim is not evidence on its own.
update public.work_queue set status = 'running'
where part_id = '97942000-0000-4000-8000-000000000015';
select lives_ok((select sql from u4g_guard), 'only completed claims count as evidence');

select * from finish();
rollback;
