-- OVD-538: this SECURITY DEFINER RPC returns platform-wide totals and a
-- per-organization breakdown. Internal membership in one organization must
-- not grant access to the other organizations' spend.
--
-- CREATE OR REPLACE preserves the existing authenticated EXECUTE grant. The
-- function itself continues to enforce the allowlisted platform-admin guard.
create or replace function public.api_spend_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz := date_trunc('day', timezone('utc', now()));
  v_global public.spend_caps%rowtype;
  v_total numeric(14, 6);
  v_by_category jsonb;
  v_by_org jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized';
  end if;

  select * into v_global from public.spend_caps where organization_id is null;

  select coalesce(sum(amount_usd), 0) into v_total
  from public.spend_ledger where occurred_at >= v_since;

  select coalesce(jsonb_object_agg(category, total), '{}'::jsonb) into v_by_category
  from (
    select category, sum(amount_usd) as total
    from public.spend_ledger
    where occurred_at >= v_since
    group by category
  ) grouped;

  select coalesce(jsonb_agg(row_to_json(ranked)), '[]'::jsonb) into v_by_org
  from (
    select
      l.organization_id as "organizationId",
      o.name as "organizationName",
      sum(l.amount_usd) as "spendUsd",
      c.daily_ceiling_usd as "dailyCeilingUsd"
    from public.spend_ledger l
    left join public.organizations o on o.id = l.organization_id
    left join public.spend_caps c on c.organization_id = l.organization_id
    where l.occurred_at >= v_since
    group by l.organization_id, o.name, c.daily_ceiling_usd
    order by sum(l.amount_usd) desc
    limit 50
  ) ranked;

  return jsonb_build_object(
    'since', v_since,
    'totalSpendUsd', v_total,
    'globalDailyCeilingUsd', coalesce(v_global.daily_ceiling_usd, public.spend_default_daily_ceiling_usd()),
    'perRunCeilingUsd', coalesce(v_global.per_run_ceiling_usd, public.spend_default_per_run_ceiling_usd()),
    'killSwitch', coalesce(v_global.kill_switch, false),
    'byCategory', v_by_category,
    'byOrganization', v_by_org
  );
end;
$$;
