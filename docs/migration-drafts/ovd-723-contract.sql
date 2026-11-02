-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-723 CONTRACT migration (window 2, about Nov 9; before any provider
-- goes live for beta users). Requires the EXPAND migration (ovd-723.sql) and
-- a deployed web client that uses the declaring upload overloads and a
-- deployed worker that calls api_check_export_control_dispatch.
--
-- This file is a DRAFT. It is not under supabase/migrations/. Rollback:
-- ovd-723-contract.rollback.sql (guarded; refuses unless the OVD-723
-- wrappers are the outermost preflights).
--
-- After this migration the server side block is complete, for any client
-- and any worker:
--   C.1-C.3 the legacy 6- and 8-argument upload RPCs refuse
--           (export_declaration_missing); their bodies move to private cores
--           that only the declaring overloads reach;
--   C.4     both provider preflights are wrapped by the export gate;
--   C.5     the old job-files Storage INSERT policy is dropped, so only the
--           grant policy added by the expand migration remains;
--   C.6     client manual quote requests (api_request_manual_quote, and
--           api_request_manual_quotes through it) are refused for a held
--           part, so held files never reach the admin manual quote inbox.
--
-- Promote together with: the contract pgTAP suite
-- (ovd723_export_control_contract.sql.pending, renamed into supabase/tests/),
-- and the free_confirmed_quote_access seed in
-- ovd-723-contract-free-confirmed-seed.patch, which needs the expanded fixture
-- regenerated (node scripts/generate-free-quote-fixtures.mjs) and its pin in
-- scripts/fixtures/free-quote-ci-source.json refreshed. Without the seed that
-- suite's one authorized dispatch is refused by the wrapped preflight.
--
-- Every statement here changes an existing object, so none of it can be
-- expand. C.5 takes ACCESS EXCLUSIVE on storage.objects; the lock timeout
-- makes the migration fail fast and roll back whole. On a timeout, rerun at
-- lower traffic.

set local lock_timeout = '3s';

do $guard$
declare
  v_expected record;
  v_md5 text;
