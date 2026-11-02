begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(27);

-- Fixture ids and repeated names live here once; the schema rolls back with the test.
create schema ovd979u3_test;
create function ovd979u3_test.id(n integer) returns uuid language sql immutable as $$
  select ('97930000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create table ovd979u3_test.k as select
  'public'::name as app_schema, 'authenticated'::text as auth_role, 'u3-worker'::text as worker,
  'public.api_claim_next_task(text)'::text as claim_fn, 'EXECUTE'::text as execute_priv;
grant usage on schema ovd979u3_test to authenticated, service_role;
grant select on ovd979u3_test.k to authenticated, service_role;
grant execute on function ovd979u3_test.id(integer) to authenticated, service_role;

select col_type_is((select app_schema from ovd979u3_test.k), 'work_queue', 'attempt_id', 'uuid', 'queue attempt is a UUID');
select col_is_null((select app_schema from ovd979u3_test.k), 'work_queue', 'attempt_id', 'queue attempt is nullable');
select col_type_is((select app_schema from ovd979u3_test.k), 'drawing_extractions', 'source_attempt_id', 'uuid', 'extraction attempt is a UUID');
select col_is_null((select app_schema from ovd979u3_test.k), 'drawing_extractions', 'source_attempt_id', 'extraction attempt is nullable');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select ovd979u3_test.id(1), auth_role, auth_role, 'u3-client@example.test', now(), '{"provider":"email"}'
from ovd979u3_test.k;
insert into public.organizations (id, name, slug)
values (ovd979u3_test.id(2), 'U3 synthetic org', 'ovd979-u3');
insert into public.organization_memberships (organization_id, user_id, role)
values (ovd979u3_test.id(2), ovd979u3_test.id(1), 'client');
insert into public.jobs (id, organization_id, created_by, title)
values (ovd979u3_test.id(3), ovd979u3_test.id(2), ovd979u3_test.id(1), 'U3 synthetic job');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values (ovd979u3_test.id(4), ovd979u3_test.id(3), ovd979u3_test.id(2), 'U3 part', 'u3-part');
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, created_at)
values (ovd979u3_test.id(5), ovd979u3_test.id(2), ovd979u3_test.id(3), ovd979u3_test.id(4), 'extract_part', '-infinity');
insert into public.drawing_extractions (part_id, organization_id)
values (ovd979u3_test.id(4), ovd979u3_test.id(2));
select is((select attempt_id from public.work_queue where id = ovd979u3_test.id(5)), null::uuid, 'legacy queue identity remains null');
select is((select source_attempt_id from public.drawing_extractions where part_id = ovd979u3_test.id(4)), null::uuid, 'legacy extraction provenance remains null');

set local role service_role;
create temporary table u3_first_claim as
  select c.* from ovd979u3_test.k, lateral public.api_claim_next_task(k.worker) c;
reset role;
select is((select id from u3_first_claim), ovd979u3_test.id(5), 'claims the expected task');
select isnt((select attempt_id from u3_first_claim), null::uuid, 'first claim has a UUID');
select is((select status::text from u3_first_claim), 'running', 'claim still enters running');
select is((select attempts from u3_first_claim), 1, 'claim still increments attempts');
select is((select locked_by from u3_first_claim), (select worker from ovd979u3_test.k), 'claim retains worker lock');

-- Same table upsert used by handleExtractTask; only the service role writes provenance.
set local role service_role;
insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
select part_id, organization_id, attempt_id from u3_first_claim
on conflict (part_id) do update set source_attempt_id = excluded.source_attempt_id;
reset role;
select is((select source_attempt_id from public.drawing_extractions where part_id = ovd979u3_test.id(4)),
  (select attempt_id from u3_first_claim), 'extraction upsert carries the claimed attempt');

-- Shared worker retry update: clear identity and release the lock atomically.
set local role service_role;
update public.work_queue set status = 'queued', attempt_id = null, locked_at = null, locked_by = null
from ovd979u3_test.k
where id = ovd979u3_test.id(5) and status = 'running' and attempts = 1 and locked_by = k.worker;
reset role;
select is((select attempt_id from public.work_queue where id = ovd979u3_test.id(5)), null::uuid, 'requeue clears the attempt');
set local role service_role;
create temporary table u3_second_claim as
  select c.* from ovd979u3_test.k, lateral public.api_claim_next_task(k.worker) c;
reset role;
select isnt((select attempt_id from u3_second_claim), null::uuid, 'retry claim has a UUID');
select isnt((select attempt_id from u3_second_claim), (select attempt_id from u3_first_claim), 'same worker reclaim receives a fresh UUID');
select is((select attempts from u3_second_claim), 2, 'retry claim increments attempts');
select isnt((select source_attempt_id from public.drawing_extractions where part_id = ovd979u3_test.id(4)),
  (select attempt_id from u3_second_claim), 'old extraction does not match the new claim');
set local role service_role;
insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
select part_id, organization_id, attempt_id from u3_second_claim
on conflict (part_id) do update set source_attempt_id = excluded.source_attempt_id;
reset role;
select is((select source_attempt_id from public.drawing_extractions where part_id = ovd979u3_test.id(4)),
  (select attempt_id from u3_second_claim), 'retry extraction replaces old provenance');

select set_config('request.jwt.claims', json_build_object('sub', ovd979u3_test.id(1), 'role', k.auth_role)::text, true)
from ovd979u3_test.k;
set local role authenticated;
select is(public.is_internal_user(ovd979u3_test.id(2)), false, 'fixture is a client, not internal staff');
select results_eq($$update public.work_queue set attempt_id = gen_random_uuid()
  where id = ovd979u3_test.id(5) returning id$$, array[]::uuid[], 'client cannot update attempt identity');
select throws_ok($$insert into public.work_queue (organization_id, task_type, attempt_id)
  values (ovd979u3_test.id(2), 'extract_part', gen_random_uuid())$$,
  '42501', 'new row violates row-level security policy for table "work_queue"', 'client cannot insert attempt identity');
select results_eq($$update public.drawing_extractions set source_attempt_id = gen_random_uuid()
  where part_id = ovd979u3_test.id(4) returning part_id$$, array[]::uuid[], 'client cannot update extraction provenance');
select throws_ok($$insert into public.drawing_extractions (part_id, organization_id, source_attempt_id)
  values (ovd979u3_test.id(4), ovd979u3_test.id(2), gen_random_uuid())$$,
  '42501', 'new row violates row-level security policy for table "drawing_extractions"', 'client cannot insert extraction provenance');
reset role;
select ok(not has_function_privilege(k.auth_role, k.claim_fn, k.execute_priv), 'clients cannot invoke claim') from ovd979u3_test.k;
select ok(not has_function_privilege('anon', k.claim_fn, k.execute_priv), 'anonymous users cannot invoke claim') from ovd979u3_test.k;
select ok(has_function_privilege('service_role', k.claim_fn, k.execute_priv), 'service role retains claim execute') from ovd979u3_test.k;
select is((select attempt_id from public.work_queue where id = ovd979u3_test.id(5)),
  (select attempt_id from u3_second_claim), 'denied client writes leave claim identity intact');

select * from finish();
rollback;
