-- OVD-723: controlled or uncertain uploads are blocked at upload time, files
-- with export-control markings are held for admin review, and every provider
-- preflight denies without a clean latest declaration.
--
-- Targets the EXPAND migration 20261013043000_ovd723_export_control_upload_block.sql
-- (window 1, bytes identical to the reviewed draft docs/migration-drafts/ovd-723.sql)
-- alone. Window 1 changes no existing object: the legacy upload RPCs, the
-- old Storage INSERT policy, and both preflights keep their behavior, so
-- this suite checks the grant policy expression and the new worker dispatch
-- check directly. The server side enforcement added by the contract draft is
-- covered by ovd723_export_control_contract.sql.pending.
-- The contract draft stays pending until migration window 2.
--
-- Acceptance coverage:
--   1. upload without a declaration is rejected and stores nothing
--   2. controlled / unsure blocks the upload; zero storage objects
--   3. a declaration exists but the latest is not clean: preflight denies
--   4. a marking hit blocks; a user cannot clear it; an admin can, audited
--   5. foreign providers have their own denial; Xometry and Fictiv are denied
--   6. a preflight lookup that finds nothing denies (fail closed)
--   7. cross-org reads fail, audit UPDATE/DELETE fail, anon cannot execute
--   8. dispatch needs a clean scan of record for the part's own files; a
--      reused file (same bytes, different job_file) is not covered by another
--      file's scan
--  10. extraction check: CAD or drawing content reaches a model only for a
--      clean, unblocked job; repeat marking hits do not open duplicate
--      blocks; RapidDirect and Protolabs Network are foreign; no IP stored
--   9. Codex review attacks: an upload grant covers one exact object, is
--      single use, and finalize checks owner, size, and window (finding 2);
--      the Storage helper serializes with declaration writers (finding 1, the
--      two-session race is docs/migration-drafts/ovd-723-upload-race.sh); the
--      legacy signatures never delegate (finding 3); a scan stops vouching
--      once its file row is repointed, moved, or its hash is unverified
--      (finding 4)
--  11. parts extracted before OVD-723: rescan recovery, scan state, owner
--      requeue; 11c (review round 5): extraction scans a fresh STEP part and
--      records final outcomes, and a replaced drawing no part references does
--      not hold the scan state
begin;

select plan(167);

create function pg_temp.set_ovd723_request_identity(
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

create temporary table ovd723_ctx (
  admin_user_id uuid not null,
  member_user_id uuid not null,
  other_user_id uuid not null,
  organization_id uuid not null,
  other_organization_id uuid not null,
  clean_job_id uuid not null,
  unsure_job_id uuid not null,
  undeclared_job_id uuid not null,
  other_job_id uuid not null,
  clean_hash text not null,
  blocked_hash text not null,
  terms_version text not null,
  controlled_declaration jsonb,
  unsure_declaration jsonb,
  clean_declaration jsonb,
  block_id uuid,
  job_files_before integer,
  objects_before integer
) on commit drop;

insert into ovd723_ctx values (
  '00000000-0000-4000-8000-000000007231',
  '00000000-0000-4000-8000-000000007232',
  '00000000-0000-4000-8000-000000007233',
  '00000000-0000-4000-8000-000000007234',
  '00000000-0000-4000-8000-000000007235',
  '00000000-0000-4000-8000-000000007236',
  '00000000-0000-4000-8000-000000007237',
  '00000000-0000-4000-8000-000000007238',
  '00000000-0000-4000-8000-000000007239',
  repeat('a', 64),
  repeat('b', 64),
  'ovd-beta-export-control.v1',
  null, null, null, null, null, null
);

grant select, update on ovd723_ctx to authenticated, service_role;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values
  ((select admin_user_id from ovd723_ctx), 'authenticated', 'authenticated', 'ovd723-admin@example.com', timezone('utc', now())),
  ((select member_user_id from ovd723_ctx), 'authenticated', 'authenticated', 'ovd723-member@example.com', timezone('utc', now())),
  ((select other_user_id from ovd723_ctx), 'authenticated', 'authenticated', 'ovd723-other@example.com', timezone('utc', now()));

insert into private.platform_admin_emails (email)
values ('ovd723-admin@example.com');

insert into public.organizations (id, name, slug)
values
  ((select organization_id from ovd723_ctx), 'OVD 723 Export', 'ovd-723-export'),
  ((select other_organization_id from ovd723_ctx), 'OVD 723 Other', 'ovd-723-other');

insert into public.organization_memberships (organization_id, user_id, role)
values
  ((select organization_id from ovd723_ctx), (select admin_user_id from ovd723_ctx), 'internal_admin'),
  ((select organization_id from ovd723_ctx), (select member_user_id from ovd723_ctx), 'client'),
  ((select other_organization_id from ovd723_ctx), (select other_user_id from ovd723_ctx), 'client');

insert into public.jobs (id, organization_id, created_by, title)
select job.id, context.organization_id, context.member_user_id, job.title
from ovd723_ctx context
cross join lateral (values
  (context.clean_job_id, 'OVD 723 clean'),
  (context.unsure_job_id, 'OVD 723 unsure'),
  (context.undeclared_job_id, 'OVD 723 undeclared')
) as job(id, title);

insert into public.jobs (id, organization_id, created_by, title)
select other_job_id, other_organization_id, other_user_id, 'OVD 723 other org'
from ovd723_ctx;

insert into storage.buckets (id, name, public)
values ('job-files', 'job-files', false) -- NOSONAR: canonical private bucket fixture
on conflict (id) do nothing;

update ovd723_ctx
set job_files_before = (select count(*)::integer from public.job_files),
    objects_before = (select count(*)::integer from storage.objects where bucket_id = 'job-files');

-- Fixture: enroll the organization so no denial below is a Founding Beta denial.
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');

select lives_ok(
  format($$select public.api_admin_set_founding_beta_enrollment(%L::uuid, true, 'Approved export-control test', 'ovd723-grant')$$,
    (select organization_id from ovd723_ctx)),
  'an administrator enrolls the test organization'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select is(
  public.api_accept_founding_beta_notice((select organization_id from ovd723_ctx), 'founding-beta-2026-08-15') ->> 'state',
  'eligible',
  'the member is eligible for uploads'
);

-- 1. No declaration.
select is(
  public.api_prepare_job_file_upload(
    (select clean_job_id from ovd723_ctx), 'part.step', 'cad', null, 10, (select clean_hash from ovd723_ctx)
  ) ->> 'status',
  'upload_required',
  'window 1 leaves the legacy prepare unchanged (the contract makes it refuse)'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', 'x', 'part.step', 'cad', null, 10, %L)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx)),
  'P0001', 'file_upload_path_mismatch',
  'window 1 leaves the legacy finalize unchanged: it still runs its own checks'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, null::uuid)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx)),
  'P0001', 'export_declaration_missing',
  'prepare with a null declaration id is rejected'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, gen_random_uuid())$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx)),
  'P0001', 'export_declaration_missing',
  'prepare with an unknown declaration id on an undeclared job is rejected'
);

select is(
  public.current_user_has_export_cleared_upload('job-files', (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx)),
  false,
  'the grant policy rejects a job-files object without a declaration backed grant'
);

-- Declaration input validation.
select throws_ok(
  format($$select public.api_declare_job_export_status(%L::uuid, null, %L)$$,
    (select clean_job_id from ovd723_ctx), (select terms_version from ovd723_ctx)),
  'P0001', 'export_declaration_invalid',
  'a missing answer is invalid (there is no default)'
);

select throws_ok(
  format($$select public.api_declare_job_export_status(%L::uuid, 'missing', %L)$$,
    (select clean_job_id from ovd723_ctx), (select terms_version from ovd723_ctx)),
  'P0001', 'export_declaration_invalid',
  'users cannot declare the system-only missing answer'
);

select throws_ok(
  format($$select public.api_declare_job_export_status(%L::uuid, 'not_controlled', 'old-terms')$$,
    (select clean_job_id from ovd723_ctx)),
  'P0001', 'export_terms_version_stale',
  'a stale terms version is rejected'
);

-- 2. controlled and unsure.
update ovd723_ctx
set controlled_declaration = public.api_declare_job_export_status(clean_job_id, 'controlled', terms_version);

select is(
  (select (controlled_declaration ->> 'uploadAllowed')::boolean from ovd723_ctx),
  false,
  'a controlled declaration is recorded but not upload-allowed'
);

