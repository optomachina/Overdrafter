-- OVD-1151 rollback draft: authorized migration window only, one transaction.
-- Restores the OVD-746 public wrapper byte for byte. The client editor then
-- loses the RFQ details again, so a full save can null them; no stored data changes.

set local lock_timeout = '5s';

do $ovd1151_guard$
declare
  v_md5 text;
begin
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.api_list_client_part_metadata(uuid[])');
  if v_md5 is null or v_md5 not in ('a195ef0e6fa0d766369b404638832123', '9127a3995b7bb5fc089ea4fa91525652') then
    raise exception 'OVD-1151 rollback refused: public.api_list_client_part_metadata(uuid[]) has an unexpected body'
      using errcode = '55000';
  end if;
end;
$ovd1151_guard$;

create or replace function public.api_list_client_part_metadata(p_job_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  return private.api_list_client_part_metadata(p_job_ids);
end;
$$;

revoke all on function public.api_list_client_part_metadata(uuid[]) from public, anon;
grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated, service_role;
