/** Connected privilege checks against the committed, inert OVD-558 fixture state. */
export const durableBehaviorSql = `begin;
set local statement_timeout = '90s';
set role postgres;
insert into engineering_private.native_verifier_registered_objects values
  ('ovd558-proof', 'registered-result');
create function public.ovd558_unlisted_plain() returns text
  language sql as $body$ select 'unexpected'::text; $body$;
create function public.ovd558_unlisted_definer() returns text
  language sql security definer set search_path = '' as $body$ select 'unexpected'::text; $body$;
create function engineering_private.ovd558_unlisted_private() returns text
  language sql as $body$ select 'unexpected'::text; $body$;
create function public.ovd558_future_public() returns text
  language sql as $body$ select 'future'::text; $body$;
create function engineering_private.ovd558_future_private() returns text
  language sql as $body$ select 'future'::text; $body$;
create function private.ovd558_future_nonverifier() returns text
  language sql as $body$ select 'future'::text; $body$;
create function extensions.ovd558_future_extensions() returns text
  language sql as $body$ select 'future'::text; $body$;
reset role;
set role supabase_storage_admin;
create function storage.ovd558_future_storage() returns text
  language sql as $body$ select 'future'::text; $body$;
reset role;
insert into storage.buckets (id, name, public) values ('ovd558-proof', 'ovd558-proof', false);
insert into storage.objects (bucket_id, name) values
  ('ovd558-proof', 'registered-result'), ('ovd558-proof', 'unregistered-result');
do $future$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname like 'ovd558_future_%' and n.nspname in ('public','engineering_private','storage')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'ovd558_future_target_public_execute';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname like 'ovd558_future_%' and n.nspname in ('private','extensions')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) <> 2 then
    raise exception 'ovd558_future_nonverifier_default_drift';
  end if;
end $future$;
set role engineering_native_verifier;
set request.jwt.claim.role = 'engineering_native_verifier';
do $checks$ declare found_count integer;
begin
  begin
    perform public.api_load_native_verification('00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid);
    raise exception 'ovd558_load_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  begin
    perform public.api_complete_native_verification('00000000-0000-0000-0000-000000000002'::uuid, 'proof');
    raise exception 'ovd558_complete_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  begin
    perform public.api_reject_native_verification('00000000-0000-0000-0000-000000000002'::uuid, '{}'::jsonb);
    raise exception 'ovd558_reject_unexpected_success';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ovd510_proof_only' then raise; end if;
  end;
  if not engineering_private.native_verifier_can_read_object('ovd558-proof','registered-result')
     or engineering_private.native_verifier_can_read_object('ovd558-proof','unregistered-result') then
    raise exception 'ovd558_registry_helper_mismatch';
  end if;
  select count(*) into found_count from storage.objects where bucket_id = 'ovd558-proof';
  if found_count <> 1 then raise exception 'ovd558_storage_registered_read_mismatch:%', found_count; end if;
  begin perform public.api_admin_list_all_jobs();
    raise exception 'ovd558_public_helper_callable';
  exception when insufficient_privilege then null; end;
  begin perform public.ovd558_unlisted_plain();
    raise exception 'ovd558_unlisted_plain_callable';
  exception when insufficient_privilege then null; end;
  begin perform public.ovd558_unlisted_definer();
    raise exception 'ovd558_unlisted_definer_callable';
  exception when insufficient_privilege then null; end;
  begin perform engineering_private.engineering_access(null::uuid,null::uuid);
    raise exception 'ovd558_private_helper_callable';
  exception when insufficient_privilege then null; end;
  begin perform engineering_private.preserve_native_execution_identity();
    raise exception 'ovd558_trigger_helper_callable';
  exception when insufficient_privilege then null; end;
  begin perform storage.get_level('foo'::text);
    raise exception 'ovd558_storage_helper_callable';
  exception when insufficient_privilege then null; end;
  begin perform public.ovd558_future_public();
    raise exception 'ovd558_future_public_callable';
  exception when insufficient_privilege then null; end;
  begin perform engineering_private.ovd558_future_private();
    raise exception 'ovd558_future_private_callable';
  exception when insufficient_privilege then null; end;
  begin perform storage.ovd558_future_storage();
    raise exception 'ovd558_future_storage_callable';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects (bucket_id,name) values ('ovd558-proof','illegal-insert');
    raise exception 'ovd558_storage_insert_succeeded';
  exception when insufficient_privilege then null; end;
  begin update storage.objects set name = 'illegal-update' where bucket_id = 'ovd558-proof';
    raise exception 'ovd558_storage_update_succeeded';
  exception when insufficient_privilege then null; end;
  begin delete from storage.objects where bucket_id = 'ovd558-proof';
    raise exception 'ovd558_storage_delete_succeeded';
  exception when insufficient_privilege then null; end;
end $checks$;
reset role;
rollback;`;