select is(
  (select controlled_declaration ->> 'reasonCode' from ovd723_ctx),
  'export_declaration_not_clean',
  'a controlled declaration reports export_declaration_not_clean'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx),
    (select controlled_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'export_declaration_not_clean',
  'prepare with a controlled declaration is rejected'
);

update ovd723_ctx
set unsure_declaration = public.api_declare_job_export_status(unsure_job_id, 'unsure', terms_version);

select is(
  (select (unsure_declaration ->> 'uploadAllowed')::boolean from ovd723_ctx),
  false,
  'an unsure declaration is not upload-allowed'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select unsure_job_id from ovd723_ctx), (select blocked_hash from ovd723_ctx),
    (select unsure_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'export_declaration_not_clean',
  'prepare with an unsure declaration is rejected'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select unsure_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, blocked_hash, 'part.step') from ovd723_ctx),
    (select blocked_hash from ovd723_ctx),
    (select unsure_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'export_declaration_not_clean',
  'finalize with an unsure declaration is rejected'
);

select is(
  public.current_user_has_export_cleared_upload('job-files', (select public.build_org_file_blob_storage_path(organization_id, blocked_hash, 'part.step') from ovd723_ctx)),
  false,
  'the grant policy rejects the object after an unsure declaration'
);

reset role;

select is(
  (select count(*)::integer from public.job_files) - (select job_files_before from ovd723_ctx),
  0,
  'no job_files row was written by any blocked upload'
);

select is(
  (select count(*)::integer from storage.objects where bucket_id = 'job-files') - (select objects_before from ovd723_ctx),
  0,
  'zero storage objects were written by any blocked upload'
);

select is(
  (select count(*)::integer from private.export_cleared_upload_grants),
  0,
  'no upload grant was issued for a blocked upload'
);

select is(
  (select count(*)::integer from private.export_control_events
   where event = 'declaration_recorded' and job_id in ((select clean_job_id from ovd723_ctx), (select unsure_job_id from ovd723_ctx))),
  2,
  'controlled and unsure declarations are audited'
);

-- Clean declaration, then a stale one.
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

update ovd723_ctx
set clean_declaration = public.api_declare_job_export_status(clean_job_id, 'not_controlled', terms_version);

select is(
  (select (clean_declaration ->> 'uploadAllowed')::boolean from ovd723_ctx),
  true,
  'a not_controlled declaration is upload-allowed'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx),
    (select controlled_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'export_declaration_stale',
  'a superseded declaration id is rejected as stale'
);

select is(
  public.api_prepare_job_file_upload(
    (select clean_job_id from ovd723_ctx), 'part.step', 'cad', null, 10,
    (select clean_hash from ovd723_ctx),
    (select (clean_declaration ->> 'declarationId')::uuid from ovd723_ctx)
  ) ->> 'status',
  'upload_required',
  'prepare with the latest clean declaration proceeds'
);

-- Finding 2: the grant covers the exact path only.
select is(
  public.current_user_has_export_cleared_upload('job-files', (select 'org-sha256/' || organization_id || '/' || clean_hash || '/other.pdf' from ovd723_ctx)),
  false,
  'the grant policy rejects another basename under the granted org/hash'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'file_upload_object_missing',
  'finalize before the granted object exists is rejected'
);

-- Real Storage writes the row in a later transaction than prepare; this
-- fixture runs in one, so it stamps created_at with the wall clock.
select lives_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner, created_at, metadata) values (gen_random_uuid(), 'job-files', %L, %L::uuid, clock_timestamp(), '{"size": 10}')$$,
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select member_user_id from ovd723_ctx)),
  'storage accepts the object covered by a clean grant'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 11, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'file_upload_grant_missing',
  'finalize with a size other than the granted size is rejected'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'renamed.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'file_upload_path_mismatch',
  'finalize under a name other than the granted object is rejected'
);

select lives_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'finalize with the latest clean declaration registers the file'
);

select is(
  public.current_user_has_export_cleared_upload(
    'job-files', (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx)
  ),
  false,
  'a finalized grant no longer authorizes a Storage write (single use)'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'A matching file is already attached to this job.',
  'a consumed grant cannot finalize a second time'
);

-- Finding 2: an object inserted by another user does not satisfy this
-- user's grant, and an expired grant authorizes nothing.
select is(
  public.api_prepare_job_file_upload(
    (select clean_job_id from ovd723_ctx), 'owned.step', 'cad', null, 10, repeat('7', 64),
    (select (clean_declaration ->> 'declarationId')::uuid from ovd723_ctx)
  ) ->> 'status',
  'upload_required',
  'prepare issues a grant for a second object'
);

reset role;

insert into storage.objects (id, bucket_id, name, owner, created_at, metadata)
select gen_random_uuid(), 'job-files', public.build_org_file_blob_storage_path(organization_id, repeat('7', 64), 'owned.step'),
  admin_user_id, clock_timestamp(), '{"size": 10}'
from ovd723_ctx;

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'owned.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, repeat('7', 64), 'owned.step') from ovd723_ctx),
    repeat('7', 64),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'file_upload_grant_missing',
  'finalize rejects an object another user wrote at the granted path'
);

select is(
  public.api_prepare_job_file_upload(
    (select clean_job_id from ovd723_ctx), 'late.step', 'cad', null, 10, repeat('6', 64),
    (select (clean_declaration ->> 'declarationId')::uuid from ovd723_ctx)
  ) ->> 'status',
  'upload_required',
  'prepare issues a grant that the test then expires'
);

reset role;
update private.export_cleared_upload_grants
set expires_at = clock_timestamp() - interval '1 second'
where content_sha256 = repeat('6', 64);
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select is(
  public.current_user_has_export_cleared_upload('job-files', (select public.build_org_file_blob_storage_path(organization_id, repeat('6', 64), 'late.step') from ovd723_ctx)),
  false,
  'the grant policy rejects the exact object once its grant has expired'
);

-- Finding 3 (window 1 part): the legacy RPCs still work and are untouched;
-- the contract draft makes them refuse.
select is(
  public.api_prepare_job_file_upload(
    (select clean_job_id from ovd723_ctx), 'legacy.step', 'cad', null, 10, repeat('5', 64)
  ) ->> 'status',
  'upload_required',
  'the legacy prepare still works after a clean declaration in window 1'
);

reset role;

select ok(
  not has_function_privilege('authenticated', 'private.job_file_prepare_delegate(uuid, text, public.job_file_kind, text, bigint, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.job_file_finalize_delegate(uuid, text, text, text, public.job_file_kind, text, bigint, text)', 'execute')
  and (select prosrc !~ 'export' from pg_proc
       where oid = 'public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)'::regprocedure)
  and (select prosrc !~ 'export' from pg_proc
       where oid = 'public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)'::regprocedure),
  'the upload delegates are not client executable and the legacy RPC bodies are untouched'
);

select ok(
  (select provolatile = 'v' and prosecdef from pg_proc
   where oid = 'public.current_user_has_export_cleared_upload(text, text)'::regprocedure),
  'the Storage helper is VOLATILE SECURITY DEFINER (fresh snapshot after the lock)'
);

-- 3, 5, 6. Dispatch gate.
select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'fictiv'),
  null,
  'fictiv: a clean, unblocked declaration is admitted'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'weerg'),
  null,
  'weerg: a clean, unblocked declaration is admitted'
);

select is(
  private.export_control_dispatch_denial((select unsure_job_id from ovd723_ctx), 'fictiv'),
  'export_declaration_not_clean',
  'fictiv: an unsure latest declaration is denied'
);

select is(
  private.export_control_dispatch_denial((select unsure_job_id from ovd723_ctx), 'xometry'),
  'export_declaration_not_clean',
  'xometry: an unsure latest declaration is denied'
);

select is(
  private.export_control_dispatch_denial((select unsure_job_id from ovd723_ctx), 'weerg'),
  'export_foreign_provider_requires_clean_declaration',
  'weerg: the foreign-provider rule has its own code'
);

select is(
  private.export_control_dispatch_denial((select undeclared_job_id from ovd723_ctx), 'xometry'),
  'export_declaration_missing',
  'xometry: no declaration is denied'
);

