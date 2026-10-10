-- Test OVD-670: Parts with no drawing file should have lifecycle 'succeeded', not 'uploaded'
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(6);

-- Set up test data
insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000006701', 'No drawing lifecycle test org', 'no-drawing-lifecycle-test');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000006711', 'authenticated', 'authenticated',
   'no-drawing-test@example.test', now(), '{"provider":"email"}'::jsonb);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000006701', '00000000-0000-4000-8000-000000006711', 'client');

insert into public.projects (id, organization_id, name, created_by) values
  ('00000000-0000-4000-8000-000000006721', '00000000-0000-4000-8000-000000006701', 'Test Project', '00000000-0000-4000-8000-000000006711');

-- Job with a part that has only CAD, no drawing
insert into public.jobs (id, organization_id, project_id, title, status, source, created_by, created_at) values
  ('00000000-0000-4000-8000-000000006731', '00000000-0000-4000-8000-000000006701', '00000000-0000-4000-8000-000000006721',
   'No drawing test job', 'ready_to_quote', 'client_home', '00000000-0000-4000-8000-000000006711', now());

-- CAD file only (no drawing file)
insert into public.job_files (id, job_id, storage_bucket, storage_path, original_name, file_kind, created_at) values
  ('00000000-0000-4000-8000-000000006741', '00000000-0000-4000-8000-000000006731', 'job-files',
   'org/no-drawing-test.step', 'test-part.step', 'cad', now());

-- Part with CAD but no drawing
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, created_at) values
  ('00000000-0000-4000-8000-000000006751', '00000000-0000-4000-8000-000000006731', '00000000-0000-4000-8000-000000006701',
   'Test Part', 'test-part', '00000000-0000-4000-8000-000000006741', null, now());

-- Approved requirements (simulating auto-approval or manual review)
insert into public.approved_part_requirements (part_id, description, part_number, revision, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities, requested_by_date, spec_snapshot, created_at) values
  ('00000000-0000-4000-8000-000000006751', 'Test Part', 'TP-001', 'A', 'Aluminum 6061-T6', 'As Machined',
   0.005, 1, array[1], null, '{}'::jsonb, now());

-- Set the authenticated user context
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000006711"}'::json;

-- Test 1: Verify the function returns data for the test job
select ok(
  (select public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]) is not null),
  'api_list_client_part_metadata returns data for test job'
);

-- Test 2: Verify lifecycle is "succeeded" when no drawing file exists
select is(
  (select (jsonb_array_elements(public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]))
    -> 'clientExtraction' ->> 'lifecycle')),
  'succeeded',
  'lifecycle is "succeeded" when part has CAD but no drawing file'
);

-- Test 3: Verify hasDrawingFile is false
select is(
  (select (jsonb_array_elements(public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]))
    -> 'clientExtraction' ->> 'hasDrawingFile')),
  'false',
  'hasDrawingFile is false when no drawing is attached'
);

-- Test 4: Verify hasCadFile is true
select is(
  (select (jsonb_array_elements(public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]))
    -> 'clientExtraction' ->> 'hasCadFile')),
  'true',
  'hasCadFile is true when CAD is attached'
);

-- Test 5: Add a part with drawing to verify it still works correctly
insert into public.job_files (id, job_id, storage_bucket, storage_path, original_name, file_kind, created_at) values
  ('00000000-0000-4000-8000-000000006742', '00000000-0000-4000-8000-000000006731', 'job-files',
   'org/with-drawing-test.pdf', 'test-drawing.pdf', 'drawing', now());

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, created_at) values
  ('00000000-0000-4000-8000-000000006752', '00000000-0000-4000-8000-000000006731', '00000000-0000-4000-8000-000000006701',
   'Test Part With Drawing', 'test-part-with-drawing', '00000000-0000-4000-8000-000000006741',
   '00000000-0000-4000-8000-000000006742', now());

insert into public.approved_part_requirements (part_id, description, part_number, revision, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities, requested_by_date, spec_snapshot, created_at) values
  ('00000000-0000-4000-8000-000000006752', 'Test Part With Drawing', 'TP-002', 'A', 'Aluminum 6061-T6', 'As Machined',
   0.005, 1, array[1], null, '{}'::jsonb, now());

-- Add extraction record for the part with drawing
insert into public.drawing_extractions (part_id, extraction, page_count, worker_build_version, extractor_version,
  created_at, updated_at) values
  ('00000000-0000-4000-8000-000000006752',
   '{"warnings":[],"missingFields":[],"reviewFields":[]}'::jsonb,
   2, 'test-build', 'test-extractor-v1', now(), now());

-- Test 6: Verify part with drawing has "succeeded" lifecycle when extraction is complete
select is(
  (select (jsonb_array_elements(
      jsonb_path_query_array(
        public.api_list_client_part_metadata(array['00000000-0000-4000-8000-000000006731']::uuid[]),
        '$[*] ? (@.partId == "00000000-0000-4000-8000-000000006752")'
      )
    ) -> 'clientExtraction' ->> 'lifecycle')),
  'succeeded',
  'lifecycle is "succeeded" when part has drawing and extraction completed successfully'
);

select * from finish();
rollback;
