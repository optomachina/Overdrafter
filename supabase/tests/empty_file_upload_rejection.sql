-- OVD-601: the job-file prepare and finalize RPCs reject empty uploads on the
-- server. A missing, zero or negative size, or the SHA-256 of zero bytes, is
-- denied with P0001 file_upload_empty. Every other precondition holds for each
-- denied call: an eligible Founding Beta member, an editable job, a canonical
-- path and an existing Storage object. So the only reason any call here can be
-- denied is the empty-upload guard.
--
-- Pre-fix observation (this suite on the tree without migration
-- 20261004110000_reject_empty_job_file_uploads.sql). Expected:
-- - Prepare with size 0, null or -1 returns upload_required, so each
--   throws_ok fails with "no exception".
-- - Prepare with the empty hash returns reused and attaches the existing
--   zero-byte blob. The case- and whitespace-normalized empty hash then
--   returns duplicate_in_job. Neither raises.
-- - The job_files count after the prepare block is one higher than before.
-- - Finalize with size 0, null or -1, and with the empty hash, registers the
--   upload. The normalized empty hash then raises "A matching file is already
--   attached to this job."
-- - The job_files and organization_file_blobs counts after the finalize block
--   are higher than before. The finalize job holds five rows instead of the
--   control's one.
begin;

select plan(19);

create function pg_temp.set_ovd601_request_identity(
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

create temporary table ovd601_test_context (
  admin_user_id uuid not null,
  member_user_id uuid not null,
  organization_id uuid not null,
  prepare_job_id uuid not null,
  finalize_job_id uuid not null,
  empty_hash text not null,
  prepare_zero_hash text not null,
  prepare_null_hash text not null,
  prepare_negative_hash text not null,
  finalize_zero_hash text not null,
  finalize_null_hash text not null,
  finalize_negative_hash text not null,
  control_hash text not null,
  finalize_control_hash text not null,
  job_files_before integer,
  blobs_before integer
) on commit drop;

-- empty_hash is derived here, not copied from the migration, so a typo in the
-- migration's literal cannot pass. It equals
-- e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
insert into ovd601_test_context values (
  '00000000-0000-4000-8000-000000006011',
  '00000000-0000-4000-8000-000000006012',
  '00000000-0000-4000-8000-000000006013',
  '00000000-0000-4000-8000-000000006014',
  '00000000-0000-4000-8000-000000006015',
  encode(pg_catalog.sha256(''::bytea), 'hex'),
  repeat('1', 64),
  repeat('2', 64),
  repeat('3', 64),
  repeat('4', 64),
  repeat('5', 64),
  repeat('6', 64),
  repeat('d', 64),
  repeat('f', 64),
  null,
  null
);

grant select on ovd601_test_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values
  ((select admin_user_id from ovd601_test_context), 'authenticated', 'authenticated', 'ovd601-admin@example.com', timezone('utc', now())),
  ((select member_user_id from ovd601_test_context), 'authenticated', 'authenticated', 'ovd601-member@example.com', timezone('utc', now()));

insert into private.platform_admin_emails (email)
values ('ovd601-admin@example.com');

insert into public.organizations (id, name, slug)
values ((select organization_id from ovd601_test_context), 'OVD 601 Empty Upload', 'ovd-601-empty-upload');

insert into public.organization_memberships (organization_id, user_id, role)
values
  ((select organization_id from ovd601_test_context), (select admin_user_id from ovd601_test_context), 'internal_admin'),
  ((select organization_id from ovd601_test_context), (select member_user_id from ovd601_test_context), 'client');

insert into public.jobs (id, organization_id, created_by, title)
values
  ((select prepare_job_id from ovd601_test_context), (select organization_id from ovd601_test_context), (select member_user_id from ovd601_test_context), 'OVD 601 prepare'),
  ((select finalize_job_id from ovd601_test_context), (select organization_id from ovd601_test_context), (select member_user_id from ovd601_test_context), 'OVD 601 finalize');

insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false) -- NOSONAR: canonical private bucket fixture
on conflict (id) do nothing;

-- An existing zero-byte blob, for example one written before this guard. It
-- gives prepare's reuse branch something to attach, so the prepare row counts
-- below can actually fail.
insert into public.organization_file_blobs (organization_id, content_sha256, storage_bucket, storage_path, size_bytes)
select
  context.organization_id,
  context.empty_hash,
  'job-files',
  public.build_org_file_blob_storage_path(context.organization_id, context.empty_hash, 'legacy-empty.step'),
  0
from ovd601_test_context context;

-- Canonical objects for every finalize call, so finalize passes its path and
-- object checks for each one.
insert into storage.objects (id, bucket_id, name, owner)
select
  gen_random_uuid(),
  'job-files',
  public.build_org_file_blob_storage_path(context.organization_id, fixture.content_hash, fixture.original_name),
  context.member_user_id
