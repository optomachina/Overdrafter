-- CALIBRATE: thresholds below are starting values, not calibrated.
-- After 14 full UTC days of production data, review extraction_quality_summary
-- and revise thresholds before treating alerts as P1.

create table if not exists public.extraction_quality_alerts (
  id               uuid         primary key default gen_random_uuid(),
  organization_id  uuid         not null references public.organizations(id) on delete cascade,
  alert_day        date         not null,
  alert_type       text         not null,
  metric_value     numeric(7,4) not null,
  threshold_value  numeric(7,4) not null,
  created_at       timestamptz  not null default timezone('utc', now()),
  unique (organization_id, alert_day, alert_type)
);

alter table public.extraction_quality_alerts enable row level security;

drop policy if exists "extraction_quality_alerts_internal_select" on public.extraction_quality_alerts;
create policy "extraction_quality_alerts_internal_select"
on public.extraction_quality_alerts
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "extraction_quality_alerts_manage_internal" on public.extraction_quality_alerts;
create policy "extraction_quality_alerts_manage_internal"
on public.extraction_quality_alerts
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

grant select on public.extraction_quality_alerts to authenticated;

create or replace function public.evaluate_extraction_quality_alerts(
  p_day date default (current_date - 1)
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count    integer := 0;
  v_inserted integer;
begin
  -- Alert on high model fallback rate (threshold: 0.3000, CALIBRATE after 14 days production data)
  insert into public.extraction_quality_alerts
    (organization_id, alert_day, alert_type, metric_value, threshold_value)
  select
    organization_id,
    day,
    'model_fallback_rate_high',
    model_fallback_rate,
    0.3000
  from public.extraction_quality_summary
  where day = p_day
    and completed_extractions > 0
    and model_fallback_rate > 0.3000
  on conflict (organization_id, alert_day, alert_type) do nothing;

  get diagnostics v_inserted = row_count;
  v_count := v_count + v_inserted;

  -- Alert on low auto-approve rate (threshold: 0.7000, CALIBRATE after 14 days production data)
  insert into public.extraction_quality_alerts
    (organization_id, alert_day, alert_type, metric_value, threshold_value)
  select
    organization_id,
    day,
    'auto_approve_rate_low',
    auto_approve_rate,
    0.7000
  from public.extraction_quality_summary
  where day = p_day
    and completed_extractions > 0
    and auto_approve_rate < 0.7000
  on conflict (organization_id, alert_day, alert_type) do nothing;

  get diagnostics v_inserted = row_count;
  v_count := v_count + v_inserted;

  return v_count;
end;
$$;
