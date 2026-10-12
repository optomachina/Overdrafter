-- OVD-722 rollback, runnable form. Window 1 packet, not a migration.
--
-- Source: the commented ROLLBACK section of docs/migration-drafts/ovd-722.sql
-- at 8302da984036352ad21b9ce86827682f275657a5, from "-- begin;" through "-- commit;" with the leading "-- "
-- removed and nothing else changed. scripts/window-1/rehearse.mjs refuses to
-- run if the body below the marker drifts from that section.
--
-- Order: roll back strictly in reverse order of apply (recommended order is
-- 462, 723, 722, so this runs first). The draft's own guard refuses while a
-- switch is engaged or when the role cannot bypass RLS.
-- Roll the worker back to a build without OVD-722 first (the worker fails
-- closed while api_worker_provider_kill_switch_state is missing).
-- The last block drops private.provider_kill_switch_audit. Export it first, or
-- delete that block to keep the audit trail.
--
-- Apply: psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f docs/release/window-1/rollback/ovd-722.rollback.sql
-- ---- body (derived, do not edit) ----
begin;

do $$
declare
  v_dependents text;
begin
  if pg_catalog.to_regclass('private.provider_kill_switches') is not null then
    if not exists (select 1 from pg_catalog.pg_roles r
                   where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
      raise exception 'OVD-722 rollback refused: the running role must bypass RLS to see engagements'
        using errcode = 'P0001';
    end if;
    lock table private.provider_global_kill_switch, private.provider_kill_switches in access exclusive mode;
    if coalesce(pg_catalog.current_setting('ovd722.rollback_discard_engagements', true), '') <> 'confirmed'
       and (exists (select 1 from private.provider_global_kill_switch where engaged)
            or exists (select 1 from private.provider_kill_switches where engaged)) then
      raise exception 'OVD-722 rollback refused: a provider kill switch is engaged'
        using errcode = 'P0001',
              hint = 'Record the engagements, or set local ovd722.rollback_discard_engagements = ''confirmed''.';
    end if;
  end if;
  select pg_catalog.string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
  into v_dependents
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where (p.prosrc like '%provider\_kill\_switch%' or p.prosrc like '%provider\_global\_kill\_switch%')
    and (n.nspname, p.proname) not in (
      ('private', 'provider_kill_switch_engaged'), ('private', 'provider_kill_switch_engaged_text'),
      ('private', 'provider_kill_switch_audit_immutable'), ('private', 'provider_kill_switch_permit_guard'),
      ('public', 'api_worker_provider_kill_switch_state'), ('public', 'api_admin_set_provider_kill_switch'),
      ('public', 'api_admin_set_global_kill_switch'), ('public', 'api_admin_list_provider_kill_switches'),
      ('public', 'api_worker_cancel_provider_disabled_tasks'));
  if v_dependents is not null then
    raise exception 'OVD-722 rollback refused: other functions depend on the kill switch (%); roll that migration back first', v_dependents
      using errcode = 'P0001';
  end if;
end
$$;

drop trigger provider_kill_switch_permit_guard on private.xometry_beta_dispatch_permits;
drop trigger provider_kill_switch_permit_guard on private.provider_dispatch_permits;
drop function private.provider_kill_switch_permit_guard();

drop function public.api_worker_cancel_provider_disabled_tasks();
drop function public.api_admin_list_provider_kill_switches();
drop function public.api_admin_set_global_kill_switch(boolean, text, bigint);
drop function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint);
drop function public.api_worker_provider_kill_switch_state(public.vendor_name);
drop function private.provider_kill_switch_engaged_text(text);
drop function private.provider_kill_switch_engaged(public.vendor_name);
drop table private.provider_global_kill_switch;
drop table private.provider_kill_switches;
-- Evidence: export first, or omit the next four statements to keep the audit trail.
drop trigger provider_kill_switch_audit_no_truncate on private.provider_kill_switch_audit;
drop trigger provider_kill_switch_audit_no_update_delete on private.provider_kill_switch_audit;
drop table private.provider_kill_switch_audit;
drop function private.provider_kill_switch_audit_immutable();

commit;
