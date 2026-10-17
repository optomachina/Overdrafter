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
-- The daily cap is optional and per supplier: there is no default cap
-- (docs/business/business-model.md). A provider is reported at cap only when an
-- admin set a positive private.provider_kill_switches.daily_quote_cap
-- (OVD-829, docs/migration-drafts/ovd-828-s1.sql); a null cap never appears.
-- It protects OverDrafter's own provider account, so it counts permits across
-- all organizations. The function returns only which providers are at that
-- cap, never the counts themselves. Both permit paths count. Rebind the count
-- to private.provider_daily_quote_usage before review.
--
-- quoteRequestBudget mirrors the per user guardrail that
-- private.request_scoped_automatic_quote_impl enforces on every provider
-- request (20260812044000): userMaxRequestsPerWindow requests per user per
-- userWindowMinutes (default 5 per 60), and the org pending cost ceiling
-- (default $500 at $75 per requested lane). It is null when the org has the
-- guardrail off. The numbers are the caller's own and their org's own.
--
-- The worker execution seam remains the authority (provider_disabled,
-- export_control_blocked, provider_daily_cap_reached), as does the admission
-- guardrail; this RPC only lets the customer see a skip before confirming.

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
  v_guardrails jsonb;
  v_window_minutes integer;
  v_max_requests integer;
  v_ceiling numeric(12, 2);
  v_lane_cost numeric(12, 2);
  v_user_requests integer;
  v_budget jsonb := null;
begin
  select job.* into v_job from public.jobs job where job.id = p_job_id;
  if v_job.id is null or not public.user_can_access_job(p_job_id) then
    raise exception 'provider_fanout_job_unavailable';
  end if;

  v_guardrails := public.get_quote_request_guardrails(v_job.organization_id);
  if coalesce((v_guardrails ->> 'enabled')::boolean, true) then
    v_window_minutes := coalesce((v_guardrails ->> 'userWindowMinutes')::integer, 60);
    v_max_requests := coalesce((v_guardrails ->> 'userMaxRequestsPerWindow')::integer, 5);
    v_ceiling := coalesce((v_guardrails ->> 'orgPendingCostCeilingUsd')::numeric(12, 2), 500.00);
    v_lane_cost := coalesce((v_guardrails ->> 'defaultCostPerRequestedLaneUsd')::numeric(12, 2), 75.00);

    select pg_catalog.count(*)::integer into v_user_requests
    from public.quote_requests request_row
    where request_row.organization_id = v_job.organization_id
      and request_row.requested_by = auth.uid()
      and request_row.created_at >= pg_catalog.timezone('utc', pg_catalog.now())
        - pg_catalog.make_interval(mins => v_window_minutes);

    v_budget := pg_catalog.jsonb_build_object(
      'userWindowMinutes', v_window_minutes,
      'userMaxRequestsPerWindow', v_max_requests,
      'userRequestsRemaining', greatest(v_max_requests - v_user_requests, 0),
      'orgPendingCostCeilingUsd', v_ceiling,
      'costPerLaneUsd', v_lane_cost,
      'orgPendingCostHeadroomUsd', greatest(
        v_ceiling - public.get_quote_request_pending_estimated_cost_usd(v_job.organization_id),
        0
      )
    );
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
    'providersAtDailyCap', coalesce((
      select pg_catalog.jsonb_agg(counts.provider order by counts.provider)
      from (
        select issued.provider, pg_catalog.sum(issued.total) as total
        from (
          select permit.provider::text as provider, pg_catalog.count(*) as total
          from private.provider_dispatch_permits permit
          where permit.issued_at >= v_day_start
          group by permit.provider
          union all
          select 'xometry', pg_catalog.count(*)
          from private.xometry_beta_dispatch_permits permit
          where permit.created_at >= v_day_start
        ) issued
        group by issued.provider
      ) counts
      join private.provider_kill_switches cap_row
        on cap_row.provider::text = counts.provider
      where cap_row.daily_quote_cap is not null
        and cap_row.daily_quote_cap > 0
        and counts.total >= cap_row.daily_quote_cap
    ), '[]'::jsonb),
    'quoteRequestBudget', coalesce(v_budget, 'null'::jsonb)
  );
end;
$$;

revoke all on function public.api_get_provider_fanout_guards(uuid) from public, anon;
grant execute on function public.api_get_provider_fanout_guards(uuid) to authenticated;
