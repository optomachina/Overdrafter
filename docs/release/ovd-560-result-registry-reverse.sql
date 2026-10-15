-- Reverse only an unused OVD-560 source fixture, before OVD-558 reversal.
-- Existing registrations are immutable evidence and must never be discarded.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- READ COMMITTED first: the emptiness check below must read a snapshot taken
-- after the locks; an older REPEATABLE READ or SERIALIZABLE snapshot could miss
-- a committed registration.
do $isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd560_reverse_requires_read_committed';
  end if;
end $isolation$;
-- The shared window 2 reverse lock serializes every staged reverse, including
-- the OVD-558 reverse, before any relation lock is requested.
select pg_advisory_xact_lock(510, 2);
-- The window 2 relation order, the order registration takes them: the attempt
-- (registration locks it FOR UPDATE first), its snapshot parent, then
-- storage.objects (FOR SHARE on the object), then the registry. Dropping the
-- registry columns drops their foreign keys, which takes ACCESS EXCLUSIVE on
-- every referenced table; taking those locks here, first, means a live
-- registration either finishes before the reverse (which then refuses) or
-- waits behind it and fails, and the two never deadlock.
lock table public.engineering_execution_attempts, public.engineering_snapshots,
  storage.objects, engineering_private.native_verifier_registered_objects
  in access exclusive mode;
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
  drop constraint native_result_bucket_name_bound;
alter table engineering_private.native_verifier_registered_objects
  drop column organization_id, drop column project_id, drop column task_id,
  drop column attempt_id, drop column fence, drop column input_snapshot_id,
  drop column candidate_snapshot_id, drop column artifact_role, drop column storage_object_id,
  drop column storage_version, drop column storage_updated_at, drop column byte_length, drop column sha256,
  drop column registered_at;

do $postflight$
declare callable_count integer;
begin
  -- OVD-558 allowlist: exactly 7 application functions, and in storage nothing
  -- anon cannot call (storage functions keep Supabase's shipped ACLs).
  select count(*) into callable_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private')
      and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE');
  if callable_count <> 7 then raise exception 'ovd560_reverse_allowlist_drift:%', callable_count; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage'
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'ovd560_reverse_allowlist_drift_storage_beyond_anon';
  end if;
end $postflight$;
commit;
