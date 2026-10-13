-- Multi provider fan out guards: DRAFT ONLY. Not a migration.
--
-- Do not copy into supabase/migrations/ or apply to any hosted project without
-- its own migration window review and Blaine's approval.
--
-- The client calls public.api_get_provider_fanout_guards(p_job_id) when
-- VITE_MULTI_PROVIDER_FANOUT=true (src/features/quotes/api/quote-requests-api.ts).
-- Until this function exists the call fails and the client sends to the
-- primary provider only, which is today's behavior.
--
-- Dependencies that are not on main yet:
--   OVD-722 (PR #676): private.provider_kill_switches. Assumed shape
--     (provider public.vendor_name primary key, disabled boolean not null).
--     Rebind the kill switch CTE to the merged shape before review.
--   OVD-723 (PR #677): a job level clean export declaration. Bound here through
--     private.job_export_declaration_is_clean(uuid), a name to replace with
--     #677's real predicate (clean declaration, no pending marking review,
--     clean scan of record for every file the part sends).
--
-- The daily count is per provider across all organizations, because the cap
-- (about 20 quotes per provider per day, docs/business/business-model.md)
-- protects OverDrafter's own provider account. Both permit paths count.
-- The worker execution seam remains the authority (provider_disabled,
-- export_control_blocked, provider_daily_cap_reached); this RPC only lets the
-- customer see a skip before confirming.

create or replace function public.api_get_provider_fanout_guards(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_day_start timestamptz := pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC';
begin
  select job.* into v_job from public.jobs job where job.id = p_job_id;
  if v_job.id is null or not public.user_can_access_job(p_job_id) then
    raise exception 'provider_fanout_job_unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'killSwitchedProviders', coalesce((
      select pg_catalog.jsonb_agg(switch.provider::text order by switch.provider::text)
      from private.provider_kill_switches switch
      where switch.disabled
    ), '[]'::jsonb),
    'exportDeclaration', case
      when private.job_export_declaration_is_clean(p_job_id) then 'clean'
      else 'not_clean'
    end,
    'dailyQuoteCounts', coalesce((
      select pg_catalog.jsonb_object_agg(counts.provider, counts.total)
      from (
        select permit.provider::text as provider, pg_catalog.count(*)::integer as total
        from private.provider_dispatch_permits permit
        where permit.issued_at >= v_day_start
        group by permit.provider
        union all
        select 'xometry', pg_catalog.count(*)::integer
        from private.xometry_beta_dispatch_permits permit
        where permit.created_at >= v_day_start
      ) counts
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.api_get_provider_fanout_guards(uuid) from public, anon, service_role;
grant execute on function public.api_get_provider_fanout_guards(uuid) to authenticated;
