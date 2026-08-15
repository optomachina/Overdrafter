begin;

select plan(38);

create function pg_temp.set_ovd365_request_identity(
  p_user_id uuid,
  p_aal text default 'aal1'
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated', -- NOSONAR: repeated JWT fixture claim
      'aal', p_aal
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create temporary table ovd365_test_context (
  admin_user_id uuid not null,
  member_user_id uuid not null,
  outsider_user_id uuid not null,
  organization_id uuid not null,
  other_organization_id uuid not null,
  job_id uuid not null,
  reuse_job_id uuid not null,
  other_job_id uuid not null,
  content_hash text not null,
  second_hash text not null,
  third_hash text not null,
  canonical_path text not null
) on commit drop;

insert into ovd365_test_context values (
  '00000000-0000-4000-8000-000000003651',
  '00000000-0000-4000-8000-000000003652',
  '00000000-0000-4000-8000-000000003653',
  '00000000-0000-4000-8000-000000003654',
  '00000000-0000-4000-8000-000000003655',
  '00000000-0000-4000-8000-000000003656',
  '00000000-0000-4000-8000-000000003657',
  '00000000-0000-4000-8000-000000003658',
  repeat('a', 64),
  repeat('b', 64),
  repeat('c', 64),
  public.build_org_file_blob_storage_path(
    '00000000-0000-4000-8000-000000003654',
    repeat('a', 64),
    'validation.step' -- NOSONAR: repeated canonical filename fixture
  )
);

grant select on ovd365_test_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values
  ((select admin_user_id from ovd365_test_context), 'authenticated', 'authenticated', 'ovd365-admin@example.com', timezone('utc', now())),
  ((select member_user_id from ovd365_test_context), 'authenticated', 'authenticated', 'ovd365-member@example.com', timezone('utc', now())),
  ((select outsider_user_id from ovd365_test_context), 'authenticated', 'authenticated', 'ovd365-outsider@example.com', timezone('utc', now()));

insert into private.platform_admin_emails (email)
values ('ovd365-admin@example.com');

insert into public.organizations (id, name, slug)
values
  ((select organization_id from ovd365_test_context), 'OVD 365 Primary', 'ovd-365-primary'),
  ((select other_organization_id from ovd365_test_context), 'OVD 365 Other', 'ovd-365-other');

insert into public.organization_memberships (organization_id, user_id, role)
values
  ((select organization_id from ovd365_test_context), (select admin_user_id from ovd365_test_context), 'internal_admin'),
  ((select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context), 'client'),
  ((select other_organization_id from ovd365_test_context), (select outsider_user_id from ovd365_test_context), 'client');

insert into public.jobs (id, organization_id, created_by, title)
values
  ((select job_id from ovd365_test_context), (select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context), 'OVD 365 upload'),
  ((select reuse_job_id from ovd365_test_context), (select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context), 'OVD 365 reuse'),
  ((select other_job_id from ovd365_test_context), (select other_organization_id from ovd365_test_context), (select outsider_user_id from ovd365_test_context), 'OVD 365 other');

insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false) -- NOSONAR: canonical private bucket fixture
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner)
values (
  gen_random_uuid(),
  'job-files',
  'org-sha256/00000000-0000-4000-8000-000000003655/victim/victim.step', -- NOSONAR: cross-tenant exploit fixture
  (select outsider_user_id from ovd365_test_context)
);

set local role authenticated;
select pg_temp.set_ovd365_request_identity((select member_user_id from ovd365_test_context));

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'P0001', 'founding_beta_not_enrolled', -- NOSONAR: stable denial-state assertion
  'prepare fails closed before enrollment'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select canonical_path from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'P0001', 'founding_beta_not_enrolled',
  'finalize fails closed before enrollment'
);

select throws_ok(
  format($$select public.api_attach_job_file(%L::uuid, 'job-files', 'guessed/path', 'validation.step', 'cad')$$,
    (select job_id from ovd365_test_context)),
  'P0001', 'founding_beta_not_enrolled',
  'legacy attach fails closed before enrollment'
);

