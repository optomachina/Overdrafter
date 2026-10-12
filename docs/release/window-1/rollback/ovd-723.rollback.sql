-- OVD-723 rollback, runnable form. Window 1 packet, not a migration.
--
-- Source: the ROLLBACK prose of docs/migration-drafts/ovd-723.sql at PR #677
-- head 673fbe33 (one migration: upload block, dispatch gate, backfill, storage
-- policy), turned into statements. Lines the draft leaves as prose are written
-- out from origin/main:
--   * "job_files_storage_insert" exactly as in 20260815093000 (lines 384-398);
--   * the dispatch preflights back to service_role only (20261003170000,
--     20261002182910);
--   * the upload RPCs back to authenticated and service_role (20261004110000).
-- Rehearsed by scripts/window-1/rehearse.mjs.
--
-- Order: roll back strictly in reverse order of apply. With the recommended
-- order (462, 723, 722) roll back OVD-722 first; this file drops the public
-- dispatch RPC names, so running it under the 722 wrapper would delete the
-- kill switch gate silently.
-- Retained on purpose (audit data, per the draft): private.job_export_declarations,
-- private.export_control_events, private.job_export_marking_blocks,
-- private.job_file_export_scans, their append only triggers and member read
-- policies, and private.reject_export_control_audit_mutation(). Dropping them
-- needs Blaine's explicit approval after an export.
-- Effect: removes the upload block and the dispatch gate. Run only with Blaine's yes.
--
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/release/window-1/rollback/ovd-723.rollback.sql

set local lock_timeout = '5s';

-- Storage policy first: it depends on current_user_has_export_cleared_upload.
drop policy if exists "job_files_storage_insert" on storage.objects;
create policy "job_files_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-files'
  and name ~ '^org-sha256/[0-9a-f-]{36}/[0-9a-f]{64}/[a-z0-9._-]+$'
  and exists (
    select 1
    from public.jobs job
    where job.organization_id::text = split_part(name, '/', 2)
      and public.user_can_edit_job(job.id)
      and public.current_user_has_current_founding_beta_access(job.organization_id)
  )
);

-- Dispatch preflight wrappers (1.16): restore the preserved bodies.
drop function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.provider_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_provider_worker_dispatch;
alter function private.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

drop function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.xometry_beta_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_xometry_beta_worker_dispatch;
alter function private.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

-- Upload RPCs (1.13): drop the declaration overloads and the refusing legacy
-- signatures, then restore the preserved bodies under their public names.
drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text, uuid);
drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text, uuid);
drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text);
drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text);

alter function private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)
  rename to api_prepare_job_file_upload;
alter function private.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  set schema public;
revoke all on function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  to authenticated, service_role;

alter function private.job_file_finalize_core(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  rename to api_finalize_job_file_upload;
alter function private.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  set schema public;
revoke all on function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  to authenticated, service_role;

-- New RPCs and helpers.
drop function public.current_user_has_export_cleared_upload(text, text);
drop function public.api_review_export_control_block(uuid, text, text);
drop function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[]);
drop function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text);
drop function public.api_get_job_export_control_status(uuid);
drop function public.api_declare_job_export_status(uuid, text, text, uuid);
drop function private.export_control_dispatch_denial_for_task(uuid, text);
drop function private.export_control_scan_denial(uuid, uuid);
drop function private.export_control_file_denial(uuid, uuid, text[]);
drop function private.export_control_dispatch_denial(uuid, text);
drop function private.require_clean_export_declaration(uuid, uuid);
drop function private.job_export_upload_denial(uuid, uuid);
drop function private.lock_job_export_state(uuid, boolean);
drop function private.export_control_provider_jurisdiction(text);
drop function private.export_control_terms_version();
drop table private.export_cleared_upload_grants;
