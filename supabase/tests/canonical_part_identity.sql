begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data
) values
  (
    '82000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'identity-a@example.test',
    timezone('utc', now()), '{"provider":"email"}'::jsonb
  ),
  (
    '82000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'identity-b@example.test',
    timezone('utc', now()), '{"provider":"email"}'::jsonb
  );

insert into public.organizations (id, name, slug)
values
  ('82000000-0000-4000-8000-000000000003', 'Identity A', 'identity-a'),
  ('82000000-0000-4000-8000-000000000004', 'Identity B', 'identity-b');

insert into public.organization_memberships (organization_id, user_id, role)
values
  (
    '82000000-0000-4000-8000-000000000003',
    '82000000-0000-4000-8000-000000000001',
    'client'
  ),
  (
    '82000000-0000-4000-8000-000000000004',
    '82000000-0000-4000-8000-000000000002',
    'client'
  );

insert into public.jobs (id, organization_id, created_by, title)
values
  (
    '82000000-0000-4000-8000-000000000005',
    '82000000-0000-4000-8000-000000000003',
    '82000000-0000-4000-8000-000000000001',
    'Identity A source'
  ),
  (
    '82000000-0000-4000-8000-000000000006',
    '82000000-0000-4000-8000-000000000004',
    '82000000-0000-4000-8000-000000000002',
    'Identity B source'
  );

create function pg_temp.add_identity_blob(
  p_id uuid, p_organization_id uuid, p_hash_seed text,
  p_storage_path text, p_mime_type text
) returns void language sql as $$
  insert into public.organization_file_blobs (
    id, organization_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, size_bytes, mime_type
  ) values (
    p_id, p_organization_id, repeat(p_hash_seed, 64), repeat(p_hash_seed, 64),
    'job-files', p_storage_path, 100, p_mime_type
  );
$$;

create function pg_temp.add_identity_file(
  p_id uuid, p_job_id uuid, p_organization_id uuid, p_uploaded_by uuid,
  p_blob_id uuid, p_hash_seed text, p_storage_path text,
  p_original_name text, p_normalized_name text, p_file_kind text
) returns void language sql as $$
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
    trusted_content_sha256, storage_bucket, storage_path, original_name,
    normalized_name, file_kind, size_bytes
  ) values (
    p_id, p_job_id, p_organization_id, p_uploaded_by, p_blob_id,
    repeat(p_hash_seed, 64), repeat(p_hash_seed, 64), 'job-files',
    p_storage_path, p_original_name, p_normalized_name, p_file_kind::public.job_file_kind, 100
  );
$$;

select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000007', '82000000-0000-4000-8000-000000000003', 'c', 'identity-a/cad.step', 'application/step');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000008', '82000000-0000-4000-8000-000000000003', 'd', 'identity-a/drawing.pdf', 'application/pdf');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000009', '82000000-0000-4000-8000-000000000003', 'e', 'identity-a/drawing-v2.pdf', 'application/pdf');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000010', '82000000-0000-4000-8000-000000000004', 'c', 'identity-b/cad.step', 'application/step');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000011', '82000000-0000-4000-8000-000000000004', 'd', 'identity-b/drawing.pdf', 'application/pdf');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000018', '82000000-0000-4000-8000-000000000004', 'f', 'identity-b/private-cad.step', 'application/step');
select pg_temp.add_identity_blob('82000000-0000-4000-8000-000000000019', '82000000-0000-4000-8000-000000000004', '9', 'identity-b/private-drawing.pdf', 'application/pdf');

select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000012', '82000000-0000-4000-8000-000000000005', '82000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000007', 'c', 'identity-a/cad.step', 'bracket.step', 'bracket', 'cad');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000013', '82000000-0000-4000-8000-000000000005', '82000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000008', 'd', 'identity-a/drawing.pdf', 'bracket.pdf', 'bracket', 'drawing');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000014', '82000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000010', 'c', 'identity-b/cad.step', 'different-name.step', 'different-name', 'cad');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000015', '82000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000011', 'd', 'identity-b/drawing.pdf', 'different-name.pdf', 'different-name', 'drawing');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000020', '82000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000018', 'f', 'identity-b/private-cad.step', 'private.step', 'private', 'cad');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000021', '82000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000019', '9', 'identity-b/private-drawing.pdf', 'private.pdf', 'private', 'drawing');

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id
) values
  (
    '82000000-0000-4000-8000-000000000016',
    '82000000-0000-4000-8000-000000000005',
    '82000000-0000-4000-8000-000000000003',
    'Bracket', 'bracket',
    '82000000-0000-4000-8000-000000000012',
    '82000000-0000-4000-8000-000000000013'
  ),
  (
    '82000000-0000-4000-8000-000000000017',
    '82000000-0000-4000-8000-000000000006',
    '82000000-0000-4000-8000-000000000004',
    'Different filename', 'different-name',
    '82000000-0000-4000-8000-000000000014',
    '82000000-0000-4000-8000-000000000015'
  ),
  (
    '82000000-0000-4000-8000-000000000022',
    '82000000-0000-4000-8000-000000000006',
    '82000000-0000-4000-8000-000000000004',
    'Private cross-org package', 'private',
    '82000000-0000-4000-8000-000000000020',
    '82000000-0000-4000-8000-000000000021'
  );

