-- OVD-723 CONTRACT rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-723-contract.rollback.sql
--
-- Restores the state after the expand migration: the legacy upload RPCs work
-- again, the old Storage INSERT policy is back (exactly as in
-- 20260815093000), and the preflights are the original bodies. Effect:
-- removes the server side upload and dispatch block. Run only with Blaine's
-- yes. Roll back strictly in reverse order of apply: the guard refuses when
-- another migration (for example OVD-722) wraps the OVD-723 preflight
-- wrappers, because dropping them would silently remove that gate.

set local lock_timeout = '5s';

do $guard$
begin
  if pg_catalog.to_regprocedure('private.provider_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)') is null
    or pg_catalog.to_regprocedure('private.xometry_beta_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)') is null
    or pg_catalog.to_regprocedure('private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)') is null
    or pg_catalog.to_regprocedure('private.job_file_finalize_core(uuid, text, text, text, public.job_file_kind, text, bigint, text)') is null then
    raise exception 'OVD-723 contract rollback refused: the contract migration is not applied';
  end if;
  if (select pg_catalog.strpos(prosrc, 'private.provider_worker_dispatch_core(') from pg_catalog.pg_proc
      where oid = 'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)'::pg_catalog.regprocedure) = 0
    or (select pg_catalog.strpos(prosrc, 'private.xometry_beta_worker_dispatch_core(') from pg_catalog.pg_proc
      where oid = 'public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)'::pg_catalog.regprocedure) = 0 then
    raise exception 'OVD-723 contract rollback refused: the OVD-723 wrappers are not the outermost preflights; roll back the later migration first';
  end if;
end;
$guard$;

-- C.5
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

-- C.4
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

-- C.3 and C.1
drop function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text);
drop function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text);
alter function private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)
  rename to api_prepare_job_file_upload;
alter function private.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  set schema public;
alter function private.job_file_finalize_core(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  rename to api_finalize_job_file_upload;
alter function private.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  set schema public;
revoke all on function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  from public, anon;
grant execute on function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text)
  to authenticated;
revoke all on function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  from public, anon;
grant execute on function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text)
  to authenticated;

-- C.2: the delegates call the legacy RPCs again (expand state).
create or replace function private.job_file_prepare_delegate(
  p_job_id uuid, p_original_name text, p_file_kind public.job_file_kind,
  p_mime_type text, p_size_bytes bigint, p_content_sha256 text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return public.api_prepare_job_file_upload(
    p_job_id, p_original_name, p_file_kind, p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

create or replace function private.job_file_finalize_delegate(
  p_job_id uuid, p_storage_bucket text, p_storage_path text, p_original_name text,
  p_file_kind public.job_file_kind, p_mime_type text, p_size_bytes bigint, p_content_sha256 text
)
returns uuid
language plpgsql
set search_path = ''
as $$
begin
  return public.api_finalize_job_file_upload(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;
