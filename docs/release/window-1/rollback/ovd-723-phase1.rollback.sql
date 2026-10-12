-- OVD-723 PHASE 1 rollback, runnable form. Window 1 packet, not a migration.
--
-- Source: the R1 prose in the ROLLBACK section of docs/migration-drafts/ovd-723.sql
-- (PR #677 head 96d8b7adb3db1029ed0e8217b1b0573a181f41a3), turned into
-- statements. The "restate the original grants" lines are written out from
-- origin/main (20261003170000, 20261002182910, 20261004110000): the dispatch
-- preflights are service_role only; the upload RPCs are authenticated and
-- service_role. Rehearsed by scripts/window-1/rehearse.mjs.
--
-- Scope: undoes PHASE 1 only. PHASE 2 is not in window 1; the guard below
-- refuses if the PHASE 2 storage policy is present.
-- Order: roll back strictly in reverse order of apply. With the recommended
-- order (462, 723, 722) roll back OVD-722 first; this file drops the public
-- dispatch RPC names, so running it under the 722 wrapper would delete the
-- kill switch gate silently.
-- Retained on purpose (audit data, per the draft): the tables
-- private.job_export_declarations, private.export_control_events,
-- private.job_export_marking_blocks, private.job_file_export_scans, their
-- append only triggers, their member read policies, and
-- private.reject_export_control_audit_mutation(). Dropping them needs Blaine's
-- explicit approval after an export.
--
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/release/window-1/rollback/ovd-723-phase1.rollback.sql

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'job_files_storage_insert'
      and with_check like '%current_user_has_export_cleared_upload%'
  ) then
    raise exception 'OVD-723 phase 1 rollback refused: PHASE 2 storage policy is applied; undo PHASE 2 (R2) first'
      using errcode = 'P0001';
  end if;
end
$$;

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

-- Upload RPCs (1.13): drop the declaration overloads and the delegating
-- wrappers, then restore the preserved bodies under their public names.
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
drop function public.current_user_has_export_cleared_upload(text);
drop function public.api_review_export_control_block(uuid, text, text);
drop function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[]);
drop function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text);
drop function public.api_get_job_export_control_status(uuid);
drop function public.api_declare_job_export_status(uuid, text, text, uuid);
drop function private.export_control_dispatch_denial_for_task(uuid, text);
drop function private.export_control_scan_denial(uuid);
drop function private.export_control_dispatch_denial(uuid, text);
drop function private.require_clean_export_declaration(uuid, uuid);
drop function private.job_export_upload_denial(uuid, uuid);
drop function private.lock_job_export_state(uuid, boolean);
drop function private.export_control_provider_jurisdiction(text);
drop function private.export_control_terms_version();
drop table private.export_cleared_upload_grants;
