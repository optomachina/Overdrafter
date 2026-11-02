-- OVD-723 CONTRACT rollback. Not a migration.
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-723-contract.rollback.sql
--
-- Restores the pinned current-main state before contract apply: the legacy upload RPCs work
-- again, the old Storage INSERT policy is back (exactly as in
-- 20260815093000), and the preflights and the manual quote RPC are the
-- original bodies. Effect:
-- removes the server side upload and dispatch block. Run only with Blaine's
-- yes. Roll back strictly in reverse order of apply: the guard refuses when
-- another migration (for example OVD-722) wraps the OVD-723 preflight
-- wrappers, because dropping them would silently remove that gate.

set local lock_timeout = '5s';

-- One block makes the inverse atomic; replay requires pinned bodies and no cores.
do $rollback$
declare
  v_expected record;
  v_md5 text;
begin
  if not exists (
    select 1 from (values
      ('private.job_file_prepare_delegate(uuid,text,public.job_file_kind,text,bigint,text)', '8c5fae6e53835f537916e8097021456c'),
      ('private.job_file_finalize_delegate(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'd1e7d64c3a20a6a05c55cbe4c316fc0e'),
      ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', '686d958f0545bee88af127afa5a88860'),
      ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'fcbee1db0a164cf78f2dd356dcb85c55'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19'),
      ('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '254e6ce84f67dae43d9664adf4b85673'),
      ('public.api_request_manual_quote(uuid,boolean)', '8e5f10dabbf9c8c6420e2c14e9b01e79')
    ) as expected(signature, body_md5)
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(expected.signature)
    where pg_catalog.md5(p.prosrc) is distinct from expected.body_md5
  )
    and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'job_file_prepare_core')
    and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'job_file_finalize_core')
    and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'provider_worker_dispatch_core')
    and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'xometry_beta_worker_dispatch_core')
    and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'manual_quote_request_core')
    and pg_catalog.to_regprocedure('private.export_control_manual_quote_denial(uuid)') is null
    and exists (select 1 from pg_catalog.pg_policy where polrelid = 'storage.objects'::pg_catalog.regclass and polname = 'job_files_storage_insert') then
    return;
  end if;

  if pg_catalog.to_regprocedure('private.provider_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)') is null
    or pg_catalog.to_regprocedure('private.xometry_beta_worker_dispatch_core(uuid, uuid, jsonb, text, timestamptz)') is null
    or pg_catalog.to_regprocedure('private.job_file_prepare_core(uuid, text, public.job_file_kind, text, bigint, text)') is null
    or pg_catalog.to_regprocedure('private.job_file_finalize_core(uuid, text, text, text, public.job_file_kind, text, bigint, text)') is null
    or pg_catalog.to_regprocedure('private.manual_quote_request_core(uuid, boolean)') is null then
    raise exception 'OVD-723 contract rollback refused: the contract migration is not applied';
  end if;
  if (select pg_catalog.strpos(prosrc, 'private.provider_worker_dispatch_core(') from pg_catalog.pg_proc
      where oid = 'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)'::pg_catalog.regprocedure) = 0
    or (select pg_catalog.strpos(prosrc, 'private.xometry_beta_worker_dispatch_core(') from pg_catalog.pg_proc
      where oid = 'public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)'::pg_catalog.regprocedure) = 0 then
    raise exception 'OVD-723 contract rollback refused: the OVD-723 wrappers are not the outermost preflights; roll back the later migration first';
  end if;

  for v_expected in
    select * from (values
      ('private.job_file_prepare_delegate(uuid,text,public.job_file_kind,text,bigint,text)', 'c79b6caca22fa14812a4606bf80f6bfe'),
      ('private.job_file_finalize_delegate(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'ceaf33efeba60bc3844b73c62e5adc05'),
      ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', 'c39ae0621bba5ad1dd1670b76dec4e78'),
      ('private.job_file_prepare_core(uuid,text,public.job_file_kind,text,bigint,text)', '686d958f0545bee88af127afa5a88860'),
      ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', '193b46deb75a1d58a34e2526798a9ad9'),
      ('private.job_file_finalize_core(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'fcbee1db0a164cf78f2dd356dcb85c55'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '571b326dd5ab8a12389d9e8e39265374'),
      ('private.xometry_beta_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19'),
      ('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', 'bb800ea3d7e9d2e850f30eddad2e8fa3'),
      ('private.provider_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz)', '254e6ce84f67dae43d9664adf4b85673'),
      ('public.api_request_manual_quote(uuid,boolean)', 'ae6ef2e4c3cc9170dbcfe21f77aa8b83'),
      ('private.manual_quote_request_core(uuid,boolean)', '8e5f10dabbf9c8c6420e2c14e9b01e79'),
      ('private.export_control_manual_quote_denial(uuid)', '24fc5eb8424a0d090a2383abc9d4eab3')
    ) as expected(signature, body_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is distinct from v_expected.body_md5 then
      raise exception 'OVD-723 contract rollback refused: unexpected body for %', v_expected.signature;
    end if;
  end loop;

-- C.6: the manual quote RPC is the original body again.
-- Restore from the pinned core without replacing the original public OID/ACL.
execute pg_catalog.replace(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.manual_quote_request_core(uuid,boolean)')),
  'FUNCTION private.manual_quote_request_core(', 'FUNCTION public.api_request_manual_quote('
);
drop function private.manual_quote_request_core(uuid,boolean);
revoke all on function public.api_request_manual_quote(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_manual_quote(uuid, boolean)
  to authenticated;

drop function private.export_control_manual_quote_denial(uuid);

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
-- Restore from the pinned core without replacing the original public OID/ACL.
execute pg_catalog.replace(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.provider_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz)')),
  'FUNCTION private.provider_worker_dispatch_core(', 'FUNCTION public.api_authorize_provider_worker_dispatch('
);
drop function private.provider_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz);
revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

-- Restore from the pinned core without replacing the original public OID/ACL.
execute pg_catalog.replace(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.xometry_beta_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz)')),
  'FUNCTION private.xometry_beta_worker_dispatch_core(', 'FUNCTION public.api_authorize_xometry_beta_worker_dispatch('
);
drop function private.xometry_beta_worker_dispatch_core(uuid,uuid,jsonb,text,timestamptz);
revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

-- C.3 and C.1: restore in place, preserving the pre-apply public ACLs.
execute pg_catalog.replace(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.job_file_prepare_core(uuid,text,public.job_file_kind,text,bigint,text)')),
  'FUNCTION private.job_file_prepare_core(', 'FUNCTION public.api_prepare_job_file_upload('
);
drop function private.job_file_prepare_core(uuid,text,public.job_file_kind,text,bigint,text);

execute pg_catalog.replace(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.job_file_finalize_core(uuid,text,text,text,public.job_file_kind,text,bigint,text)')),
  'FUNCTION private.job_file_finalize_core(', 'FUNCTION public.api_finalize_job_file_upload('
);
drop function private.job_file_finalize_core(uuid,text,text,text,public.job_file_kind,text,bigint,text);

-- C.2: the delegates call the legacy RPCs again (expand state).
create or replace function private.job_file_prepare_delegate(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text
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
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text,
  p_size_bytes bigint,
  p_content_sha256 text
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

  for v_expected in
    select * from (values
      ('private.job_file_prepare_delegate(uuid,text,public.job_file_kind,text,bigint,text)', '8c5fae6e53835f537916e8097021456c'),
      ('private.job_file_finalize_delegate(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'd1e7d64c3a20a6a05c55cbe4c316fc0e'),
      ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', '686d958f0545bee88af127afa5a88860'),
      ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'fcbee1db0a164cf78f2dd356dcb85c55'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19'),
      ('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '254e6ce84f67dae43d9664adf4b85673'),
      ('public.api_request_manual_quote(uuid,boolean)', '8e5f10dabbf9c8c6420e2c14e9b01e79')
    ) as expected(signature, body_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is distinct from v_expected.body_md5 then
      raise exception 'OVD-723 contract rollback refused: unexpected body for %', v_expected.signature;
    end if;
  end loop;
end;
$rollback$;
