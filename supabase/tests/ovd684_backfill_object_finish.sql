begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('84000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'ovd684@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb);

insert into public.organizations (id, name, slug)
values ('84000000-0000-4000-8000-000000000002', 'OVD684', 'ovd684');

insert into public.jobs (id, organization_id, created_by, title)
values ('84000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000001', 'ovd684');

insert into public.parts (id, job_id, organization_id, name, normalized_key)
select ('84000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  '84000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000002',
  'p' || n, 'p' || n
from generate_series(1, 8) n;

-- 1 normalized string, 2 raw string with null normalized, 3 non-string normalized/raw,
-- 4 empty object, 5 plain text, 6 NULL, 7 invalid JSON starting with "{",
-- 8 normalized null with raw string (key order reversed)
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, finish)
select ('84000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  '84000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000001', 'AL',
  (array[
    '{"raw":"r1","normalized":"Anodized","reasons":[],"confidence":0.9}',
    '{"raw":"Black oxide","normalized":null}',
    '{"raw":5,"normalized":{"x":1}}',
    '{}',
    'Powder coat',
    null,
    '{not json',
    '{"normalized":null,"raw":"Clear"}'
  ])[n]
from generate_series(1, 8) n;

create function pg_temp.finish_of(n int) returns text language sql as $$
  select finish from public.approved_part_requirements
  where part_id = ('84000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid
$$;

create function pg_temp.snapshot() returns jsonb language sql as $$
  select jsonb_agg(finish order by part_id) from public.approved_part_requirements
$$;

create temporary table before_run on commit drop as select pg_temp.snapshot() as s;

-- CI stages these tests without supabase/migrations; fixtures/ holds a byte copy of
-- the migration, kept identical by scripts/run-supabase-policy-tests.node-test.mjs.
\ir fixtures/ovd684_backfill_object_finish.inc

select is(pg_temp.finish_of(1), 'Anodized', 'normalized string wins');
select is(pg_temp.finish_of(2), 'Black oxide', 'raw string used when normalized is not a string');
select is(pg_temp.finish_of(3), null, 'object with no string normalized/raw becomes null');
select is(pg_temp.finish_of(4), null, 'empty object becomes null');
select is(pg_temp.finish_of(5), 'Powder coat', 'plain text untouched');
select is(pg_temp.finish_of(6), null, 'null untouched');
select is(pg_temp.finish_of(7), '{not json', 'invalid-JSON text untouched');
select is(pg_temp.finish_of(8), 'Clear', 'null normalized falls through to raw');

create temporary table after_first on commit drop as select pg_temp.snapshot() as s;

\ir fixtures/ovd684_backfill_object_finish.inc

select is((select s from after_first), pg_temp.snapshot(), 'second run changes nothing (idempotent)');
select isnt((select s from before_run), (select s from after_first), 'first run changed data');

select * from finish();
rollback;
