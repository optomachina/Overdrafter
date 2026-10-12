-- OVD-722 rollback, runnable form. Window 1 packet, not a migration.
--
-- Source: the commented ROLLBACK section of docs/migration-drafts/ovd-722.sql
-- at b623890a4499eea412dbbbf5b5ac616cb8df301b, from "-- begin;" through "-- commit;" with the leading "-- "
-- removed and nothing else changed. scripts/window-1/rehearse.mjs refuses to
-- run if the body below the marker drifts from that section.
--
-- Order: roll back strictly in reverse order of apply (recommended order is
-- 462, 723, 722, so this runs first). It drops the public dispatch RPC names and
-- restores whatever is preserved under private.*_pre_ovd722; run while OVD-723
-- wraps those names (722 applied first), it would delete the export gate silently.
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
  v_generic text;
  v_xometry text;
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
  select p.prosrc into v_generic from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.api_authorize_provider_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)');
  select p.prosrc into v_xometry from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)');
  if pg_catalog.to_regprocedure('private.api_authorize_provider_worker_dispatch_pre_ovd722(uuid,uuid,jsonb,text,timestamptz)') is null
     or pg_catalog.to_regprocedure('private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid,uuid,jsonb,text,timestamptz)') is null
     or coalesce(pg_catalog.strpos(v_generic, 'private.api_authorize_provider_worker_dispatch_pre_ovd722('), 0) = 0
     or coalesce(pg_catalog.strpos(v_xometry, 'private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722('), 0) = 0 then
    raise exception 'OVD-722 rollback refused: the public preflights are not the OVD-722 wrappers; roll back the later migration first'
      using errcode = 'P0001';
  end if;
end
$$;

drop trigger provider_kill_switch_permit_guard on private.xometry_beta_dispatch_permits;
drop trigger provider_kill_switch_permit_guard on private.provider_dispatch_permits;
drop function private.provider_kill_switch_permit_guard();

drop function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
alter function public.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_xometry_beta_worker_dispatch;
revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

drop function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
alter function private.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema public;
alter function public.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_provider_worker_dispatch;
revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

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
