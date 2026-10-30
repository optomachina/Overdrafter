begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(27);

select col_type_is('public', 'work_queue', 'attempt_id', 'uuid', 'queue attempt is a UUID');
select col_is_null('public', 'work_queue', 'attempt_id', 'queue attempt is nullable');
select col_type_is('public', 'drawing_extractions', 'source_attempt_id', 'uuid', 'extraction attempt is a UUID');
select col_is_null('public', 'drawing_extractions', 'source_attempt_id', 'extraction attempt is nullable');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('97930000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'u3-client@example.test', now(), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values ('97930000-0000-4000-8000-000000000002', 'U3 synthetic org', 'ovd979-u3');
insert into public.organization_memberships (organization_id, user_id, role)
values ('97930000-0000-4000-8000-000000000002', '97930000-0000-4000-8000-000000000001', 'client');
insert into public.jobs (id, organization_id, created_by, title)
values ('97930000-0000-4000-8000-000000000003', '97930000-0000-4000-8000-000000000002',
  '97930000-0000-4000-8000-000000000001', 'U3 synthetic job');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('97930000-0000-4000-8000-000000000004', '97930000-0000-4000-8000-000000000003',
  '97930000-0000-4000-8000-000000000002', 'U3 part', 'u3-part');
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, created_at)
values ('97930000-0000-4000-8000-000000000005', '97930000-0000-4000-8000-000000000002',
  '97930000-0000-4000-8000-000000000003', '97930000-0000-4000-8000-000000000004', 'extract_part', '-infinity');
insert into public.drawing_extractions (part_id, organization_id)
values ('97930000-0000-4000-8000-000000000004', '97930000-0000-4000-8000-000000000002');
select is((select attempt_id from public.work_queue where id = '97930000-0000-4000-8000-000000000005'), null::uuid, 'legacy queue identity remains null');
select is((select source_attempt_id from public.drawing_extractions where part_id = '97930000-0000-4000-8000-000000000004'), null::uuid, 'legacy extraction provenance remains null');

set local role service_role;
create temporary table u3_first_claim as select * from public.api_claim_next_task('u3-worker');
reset role;
select is((select id from u3_first_claim), '97930000-0000-4000-8000-000000000005'::uuid, 'claims the expected task');
select isnt((select attempt_id from u3_first_claim), null::uuid, 'first claim has a UUID');
select is((select status::text from u3_first_claim), 'running', 'claim still enters running');
select is((select attempts from u3_first_claim), 1, 'claim still increments attempts');
select is((select locked_by from u3_first_claim), 'u3-worker', 'claim retains worker lock');

-- Same table upsert used by handleExtractTask; only the service role writes provenance.
set local role service_role;
insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
select part_id, organization_id, attempt_id from u3_first_claim
on conflict (part_id) do update set source_attempt_id = excluded.source_attempt_id;
reset role;
select is((select source_attempt_id from public.drawing_extractions where part_id = '97930000-0000-4000-8000-000000000004'),
  (select attempt_id from u3_first_claim), 'extraction upsert carries the claimed attempt');

-- Shared worker retry update: clear identity and release the lock atomically.
set local role service_role;
update public.work_queue set status = 'queued', attempt_id = null, locked_at = null, locked_by = null
where id = '97930000-0000-4000-8000-000000000005' and status = 'running' and attempts = 1 and locked_by = 'u3-worker';
reset role;
select is((select attempt_id from public.work_queue where id = '97930000-0000-4000-8000-000000000005'), null::uuid, 'requeue clears the attempt');
set local role service_role;
create temporary table u3_second_claim as select * from public.api_claim_next_task('u3-worker');
reset role;
select isnt((select attempt_id from u3_second_claim), null::uuid, 'retry claim has a UUID');
select isnt((select attempt_id from u3_second_claim), (select attempt_id from u3_first_claim), 'same worker reclaim receives a fresh UUID');
select is((select attempts from u3_second_claim), 2, 'retry claim increments attempts');
select isnt((select source_attempt_id from public.drawing_extractions where part_id = '97930000-0000-4000-8000-000000000004'),
  (select attempt_id from u3_second_claim), 'old extraction does not match the new claim');
set local role service_role;
insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
select part_id, organization_id, attempt_id from u3_second_claim
on conflict (part_id) do update set source_attempt_id = excluded.source_attempt_id;
reset role;
select is((select source_attempt_id from public.drawing_extractions where part_id = '97930000-0000-4000-8000-000000000004'),
  (select attempt_id from u3_second_claim), 'retry extraction replaces old provenance');

select set_config('request.jwt.claims', '{"sub":"97930000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is(public.is_internal_user('97930000-0000-4000-8000-000000000002'), false, 'fixture is a client, not internal staff');
select results_eq($$update public.work_queue set attempt_id = gen_random_uuid()
  where id = '97930000-0000-4000-8000-000000000005' returning id$$, array[]::uuid[], 'client cannot update attempt identity');
select throws_ok($$insert into public.work_queue (organization_id, task_type, attempt_id)
  values ('97930000-0000-4000-8000-000000000002', 'extract_part', gen_random_uuid())$$,
  '42501', 'new row violates row-level security policy for table "work_queue"', 'client cannot insert attempt identity');
select results_eq($$update public.drawing_extractions set source_attempt_id = gen_random_uuid()
  where part_id = '97930000-0000-4000-8000-000000000004' returning part_id$$, array[]::uuid[], 'client cannot update extraction provenance');
select throws_ok($$insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
  values ('97930000-0000-4000-8000-000000000004', '97930000-0000-4000-8000-000000000002', gen_random_uuid())$$,
  '42501', 'new row violates row-level security policy for table "drawing_extractions"', 'client cannot insert extraction provenance');
reset role;
select ok(not has_function_privilege('authenticated', 'public.api_claim_next_task(text)', 'EXECUTE'), 'clients cannot invoke claim');
select ok(not has_function_privilege('anon', 'public.api_claim_next_task(text)', 'EXECUTE'), 'anonymous users cannot invoke claim');
select ok(has_function_privilege('service_role', 'public.api_claim_next_task(text)', 'EXECUTE'), 'service role retains claim execute');
select is((select attempt_id from public.work_queue where id = '97930000-0000-4000-8000-000000000005'),
  (select attempt_id from u3_second_claim), 'denied client writes leave claim identity intact');

select * from finish();
rollback;