select is(
  private.export_control_dispatch_denial((select undeclared_job_id from ovd723_ctx), 'geomiq'),
  'export_foreign_provider_requires_clean_declaration',
  'geomiq: no declaration is denied by the foreign rule'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'new-unknown-provider'),
  null,
  'an unknown provider with a clean declaration passes the foreign rule'
);

select is(
  private.export_control_dispatch_denial((select undeclared_job_id from ovd723_ctx), 'new-unknown-provider'),
  'export_foreign_provider_requires_clean_declaration',
  'an unknown provider is held to the foreign rule'
);

select is(
  private.export_control_dispatch_denial_for_task(gen_random_uuid(), 'fictiv'),
  'export_declaration_missing',
  'a task lookup that finds nothing is denied'
);

-- 10. Extraction check, jurisdiction, and no stored IP.
select is(
  private.export_control_extraction_denial((select clean_job_id from ovd723_ctx)),
  null,
  'extraction: a clean, unblocked job may reach the model'
);

select is(
  private.export_control_extraction_denial((select unsure_job_id from ovd723_ctx)),
  'export_declaration_not_clean',
  'extraction: an unsure job never reaches the model'
);

select is(
  private.export_control_extraction_denial((select undeclared_job_id from ovd723_ctx)),
  'export_declaration_missing',
  'extraction: an undeclared job (legacy upload path) never reaches the model'
);

select ok(
  private.export_control_provider_jurisdiction('rapiddirect') = 'foreign'
  and private.export_control_provider_jurisdiction('protolabsnetwork') = 'foreign'
  and private.export_control_provider_jurisdiction('weerg') = 'foreign'
  and private.export_control_provider_jurisdiction('geomiq') = 'foreign',
  'RapidDirect and Protolabs Network are foreign, with Weerg and Geomiq'
);

select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'job_export_declarations' and column_name = 'ip_hash'
  ),
  'declarations store no client IP hash'
);

select ok(
  not has_function_privilege('authenticated', 'public.api_check_export_control_extraction(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_check_export_control_extraction(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.api_check_export_control_extraction(uuid)', 'execute'),
  'only the service role can run the extraction check'
);

set local role service_role;

select is(
  public.api_authorize_provider_worker_dispatch(gen_random_uuid(), gen_random_uuid(), '{"vendor":"fictiv"}'::jsonb, 'worker-1', now()) ->> 'denial',
  'scope_mismatch',
  'a core denial of an unknown task is returned unchanged by the provider wrapper'
);

select is(
  public.api_authorize_xometry_beta_worker_dispatch(gen_random_uuid(), gen_random_uuid(), '{"vendor":"xometry"}'::jsonb, 'worker-1', now()) ->> 'reasonCode',
  'dispatch_task_not_running',
  'a core denial of an unknown task is returned unchanged by the Xometry wrapper'
);

-- 4. Marking hit.
update ovd723_ctx
set block_id = (public.api_record_export_control_marking_hits(
  clean_job_id, null, null, 'drawing_text', array['itar', 'eccn_code']
) ->> 'blockId')::uuid;

select is(
  public.api_record_export_control_marking_hits(
    (select clean_job_id from ovd723_ctx), null, null, 'drawing_text', array['itar']
  ),
  pg_catalog.jsonb_build_object('blockId', (select block_id from ovd723_ctx), 'resolved', false),
  'a repeat hit on the same file and source returns the open block, unresolved'
);

select is(
  public.api_check_export_control_extraction((select clean_job_id from ovd723_ctx)),
  '{"allowed": false, "reasonCode": "export_review_pending"}'::jsonb,
  'extraction: a job with an open marking block never reaches the model'
);

reset role;

select ok(
  (select count(*) from private.job_export_marking_blocks
   where job_id = (select clean_job_id from ovd723_ctx) and source = 'drawing_text') = 1
  and (select count(*) from private.export_control_events
   where event = 'marking_block_opened' and job_id = (select clean_job_id from ovd723_ctx)) = 1,
  'the repeat hit opened no second block and no second audit event'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'fictiv'),
  'export_review_pending',
  'fictiv: an open marking block is denied'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'xometry'),
  'export_review_pending',
  'xometry: an open marking block is denied'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'geomiq'),
  'export_foreign_provider_requires_clean_declaration',
  'geomiq: an open marking block is denied by the foreign rule'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select is(
  public.api_get_job_export_control_status((select clean_job_id from ovd723_ctx)) ->> 'exportReviewState',
  'blocked_pending_review',
  'the member sees the part held for review'
);

select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx), repeat('c', 64),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'P0001', 'export_review_pending',
  'further uploads to a held part are rejected'
);

select throws_ok(
  format($$select public.api_review_export_control_block(%L::uuid, 'cleared_by_admin', 'not controlled')$$,
    (select block_id from ovd723_ctx)),
  '42501', 'export_review_admin_required',
  'a user cannot clear a marking block'
);

select throws_ok(
  format($$select public.api_declare_job_export_status(%L::uuid, 'not_controlled', %L)$$,
    (select other_job_id from ovd723_ctx), (select terms_version from ovd723_ctx)),
  '42501', 'export_declaration_forbidden',
  'a user cannot declare for another organization''s job'
);

reset role;
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');

select throws_ok(
  format($$select public.api_review_export_control_block(%L::uuid, 'cleared_by_admin', '  ')$$,
    (select block_id from ovd723_ctx)),
  'P0001', 'export_review_invalid',
  'an admin review requires a note'
);

select is(
  public.api_review_export_control_block((select block_id from ovd723_ctx), 'cleared_by_admin', 'Title block reference only') ->> 'state',
  'cleared_by_admin',
  'an admin can clear a marking block'
);

select throws_ok(
  format($$select public.api_review_export_control_block(%L::uuid, 'confirmed_controlled', 'again')$$,
    (select block_id from ovd723_ctx)),
  'P0001', 'export_review_not_pending',
  'a reviewed block cannot be reviewed again'
);

reset role;

select is(
  (select actor from private.export_control_events
   where event = 'marking_block_cleared' and detail ->> 'blockId' = (select block_id::text from ovd723_ctx)),
  (select admin_user_id from ovd723_ctx),
  'the admin clearance is audited with the admin as actor'
);

select is(
  private.export_control_dispatch_denial((select clean_job_id from ovd723_ctx), 'fictiv'),
  null,
  'after admin clearance the clean declaration is admitted again'
);

select is(
  private.export_control_extraction_denial((select clean_job_id from ovd723_ctx)),
  null,
  'after admin clearance extraction is allowed again'
);

-- 8. Clean scan of record (reused files and skipped extraction).
reset role;

-- trusted_content_sha256 stands for the worker's staging, which records the
-- hash of the bytes it downloaded (api_register_trusted_file_hash).
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select file.id, context.clean_job_id, context.organization_id, context.member_user_id,
  file.sha, file.sha, 'job-files', 'org-sha256/' || context.organization_id || '/' || file.sha || '/' || file.name,
  file.name, file.name, file.kind::public.job_file_kind, 100
from ovd723_ctx context
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072a1'::uuid, repeat('d', 64), 'part.step', 'cad'),
  ('00000000-0000-4000-8000-0000000072a2'::uuid, repeat('e', 64), 'part.pdf', 'drawing'),
  -- Reused copies: identical bytes attached as different job_files.
  ('00000000-0000-4000-8000-0000000072a3'::uuid, repeat('d', 64), 'part-copy.step', 'cad'),
  ('00000000-0000-4000-8000-0000000072a4'::uuid, repeat('e', 64), 'part-copy.pdf', 'drawing')
) as file(id, sha, name, kind);

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select '00000000-0000-4000-8000-0000000072a5', other_job_id, other_organization_id, other_user_id,
  repeat('f', 64), 'job-files', 'org-sha256/' || other_organization_id || '/' || repeat('f', 64) || '/other.step',
  'other.step', 'other.step', 'cad', 100
from ovd723_ctx;

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
select part.id, clean_job_id, organization_id, part.name, part.key, part.cad, part.drawing
from ovd723_ctx
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072b1'::uuid, 'Scanned part', 'scanned-part',
    '00000000-0000-4000-8000-0000000072a1'::uuid, '00000000-0000-4000-8000-0000000072a2'::uuid),
  ('00000000-0000-4000-8000-0000000072b2'::uuid, 'Reused part', 'reused-part',
    '00000000-0000-4000-8000-0000000072a3'::uuid, '00000000-0000-4000-8000-0000000072a4'::uuid)
) as part(id, name, key, cad, drawing);

insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, payload)
select task.id, organization_id, clean_job_id, task.part_id, 'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb
from ovd723_ctx
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072c1'::uuid, '00000000-0000-4000-8000-0000000072b1'::uuid),
  ('00000000-0000-4000-8000-0000000072c2'::uuid, '00000000-0000-4000-8000-0000000072b2'::uuid)
) as task(id, part_id);

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a clean, unblocked job is still denied while its part files have no clean scan'
);

select ok(
  not has_function_privilege('authenticated', 'public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text)', 'execute'),
  'only the service role can record a clean scan'
);

set local role service_role;

select throws_ok(
  format($$select public.api_record_export_control_clean_scan(%L::uuid, null, '00000000-0000-4000-8000-0000000072a5', 'step_header', %L)$$,
    (select clean_job_id from ovd723_ctx), repeat('f', 64)),
  'P0001', 'export_scan_invalid',
  'a clean scan cannot be recorded against a file from another job'
);

select throws_ok(
  format($$select public.api_record_export_control_clean_scan(%L::uuid, '00000000-0000-4000-8000-0000000072b1', '00000000-0000-4000-8000-0000000072a2', 'drawing_text', %L)$$,
    (select clean_job_id from ovd723_ctx), repeat('8', 64)),
  'P0001', 'export_content_hash_mismatch',
  'a clean scan of bytes whose hash differs from the file''s claimed hash is rejected (finding 2, 4)'
);

select throws_ok(
  format($$select public.api_record_export_control_clean_scan(%L::uuid, '00000000-0000-4000-8000-0000000072b2', '00000000-0000-4000-8000-0000000072a2', 'drawing_text', %L)$$,
    (select clean_job_id from ovd723_ctx), repeat('e', 64)),
  'P0001', 'export_scan_invalid',
  'a clean scan cannot name a part that does not reference the file'
);

select lives_ok(
  $$select public.api_record_export_control_clean_scan(
    (select clean_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072b1',
    '00000000-0000-4000-8000-0000000072a2', 'drawing_text', repeat('e', 64))$$,
  'the worker records a clean drawing scan'
);

reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a scanned drawing is not enough while the STEP header has no clean scan'
);

set local role service_role;
select public.api_record_export_control_clean_scan(
  (select clean_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072b1',
  '00000000-0000-4000-8000-0000000072a1', 'step_header', repeat('d', 64));
reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  null,
  'with both files scanned clean, the part is admitted'
);

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c2', 'fictiv'),
  'export_scan_missing',
  'a reused copy of the same bytes is denied: another file''s scan never vouches for it'
);

-- Finding 4: a scan stops vouching once its row changes. The internal org
-- role may update job_files (job_files_update_internal).
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');

select lives_ok(
  $$update public.job_files
    set content_sha256 = repeat('9', 64), trusted_content_sha256 = repeat('9', 64),
        storage_path = 'org-sha256/' || organization_id || '/' || repeat('9', 64) || '/part.step'
    where id = '00000000-0000-4000-8000-0000000072a1'$$,
  'an internal org role repoints the scanned CAD row to other bytes'
);

reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a repointed CAD row loses its clean scan'
);

update public.job_files
set content_sha256 = repeat('d', 64), trusted_content_sha256 = repeat('d', 64),
    storage_path = 'org-sha256/' || organization_id || '/' || repeat('d', 64) || '/part.step'
where id = '00000000-0000-4000-8000-0000000072a1';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  null,
  'restoring the scanned bytes restores the admission'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');

select lives_ok(
  format($$update public.job_files set job_id = %L::uuid where id = '00000000-0000-4000-8000-0000000072a2'$$,
    (select undeclared_job_id from ovd723_ctx)),
  'an internal org role moves the scanned drawing row to another job'
);

reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a drawing row moved to another job loses its clean scan'
);

update public.job_files
set job_id = (select clean_job_id from ovd723_ctx)
where id = '00000000-0000-4000-8000-0000000072a2';

-- The worker's staging found different bytes than the claimed hash.
update public.job_files
set trusted_content_sha256 = repeat('8', 64)
where id = '00000000-0000-4000-8000-0000000072a2';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a drawing whose staged bytes do not match its claimed hash is denied'
);

update public.job_files
set trusted_content_sha256 = repeat('e', 64)
where id = '00000000-0000-4000-8000-0000000072a2';

-- A part repointed to a file that was scanned clean in another job.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select '00000000-0000-4000-8000-0000000072a6', undeclared_job_id, organization_id, member_user_id,
  repeat('4', 64), repeat('4', 64), 'job-files', 'org-sha256/' || organization_id || '/' || repeat('4', 64) || '/elsewhere.pdf',
  'elsewhere.pdf', 'elsewhere.pdf', 'drawing', 100
from ovd723_ctx;

set local role service_role;
select lives_ok(
  format($$select public.api_record_export_control_clean_scan(%L::uuid, null, '00000000-0000-4000-8000-0000000072a6', 'drawing_text', %L)$$,
    (select undeclared_job_id from ovd723_ctx), repeat('4', 64)),
  'the other job''s drawing is scanned clean in its own job'
);
reset role;

update public.parts
set drawing_file_id = '00000000-0000-4000-8000-0000000072a6'
where id = '00000000-0000-4000-8000-0000000072b1';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  'export_scan_missing',
  'a part repointed to another job''s scanned file is denied'
);

update public.parts
set drawing_file_id = '00000000-0000-4000-8000-0000000072a2'
where id = '00000000-0000-4000-8000-0000000072b1';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  null,
  'the restored part is admitted again'
);

-- A CAD format with no scanner still needs a verified hash.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select '00000000-0000-4000-8000-0000000072a7', clean_job_id, organization_id, member_user_id,
  repeat('3', 64), 'job-files', 'org-sha256/' || organization_id || '/' || repeat('3', 64) || '/part.sldprt',
  'part.sldprt', 'part.sldprt', 'cad', 100
from ovd723_ctx;

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
select '00000000-0000-4000-8000-0000000072b3', clean_job_id, organization_id, 'Native part', 'native-part',
  '00000000-0000-4000-8000-0000000072a7'
from ovd723_ctx;

insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, payload)
select '00000000-0000-4000-8000-0000000072c3', organization_id, clean_job_id,
  '00000000-0000-4000-8000-0000000072b3', 'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb
from ovd723_ctx;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c3', 'fictiv'),
  'export_scan_missing',
  'a native CAD file without a worker-verified hash is denied'
);

update public.job_files
set trusted_content_sha256 = repeat('3', 64)
where id = '00000000-0000-4000-8000-0000000072a7';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072c3', 'fictiv'),
  null,
  'a native CAD file with a verified hash is admitted (no scanner for the format yet)'
);

-- The worker dispatch check (window 1): the new worker calls it before every
-- preflight and stops on anything but {"allowed": true}.
select ok(
  has_function_privilege('service_role', 'public.api_check_export_control_dispatch(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.api_check_export_control_dispatch(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.api_check_export_control_dispatch(uuid, text)', 'execute'),
  'only the service role can run the dispatch check'
);

set local role service_role;

select is(
  public.api_check_export_control_dispatch('00000000-0000-4000-8000-0000000072c2', 'fictiv'),
  '{"allowed": false, "reasonCode": "export_scan_missing"}'::jsonb,
  'the dispatch check denies the reused copy'
);

select is(
  public.api_check_export_control_dispatch('00000000-0000-4000-8000-0000000072c1', 'fictiv'),
  '{"allowed": true}'::jsonb,
  'the dispatch check admits a clean, scanned, verified part'
);

select is(
  public.api_check_export_control_dispatch(gen_random_uuid(), 'fictiv') ->> 'reasonCode',
  'export_declaration_missing',
  'the dispatch check denies a task it cannot find'
);

reset role;

select throws_ok(
  $$delete from private.job_file_export_scans$$,
  '42501', 'export_control_audit_append_only',
  'clean scan records cannot be deleted'
);

-- 11. A part extracted before OVD-723 (review round 3, blocker 2). Its job
-- was backfilled 'missing', it has an extraction row, and its files have no
-- clean scan. api_request_extraction skips it (it already has an
-- extraction), so a clean declaration must queue a scan only rescan.
reset role;

alter table ovd723_ctx add column legacy_job_id uuid, add column first_cleared_block_id uuid,
  add column second_block_id uuid, add column third_block_id uuid;
