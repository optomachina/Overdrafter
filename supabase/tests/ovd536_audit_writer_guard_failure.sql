begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

-- Failure path of the OVD-536 guard. Everything here, including the synthetic
-- role, is rolled back. The replayed statement below must stay byte-identical
-- to the migration's DO block; scripts/ovd536-audit-writer-guard.test.mjs
-- enforces that.
create temporary table ovd536_guard_replay on commit drop as
select $ovd536_replay$
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
$ovd536_guard$
$ovd536_replay$::text as statement,
  'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::text as writer_signature,
  'ovd536_stranded_probe'::text as probe_role;

-- Restore the pre-migration grants and add an RLS-bypassing role that can
-- delete jobs but executes the writer only through PUBLIC.
grant execute on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
  to public, anon, authenticated;
create role ovd536_stranded_probe nologin bypassrls;
grant delete on table public.jobs to ovd536_stranded_probe;

create temporary table ovd536_acl_before on commit drop as
select procedure_row.proacl::text as acl
from pg_catalog.pg_proc procedure_row, pg_temp.ovd536_guard_replay r
where procedure_row.oid = to_regprocedure(r.writer_signature);

select ok(pg_catalog.has_function_privilege(r.probe_role::name, r.writer_signature, 'EXECUTE'),
  'the synthetic archive-capable role can execute the writer before the change')
from pg_temp.ovd536_guard_replay r;
select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) grant_row
    where procedure_row.oid = to_regprocedure(r.writer_signature)
      and grant_row.grantee = r.probe_role::regrole
  ), 'the synthetic role relies only on PUBLIC EXECUTE')
from pg_temp.ovd536_guard_replay r;

select throws_ok(r.statement, 'P0001',
  'ovd536: archive-capable roles would lose EXECUTE on log_audit_event(uuid,text,jsonb,uuid,uuid): ovd536_stranded_probe',
  'the guard aborts when an archive-capable role would lose EXECUTE')
from pg_temp.ovd536_guard_replay r;

select is((select procedure_row.proacl::text
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = to_regprocedure(r.writer_signature)),
  (select acl from pg_temp.ovd536_acl_before),
  'the aborted change leaves the original ACL byte-identical')
from pg_temp.ovd536_guard_replay r;
select ok(pg_catalog.has_function_privilege('anon', r.writer_signature, 'EXECUTE'),
  'the aborted revoke did not commit for anonymous callers')
from pg_temp.ovd536_guard_replay r;
select ok(pg_catalog.has_function_privilege('authenticated', r.writer_signature, 'EXECUTE'),
  'the aborted revoke did not commit for signed-in callers')
from pg_temp.ovd536_guard_replay r;
select ok(pg_catalog.has_function_privilege(r.probe_role::name, r.writer_signature, 'EXECUTE'),
  'the archive-capable role keeps EXECUTE after the abort')
from pg_temp.ovd536_guard_replay r;

-- With an explicit grant for that role, the same statement applies cleanly.
grant execute on function public.log_audit_event(uuid, text, jsonb, uuid, uuid)
  to ovd536_stranded_probe;

select lives_ok(r.statement, 'the guarded change applies once every archive-capable role is granted')
from pg_temp.ovd536_guard_replay r;
select ok(not pg_catalog.has_function_privilege('anon', r.writer_signature, 'EXECUTE'),
  'the applied change denies anonymous callers')
from pg_temp.ovd536_guard_replay r;
select ok(not pg_catalog.has_function_privilege('authenticated', r.writer_signature, 'EXECUTE'),
  'the applied change denies signed-in callers')
from pg_temp.ovd536_guard_replay r;
select ok(pg_catalog.has_function_privilege(r.probe_role::name, r.writer_signature, 'EXECUTE'),
  'the explicitly granted archive-capable role keeps EXECUTE')
from pg_temp.ovd536_guard_replay r;
select ok(pg_catalog.has_function_privilege('service_role', r.writer_signature, 'EXECUTE'),
  'service callers keep EXECUTE after the applied change')
from pg_temp.ovd536_guard_replay r;

select * from finish();
rollback;
