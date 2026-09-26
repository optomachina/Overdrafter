-- Synthetic metadata applied immediately before OVD-549 in an isolated CI
-- database. This file is not a production migration.
insert into auth.users (id, aud, role, email, email_confirmed_at)
values (
  '00000000-0000-4000-8000-000000054921',
  'authenticated', 'authenticated',
  'ovd549-backfill@example.test', timezone('utc', now())
);

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000054922',
  'OVD-549 backfill', 'ovd549-backfill'
);

insert into public.jobs (id, organization_id, created_by, title)
values (
  '00000000-0000-4000-8000-000000054923',
  '00000000-0000-4000-8000-000000054922',
  '00000000-0000-4000-8000-000000054921',
  'OVD-549 preexisting file'
);

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, storage_bucket, storage_path
) values (
  '00000000-0000-4000-8000-000000054925',
  '00000000-0000-4000-8000-000000054922',
  repeat('f', 64), 'job-files', 'ovd549-backfill/shared.step'
);

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, storage_bucket,
  storage_path, original_name, normalized_name, file_kind
) values (
  '00000000-0000-4000-8000-000000054924',
  '00000000-0000-4000-8000-000000054923',
  '00000000-0000-4000-8000-000000054922',
  '00000000-0000-4000-8000-000000054921',
  '00000000-0000-4000-8000-000000054925',
  'job-files', 'ovd549-backfill/shared.step',
  'shared.step', 'shared', 'cad'
);

insert into public.canonical_parts (id, organization_id, display_name)
values (
  '00000000-0000-4000-8000-000000054926',
  '00000000-0000-4000-8000-000000054922',
  'OVD-549 backfill part'
);

insert into public.part_versions (
  id, canonical_part_id, organization_id, version_state,
  package_fingerprint, cad_blob_id
) values (
  '00000000-0000-4000-8000-000000054927',
  '00000000-0000-4000-8000-000000054926',
  '00000000-0000-4000-8000-000000054922',
  'unverified', repeat('e', 64),
  '00000000-0000-4000-8000-000000054925'
);