update ovd723_ctx set legacy_job_id = '00000000-0000-4000-8000-0000000072d0';

insert into public.jobs (id, organization_id, created_by, title)
select legacy_job_id, organization_id, member_user_id, 'OVD 723 extracted before deploy'
from ovd723_ctx;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select file.id, context.legacy_job_id, context.organization_id, context.member_user_id,
  file.sha, file.sha, 'job-files', 'org-sha256/' || context.organization_id || '/' || file.sha || '/' || file.name,
  -- normalized_name pairs the drawing with the CAD file into one part, as
  -- api_reconcile_job_parts (run by api_request_extraction) expects.
  file.name, 'legacy', file.kind::public.job_file_kind, 100
from ovd723_ctx context
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072d3'::uuid, repeat('5', 64), 'legacy.pdf', 'drawing'),
  ('00000000-0000-4000-8000-0000000072d4'::uuid, repeat('6', 64), 'legacy.step', 'cad')
) as file(id, sha, name, kind);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
select '00000000-0000-4000-8000-0000000072d1', legacy_job_id, organization_id, 'legacy', 'legacy',
  '00000000-0000-4000-8000-0000000072d4', '00000000-0000-4000-8000-0000000072d3'
from ovd723_ctx;

insert into public.drawing_extractions (part_id, organization_id, extraction)
select '00000000-0000-4000-8000-0000000072d1', organization_id, '{"source": "before OVD-723"}'::jsonb
from ovd723_ctx;

-- The window 1 backfill row for a job that existed before the migration.
insert into private.job_export_declarations (job_id, organization_id, declared_by, answer, terms_version)
select legacy_job_id, organization_id, null, 'missing', terms_version
from ovd723_ctx;

insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, payload)
select '00000000-0000-4000-8000-0000000072d2', organization_id, legacy_job_id,
  '00000000-0000-4000-8000-0000000072d1', 'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb
from ovd723_ctx;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072d2', 'fictiv'),
  'export_declaration_missing',
  'a part extracted before the deploy is held until its owner declares'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select is(
  public.api_request_extraction((select legacy_job_id from ovd723_ctx)),
  0,
  'extraction queues nothing for a part that already has an extraction (why a rescan is needed)'
);

select is(
  public.api_declare_job_export_status((select legacy_job_id from ovd723_ctx), 'not_controlled', (select terms_version from ovd723_ctx)) ->> 'rescansQueued',
  '2',
  'a clean declaration queues a scan only rescan for the drawing and the STEP file'
);

reset role;

select is(
  (select pg_catalog.array_agg(queue.payload ->> 'jobFileId' order by queue.payload ->> 'jobFileId')
   from public.work_queue queue
   where queue.job_id = (select legacy_job_id from ovd723_ctx)
     and queue.task_type::text = 'export_marking_rescan'
     and queue.status = 'queued'
     and queue.part_id = '00000000-0000-4000-8000-0000000072d1'),
  array['00000000-0000-4000-8000-0000000072d3', '00000000-0000-4000-8000-0000000072d4'],
  'one queued rescan task per unscanned file, linked to the part'
);

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072d2', 'fictiv'),
  'export_scan_missing',
  'after the declaration, the part waits for the rescan'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));

select is(
  public.api_declare_job_export_status((select legacy_job_id from ovd723_ctx), 'not_controlled', (select terms_version from ovd723_ctx)) ->> 'rescansQueued',
  '0',
  'declaring again queues no duplicate while the rescans are queued'
);

reset role;

select ok(
  has_function_privilege('service_role', 'public.api_queue_export_marking_rescan(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.api_queue_export_marking_rescan(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_queue_export_marking_rescan(uuid)', 'execute')
  and (select prosecdef and proconfig @> array['search_path=""']
       from pg_proc where oid = 'public.api_queue_export_marking_rescan(uuid)'::regprocedure),
  'only the service role can queue a rescan; the RPC is SECURITY DEFINER with an empty search_path'
);

-- The worker's rescan task: it scans (no model) and records clean scans.
set local role service_role;
select lives_ok(
  $$select public.api_record_export_control_clean_scan(
    (select legacy_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072d1',
    '00000000-0000-4000-8000-0000000072d3', 'drawing_ocr', repeat('5', 64));
    select public.api_record_export_control_clean_scan(
    (select legacy_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072d1',
    '00000000-0000-4000-8000-0000000072d4', 'step_header', repeat('6', 64))$$,
  'the rescan records a clean OCR drawing scan and a clean STEP header scan'
);
reset role;

update public.work_queue set status = 'completed'
where job_id = (select legacy_job_id from ovd723_ctx) and task_type::text = 'export_marking_rescan';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072d2', 'fictiv'),
  null,
  'end to end: the part extracted before the deploy is dispatchable after declare and rescan, with no new extraction'
);

set local role service_role;
select is(
  public.api_queue_export_marking_rescan((select legacy_job_id from ovd723_ctx)),
  0,
  'files with a clean scan of their current bytes are not queued again'
);
reset role;

update public.job_files
set content_sha256 = repeat('1', 64), trusted_content_sha256 = null
where id = '00000000-0000-4000-8000-0000000072d4';

set local role service_role;
select is(
  public.api_queue_export_marking_rescan((select legacy_job_id from ovd723_ctx)),
  1,
  'a file whose bytes changed is queued again'
);
reset role;

-- 11b. Rescan recovery (review round 4, blocker 1). The part page reads the
-- scan state; a rescan that failed for good leaves the file missing, and the
-- owner can requeue it through an authenticated RPC that only queues rescans.
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select legacy_job_id from ovd723_ctx)) ->> 'scanState',
  'pending',
  'scan state is pending while a rescan of the file is queued'
);
reset role;

update public.work_queue set status = 'failed', last_error = 'Unhandled task type: export_marking_rescan'
where job_id = (select legacy_job_id from ovd723_ctx) and task_type::text = 'export_marking_rescan'
  and status = 'queued';

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select legacy_job_id from ovd723_ctx)) ->> 'scanState',
  'missing',
  'a rescan that failed for good leaves the file missing (an old worker in the deploy gap)'
);
select is(
  public.api_request_export_marking_rescan((select legacy_job_id from ovd723_ctx)),
  1,
  'the owner requeues the failed rescan'
);
select is(
  public.api_request_export_marking_rescan((select legacy_job_id from ovd723_ctx)),
  0,
  'requeuing again queues no duplicate while the rescan is queued'
);
select is(
  public.api_get_job_export_control_status((select legacy_job_id from ovd723_ctx)) ->> 'scanState',
  'pending',
  'after the requeue the part page shows the check as pending'
);
select throws_ok(
  format('select public.api_request_export_marking_rescan(%L::uuid)', (select unsure_job_id from ovd723_ctx)),
  'P0001',
  'export_rescan_not_allowed',
  'a job whose latest answer is not clean cannot requeue rescans'
);
select pg_temp.set_ovd723_request_identity((select other_user_id from ovd723_ctx));
select throws_ok(
  format('select public.api_request_export_marking_rescan(%L::uuid)', (select legacy_job_id from ovd723_ctx)),
  '42501',
  'export_rescan_forbidden',
  'a user outside the organization cannot requeue rescans'
);
reset role;

update public.work_queue
set status = 'completed',
    payload = payload || '{"exportScanOutcome": "step_header_incomplete"}'::jsonb
where job_id = (select legacy_job_id from ovd723_ctx) and task_type::text = 'export_marking_rescan'
  and status = 'queued';

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select legacy_job_id from ovd723_ctx)) ->> 'scanState',
  'step_header_incomplete',
  'an incomplete STEP header is shown as such, not as a recheck'
);
select is(
  public.api_request_export_marking_rescan((select legacy_job_id from ovd723_ctx)),
  0,
  'the same bytes are not queued again after a final outcome (drawing_unread or step_header_incomplete)'
);
reset role;

select ok(
  has_function_privilege('authenticated', 'public.api_request_export_marking_rescan(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_request_export_marking_rescan(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.api_request_export_marking_rescan(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.job_export_scan_state(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.export_rescan_final_outcome(uuid, uuid, text)', 'execute')
  and (select prosecdef and proconfig @> array['search_path=""']
       from pg_proc where oid = 'public.api_request_export_marking_rescan(uuid)'::regprocedure),
  'only an authenticated user can call the owner requeue; it is SECURITY DEFINER with an empty search_path, and its helpers are private'
);

