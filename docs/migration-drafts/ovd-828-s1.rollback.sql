-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-828 S1 (OVD-829) ROLLBACK for docs/migration-drafts/ovd-828-s1.sql.
--
-- Run as one transaction, only in a Blaine-approved window:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Order: roll the worker back to a build without OVD-829 FIRST. That worker
-- reserves every dispatch through api_worker_reserve_provider_dispatch and
-- refuses every live dispatch (provider_dispatch_counter_unavailable) once the
-- function is gone. The pre-OVD-829 worker keeps only RMFG's in-process cap.
--
-- Restores, byte for byte, the bodies, signatures and grants of
-- api_admin_set_provider_kill_switch and api_admin_list_provider_kill_switches
-- from supabase/migrations/20261013043100_ovd722_provider_kill_switch.sql.
-- If ovd-766-a.sql was applied AFTER that migration and BEFORE ovd-828-s1,
-- re-run ovd-766-a.sql's api_admin_set_provider_kill_switch section after this
-- rollback so the AAL2 guard it added is not lost.
--
-- Evidence: the cap columns on private.provider_kill_switch_audit and the
-- private.provider_daily_quote_usage rows are dropped. Export both first, or
-- leave the two marked statements out to keep them.
-- =====================================================================

-- Settings writers and worker RPCs added by this draft.
drop function if exists public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint);
drop function if exists public.api_worker_reserve_provider_dispatch(public.vendor_name);
drop function if exists public.api_worker_provider_settings_state(public.vendor_name);

-- Prior definition (20261013043100_ovd722_provider_kill_switch.sql), restored exactly.
create or replace function public.api_admin_set_provider_kill_switch(
  p_provider public.vendor_name,
  p_engaged boolean,
  p_reason text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  -- A missing row reads as engaged (fail closed). Materialize it that way so
  -- there is always a row to lock; a concurrent flip cannot slip in unlocked.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  -- Take the row lock first; the version check and timestamp are read after it.
  select s.version into strict v_current_version
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  if not p_engaged
    and (p_expected_version is null or p_expected_version <> v_current_version) then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              coalesce(p_expected_version::text, 'none'), v_current_version);
  end if;

  -- Captured after the lock wait so the recorded time orders with the commit.
  v_at := pg_catalog.clock_timestamp();

  update private.provider_kill_switches s
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = v_actor,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, p_provider, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  to authenticated;

-- The shared writer is unused once the kill-switch RPC no longer calls it.
drop function if exists private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint);

-- Prior definition (20261013043100_ovd722_provider_kill_switch.sql), restored exactly.
create or replace function public.api_admin_list_provider_kill_switches()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-kill-switch-admin.v1',
    'global', (
      select pg_catalog.jsonb_build_object(
        'engaged', g.engaged, 'reason', g.reason,
        'changedBy', g.engaged_by, 'changedAt', g.engaged_at, 'version', g.version)
      from private.provider_global_kill_switch g where g.singleton
    ),
    'providers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', s.provider, 'engaged', s.engaged, 'reason', s.reason,
        'changedBy', s.engaged_by, 'changedAt', s.engaged_at, 'version', s.version) order by s.provider::text)
      from private.provider_kill_switches s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.api_admin_list_provider_kill_switches()
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_provider_kill_switches()
  to authenticated;

-- Evidence: export first, or omit to keep the daily usage history.
drop table if exists private.provider_daily_quote_usage;

-- Evidence: export first, or omit to keep the cap history on audit rows.
-- DROP COLUMN fires no row trigger, so the append-only triggers do not block it.
alter table private.provider_kill_switch_audit
  drop column if exists previous_daily_quote_cap,
  drop column if exists daily_quote_cap;

alter table private.provider_kill_switches
  drop constraint if exists provider_kill_switches_daily_quote_cap_check;
alter table private.provider_kill_switches
  drop column if exists daily_quote_cap;
