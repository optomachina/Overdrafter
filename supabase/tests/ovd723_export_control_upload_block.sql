-- OVD-723: controlled or uncertain uploads are blocked at upload time, files
-- with export-control markings are held for admin review, and every provider
-- preflight denies without a clean latest declaration.
--
-- Targets the DRAFT docs/migration-drafts/ovd-723.sql (PHASE 1 and PHASE 2).
-- The draft is not applied and needs a Blaine migration window, so this suite
-- is not in any CI path list yet. Pre-apply observation: every assertion that
-- references the new functions or tables fails with "does not exist".
--
-- Acceptance coverage:
--   1. upload without a declaration is rejected and stores nothing
--   2. controlled / unsure blocks the upload; zero storage objects
--   3. a declaration exists but the latest is not clean: preflight denies
--   4. a marking hit blocks; a user cannot clear it; an admin can, audited
--   5. foreign providers have their own denial; Xometry and Fictiv are denied
--   6. a preflight lookup that finds nothing denies (fail closed)
--   7. cross-org reads fail, audit UPDATE/DELETE fail, anon cannot execute
begin;

select plan(56);

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
select throws_ok(
  format($$select public.api_prepare_job_file_upload(%L::uuid, 'part.step', 'cad', null, 10, %L)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx)),
  'P0001', 'export_declaration_missing', -- NOSONAR: stable export-control denial assertion
  'the legacy prepare signature without a declaration is rejected'
);

select throws_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', 'x', 'part.step', 'cad', null, 10, %L)$$,
    (select clean_job_id from ovd723_ctx), (select clean_hash from ovd723_ctx)),
  'P0001', 'export_declaration_missing',
  'the legacy finalize signature without a declaration is rejected'
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

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner) values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select member_user_id from ovd723_ctx)),
  '42501',
  null,
  'storage rejects a job-files object without a declaration-backed grant'
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

select throws_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner) values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select public.build_org_file_blob_storage_path(organization_id, blocked_hash, 'part.step') from ovd723_ctx),
    (select member_user_id from ovd723_ctx)),
  '42501',
  null,
  'storage rejects the object after an unsure declaration'
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

select lives_ok(
  format($$insert into storage.objects (id, bucket_id, name, owner) values (gen_random_uuid(), 'job-files', %L, %L::uuid)$$,
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select member_user_id from ovd723_ctx)),
  'storage accepts the object covered by a clean grant'
);

select lives_ok(
  format($$select public.api_finalize_job_file_upload(%L::uuid, 'job-files', %L, 'part.step', 'cad', null, 10, %L, %L::uuid)$$,
    (select clean_job_id from ovd723_ctx),
    (select public.build_org_file_blob_storage_path(organization_id, clean_hash, 'part.step') from ovd723_ctx),
    (select clean_hash from ovd723_ctx),
    (select clean_declaration ->> 'declarationId' from ovd723_ctx)),
  'finalize with the latest clean declaration registers the file'
);

reset role;

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

set local role service_role;

select is(
  public.api_authorize_provider_worker_dispatch(gen_random_uuid(), gen_random_uuid(), '{"vendor":"fictiv"}'::jsonb, 'worker-1', now()) ->> 'denial',
  'export_declaration_missing',
  'the provider preflight denies before the core when the export lookup finds nothing'
);

select is(
  public.api_authorize_xometry_beta_worker_dispatch(gen_random_uuid(), gen_random_uuid(), '{"vendor":"xometry"}'::jsonb, 'worker-1', now()) ->> 'reasonCode',
  'export_declaration_missing',
  'the Xometry preflight denies before the core when the export lookup finds nothing'
);

-- 4. Marking hit.
update ovd723_ctx
set block_id = public.api_record_export_control_marking_hits(
  clean_job_id, null, null, 'drawing_text', array['itar', 'eccn_code']
);

reset role;

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
  not has_function_privilege('authenticated', 'public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[])', 'execute')
  and has_function_privilege('service_role', 'public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[])', 'execute'),
  'only the service role can record marking hits'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.api_declare_job_export_status(uuid, text, text, uuid)'::regprocedure),
  'the declaration RPC is SECURITY DEFINER with an empty search_path'
);

select * from finish();
rollback;
