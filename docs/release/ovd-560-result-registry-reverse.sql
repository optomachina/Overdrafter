-- Reverse only an unused OVD-560 source fixture, before OVD-558 reversal.
-- Existing registrations are immutable evidence and must never be discarded.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $preflight$
begin
  if current_user <> 'postgres'
    or to_regprocedure('engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text)') is null
    or (select count(*) from engineering_private.native_verifier_registered_objects) <> 0 then
    raise exception 'ovd560_reverse_requires_empty_exact_registry';
  end if;
end $preflight$;

drop function engineering_private.register_native_result_object(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,uuid,text,timestamptz,bigint,text) restrict;
drop trigger native_result_registration_immutable on engineering_private.native_verifier_registered_objects;
drop function engineering_private.native_result_registration_immutable() restrict;

create or replace function engineering_private.native_verifier_can_read_object(p_bucket text, p_name text)
returns boolean language plpgsql security definer set search_path = '' as $body$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'engineering_native_verifier' then
    return false;
  end if;
  return exists (select 1 from engineering_private.native_verifier_registered_objects
    where bucket_id = p_bucket and object_name = p_name);
end $body$;

alter table engineering_private.native_verifier_registered_objects
  drop column organization_id, drop column project_id, drop column task_id,
  drop column attempt_id, drop column fence, drop column input_snapshot_id,
  drop column candidate_snapshot_id, drop column artifact_role, drop column storage_object_id,
  drop column storage_version, drop column storage_updated_at, drop column byte_length, drop column sha256,
  drop column registered_at;

do $postflight$
declare callable_count integer;
begin
  select count(*) into callable_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private','storage')
      and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE');
  if callable_count <> 7 then raise exception 'ovd560_reverse_allowlist_drift:%', callable_count; end if;
end $postflight$;
commit;