select isnt(
  (
    select part_version_id
    from public.parts
    where id = '82000000-0000-4000-8000-000000000016'
  ),
  (
    select part_version_id
    from public.parts
    where id = '82000000-0000-4000-8000-000000000017'
  ),
  'identical packages in different organizations never share a version'
);

select set_config(
  'test.source_part_version_id',
  (
    select source_part.part_version_id::text
    from public.parts source_part
    where source_part.id = '82000000-0000-4000-8000-000000000016'
  ),
  true
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-4000-8000-000000000001', true);

select is(
  public.api_prepare_part_intake(repeat('c', 64), repeat('d', 64)) ->> 'result',
  'existing_version',
  'an accessible same-organization client-hash match is reported only as a preflight hint'
);

select is(
  public.api_prepare_part_intake(repeat('c', 64), repeat('d', 64)) ->> 'partVersionId',
  null,
  'the authenticated preflight never exposes the reusable version identifier'
);

select is(
  public.api_prepare_part_intake(repeat('c', 64), repeat('e', 64)) ->> 'result',
  'new_version',
  'the same CAD with a different drawing is a new version'
);

select is(
  public.api_prepare_part_intake(repeat('c', 64), null) ->> 'result',
  'new_version',
  'a missing drawing does not match an existing drawing'
);

select is(
  public.api_prepare_part_intake(repeat('f', 64), repeat('d', 64)) ->> 'result',
  'new_identity',
  'filenames never establish identity when the trusted CAD differs'
);

select is(
  public.api_prepare_part_intake(repeat('f', 64), repeat('9', 64)) ->> 'result',
  'new_identity',
  'a hidden cross-organization match is indistinguishable from a new upload'
);

reset role;

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_resolve_trusted_part_intake(uuid)',
    'EXECUTE'
  ),
  'authenticated callers cannot resolve trusted intake identities'
);

select ok(
  not exists (
    select 1
    from public.part_versions version
    where version.organization_id = '82000000-0000-4000-8000-000000000003'
      and version.cad_content_sha256 = repeat('f', 64)
  ),
  'cross-organization hashes never create a reusable same-organization version'
);

-- Model the worker-verified duplicate placement that the upload path creates
-- before technical artifacts are reused from the canonical source version.
insert into public.jobs (id, organization_id, created_by, title)
values (
  '82000000-0000-4000-8000-000000000024',
  '82000000-0000-4000-8000-000000000003',
  '82000000-0000-4000-8000-000000000001',
  'Identity A duplicate placement'
);

select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000025', '82000000-0000-4000-8000-000000000024', '82000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000007', 'c', 'identity-a/cad.step', 'bracket-copy.step', 'bracket-copy', 'cad');
select pg_temp.add_identity_file('82000000-0000-4000-8000-000000000026', '82000000-0000-4000-8000-000000000024', '82000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000008', 'd', 'identity-a/drawing.pdf', 'bracket-copy.pdf', 'bracket-copy', 'drawing');

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id
) values (
  '82000000-0000-4000-8000-000000000027',
  '82000000-0000-4000-8000-000000000024',
  '82000000-0000-4000-8000-000000000003',
  'Bracket copy', 'bracket-copy',
  '82000000-0000-4000-8000-000000000025',
  '82000000-0000-4000-8000-000000000026'
);

insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status, payload
) values (
  '82000000-0000-4000-8000-000000000023',
  '82000000-0000-4000-8000-000000000003',
  '82000000-0000-4000-8000-000000000005',
  '82000000-0000-4000-8000-000000000016',
  'extract_part', 'running', '{}'::jsonb
);

select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (
    public.api_reuse_trusted_part_version_artifacts(
      '82000000-0000-4000-8000-000000000027',
      '82000000-0000-4000-8000-000000000016',
      (
        select source.part_version_id from public.parts source
        where source.id = '82000000-0000-4000-8000-000000000016'
      )
    ) ->> 'artifactsReady'
  )::boolean,
  false,
  'a concurrent duplicate waits while the source extraction is active'
);

delete from public.work_queue
where id = '82000000-0000-4000-8000-000000000023';

select is(
  (
    public.api_reuse_trusted_part_version_artifacts(
      '82000000-0000-4000-8000-000000000027',
      '82000000-0000-4000-8000-000000000016',
      (
        select source.part_version_id from public.parts source
        where source.id = '82000000-0000-4000-8000-000000000016'
      )
    ) ->> 'extractTargetIndependently'
  )::boolean,
  true,
  'a duplicate extracts independently when its canonical source has no active task or artifacts'
);

insert into public.drawing_extractions (
  part_id, organization_id, extractor_version, extraction, status
) values (
  '82000000-0000-4000-8000-000000000016',
  '82000000-0000-4000-8000-000000000003',
  'identity-test-v1', '{"material":"6061-T6"}'::jsonb, 'approved'
);

select is(
  (
    public.api_reuse_trusted_part_version_artifacts(
      '82000000-0000-4000-8000-000000000027',
      '82000000-0000-4000-8000-000000000016',
      (
        select source.part_version_id from public.parts source
        where source.id = '82000000-0000-4000-8000-000000000016'
      )
    ) ->> 'artifactsReady'
  )::boolean,
  true,
  'the duplicate reuses artifacts after the source extraction completes'
);

select is(
  (
    select count(*)::integer
    from public.drawing_extractions extraction
    where extraction.part_id = '82000000-0000-4000-8000-000000000027'
  ),
  1,
  'artifact reuse creates one compatibility projection without duplicate extraction work'
);

select * from finish();

rollback;