update public.job_files
set content_sha256 = repeat('6', 64), trusted_content_sha256 = repeat('6', 64)
where id = '00000000-0000-4000-8000-0000000072d4';
update public.work_queue set status = 'completed'
where job_id = (select legacy_job_id from ovd723_ctx) and task_type::text = 'export_marking_rescan';

-- 11c. Fresh upload and replaced drawing (review round 5, B1 and B2).
-- B1: the client declares before the job_files rows exist, so the
-- declaration queues no rescan; extract_part then scans the drawing and the
-- STEP header itself (no model), so after extraction the part is not shown
-- as missing before any quote. An extraction that ends on an unread drawing
-- or an incomplete STEP header records that outcome, so the part shows it at
-- once. B2: a replaced drawing that no part references any more does not
-- hold the job's scan state, matching the dispatch denial.
alter table ovd723_ctx add column fresh_job_id uuid, add column replaced_job_id uuid;
update ovd723_ctx set fresh_job_id = '00000000-0000-4000-8000-0000000072f0',
  replaced_job_id = '00000000-0000-4000-8000-0000000072f5';

insert into public.jobs (id, organization_id, created_by, title)
select job.id, context.organization_id, context.member_user_id, job.title
from ovd723_ctx context
cross join lateral (values
  (context.fresh_job_id, 'OVD 723 fresh upload'),
  (context.replaced_job_id, 'OVD 723 replaced drawing')
) as job(id, title);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_declare_job_export_status((select fresh_job_id from ovd723_ctx), 'not_controlled', (select terms_version from ovd723_ctx)) ->> 'rescansQueued',
  '0',
  'B1: the declaration comes before the files, so it queues no rescan'
);
select is(
  public.api_declare_job_export_status((select replaced_job_id from ovd723_ctx), 'not_controlled', (select terms_version from ovd723_ctx)) ->> 'rescansQueued',
  '0',
  'B2: the replaced drawing job is declared clean before its files exist'
);
reset role;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select file.id, file.job_id, context.organization_id, context.member_user_id,
  file.sha, file.sha, 'job-files', 'org-sha256/' || context.organization_id || '/' || file.sha || '/' || file.name,
  file.name, file.normalized, file.kind::public.job_file_kind, 100
from ovd723_ctx context
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072f1'::uuid, context.fresh_job_id, repeat('ab', 32), 'fresh.pdf', 'fresh', 'drawing'),
  ('00000000-0000-4000-8000-0000000072f2'::uuid, context.fresh_job_id, repeat('cd', 32), 'fresh.step', 'fresh', 'cad'),
  ('00000000-0000-4000-8000-0000000072f6'::uuid, context.replaced_job_id, repeat('ef', 32), 'rep-scan.pdf', 'rep', 'drawing'),
  ('00000000-0000-4000-8000-0000000072f7'::uuid, context.replaced_job_id, repeat('12', 32), 'rep.pdf', 'rep', 'drawing'),
  ('00000000-0000-4000-8000-0000000072f8'::uuid, context.replaced_job_id, repeat('34', 32), 'rep.step', 'rep', 'cad')
) as file(id, job_id, sha, name, normalized, kind);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id)
select part.id, part.job_id, context.organization_id, part.name, part.name, part.cad, part.drawing
from ovd723_ctx context
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072f3'::uuid, context.fresh_job_id, 'fresh',
    '00000000-0000-4000-8000-0000000072f2'::uuid, '00000000-0000-4000-8000-0000000072f1'::uuid),
  -- The part points at the replacement drawing (latest file per normalized name).
  ('00000000-0000-4000-8000-0000000072f9'::uuid, context.replaced_job_id, 'rep',
    '00000000-0000-4000-8000-0000000072f8'::uuid, '00000000-0000-4000-8000-0000000072f7'::uuid)
) as part(id, job_id, name, cad, drawing);

insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, payload)
select task.id, context.organization_id, task.job_id, task.part_id, task.task_type::public.queue_task_type,
  task.status::public.queue_task_status, task.payload
from ovd723_ctx context
cross join lateral (values
  ('00000000-0000-4000-8000-0000000072fa'::uuid, context.fresh_job_id, '00000000-0000-4000-8000-0000000072f3'::uuid,
    'extract_part', 'queued', '{}'::jsonb),
  ('00000000-0000-4000-8000-0000000072fb'::uuid, context.fresh_job_id, '00000000-0000-4000-8000-0000000072f3'::uuid,
    'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb),
  ('00000000-0000-4000-8000-0000000072fc'::uuid, context.replaced_job_id, '00000000-0000-4000-8000-0000000072f9'::uuid,
    'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb)
) as task(id, job_id, part_id, task_type, status, payload);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) ->> 'scanState',
  'pending',
  'B1: while extraction is queued the fresh part shows the check as pending'
);
reset role;

-- The worker's extract_part: it scans the drawing text and the STEP header
-- (no model) and records both clean scans, then completes with its outcomes.
set local role service_role;
select lives_ok(
  $$select public.api_record_export_control_clean_scan(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072f3',
    '00000000-0000-4000-8000-0000000072f1', 'drawing_text', repeat('ab', 32));
    select public.api_record_export_control_clean_scan(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072f3',
    '00000000-0000-4000-8000-0000000072f2', 'step_header', repeat('cd', 32))$$,
  'B1: extraction records a clean drawing scan and a clean STEP header scan'
);
reset role;

update public.work_queue
set status = 'completed',
    payload = pg_catalog.jsonb_build_object('exportScanOutcomes', pg_catalog.jsonb_build_object(
      '00000000-0000-4000-8000-0000000072f2',
      pg_catalog.jsonb_build_object('contentSha256', repeat('cd', 32), 'outcome', 'clean')))
where id = '00000000-0000-4000-8000-0000000072fa';

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) - 'jobId' - 'latestDeclaredAt',
  pg_catalog.jsonb_build_object(
    'latestAnswer', 'not_controlled',
    'termsVersion', (select terms_version from ovd723_ctx),
    'exportReviewState', 'clear',
    'scanState', 'complete'
  ),
  'B1: after extraction completes the fresh STEP part is complete and clear (no hold notice) before any quote'
);
reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072fb', 'fictiv'),
  null,
  'B1: the fresh part is dispatchable after extraction alone'
);

-- An extraction that stopped on an unread replacement drawing records the
-- outcome on the failed task, so the part shows drawing_unread, not missing.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select '00000000-0000-4000-8000-0000000072fd', fresh_job_id, organization_id, member_user_id,
  repeat('56', 32), repeat('56', 32), 'job-files',
  'org-sha256/' || organization_id || '/' || repeat('56', 32) || '/fresh-scan.pdf',
  'fresh-scan.pdf', 'fresh', 'drawing', 100
from ovd723_ctx;
update public.parts set drawing_file_id = '00000000-0000-4000-8000-0000000072fd'
where id = '00000000-0000-4000-8000-0000000072f3';
insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, last_error, payload)
select '00000000-0000-4000-8000-0000000072fe', organization_id, fresh_job_id,
  '00000000-0000-4000-8000-0000000072f3', 'extract_part', 'failed', 'export_scan_unread',
  pg_catalog.jsonb_build_object('failureCode', 'export_scan_unread', 'exportScanOutcomes', pg_catalog.jsonb_build_object(
    '00000000-0000-4000-8000-0000000072fd',
    pg_catalog.jsonb_build_object('contentSha256', repeat('56', 32), 'outcome', 'drawing_unread')))
from ovd723_ctx;

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) ->> 'scanState',
  'drawing_unread',
  'B2: an extraction that fails on an unread drawing shows drawing_unread at once, not missing'
);
select is(
  public.api_request_export_marking_rescan((select fresh_job_id from ovd723_ctx)),
  0,
  'B2: the unread bytes are not queued for a rescan that would read the same nothing'
);
reset role;

