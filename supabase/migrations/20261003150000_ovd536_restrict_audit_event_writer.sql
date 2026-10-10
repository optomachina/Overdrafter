-- OVD-536: public.log_audit_event is a SECURITY DEFINER writer that inserts
-- caller-supplied audit rows with no caller guard. It is an internal helper,
-- not a client RPC. Remove the inherited PUBLIC default and the explicit Data
-- API client grants so anonymous and signed-in callers cannot forge audit
-- history.
--
-- Legitimate callers keep working:
-- * Every SQL caller is a SECURITY DEFINER function (api_* RPCs and
--   private.request_scoped_automatic_quote_impl). They execute the helper as
--   their owner, which keeps implicit EXECUTE regardless of these grants.
-- * The job-archive-fallback Edge Function calls the helper directly over
--   SUPABASE_DB_URL without JWT claims. RLS on public.jobs denies that path to
--   every role that cannot bypass RLS, so only the table owner, a superuser,
--   or a BYPASSRLS role (postgres, service_role) can complete it today.
--   service_role keeps an explicit grant; it already has direct INSERT on
--   public.audit_events, so the grant adds no capability. The guard aborts
--   this change if any RLS-bypassing role that can delete jobs would lose
--   EXECUTE.
--
-- The privilege change and its guard are one DO statement, so a guard failure
-- rolls back the REVOKE/GRANT under any runner, with or without an enclosing
-- transaction (for example psql ON_ERROR_STOP replay of this file).
--
-- Rollback (re-opens the forgeable writer; emergency use only):
--   grant execute on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
--     to public, anon, authenticated;
-- Prefer forward recovery: grant EXECUTE to the exact qualified internal role
-- that failed instead of restoring PUBLIC, anon, or authenticated access.

do $ovd536_guard$
declare
  v_function constant regprocedure :=
    'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::regprocedure;
  v_owner oid;
  v_stranded text;
begin
  revoke all on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
    from public, anon, authenticated;
  grant execute on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
    to service_role;

  select procedure_row.proowner
  into v_owner
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid = v_function;

  if exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = v_function
      and grant_row.grantee = 0
      and grant_row.privilege_type = 'EXECUTE'
  ) then
    raise exception 'ovd536: PUBLIC still has EXECUTE on %', v_function;
  end if;

  if pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE') then
    raise exception 'ovd536: a Data API client role still has EXECUTE on %', v_function;
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
    or not pg_catalog.has_function_privilege(v_owner, v_function, 'EXECUTE') then
    raise exception 'ovd536: the owner or service_role lost EXECUTE on %', v_function;
  end if;

  select string_agg(role_row.rolname, ', ' order by role_row.rolname)
  into v_stranded
  from pg_catalog.pg_roles role_row
  where (
      role_row.rolsuper
      or role_row.rolbypassrls
      or role_row.oid = (
        select class_row.relowner
        from pg_catalog.pg_class class_row
        where class_row.oid = 'public.jobs'::regclass
      )
    )
    and pg_catalog.has_table_privilege(role_row.oid, 'public.jobs', 'DELETE')
    and not pg_catalog.has_function_privilege(role_row.oid, v_function, 'EXECUTE');

  if v_stranded is not null then
    raise exception 'ovd536: archive-capable roles would lose EXECUTE on %: %',
      v_function, v_stranded;
  end if;
end;
$ovd536_guard$;