select throws_ok(
  format($$insert into public.job_files (job_id, organization_id, uploaded_by, storage_bucket, storage_path, original_name, normalized_name, file_kind)
    values (%L::uuid, %L::uuid, %L::uuid, 'job-files', 'direct/not-enrolled', 'direct.step', 'direct', 'cad')$$,
    (select job_id from ovd365_test_context), (select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'permission denied for table job_files', -- NOSONAR: repeated direct-insert denial assertion
  'direct metadata insert fails closed before enrollment'
);

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select canonical_path from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'new row violates row-level security policy for table "objects"', -- NOSONAR: repeated Storage RLS assertion
  'modern storage write fails closed before enrollment'
);

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select job_id::text || '/legacy.step' from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'new row violates row-level security policy for table "objects"',
  'legacy storage write fails closed before enrollment'
);

select is((select count(*)::integer from public.job_files where job_id = (select job_id from ovd365_test_context)), 0,
  'denied pre-enrollment paths create no file metadata');

reset role;
set local role authenticated;
select pg_temp.set_ovd365_request_identity((select admin_user_id from ovd365_test_context), 'aal2');

select lives_ok(
  format($$select public.api_admin_set_founding_beta_enrollment(%L::uuid, true, 'Approved file-boundary test', 'ovd365-grant')$$,
    (select organization_id from ovd365_test_context)),
  'an administrator grants the test organization enrollment'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd365_request_identity((select member_user_id from ovd365_test_context));

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'P0001', 'founding_beta_notice_required',
  'prepare requires acceptance of the current notice'
);

select is(
  public.api_accept_founding_beta_notice((select organization_id from ovd365_test_context), 'founding-beta-2026-08-15') ->> 'state',
  'eligible',
  'current notice acceptance enables the supported path'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'invalid.step', 'cad', null, 10, 'not-a-sha256')$$,
    (select job_id from ovd365_test_context)),
  'P0001', 'A valid SHA-256 content hash is required to prepare a file upload.',
  'prepare rejects a malformed content hash'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', 'invalid/path', 'invalid.step', 'cad', null, 10, 'not-a-sha256')$$,
    (select job_id from ovd365_test_context)),
  'P0001', 'A valid SHA-256 content hash is required to finalize a file upload.',
  'finalize rejects a malformed content hash'
);

select is(
  public.api_prepare_job_file_upload(
    (select job_id from ovd365_test_context), 'validation.step', 'cad', null, 10, (select content_hash from ovd365_test_context)
  ) ->> 'status',
  'upload_required',
  'eligible prepare requests an upload'
);

select is(
  public.api_prepare_job_file_upload(
    (select job_id from ovd365_test_context), 'validation.step', 'cad', null, 10, (select content_hash from ovd365_test_context)
  ) ->> 'storagePath',
  (select canonical_path from ovd365_test_context),
  'prepare returns the server-derived canonical path'
);

select lives_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select canonical_path from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  'eligible members can write the canonical modern storage path'
);

select lives_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    public.build_org_file_blob_storage_path(
      (select organization_id from ovd365_test_context),
      (select second_hash from ovd365_test_context),
      '.hidden.step'
    ),
    (select member_user_id from ovd365_test_context)),
  'storage policy accepts punctuation preserved by the canonical path builder'
);

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select job_id::text || '/eligible-legacy.step' from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'new row violates row-level security policy for table "objects"',
  'eligible members cannot write the retired legacy storage path'
);

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select 'org-sha256/' || organization_id::text || '/malformed/not-canonical.step' from ovd365_test_context),
    (select member_user_id from ovd365_test_context)),
  '42501', 'new row violates row-level security policy for table "objects"',
  'eligible members cannot write malformed modern storage paths'
);

select throws_ok(
  format($$insert into public.job_files (job_id, organization_id, uploaded_by, storage_bucket, storage_path, original_name, normalized_name, file_kind)
    values (%L::uuid, %L::uuid, %L::uuid, 'job-files', 'org-sha256/00000000-0000-4000-8000-000000003655/victim/victim.step', 'forged.step', 'forged', 'cad')$$,
    (select job_id from ovd365_test_context), (select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'permission denied for table job_files',
  'eligible members cannot forge metadata that points at another tenant object'
);

select is(
  (select count(*)::integer from storage.objects where name = 'org-sha256/00000000-0000-4000-8000-000000003655/victim/victim.step'),
  0,
  'a denied forged metadata row cannot unlock cross-tenant storage reads'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'other-bucket', %L, 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select canonical_path from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'P0001', 'file_upload_path_mismatch',
  'finalize rejects a substituted bucket'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', 'org-sha256/substituted', 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'P0001', 'file_upload_path_mismatch',
  'finalize rejects a substituted path'
);

select is((select count(*)::integer from public.organization_file_blobs where organization_id = (select organization_id from ovd365_test_context)), 0,
  'path substitution creates no canonical blob metadata');

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'missing.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd365_test_context), (select second_hash from ovd365_test_context), 'missing.step'),
    (select second_hash from ovd365_test_context)),
  'P0001', 'file_upload_object_missing',
  'finalize rejects a canonical path whose object is missing'
);