-- Review round 8: an unread result caused by an OCR failure (tesseract
-- failed, timed out, ran out of budget, or was unavailable) is not final for
-- those bytes. A later extraction that recorded drawing_ocr_failed for the
-- same bytes shows the file as missing, and Recheck files queues it.
insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status, last_error, payload, created_at, updated_at
)
select '00000000-0000-4000-8000-0000000072ff', organization_id, fresh_job_id,
  '00000000-0000-4000-8000-0000000072f3', 'extract_part', 'failed', 'export_scan_unread',
  pg_catalog.jsonb_build_object('failureCode', 'export_scan_unread', 'exportScanOutcomes', pg_catalog.jsonb_build_object(
    '00000000-0000-4000-8000-0000000072fd',
    pg_catalog.jsonb_build_object('contentSha256', repeat('56', 32), 'outcome', 'drawing_ocr_failed'))),
  now() + interval '1 second', now() + interval '1 second'
from ovd723_ctx;

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  null,
  'round 8: drawing_ocr_failed is not a final outcome for the bytes'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) ->> 'scanState',
  'missing',
  'round 8: an OCR failure shows the drawing as missing (recheck), not drawing_unread'
);
select is(
  public.api_request_export_marking_rescan((select fresh_job_id from ovd723_ctx)),
  1,
  'round 8: Recheck files queues the same bytes again after an OCR failure'
);
reset role;

-- Put the job back as the B2 case left it: the unread outcome is latest again
-- and no rescan is queued.
delete from public.work_queue
where job_id = (select fresh_job_id from ovd723_ctx)
  and (id = '00000000-0000-4000-8000-0000000072ff'
       or (task_type::text = 'export_marking_rescan' and status = 'queued'));

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072fb', 'fictiv'),
  'export_scan_missing',
  'B2: the part with the unread drawing stays held'
);

-- Review round 9: a fixed OCR limit (a page past the page cap, a sheet over
-- the pixel cap) is final for the bytes, and OCR failures on the same bytes
-- stop being retryable after 3 (drawing_recheck_limit), so a recheck loop
-- cannot spend the OCR budget.
insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status, last_error, payload, created_at, updated_at
)
select '00000000-0000-4000-8000-000000007301', organization_id, fresh_job_id,
  '00000000-0000-4000-8000-0000000072f3', 'extract_part', 'failed', 'export_scan_unread',
  pg_catalog.jsonb_build_object('failureCode', 'export_scan_unread', 'exportScanOutcomes', pg_catalog.jsonb_build_object(
    '00000000-0000-4000-8000-0000000072fd',
    pg_catalog.jsonb_build_object('contentSha256', repeat('56', 32), 'outcome', 'drawing_too_many_pages'))),
  now() + interval '2 seconds', now() + interval '2 seconds'
from ovd723_ctx;

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  'drawing_too_many_pages',
  'round 9: a page past the OCR page cap is final for the bytes'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) ->> 'scanState',
  'drawing_too_many_pages',
  'round 9: the part shows that the drawing has too many pages'
);
select is(
  public.api_request_export_marking_rescan((select fresh_job_id from ovd723_ctx)),
  0,
  'round 9: Recheck files does not queue a drawing over the page cap'
);
reset role;

update public.work_queue
set payload = pg_catalog.jsonb_set(payload, '{exportScanOutcomes,00000000-0000-4000-8000-0000000072fd,outcome}', '"drawing_sheet_too_large"')
where id = '00000000-0000-4000-8000-000000007301';

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  'drawing_sheet_too_large',
  'round 9: a sheet over the OCR pixel cap is final for the bytes'
);

-- Two OCR failures on the same bytes: still retryable.
update public.work_queue
set payload = pg_catalog.jsonb_set(payload, '{exportScanOutcomes,00000000-0000-4000-8000-0000000072fd,outcome}', '"drawing_ocr_failed"')
where id = '00000000-0000-4000-8000-000000007301';
insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status, payload, created_at, updated_at
)
select '00000000-0000-4000-8000-000000007302', organization_id, fresh_job_id,
  '00000000-0000-4000-8000-0000000072f3', 'export_marking_rescan', 'completed',
  pg_catalog.jsonb_build_object('jobFileId', '00000000-0000-4000-8000-0000000072fd',
    'contentSha256', repeat('56', 32), 'exportScanOutcome', 'drawing_ocr_failed'),
  now() + interval '3 seconds', now() + interval '3 seconds'
from ovd723_ctx;

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  null,
  'round 9: two OCR failures on the same bytes stay retryable'
);

-- A failure on other bytes of the same file does not count toward the cap.
insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status, payload, created_at, updated_at
)
select '00000000-0000-4000-8000-000000007303', organization_id, fresh_job_id,
  '00000000-0000-4000-8000-0000000072f3', 'export_marking_rescan', 'completed',
  pg_catalog.jsonb_build_object('jobFileId', '00000000-0000-4000-8000-0000000072fd',
    'contentSha256', repeat('57', 32), 'exportScanOutcome', 'drawing_ocr_failed'),
  now() + interval '4 seconds', now() + interval '4 seconds'
from ovd723_ctx;

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  null,
  'round 9: an OCR failure on other bytes does not count toward the recheck cap'
);

-- The third OCR failure on the same bytes reaches the cap.
update public.work_queue
set payload = pg_catalog.jsonb_set(payload, '{contentSha256}', pg_catalog.to_jsonb(repeat('56', 32)))
where id = '00000000-0000-4000-8000-000000007303';

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  'drawing_recheck_limit',
  'round 9: the third OCR failure on the same bytes is final (drawing_recheck_limit)'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select fresh_job_id from ovd723_ctx)) ->> 'scanState',
  'drawing_recheck_limit',
  'round 9: the part shows the recheck limit, not missing'
);
select is(
  public.api_request_export_marking_rescan((select fresh_job_id from ovd723_ctx)),
  0,
  'round 9: Recheck files does not queue the same bytes past the recheck cap'
);
reset role;

-- A later final outcome is the latest again, and the cap no longer applies
-- to it. The work_queue trigger sets updated_at to now(), the same as the B2
-- task's, so created_at orders them.
update public.work_queue
set created_at = now() - interval '1 day', updated_at = now() - interval '1 day'
where id in ('00000000-0000-4000-8000-000000007301', '00000000-0000-4000-8000-000000007302',
             '00000000-0000-4000-8000-000000007303');

select is(
  private.export_rescan_final_outcome(
    (select fresh_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072fd', repeat('56', 32)),
  'drawing_unread',
  'round 9: a later final outcome is still the answer after earlier OCR failures'
);

delete from public.work_queue
where id in ('00000000-0000-4000-8000-000000007301', '00000000-0000-4000-8000-000000007302',
             '00000000-0000-4000-8000-000000007303');

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072fb', 'fictiv'),
  'export_scan_missing',
  'round 9: the part with the unread drawing stays held'
);

-- B2 reproduction: the old drawing rep-scan.pdf ended drawing_unread; the
-- replacement rep.pdf and rep.step are clean; the part points at both.
insert into public.work_queue (organization_id, job_id, part_id, task_type, status, payload)
select organization_id, replaced_job_id, '00000000-0000-4000-8000-0000000072f9',
  'export_marking_rescan'::text::public.queue_task_type, 'completed',
  pg_catalog.jsonb_build_object('jobId', replaced_job_id, 'jobFileId', '00000000-0000-4000-8000-0000000072f6',
    'contentSha256', repeat('ef', 32), 'exportScanOutcome', 'drawing_unread')
from ovd723_ctx;

set local role service_role;
select lives_ok(
  $$select public.api_record_export_control_clean_scan(
    (select replaced_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072f9',
    '00000000-0000-4000-8000-0000000072f7', 'drawing_text', repeat('12', 32));
    select public.api_record_export_control_clean_scan(
    (select replaced_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072f9',
    '00000000-0000-4000-8000-0000000072f8', 'step_header', repeat('34', 32))$$,
  'B2: the replacement drawing and the STEP file are scanned clean'
);
select is(
  public.api_queue_export_marking_rescan((select replaced_job_id from ovd723_ctx)),
  0,
  'B2: the old drawing no part references is not queued for a rescan'
);
reset role;

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select member_user_id from ovd723_ctx));
select is(
  public.api_get_job_export_control_status((select replaced_job_id from ovd723_ctx)) ->> 'scanState',
  'complete',
  'B2: the replaced drawing no longer holds the scan state once the user follows the notice'
);
reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072fc', 'fictiv'),
  null,
  'B2: dispatch is allowed, matching the scan state'
);

