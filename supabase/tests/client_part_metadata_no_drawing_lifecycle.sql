-- Test OVD-670: Parts with no drawing file should have lifecycle 'succeeded', not 'uploaded'
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(6);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000006711',
  'authenticated',
  'authenticated',
  'no-drawing-test@example.test',
  timezone('utc', now()),
  '{"provider":"email"}'::jsonb
); -- NOSONAR: deterministic fixture identity

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000006701',
  'No drawing lifecycle test org',
  'no-drawing-lifecycle-test'
); -- NOSONAR: deterministic fixture identifier

insert into public.organization_memberships (organization_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000006701',
  '00000000-0000-4000-8000-000000006711',
  'client'
);

insert into public.jobs (id, organization_id, created_by, title, status)
values (
  '00000000-0000-4000-8000-000000006731',
  '00000000-0000-4000-8000-000000006701',
  '00000000-0000-4000-8000-000000006711',
  'No drawing test job',
  'ready_to_quote'
); -- NOSONAR: deterministic fixture identifier

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind
) values
  (
    '00000000-0000-4000-8000-000000006741',
    '00000000-0000-4000-8000-000000006731',
    '00000000-0000-4000-8000-000000006701',
    '00000000-0000-4000-8000-000000006711',
    'job-files',
    'org/no-drawing-test.step',
    'test-part.step',
    'test-part.step',
    'cad'
  ),
  (
    '00000000-0000-4000-8000-000000006742',
    '00000000-0000-4000-8000-000000006731',
    '00000000-0000-4000-8000-000000006701',
    '00000000-0000-4000-8000-000000006711',
    'job-files',
    'org/with-drawing-test.pdf',
    'test-drawing.pdf',
    'test-drawing.pdf',
    'drawing'
  );

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id
) values
  (
    '00000000-0000-4000-8000-000000006751',
    '00000000-0000-4000-8000-000000006731',
    '00000000-0000-4000-8000-000000006701',
    'Test Part',
    'test-part',
    '00000000-0000-4000-8000-000000006741',
    null
  ),
  (
    '00000000-0000-4000-8000-000000006752',
    '00000000-0000-4000-8000-000000006731',
    '00000000-0000-4000-8000-000000006701',
    'Test Part With Drawing',
    'test-part-with-drawing',
    '00000000-0000-4000-8000-000000006741',
    '00000000-0000-4000-8000-000000006742'
  );

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, quantity, quote_quantities
) values
  (
    '00000000-0000-4000-8000-000000006751',
    '00000000-0000-4000-8000-000000006701',
    '00000000-0000-4000-8000-000000006711',
    'Aluminum 6061-T6',
    'As Machined',
    1,
    array[1]
  ),
  (
    '00000000-0000-4000-8000-000000006752',
    '00000000-0000-4000-8000-000000006701',
    '00000000-0000-4000-8000-000000006711',
    'Aluminum 6061-T6',
    'As Machined',
    1,
    array[1]
  );

insert into public.drawing_extractions (
  part_id, organization_id, extractor_version, extraction, status
) values (
  '00000000-0000-4000-8000-000000006752',
  '00000000-0000-4000-8000-000000006701',
  'test-extractor-v1',
  '{"warnings":[],"missingFields":[],"reviewFields":[]}'::jsonb,
  'approved'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000006711","role":"authenticated","aal":"aal1"}',
  true
); -- NOSONAR: deterministic fixture identity

select ok(
  public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]) is not null,
  'api_list_client_part_metadata returns data for test job'
);

select is(
  (
    select part -> 'clientExtraction' ->> 'lifecycle'
    from jsonb_array_elements(
      public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[])
    ) as part
    where part ->> 'partId' = '00000000-0000-4000-8000-000000006751'
  ),
  'succeeded',
  'lifecycle is "succeeded" when part has CAD but no drawing file'
);

select is(
  (
    select part -> 'clientExtraction' ->> 'hasDrawingFile'
    from jsonb_array_elements(
      public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[])
    ) as part
    where part ->> 'partId' = '00000000-0000-4000-8000-000000006751'
  ),
  'false',
  'hasDrawingFile is false when no drawing is attached'
);

select is(
  (
    select part -> 'clientExtraction' ->> 'hasCadFile'
    from jsonb_array_elements(
      public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[])
    ) as part
    where part ->> 'partId' = '00000000-0000-4000-8000-000000006751'
  ),
  'true',
  'hasCadFile is true when CAD is attached'
);

select is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[])
    ) as part
  ),
  2,
  'both CAD-only and drawing-backed parts are returned'
);

select is(
  (
    select part -> 'clientExtraction' ->> 'lifecycle'
    from jsonb_array_elements(
      public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[])
    ) as part
    where part ->> 'partId' = '00000000-0000-4000-8000-000000006752'
  ),
  'succeeded',
  'lifecycle is "succeeded" when part has drawing and extraction completed successfully'
);

select * from finish();
rollback;
