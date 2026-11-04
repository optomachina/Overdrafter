-- OVD-1151: the client part metadata carries the client-visible RFQ details the
-- full request save writes, so a save built from it keeps saved packaging notes.
-- Synthetic fixtures only; all records and the rollback drill roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

\set member 11510000-0000-4000-8000-000000000001
\set outsider 11510000-0000-4000-8000-000000000002
\set unverified 11510000-0000-4000-8000-000000000003
\set org 11510000-0000-4000-8000-000000000010
\set job 11510000-0000-4000-8000-000000000020
\set part 11510000-0000-4000-8000-000000000030
\set bare_part 11510000-0000-4000-8000-000000000031
\set snapshot '{"process":"CNC","shipping":{"packagingNotes":"Bag and tag each part","shippingNotes":"Ship by ground","requestedByDateOverride":"2026-12-01"},"certifications":{"requiredCertifications":["AS9100"],"materialCertificationRequired":true,"certificateOfConformanceRequired":true,"inspectionLevel":"fai","notes":"First article per lot"},"sourcing":{"regionPreferenceOverride":"domestic_only","preferredSuppliers":["Acme Machining"],"materialProvisioning":"customer_supplied","notes":"Customer ships stock"},"release":{"releaseStatus":"prototype","reviewDisposition":"hold","quoteBlockedUntilRelease":true,"notes":"Rev A prototype"}}'
\set expected '{"shipping":{"packagingNotes":"Bag and tag each part","shippingNotes":"Ship by ground"},"certifications":{"requiredCertifications":["AS9100"],"materialCertificationRequired":true,"certificateOfConformanceRequired":true,"inspectionLevel":"fai","notes":"First article per lot"},"sourcing":{"regionPreferenceOverride":"domestic_only","preferredSuppliers":["Acme Machining"],"materialProvisioning":"customer_supplied","notes":"Customer ships stock"},"release":{"releaseStatus":"prototype","notes":"Rev A prototype"}}'

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select id, 'authenticated', 'authenticated', email,
  case when verified then timezone('utc', now()) end, '{"provider":"email"}'::jsonb
from (values
  (:'member'::uuid, 'ovd1151-member@example.test', true),
  (:'outsider'::uuid, 'ovd1151-outsider@example.test', true),
  (:'unverified'::uuid, 'ovd1151-unverified@example.test', false)
) fixture(id, email, verified);
insert into public.organizations (id, name, slug)
values (:'org', 'OVD-1151 request metadata fixture', 'ovd1151-request-metadata-fixture');
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org', :'member', 'client'), (:'org', :'unverified', 'client');
insert into public.jobs (id, organization_id, created_by, title, status)
values (:'job', :'org', :'member', 'Request metadata fixture', 'ready_to_quote');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values (:'part', :'job', :'org', 'Bracket', 'ovd1151-bracket'),
  (:'bare_part', :'job', :'org', 'No requirement', 'ovd1151-no-requirement');
insert into public.approved_part_requirements
  (part_id, organization_id, approved_by, material, quantity, quote_quantities, spec_snapshot)
values (:'part', :'org', :'member', '7075', 1, array[1], :'snapshot'::jsonb);

select ok(not has_function_privilege('anon', 'public.api_list_client_part_metadata(uuid[])', 'EXECUTE'),
  'anon still cannot execute the public wrapper');
select is((select proconfig from pg_proc where oid = 'public.api_list_client_part_metadata(uuid[])'::regprocedure),
  array['search_path=""'], 'wrapper keeps its empty search_path');

select set_config('request.jwt.claims', jsonb_build_object('sub', :'member', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select is(
  (select jsonb_agg(item - 'requestMetadata' order by ordinality)
   from jsonb_array_elements(public.api_list_client_part_metadata(array[:'job']::uuid[])) with ordinality as rows(item, ordinality)),
  private.api_list_client_part_metadata(array[:'job']::uuid[]),
  'every existing key, row and row order is unchanged');

set local role authenticated;
select is((select item -> 'requestMetadata' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part'),
  :'expected'::jsonb, 'saved RFQ details are returned with exactly the keys the full save writes');
select ok((select not (item #> '{requestMetadata,release}' ? 'reviewDisposition')
    and not (item #> '{requestMetadata,release}' ? 'quoteBlockedUntilRelease')
    and not (item #> '{requestMetadata,shipping}' ? 'requestedByDateOverride')
  from jsonb_array_elements(public.api_list_client_part_metadata(array[:'job']::uuid[])) item
  where item ->> 'partId' = :'part'), 'internal-only release and shipping keys are not returned');
select is((select item #> '{requestMetadata,shipping,packagingNotes}' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'bare_part'),
  'null'::jsonb, 'a part without a stored requirement returns empty RFQ details');

-- The client resends what it was given and changes only Notes.
select is(public.api_update_client_part_request(
    p_job_id => :'job'::uuid,
    p_requested_service_kinds => array['manufacturing_quote'],
    p_primary_service_kind => 'manufacturing_quote',
    p_material => '7075',
    p_process => 'CNC',
    p_notes => 'Deburr all edges',
    p_quantity => 1,
    p_requested_quote_quantities => array[1],
    p_shipping => metadata -> 'shipping',
    p_certifications => metadata -> 'certifications',
    p_sourcing => metadata -> 'sourcing',
    p_release => metadata -> 'release'),
  :'job'::uuid, 'member saves an unrelated edit from the projected draft')
from (select item -> 'requestMetadata' as metadata from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part') projected;
select is((select item -> 'requestMetadata' from jsonb_array_elements(
  public.api_list_client_part_metadata(array[:'job']::uuid[])) item where item ->> 'partId' = :'part'),
  :'expected'::jsonb, 'saved packaging notes and other RFQ details survive the save');
reset role;
select is((select spec_snapshot #> '{release,reviewDisposition}' from public.approved_part_requirements where part_id = :'part'),
  '"hold"'::jsonb, 'internal review disposition is untouched by the client save');

select set_config('request.jwt.claims', jsonb_build_object('sub', :'outsider', 'role', 'authenticated', 'aal', 'aal1')::text, true);
set local role authenticated;
select is(public.api_list_client_part_metadata(array[:'job']::uuid[]), '[]'::jsonb,
  'verified non-member sees nothing');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'unverified', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select throws_ok(format('select public.api_list_client_part_metadata(array[%L]::uuid[])', :'job'),
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified member is still refused before data lookup');
reset role;

savepoint ovd1151_rollback;
\ir fixtures/ovd1151_client_part_request_metadata_rollback.inc
select is((select md5(prosrc) from pg_proc where oid = 'public.api_list_client_part_metadata(uuid[])'::regprocedure),
  '9127a3995b7bb5fc089ea4fa91525652', 'rollback restores the exact previous wrapper body');
rollback to savepoint ovd1151_rollback;
select is((select md5(prosrc) from pg_proc where oid = 'public.api_list_client_part_metadata(uuid[])'::regprocedure),
  'a195ef0e6fa0d766369b404638832123', 'rollback drill leaves the migration applied');
select * from finish();
rollback;