select ok(
  (select pg_catalog.strpos(prosrc, 'queue.job_id = p_job_id') > 0
      and pg_catalog.strpos(prosrc, 'queue.task_type = ''export_marking_rescan''::text::public.queue_task_type') > 0
   from pg_catalog.pg_proc
   where oid = 'private.export_rescan_final_outcome(uuid, uuid, text)'::regprocedure),
  'the final outcome lookup is scoped to the job and compares the task type as the enum (work_queue index)'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_index idx
    join pg_catalog.pg_class index_class on index_class.oid = idx.indexrelid
    where idx.indrelid = 'public.work_queue'::regclass
      and index_class.relname = 'work_queue_job_task_type_idx'
      and idx.indkey[0] = (select attnum from pg_catalog.pg_attribute
                           where attrelid = 'public.work_queue'::regclass and attname = 'job_id')
  ),
  'work_queue has an index leading with job_id for the final outcome lookup'
);

-- 12. Admin clearance of a false positive (review round 3, blocker 3). A
-- drawing only part whose drawing text matched.
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, content_sha256, trusted_content_sha256, storage_bucket,
  storage_path, original_name, normalized_name, file_kind, size_bytes
)
select '00000000-0000-4000-8000-0000000072e1', legacy_job_id, organization_id, member_user_id,
  repeat('7', 64), repeat('7', 64), 'job-files', 'org-sha256/' || organization_id || '/' || repeat('7', 64) || '/marked.pdf',
  'marked.pdf', 'marked', 'drawing', 100
from ovd723_ctx;

insert into public.parts (id, job_id, organization_id, name, normalized_key, drawing_file_id)
select '00000000-0000-4000-8000-0000000072e2', legacy_job_id, organization_id, 'marked', 'marked',
  '00000000-0000-4000-8000-0000000072e1'
from ovd723_ctx;

insert into public.work_queue (id, organization_id, job_id, part_id, task_type, status, payload)
select '00000000-0000-4000-8000-0000000072e3', organization_id, legacy_job_id,
  '00000000-0000-4000-8000-0000000072e2', 'run_vendor_quote', 'running', '{"vendor":"fictiv"}'::jsonb
from ovd723_ctx;

set local role service_role;
update ovd723_ctx
set first_cleared_block_id = (public.api_record_export_control_marking_hits(
  legacy_job_id, '00000000-0000-4000-8000-0000000072e2', '00000000-0000-4000-8000-0000000072e1',
  'drawing_text', array['itar', 'technical_data'], repeat('7', 64)
) ->> 'blockId')::uuid;
reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv'),
  'export_review_pending',
  'a marking hit holds the part'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');

select is(
  public.api_review_export_control_block((select first_cleared_block_id from ovd723_ctx), 'cleared_by_admin', 'Drawing title only, not a marking') ->> 'scanRecorded',
  'true',
  'clearing a false positive records an admin cleared scan of the reviewed bytes'
);

reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv'),
  null,
  'after clearance the part is dispatchable: the scan rule accepts the admin cleared scan'
);

select ok(
  exists (
    select 1 from private.job_file_export_scans scan
    where scan.job_file_id = '00000000-0000-4000-8000-0000000072e1'
      and scan.content_sha256 = repeat('7', 64)
      and scan.source = 'drawing_text'
      and scan.cleared_block_id = (select first_cleared_block_id from ovd723_ctx)
      and scan.cleared_patterns = array['itar', 'technical_data']
  )
  and exists (
    select 1 from private.export_control_events event_row
    where event_row.event = 'file_scan_recorded_admin_cleared'
      and event_row.detail ->> 'blockId' = (select first_cleared_block_id::text from ovd723_ctx)
      and event_row.actor = (select admin_user_id from ovd723_ctx)
  ),
  'the admin cleared scan is bound to the file, its hash, its source, and the cleared patterns, and is audited'
);

set local role service_role;
select is(
  public.api_record_export_control_marking_hits(
    (select legacy_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072e2', '00000000-0000-4000-8000-0000000072e1',
    'drawing_text', array['itar'], repeat('7', 64)
  ),
  pg_catalog.jsonb_build_object('blockId', (select first_cleared_block_id from ovd723_ctx), 'resolved', true),
  'a rescan of the same bytes with already cleared patterns resolves to the clearance'
);
reset role;

select is(
  (select count(*)::integer from private.job_export_marking_blocks
   where job_file_id = '00000000-0000-4000-8000-0000000072e1'),
  1,
  'the resolved rescan opened no new block'
);

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv'),
  null,
  'the part stays dispatchable after the resolved rescan'
);

set local role service_role;
update ovd723_ctx
set second_block_id = (public.api_record_export_control_marking_hits(
  legacy_job_id, '00000000-0000-4000-8000-0000000072e2', '00000000-0000-4000-8000-0000000072e1',
  'drawing_text', array['itar', 'cui'], repeat('7', 64)
) ->> 'blockId')::uuid;
reset role;

select ok(
  (select second_block_id is not null and second_block_id <> first_cleared_block_id from ovd723_ctx)
  and private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv') = 'export_review_pending',
  'a new pattern on the same bytes opens a new block and holds the part'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');
select is(
  public.api_review_export_control_block((select second_block_id from ovd723_ctx), 'cleared_by_admin', 'CUI is a part number prefix') ->> 'scanRecorded',
  'true',
  'the admin clears the new pattern too'
);
reset role;

-- The same file now holds different bytes.
update public.job_files
set content_sha256 = repeat('2', 64), trusted_content_sha256 = repeat('2', 64)
where id = '00000000-0000-4000-8000-0000000072e1';

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv'),
  'export_scan_missing',
  'a clearance does not vouch for different bytes in the same file row'
);

set local role service_role;
select is(
  (public.api_record_export_control_marking_hits(
    (select legacy_job_id from ovd723_ctx), '00000000-0000-4000-8000-0000000072e2', '00000000-0000-4000-8000-0000000072e1',
    'drawing_text', array['itar'], repeat('2', 64)
  ) ->> 'resolved')::boolean,
  false,
  'the same patterns on a different hash open a new block'
);
reset role;

-- The bytes change again before the admin reviews the new block.
update public.job_files
set content_sha256 = repeat('0', 64), trusted_content_sha256 = repeat('0', 64)
where id = '00000000-0000-4000-8000-0000000072e1';
update ovd723_ctx
set third_block_id = (
  select block.id from private.job_export_marking_blocks block
  where block.job_file_id = '00000000-0000-4000-8000-0000000072e1' and block.state = 'blocked_pending_review'
);

set local role authenticated;
select pg_temp.set_ovd723_request_identity((select admin_user_id from ovd723_ctx), 'aal2');
select is(
  public.api_review_export_control_block(
    (select third_block_id from ovd723_ctx),
    'cleared_by_admin', 'Reviewed the earlier bytes') ->> 'scanRecorded',
  'false',
  'a clearance records no scan when the file no longer holds the reviewed bytes'
);
reset role;

select is(
  private.export_control_dispatch_denial_for_task('00000000-0000-4000-8000-0000000072e3', 'fictiv'),
  'export_scan_missing',
  'the changed bytes stay held until the worker scans them'
);

-- 7. Isolation and audit immutability.
set local role authenticated;
select pg_temp.set_ovd723_request_identity((select other_user_id from ovd723_ctx));

select throws_ok(
  format($$select public.api_get_job_export_control_status(%L::uuid)$$, (select clean_job_id from ovd723_ctx)),
  '42501', 'export_status_forbidden',
  'another organization cannot read the declaration status'
);

reset role;

select throws_ok(
  $$update private.export_control_events set detail = '{}'::jsonb$$,
  '42501', 'export_control_audit_append_only',
  'audit events cannot be updated'
);

select throws_ok(
  $$delete from private.job_export_declarations$$,
  '42501', 'export_control_audit_append_only',
  'declarations cannot be deleted'
);

select ok(
  not has_function_privilege('anon', 'public.api_declare_job_export_status(uuid, text, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_get_job_export_control_status(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.api_review_export_control_block(uuid, text, text)', 'execute'),
  'anon cannot execute the declaration, status, or review RPCs'
);

select ok(
  not has_function_privilege('authenticated', 'public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[], text)', 'execute')
  and has_function_privilege('service_role', 'public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[], text)', 'execute'),
  'only the service role can record marking hits'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.api_declare_job_export_status(uuid, text, text, uuid)'::regprocedure),
  'the declaration RPC is SECURITY DEFINER with an empty search_path'
);

select * from finish();
rollback;
