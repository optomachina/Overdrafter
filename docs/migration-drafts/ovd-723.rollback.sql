-- OVD-723 EXPAND rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-723.rollback.sql
--
-- Drops only what the expand migration created. The legacy upload RPCs, the
-- "job_files_storage_insert" policy, and both preflights were never changed by
-- expand, so nothing is restored. Retained on purpose (audit data):
-- private.job_export_declarations (including the backfilled rows),
-- private.export_control_events, private.job_export_marking_blocks,
-- private.job_file_export_scans, their append only triggers and member read
-- policies, and private.reject_export_control_audit_mutation(). Dropping them
-- needs Blaine's explicit approval after an export. Effect: the new client and
-- worker fail closed (their RPCs are gone) until they are rolled back too.
--
-- The 'export_marking_rescan' value of public.queue_task_type stays:
-- PostgreSQL cannot drop an enum value. Only QUEUED rescan tasks are
-- cancelled, so an older worker never claims one (it would fail on an
-- unknown task type). A rescan already running finishes or fails on its own,
-- and completed or failed rescan rows are left as they are.

set local lock_timeout = '5s';

do $guard$
begin
  if pg_catalog.to_regprocedure('private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)') is not null
    or pg_catalog.to_regprocedure('private.provider_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)') is not null
    or pg_catalog.to_regprocedure('private.manual_quote_request_core(uuid, boolean)') is not null
    or not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'job_files_storage_insert'
    ) then
    raise exception 'OVD-723 expand rollback refused: the contract migration is applied; roll it back first';
  end if;
end;
$guard$;

drop policy "job_files_storage_insert_export_cleared" on storage.objects;

update public.work_queue
set status = 'cancelled',
    last_error = 'OVD-723 expand rolled back: export marking rescan cancelled'
where task_type::text = 'export_marking_rescan'
  and status = 'queued';

drop function public.api_request_export_marking_rescan(uuid);
drop function public.api_queue_export_marking_rescan(uuid);
drop function private.queue_export_marking_rescans(uuid);
drop function private.job_export_scan_state(uuid);
drop function private.export_rescan_final_outcome(uuid, uuid, text);
drop index public.work_queue_job_task_type_idx;
drop function public.api_check_export_control_dispatch(uuid, text);
drop function public.api_check_export_control_extraction(uuid);
drop function private.export_control_extraction_denial(uuid);
drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text, uuid);
drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text, uuid);
drop function private.job_file_prepare_delegate(uuid, text, public.job_file_kind, text, bigint, text);
drop function private.job_file_finalize_delegate(uuid, text, text, text, public.job_file_kind, text, bigint, text);
drop function public.current_user_has_export_cleared_upload(text, text);
drop function public.api_review_export_control_block(uuid, text, text);
drop function private.record_admin_cleared_scan(uuid);
drop function public.api_record_export_control_marking_hits(uuid, uuid, uuid, text, text[], text);
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