begin
  if pg_catalog.to_regprocedure('public.api_check_export_control_dispatch(uuid, text)') is null
    or pg_catalog.to_regprocedure(
      'private.job_file_prepare_delegate(uuid, text, public.job_file_kind, text, bigint, text)'
    ) is null then
    raise exception 'OVD-723 contract refused: apply the OVD-723 expand migration first';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in (
      'job_file_prepare_core', 'job_file_finalize_core', 'provider_worker_dispatch_core', 'xometry_beta_worker_dispatch_core', 'manual_quote_request_core', 'export_control_manual_quote_denial'
    )) then
    raise exception 'OVD-723 contract refused: contract objects already exist';
  end if;
  for v_expected in
    select * from (values
      ('private.job_file_prepare_delegate(uuid,text,public.job_file_kind,text,bigint,text)', '8c5fae6e53835f537916e8097021456c'),
      ('private.job_file_finalize_delegate(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'd1e7d64c3a20a6a05c55cbe4c316fc0e'),
      ('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)', '686d958f0545bee88af127afa5a88860'),
      ('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)', 'fcbee1db0a164cf78f2dd356dcb85c55'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '5d7e026241a0346a6624063e86a088f7'),
      ('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '254e6ce84f67dae43d9664adf4b85673'),
      ('public.api_request_manual_quote(uuid,boolean)', '8e5f10dabbf9c8c6420e2c14e9b01e79')
    ) as expected(signature, body_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5 from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is distinct from v_expected.body_md5 then
      raise exception 'OVD-723 contract refused: unexpected body for %', v_expected.signature;
    end if;
  end loop;
end;
$guard$;

-- OVD-1035: pin the current post-window bodies before copying them unchanged.
-- OVD-767 admin guards are untouched; the Xometry core includes OVD-987.
-- C.1 The legacy bodies are copied unchanged to private cores (no grants).
-- Copy the current definition; keep the public OID, ACL order and metadata intact.
do $copy$
begin
  execute pg_catalog.replace(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.api_prepare_job_file_upload(uuid,text,public.job_file_kind,text,bigint,text)')),
    'FUNCTION public.api_prepare_job_file_upload(', 'FUNCTION private.job_file_prepare_core('
  );
end;
$copy$;
revoke all on function private.job_file_prepare_core(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated, service_role;

-- Copy the current definition; keep the public OID, ACL order and metadata intact.
do $copy$
begin
  execute pg_catalog.replace(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.api_finalize_job_file_upload(uuid,text,text,text,public.job_file_kind,text,bigint,text)')),
    'FUNCTION public.api_finalize_job_file_upload(', 'FUNCTION private.job_file_finalize_core('
  );
end;
$copy$;
revoke all on function private.job_file_finalize_core(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon, authenticated, service_role;

-- C.2 The declaring overloads now reach the cores.
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
  return private.job_file_prepare_core(
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
  return private.job_file_finalize_core(
    p_job_id, p_storage_bucket, p_storage_path, p_original_name, p_file_kind,
    p_mime_type, p_size_bytes, p_content_sha256
  );
end;
$$;

-- C.3 Legacy signatures: fail closed. They stay executable by authenticated
-- so an old client gets the stable code instead of a permission error.
create or replace function public.api_prepare_job_file_upload(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
    message = 'export_declaration_missing';
end;
$$;

create or replace function public.api_finalize_job_file_upload(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'export_declaration_missing';
end;
$$;

revoke all on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) to authenticated;
revoke all on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) to authenticated;

-- C.4 Dispatch preflights. The existing bodies are copied unchanged to private
-- cores; the public names become wrappers. Each wrapper runs the core first,
-- inside a subtransaction. A core denial is returned unchanged, so every
-- existing denial keeps its code and precedence. When the core authorizes,
-- the export gate runs (taking the shared per-job export lock, held until
-- commit, so a declaration or marking block cannot interleave); if it denies,
-- the wrapper raises SQLSTATE OV723 to roll back everything the core did
-- (for example a consumed permit) and returns the export denial instead. Any
-- other error propagates, as before. The wrappers keep the original
-- search_path = pg_catalog and qualify every reference.
-- Copy the current definition; keep the public OID, ACL order and metadata intact.
do $copy$
begin
  execute pg_catalog.replace(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)')),
    'FUNCTION public.api_authorize_xometry_beta_worker_dispatch(', 'FUNCTION private.xometry_beta_worker_dispatch_core('
  );
end;
$copy$;
revoke all on function private.xometry_beta_worker_dispatch_core(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;

-- Copy the current definition; keep the public OID, ACL order and metadata intact.
do $copy$
begin
  execute pg_catalog.replace(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)')),
    'FUNCTION public.api_authorize_provider_worker_dispatch(', 'FUNCTION private.provider_worker_dispatch_core('
  );
end;
$copy$;
revoke all on function private.provider_worker_dispatch_core(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
  v_denial text;
begin
  begin
    v_result := private.xometry_beta_worker_dispatch_core(
      p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
      p_expected_worker_name, p_expected_claimed_at
    );
    if v_result ->> 'authorized' = 'true' then
      v_denial := private.export_control_dispatch_denial_for_task(p_work_queue_task_id, 'xometry');
      if v_denial is not null then
        raise exception using errcode = 'OV723', message = v_denial;
      end if;
    end if;
  exception when sqlstate 'OV723' then
    return pg_catalog.jsonb_build_object('authorized', false, 'reasonCode', v_denial);
  end;
  return v_result;
end;
$$;

create or replace function public.api_authorize_provider_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
  v_denial text;
begin
  -- Xometry keeps its legacy response shape; its wrapper applies the gate.
  if p_scope_snapshot ->> 'vendor' = 'xometry' then
    return public.api_authorize_xometry_beta_worker_dispatch(
      p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
      p_expected_worker_name, p_expected_claimed_at
    );
  end if;

  begin
    v_result := private.provider_worker_dispatch_core(
      p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
      p_expected_worker_name, p_expected_claimed_at
    );
    if v_result ->> 'authorized' = 'true' then
      v_denial := private.export_control_dispatch_denial_for_task(
        p_work_queue_task_id,
        p_scope_snapshot ->> 'vendor'
      );
      if v_denial is not null then
        raise exception using errcode = 'OV723', message = v_denial;
      end if;
    end if;
  exception when sqlstate 'OV723' then
    return private.provider_dispatch_authorization_denial(v_denial);
  end;
  return v_result;
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;
revoke all on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;

-- C.5 Storage: drop the old job-files INSERT policy (20260815093000). The
-- expand policy "job_files_storage_insert_export_cleared" remains, so no
-- job-files object is written without an exact, declaration backed grant.
drop policy "job_files_storage_insert" on storage.objects;

-- C.6 Manual quote requests. In window 1 a client can still ask for a manual
-- quote of a held part (the request lands in the admin manual inbox, where a
-- person could send the files to a supplier by hand). The existing body is copied
-- unchanged to a private core; the public name becomes a wrapper that applies
-- the export gate first: the job's latest declaration must be not_controlled
-- with no open or confirmed marking block, and every part of the job must
-- pass the scan rule (verified hash, clean scan of its current bytes). The
-- rule does not depend on a provider: a manual quote may go to any supplier.
-- The gate takes the shared per-job export lock (held until commit), so a
-- declaration or block cannot interleave. A job the caller cannot see or
-- edit goes straight to the core, so its existing errors keep precedence.
-- Copy the current definition; keep the public OID, ACL order and metadata intact.
do $copy$
begin
  execute pg_catalog.replace(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.api_request_manual_quote(uuid,boolean)')),
    'FUNCTION public.api_request_manual_quote(', 'FUNCTION private.manual_quote_request_core('
  );
end;
$copy$;
revoke all on function private.manual_quote_request_core(uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function private.export_control_manual_quote_denial(p_job_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_denial text;
  v_part_id uuid;
begin
  v_denial := private.export_control_extraction_denial(p_job_id);
  if v_denial is not null then
    return v_denial;
  end if;
  for v_part_id in
    select part.id from public.parts part where part.job_id = p_job_id order by part.id
  loop
    v_denial := private.export_control_scan_denial(p_job_id, v_part_id);
    if v_denial is not null then
      return v_denial;
    end if;
  end loop;
  return null;
exception when others then
  return 'export_control_lookup_failed';
end;
$$;

revoke all on function private.export_control_manual_quote_denial(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_request_manual_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_denial text;
begin
  perform public.require_verified_auth();
  if p_job_id is not null
    and exists (select 1 from public.jobs job_row where job_row.id = p_job_id)
    and public.user_can_edit_job(p_job_id) then
    v_denial := private.export_control_manual_quote_denial(p_job_id);
    if v_denial is not null then
      raise exception using
        errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
        message = v_denial;
    end if;
  end if;
  return private.manual_quote_request_core(p_job_id, p_force_retry);
end;
$$;

revoke all on function public.api_request_manual_quote(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_manual_quote(uuid, boolean)
  to authenticated;

-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Executable and guarded: docs/migration-drafts/ovd-723-contract.rollback.sql.
