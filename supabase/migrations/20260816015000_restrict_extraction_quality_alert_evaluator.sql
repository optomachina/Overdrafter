-- OVD-372: safely supersede the deferred extraction-quality migration during
-- a production-first replay. The historical migration creates a SECURITY
-- DEFINER evaluator with PostgreSQL's default PUBLIC execution grant. Because
-- migration files commit independently, production must reconcile that old
-- version as applied and let this forward migration create the same deferred
-- foundation with its final fail-closed privileges.

create table if not exists public.extraction_quality_alerts (
  id               uuid         primary key default pg_catalog.gen_random_uuid(),
  organization_id  uuid         not null references public.organizations(id) on delete cascade,
  alert_day        date         not null,
  alert_type       text         not null,
  metric_value     numeric(7,4) not null,
  threshold_value  numeric(7,4) not null,
  created_at       timestamptz  not null default pg_catalog.timezone('utc', pg_catalog.now()),
  unique (organization_id, alert_day, alert_type)
);

alter table public.extraction_quality_alerts enable row level security;

drop policy if exists "extraction_quality_alerts_internal_select"
on public.extraction_quality_alerts;
create policy "extraction_quality_alerts_internal_select"
on public.extraction_quality_alerts
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "extraction_quality_alerts_manage_internal"
on public.extraction_quality_alerts;

revoke all on table public.extraction_quality_alerts
from public, anon, authenticated;
grant select on table public.extraction_quality_alerts to authenticated;

create or replace function public.evaluate_extraction_quality_alerts(
  p_day date default (current_date - 1)
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count integer := 0;
  v_inserted integer;
begin
  insert into public.extraction_quality_alerts (
    organization_id,
    alert_day,
    alert_type,
    metric_value,
    threshold_value
  )
  select
    summary.organization_id,
    summary.day,
    'model_fallback_rate_high',
    summary.model_fallback_rate,
    0.3000
  from public.extraction_quality_summary summary
  where summary.day = p_day
    and summary.completed_extractions > 0
    and summary.model_fallback_rate > 0.3000
  on conflict (organization_id, alert_day, alert_type) do nothing;

  get diagnostics v_inserted = row_count;
  v_count := v_count + v_inserted;

  insert into public.extraction_quality_alerts (
    organization_id,
    alert_day,
    alert_type,
    metric_value,
    threshold_value
  )
  select
    summary.organization_id,
    summary.day,
    'auto_approve_rate_low',
    summary.auto_approve_rate,
    0.7000
  from public.extraction_quality_summary summary
  where summary.day = p_day
    and summary.completed_extractions > 0
    and summary.auto_approve_rate < 0.7000
  on conflict (organization_id, alert_day, alert_type) do nothing;

  get diagnostics v_inserted = row_count;
  v_count := v_count + v_inserted;

  return v_count;
end;
$$;

revoke all on function public.evaluate_extraction_quality_alerts(date)
from public, anon, authenticated;

grant execute on function public.evaluate_extraction_quality_alerts(date)
to service_role;