from ovd601_test_context context
cross join lateral (values
  (context.finalize_zero_hash, 'zero-size.step'),
  (context.finalize_null_hash, 'null-size.step'),
  (context.finalize_negative_hash, 'negative-size.step'),
  (context.empty_hash, 'empty-hash.step'),
  (context.finalize_control_hash, 'control.step')
) as fixture(content_hash, original_name);

update ovd601_test_context
set job_files_before = (select count(*)::integer from public.job_files),
    blobs_before = (select count(*)::integer from public.organization_file_blobs);

set local role authenticated;
select pg_temp.set_ovd601_request_identity((select admin_user_id from ovd601_test_context), 'aal2');

select lives_ok(
  format($$select public.api_admin_set_founding_beta_enrollment(%L::uuid, true, 'Approved empty-upload test', 'ovd601-grant')$$,
    (select organization_id from ovd601_test_context)),
  'an administrator enrolls the test organization'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd601_request_identity((select member_user_id from ovd601_test_context));

select is(
  public.api_accept_founding_beta_notice((select organization_id from ovd601_test_context), 'founding-beta-2026-08-15') ->> 'state',
  'eligible',
  'the member is eligible, so no denial below is a Founding Beta denial'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'zero-size.step', 'cad', null, 0, %L)$$,
    (select prepare_job_id from ovd601_test_context), (select prepare_zero_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty', -- NOSONAR: repeated stable empty-upload denial assertion
  'prepare rejects a zero size'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'null-size.step', 'cad', null, null, %L)$$,
    (select prepare_job_id from ovd601_test_context), (select prepare_null_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'prepare rejects a missing size'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'negative-size.step', 'cad', null, -1, %L)$$,
    (select prepare_job_id from ovd601_test_context), (select prepare_negative_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'prepare rejects a negative size'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'empty-hash.step', 'cad', null, 10, %L)$$,
    (select prepare_job_id from ovd601_test_context), (select empty_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'prepare rejects the empty-content hash with a positive size, before reusing an existing blob'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'empty-hash.step', 'cad', null, 10, %L)$$,
    (select prepare_job_id from ovd601_test_context), (select ' ' || upper(empty_hash) || ' ' from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'prepare rejects the empty-content hash after case and whitespace normalization'
);

select is(
  public.api_prepare_job_file_upload(
    (select prepare_job_id from ovd601_test_context), 'control.step', 'cad', null, 10, (select control_hash from ovd601_test_context)
  ) ->> 'status',
  'upload_required',
  'prepare still requests an upload for a positive size and a non-empty hash'
);

reset role;

select is((select count(*)::integer from public.job_files), (select job_files_before from ovd601_test_context),
  'rejected prepares create no job_files rows');

select is((select count(*)::integer from public.organization_file_blobs), (select blobs_before from ovd601_test_context),
  'rejected prepares create no organization_file_blobs rows');

set local role authenticated;
select pg_temp.set_ovd601_request_identity((select member_user_id from ovd601_test_context));

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'zero-size.step', 'cad', null, 0, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select finalize_zero_hash from ovd601_test_context), 'zero-size.step'),
    (select finalize_zero_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'finalize rejects a zero size'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'null-size.step', 'cad', null, null, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select finalize_null_hash from ovd601_test_context), 'null-size.step'),
    (select finalize_null_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'finalize rejects a missing size'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'negative-size.step', 'cad', null, -1, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select finalize_negative_hash from ovd601_test_context), 'negative-size.step'),
    (select finalize_negative_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'finalize rejects a negative size'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'empty-hash.step', 'cad', null, 10, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select empty_hash from ovd601_test_context), 'empty-hash.step'),
    (select empty_hash from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'finalize rejects the empty-content hash with a positive size'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'empty-hash.step', 'cad', null, 10, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select empty_hash from ovd601_test_context), 'empty-hash.step'),
    (select ' ' || upper(empty_hash) || ' ' from ovd601_test_context)),
  'P0001', 'file_upload_empty',
  'finalize rejects the empty-content hash after case and whitespace normalization'
);

reset role;

select is((select count(*)::integer from public.job_files), (select job_files_before from ovd601_test_context),
  'rejected finalizes create no job_files rows');

select is((select count(*)::integer from public.organization_file_blobs), (select blobs_before from ovd601_test_context),
  'rejected finalizes create no organization_file_blobs rows');

set local role authenticated;
select pg_temp.set_ovd601_request_identity((select member_user_id from ovd601_test_context));

select lives_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'control.step', 'cad', null, 10, %L)$$,
    (select finalize_job_id from ovd601_test_context),
    public.build_org_file_blob_storage_path((select organization_id from ovd601_test_context), (select finalize_control_hash from ovd601_test_context), 'control.step'),
    (select finalize_control_hash from ovd601_test_context)),
  'finalize still registers a positive size and a non-empty hash on the same fixture'
);

reset role;

select is((select count(*)::integer from public.job_files where job_id = (select finalize_job_id from ovd601_test_context)), 1,
  'the finalize job holds only the control file');

select * from finish();

rollback;