select lives_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'validation.step', 'cad', null, 10, %L)$$,
    (select job_id from ovd365_test_context), (select canonical_path from ovd365_test_context), (select content_hash from ovd365_test_context)),
  'eligible finalize registers the uploaded object'
);

select is((select count(*)::integer from public.job_files where job_id = (select job_id from ovd365_test_context)), 1,
  'successful finalize creates one job-file record');

select is(
  public.api_prepare_job_file_upload(
    (select reuse_job_id from ovd365_test_context), 'validation-copy.step', 'cad', null, 10, (select content_hash from ovd365_test_context)
  ) ->> 'status',
  'reused',
  'eligible prepare can reuse an organization-scoped blob'
);

select throws_ok(
  format($$select public.api_attach_job_file(%L::uuid, 'job-files', 'guessed/path', 'validation.step', 'cad')$$,
    (select job_id from ovd365_test_context)),
  'P0001', 'legacy_file_attach_unavailable',
  'eligible callers cannot use the retired arbitrary-path attach RPC'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'cross-org.step', 'cad', null, 10, %L)$$,
    (select other_job_id from ovd365_test_context), (select third_hash from ovd365_test_context)),
  'P0001', format('You do not have permission to attach files to job %s', (select other_job_id from ovd365_test_context)),
  'prepare denies cross-organization jobs before revealing beta state'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd365_request_identity((select admin_user_id from ovd365_test_context), 'aal2');

select lives_ok(
  format($$select public.api_admin_set_founding_beta_enrollment(%L::uuid, false, 'Revoked during upload test', 'ovd365-revoke')$$,
    (select organization_id from ovd365_test_context)),
  'an administrator revokes enrollment immediately'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd365_request_identity((select member_user_id from ovd365_test_context));

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'revoked.step', 'cad', null, 10, %L)$$, -- NOSONAR: repeated revoke fixture
    (select job_id from ovd365_test_context), (select third_hash from ovd365_test_context)),
  'P0001', 'founding_beta_revoked',
  'revoked prepare fails closed immediately'
);

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner)
    values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    public.build_org_file_blob_storage_path((select organization_id from ovd365_test_context), (select third_hash from ovd365_test_context), 'revoked.step'),
    (select member_user_id from ovd365_test_context)),
  '42501', 'new row violates row-level security policy for table "objects"',
  'revocation blocks a storage write after prepare'
);

select throws_ok(
  format($$insert into public.job_files (job_id, organization_id, uploaded_by, storage_bucket, storage_path, original_name, normalized_name, file_kind)
    values (%L::uuid, %L::uuid, %L::uuid, 'job-files', 'direct/revoked', 'revoked.step', 'revoked', 'cad')$$,
    (select job_id from ovd365_test_context), (select organization_id from ovd365_test_context), (select member_user_id from ovd365_test_context)),
  '42501', 'permission denied for table job_files',
  'revocation blocks direct metadata inserts'
);

select is((select count(*)::integer from public.job_files where job_id in ((select job_id from ovd365_test_context), (select reuse_job_id from ovd365_test_context))), 2,
  'revoked members retain read access to existing file metadata');

select is((select count(*)::integer from storage.objects where bucket_id = 'job-files' and name = (select canonical_path from ovd365_test_context)), 1,
  'revoked members retain read access to an existing attached object');

select is((select count(*)::integer from storage.objects where name like '%revoked.step'), 0,
  'the revoke-between-steps denial creates no stored object');

reset role;

select is((select count(*)::integer from public.organization_file_blobs where organization_id = (select organization_id from ovd365_test_context)), 1,
  'denied paths do not create extra blob metadata');

select is((select count(*)::integer from public.job_files where storage_path in ('direct/not-enrolled', 'direct/revoked')), 0,
  'denied direct inserts leave no partial file records');

select * from finish();

rollback;
