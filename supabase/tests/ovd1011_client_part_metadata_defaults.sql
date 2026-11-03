-- OVD-1011: public wrapper returns reset defaults only to authorized members.
-- Synthetic fixtures only; all records and the rollback drill roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

\set member 10110000-0000-4000-8000-000000000001
\set outsider 10110000-0000-4000-8000-000000000002
\set unverified 10110000-0000-4000-8000-000000000003
\set org 10110000-0000-4000-8000-000000000010
\set job 10110000-0000-4000-8000-000000000020
\set part 10110000-0000-4000-8000-000000000030
\set empty_part 10110000-0000-4000-8000-000000000031
\set state '{"defaults":{"description":"Extracted bracket","partNumber":"BR-1","revision":"A","material":"6061","finish":"Anodized","threads":"M6","tightestToleranceInch":0.005,"process":"CNC"},"overrides":{"material":"7075"},"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T01:00:00Z"}'

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select id, 'authenticated', 'authenticated', email,
  case when verified then timezone('utc', now()) end, '{"provider":"email"}'::jsonb
from (values
  (:'member'::uuid, 'ovd1011-member@example.test', true),
  (:'outsider'::uuid, 'ovd1011-outsider@example.test', true),
  (:'unverified'::uuid, 'ovd1011-unverified@example.test', false)
) fixture(id, email, verified);
insert into public.organizations (id, name, slug)
values (:'org', 'OVD-1011 defaults fixture', 'ovd1011-defaults-fixture');
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org', :'member', 'client'), (:'org', :'unverified', 'client');
insert into public.jobs (id, organization_id, created_by, title, status)
values (:'job', :'org', :'member', 'Reset defaults fixture', 'ready_to_quote');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values (:'part', :'job', :'org', 'Bracket', 'ovd1011-bracket'),
  (:'empty_part', :'job', :'org', 'No state', 'ovd1011-no-state');
insert into public.approved_part_requirements
  (part_id, organization_id, approved_by, material, quantity, quote_quantities, spec_snapshot)
values (:'part', :'org', :'member', '7075', 1, array[1],
  jsonb_build_object('projectPartProperties', :'state'::jsonb));

select ok(not has_function_privilege('authenticated', 'private.api_list_client_part_metadata(uuid[])', 'EXECUTE'),
  'authenticated cannot bypass the verified-auth wrapper');
select ok(not has_function_privilege('anon', 'public.api_list_client_part_metadata(uuid[])', 'EXECUTE'),
  'anon still cannot execute the public wrapper');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object('sub', :'member', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select is(jsonb_array_length(public.api_list_client_part_metadata(array[:'job']::uuid[])), 2,
  'member sees both seeded parts');
select is((select item -> 'projectPartProperties' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part'),
  :'state'::jsonb, 'property state has exactly the client defaults, overrides and timestamps');
select is((select item #>> '{projectPartProperties,defaults,material}' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part'),
  '6061', 'extracted default is distinct from the current overridden material');
select is((select item ->> 'material' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part'),
  '7075', 'existing current material projection is unchanged');
select ok((select item ? 'projectPartProperties' and item -> 'projectPartProperties' = 'null'::jsonb
  from jsonb_array_elements(public.api_list_client_part_metadata(array[:'job']::uuid[])) item
  where item ->> 'partId' = :'empty_part'), 'part without stored state retains the historical null shape');

select set_config('request.jwt.claims', jsonb_build_object('sub', :'outsider', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select is(public.api_list_client_part_metadata(array[:'job']::uuid[]), '[]'::jsonb,
  'verified non-member sees nothing');
select is(public.api_list_client_part_metadata(array['10110000-0000-4000-8000-000000000099']::uuid[]), '[]'::jsonb,
  'absent and foreign jobs are indistinguishable');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'unverified', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select throws_ok(format('select public.api_list_client_part_metadata(array[%L]::uuid[])', :'job'),
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified member is still refused before data lookup');
reset role;

savepoint ovd1011_rollback;
\ir fixtures/ovd1011_client_part_metadata_defaults_rollback.inc
select is((select md5(prosrc) from pg_proc where oid = 'private.api_list_client_part_metadata(uuid[])'::regprocedure),
  '25cc7e1bc8c06cef379818210360f5ba', 'rollback restores the exact previous body');
rollback to savepoint ovd1011_rollback;
select is((select md5(prosrc) from pg_proc where oid = 'private.api_list_client_part_metadata(uuid[])'::regprocedure),
  'e56ec2ef049717b421ef2ebdd291c19d', 'rollback drill leaves the migration applied');
select * from finish();
rollback;
