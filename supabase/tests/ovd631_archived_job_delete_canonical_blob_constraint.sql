begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- OVD-631: api_delete_archived_jobs fails with 23503 when an orphaned blob is
-- still referenced by canonical part_versions.

create function pg_temp.set_test_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

-- Test fixture: organization, user, job, CAD blob, and canonical part_version
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000006311',
  'authenticated',
  'authenticated',
  'ovd631-user@example.test',
  timezone('utc', now()),
  '{"provider":"email"}'::jsonb
);

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000006312',
  'OVD-631 Org',
  'ovd-631-org'
);

insert into public.organization_memberships (organization_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000006312',
  '00000000-0000-4000-8000-000000006311',
  'client'
);

insert into public.jobs (id, organization_id, created_by, title)
values (
  '00000000-0000-4000-8000-000000006313',
  '00000000-0000-4000-8000-000000006312',
  '00000000-0000-4000-8000-000000006311',
  'OVD-631 test job with canonical blob reference'
);

-- Create a CAD blob that will be referenced by both job_files and part_versions
insert into public.organization_file_blobs (
  id,
  organization_id,
  content_sha256,
  trusted_content_sha256,
  storage_bucket,
  storage_path,
  size_bytes,
  mime_type
)
values (
  '00000000-0000-4000-8000-000000006314',
  '00000000-0000-4000-8000-000000006312',
  repeat('a', 64),
  repeat('a', 64),
  'job-files',
  'org-sha256/00000000-0000-4000-8000-000000006312/' || repeat('a', 64) || '/test.step',
  1024,
  'application/step'
);

-- Create a job_file that references the blob
insert into public.job_files (
  id,
  job_id,
  organization_id,
  uploaded_by,
  blob_id,
  content_sha256,
  trusted_content_sha256,
  storage_bucket,
  storage_path,
  original_name,
  normalized_name,
  file_kind,
  size_bytes
)
values (
  '00000000-0000-4000-8000-000000006315',
  '00000000-0000-4000-8000-000000006313',
  '00000000-0000-4000-8000-000000006312',
  '00000000-0000-4000-8000-000000006311',
  '00000000-0000-4000-8000-000000006314',
  repeat('a', 64),
  repeat('a', 64),
  'job-files',
  'org-sha256/00000000-0000-4000-8000-000000006312/' || repeat('a', 64) || '/test.step',
  'test.step',
  'test',
  'cad',
  1024
);

-- Create a part that uses the CAD file
insert into public.parts (
  id,
  job_id,
  organization_id,
  name,
  normalized_key,
  cad_file_id
)
values (
  '00000000-0000-4000-8000-000000006316',
  '00000000-0000-4000-8000-000000006313',
  '00000000-0000-4000-8000-000000006312',
  'Test Part',
  'test-part',
  '00000000-0000-4000-8000-000000006315'
);

-- Verify that the part_version trigger created a canonical version referencing the blob
select ok(
  exists(
    select 1
    from public.part_versions pv
    where pv.cad_blob_id = '00000000-0000-4000-8000-000000006314'
      and pv.organization_id = '00000000-0000-4000-8000-000000006312'
  ),
  'canonical part_version references the CAD blob'
);

select isnt(
  (select part_version_id from public.parts where id = '00000000-0000-4000-8000-000000006316'),
  null,
  'part has a canonical part_version_id assigned'
);

-- Archive the job as the authenticated user
set local role authenticated;
select pg_temp.set_test_identity('00000000-0000-4000-8000-000000006311');

select lives_ok(
  $$
    select public.api_archive_job('00000000-0000-4000-8000-000000006313');
  $$,
  'job can be archived by its creator'
);

reset role;

select ok(
  exists(
    select 1
    from public.jobs
    where id = '00000000-0000-4000-8000-000000006313'
      and archived_at is not null
  ),
  'job is archived'
);

-- The critical test: deleting the archived job should not raise 23503
-- Before the fix, this will fail because the blob is still referenced by part_versions
set local role authenticated;
select pg_temp.set_test_identity('00000000-0000-4000-8000-000000006311');

select lives_ok(
  $$
    select public.api_delete_archived_jobs(array['00000000-0000-4000-8000-000000006313'::uuid]);
  $$,
  'deleting archived job does not raise 23503 even when blob is referenced by canonical part_versions'
);

reset role;

-- Verify the cleanup outcome: job is deleted, but blob remains (it's still referenced)
select ok(
  not exists(
    select 1
    from public.jobs
    where id = '00000000-0000-4000-8000-000000006313'
  ),
  'archived job was successfully deleted'
);

select ok(
  exists(
    select 1
    from public.organization_file_blobs
    where id = '00000000-0000-4000-8000-000000006314'
  ),
  'blob is retained because it is still referenced by canonical part_versions'
);

select * from finish();

rollback;
