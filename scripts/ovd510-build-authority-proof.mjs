/**
 * Disposable-only SQL for the seven-signature OVD-510 authority proof. These
 * functions deliberately reject business work. They are not release RPCs.
 */
export const allowedVerifierSignatures = [
  "public.api_load_native_verification(uuid,uuid)",
  "public.api_complete_native_verification(uuid,text)",
  "public.api_reject_native_verification(uuid,jsonb)",
  "engineering_private.load_native_verification(uuid,uuid)",
  "engineering_private.complete_native_verification(uuid,text)",
  "engineering_private.reject_native_verification(uuid,jsonb)",
  "engineering_private.native_verifier_can_read_object(text,text)",
];

export function buildAuthorityProofSql(replacementGrantSql, catalogSelect,
  { injectFailureAfterRevokes = false } = {}) {
  if (!replacementGrantSql.startsWith("-- OVD-510 exact replacement grants")
      || !catalogSelect.startsWith("with selected_roles(role_name) as (")) {
    throw new Error("authority_proof_input_mismatch");
  }
  const injectedFailure = injectFailureAfterRevokes
    ? `do $injected$ begin
  raise exception 'ovd510_injected_failure' using errcode = 'P0001';
end $injected$;`
    : "";
  return `begin;
set local statement_timeout = '180s';
select pg_advisory_xact_lock(510, 2);
do $preflight$ begin
  if to_regrole('engineering_native_verifier') is not null
     or to_regprocedure('public.api_load_native_verification(uuid,uuid)') is not null
     or to_regclass('engineering_private.ovd510_proof_registry') is not null then
    raise exception 'ovd510_preexisting_verifier_object';
  end if;
end $preflight$;
create role engineering_native_verifier
  nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

set role postgres;
create table engineering_private.ovd510_proof_registry (
  bucket_id text not null, object_name text not null,
  primary key (bucket_id, object_name));
alter table engineering_private.ovd510_proof_registry enable row level security;
insert into engineering_private.ovd510_proof_registry values
  ('ovd510-proof', 'registered-result');
create function engineering_private.load_native_verification(p_task_id uuid, p_attempt_id uuid)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.complete_native_verification(p_attempt_id uuid, p_receipt text)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.reject_native_verification(p_attempt_id uuid, p_reason jsonb)
returns text language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    raise exception 'ovd510_wrong_principal' using errcode = 'P0001';
  end if;
  raise exception 'ovd510_proof_only' using errcode = 'P0001';
end $body$;
create function engineering_private.native_verifier_can_read_object(p_bucket text, p_name text)
returns boolean language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    return false;
  end if;
  return exists (select 1 from engineering_private.ovd510_proof_registry
    where bucket_id = p_bucket and object_name = p_name);
end $body$;
create function public.api_load_native_verification(p_task_id uuid, p_attempt_id uuid)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.load_native_verification($1, $2);
$body$;
create function public.api_complete_native_verification(p_attempt_id uuid, p_receipt text)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.complete_native_verification($1, $2);
$body$;
create function public.api_reject_native_verification(p_attempt_id uuid, p_reason jsonb)
returns text language sql security invoker set search_path = '' as $body$
  select engineering_private.reject_native_verification($1, $2);
$body$;
create function public.ovd510_unlisted_plain() returns text
  language sql security invoker as $body$ select 'unexpected'::text; $body$;
create function public.ovd510_unlisted_definer() returns text
  language sql security definer set search_path = '' as $body$ select 'unexpected'::text; $body$;
create function engineering_private.ovd510_unlisted_private() returns text
  language sql security invoker as $body$ select 'unexpected'::text; $body$;
reset role;

alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role supabase_storage_admin revoke execute on functions from public;
alter default privileges for role postgres in schema private, extensions grant execute on functions to public;
revoke execute on all functions in schema public, engineering_private, storage from public;
${injectedFailure}
${replacementGrantSql}
grant usage on schema public, engineering_private, storage to engineering_native_verifier;
grant select on storage.objects to engineering_native_verifier;
grant execute on function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text)
  to engineering_native_verifier;
grant engineering_native_verifier to authenticator
  with inherit false, set true, admin false;
create policy ovd510_verifier_registered_permissive on storage.objects
  as permissive for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id, name));
create policy ovd510_verifier_registered_restrictive on storage.objects
  as restrictive for select to engineering_native_verifier
  using (engineering_private.native_verifier_can_read_object(bucket_id, name));
set role postgres;
create function public.ovd510_future_public() returns text
  language sql as $body$ select 'future'::text; $body$;
create function engineering_private.ovd510_future_private() returns text
  language sql as $body$ select 'future'::text; $body$;
create function private.ovd510_future_nonverifier() returns text
  language sql as $body$ select 'future'::text; $body$;
create function extensions.ovd510_future_extensions() returns text
  language sql as $body$ select 'future'::text; $body$;
reset role;
set role supabase_storage_admin;
create function storage.ovd510_future_storage() returns text
  language sql as $body$ select 'future'::text; $body$;
reset role;
insert into storage.buckets (id, name, public) values
  ('ovd510-proof', 'ovd510-proof', false);
insert into storage.objects (bucket_id, name) values
  ('ovd510-proof', 'registered-result'),
  ('ovd510-proof', 'unregistered-result');

set role engineering_native_verifier;
set request.jwt.claim.role = 'engineering_native_verifier';
do $checks$
declare found_count integer;
begin
  begin
    perform public.api_load_native_verification('00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid);
    raise exception 'ovd510_load_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  begin
    perform public.api_complete_native_verification('00000000-0000-0000-0000-000000000002'::uuid, 'proof');
    raise exception 'ovd510_complete_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  begin
    perform public.api_reject_native_verification('00000000-0000-0000-0000-000000000002'::uuid, '{}'::jsonb);
    raise exception 'ovd510_reject_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  if not engineering_private.native_verifier_can_read_object('ovd510-proof', 'registered-result')
     or engineering_private.native_verifier_can_read_object('ovd510-proof', 'unregistered-result') then
    raise exception 'ovd510_registry_helper_mismatch';
  end if;
  select count(*) into found_count from storage.objects where bucket_id = 'ovd510-proof';
  if found_count <> 1 then raise exception 'ovd510_storage_policy_mismatch:%', found_count; end if;
  begin
    perform public.ovd510_unlisted_plain();
    raise exception 'ovd510_public_unlisted_callable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ovd510_unlisted_definer();
    raise exception 'ovd510_public_definer_callable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform engineering_private.ovd510_unlisted_private();
    raise exception 'ovd510_private_unlisted_callable';
  exception when insufficient_privilege then null;
  end;
  if has_table_privilege(current_user, 'storage.objects', 'INSERT')
     or has_table_privilege(current_user, 'storage.objects', 'UPDATE')
     or has_table_privilege(current_user, 'storage.objects', 'DELETE') then
    raise exception 'ovd510_storage_dml_grant';
  end if;
end $checks$;
reset role;
do $schema_authority$ declare schema_row record;
begin
  for schema_row in
    select nspname from pg_namespace
    where nspname not like 'pg_%' and nspname <> 'information_schema'
  loop
    if has_schema_privilege('engineering_native_verifier', schema_row.nspname, 'CREATE')
       or has_schema_privilege('engineering_native_verifier', schema_row.nspname, 'USAGE')
          <> (schema_row.nspname in ('public', 'engineering_private', 'storage')) then
      raise exception 'ovd510_verifier_schema_authority_mismatch:%', schema_row.nspname;
    end if;
  end loop;
end $schema_authority$;
set search_path = public;
${catalogSelect}
rollback;`;
}
