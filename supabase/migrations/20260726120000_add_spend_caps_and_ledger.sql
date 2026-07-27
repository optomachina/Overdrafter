-- Cumulative spend caps over money the application actually spends.
--
-- `quote_request_guardrails.org_pending_cost_ceiling_usd` already exists, but it
-- is not a budget: it gates *in-flight* notional cost, so once lanes settle the
-- pending total returns to zero and spending can resume immediately. It is a
-- concurrency limit denominated in dollars. It also guards only
-- `api_request_quote` -- internal kickoff, debug reruns, the extraction lab, and
-- retries all bypass it -- and it cannot see model spend at all.
--
-- This adds a rolling daily ceiling over real spend, enforced where spending
-- happens rather than where it is requested, and a kill switch.
--
-- Scope note: an application-level cap cannot see infrastructure billing
-- (Supabase egress, Vercel bandwidth, Cloud Run compute). Provider-side hard
-- billing limits remain the actual guarantee against a runaway bill; this layer
-- exists for graceful degradation, attribution, and per-org control.

create table if not exists public.spend_caps (
  id uuid primary key default gen_random_uuid(),
  -- NULL identifies the single global row that bounds every organization
  -- together. Per-org rows bound one organization on top of that.
  organization_id uuid references public.organizations(id) on delete cascade,
  daily_ceiling_usd numeric(12, 4) not null,
  per_run_ceiling_usd numeric(12, 4) not null default 0.50,
  -- Operator stop. Refuses all new spend in scope without touching ceilings.
  kill_switch boolean not null default false,
  enabled boolean not null default true,
  notes text,
  -- Who last changed the ceiling. `audit_events.organization_id` is NOT NULL,
  -- so a platform-wide change has no home there; the trail lives on the row.
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint spend_caps_daily_ceiling_check check (daily_ceiling_usd >= 0),
  constraint spend_caps_per_run_ceiling_check check (per_run_ceiling_usd >= 0)
);

-- Exactly one global row; at most one row per organization.
create unique index if not exists spend_caps_global_unique
  on public.spend_caps ((organization_id is null))
  where organization_id is null;

create unique index if not exists spend_caps_org_unique
  on public.spend_caps (organization_id)
  where organization_id is not null;

-- Append-only record of spend as it is incurred.
--
-- Rows are written before the spend happens (as a reservation carrying an
-- estimate) and updated afterwards with the observed amount. Reserving first is
-- what makes concurrent callers safe: a request that would breach the ceiling is
-- refused even if every other in-flight request is still mid-call.
create table if not exists public.spend_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  category text not null,
  amount_usd numeric(14, 6) not null default 0,
  settled boolean not null default false,
  occurred_at timestamptz not null default timezone('utc', now()),
  settled_at timestamptz,
  job_id uuid,
  part_id uuid,
  quote_run_id uuid,
  task_id uuid,
  provider text,
  model_name text,
  metadata jsonb not null default '{}'::jsonb,
  constraint spend_ledger_category_check
    check (category in ('llm_extraction', 'vendor_automation')),
  constraint spend_ledger_amount_check check (amount_usd >= 0)
);

create index if not exists spend_ledger_window_idx
  on public.spend_ledger (occurred_at desc);

create index if not exists spend_ledger_org_window_idx
  on public.spend_ledger (organization_id, occurred_at desc);

create index if not exists spend_ledger_category_window_idx
  on public.spend_ledger (category, occurred_at desc);

alter table public.spend_caps enable row level security;
alter table public.spend_ledger enable row level security;

drop policy if exists "spend_caps_read" on public.spend_caps;
create policy "spend_caps_read"
on public.spend_caps
for select
to authenticated
using (
  public.is_platform_admin()
  or (organization_id is not null and public.is_internal_user(organization_id))
);

drop policy if exists "spend_ledger_read" on public.spend_ledger;
create policy "spend_ledger_read"
on public.spend_ledger
for select
to authenticated
using (
  public.is_platform_admin()
  or (organization_id is not null and public.is_internal_user(organization_id))
);

drop trigger if exists touch_spend_caps_updated_at on public.spend_caps;
create trigger touch_spend_caps_updated_at
before update on public.spend_caps
for each row execute function public.touch_updated_at();

grant select on public.spend_caps to authenticated;
grant select on public.spend_ledger to authenticated;

-- Conservative built-in ceilings, used when no configuration row exists.
--
-- A missing row must never mean "unlimited". Deleting configuration is exactly
-- the circumstance in which an unbounded spend path is least acceptable, so the
-- absent case falls back to these rather than opening up.
create or replace function public.spend_default_daily_ceiling_usd()
returns numeric
language sql
immutable
as $$ select 50.00::numeric $$;

create or replace function public.spend_default_per_run_ceiling_usd()
returns numeric
language sql
immutable
as $$ select 0.50::numeric $$;

insert into public.spend_caps (organization_id, daily_ceiling_usd, per_run_ceiling_usd, notes)
select null, 50.00, 0.50, 'Default global ceiling seeded by migration. Tune from observed spend.'
where not exists (select 1 from public.spend_caps where organization_id is null);

/**
 * Reserves budget for one unit of spend, or refuses it.
 *
 * Returns { allowed, reservationId, reasonCode, ... }. The caller must treat a
 * refusal as final and must settle any reservation it is granted.
 */
create or replace function public.api_reserve_spend(
  p_organization_id uuid,
  p_category text,
  p_estimated_usd numeric,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_global public.spend_caps%rowtype;
  v_org public.spend_caps%rowtype;
  v_window_start timestamptz := date_trunc('day', timezone('utc', now()));
  v_estimate numeric(14, 6) := greatest(coalesce(p_estimated_usd, 0), 0);
  v_global_ceiling numeric(12, 4);
  v_org_ceiling numeric(12, 4);
  v_per_run_ceiling numeric(12, 4);
  v_global_spend numeric(14, 6);
  v_org_spend numeric(14, 6);
  v_reservation_id uuid;
begin
  if p_category not in ('llm_extraction', 'vendor_automation') then
    raise exception 'Unsupported spend category: %', p_category;
  end if;

  -- Serialize reservations so two concurrent callers cannot both pass a check
  -- that only one of them actually fits under.
  perform pg_advisory_xact_lock(hashtext('overdrafter.spend_reservation'));

  select * into v_global from public.spend_caps where organization_id is null;
  select * into v_org from public.spend_caps where organization_id = p_organization_id;

  if coalesce(v_global.kill_switch, false) or coalesce(v_org.kill_switch, false) then
    return jsonb_build_object(
      'allowed', false,
      'reservationId', null,
      'reasonCode', 'kill_switch',
      'reason', 'Spending is halted by an operator kill switch.'
    );
  end if;

  v_global_ceiling := case
    when v_global.id is null or not coalesce(v_global.enabled, true)
      then public.spend_default_daily_ceiling_usd()
    else v_global.daily_ceiling_usd
  end;

  -- Gated on `enabled` to match the daily ceiling below. Without this, disabling
  -- an org's override row would still leave its stale per-run ceiling in force,
  -- which is the opposite of what disabling it means.
  v_per_run_ceiling := coalesce(
    case when coalesce(v_org.enabled, true) then v_org.per_run_ceiling_usd end,
    v_global.per_run_ceiling_usd,
    public.spend_default_per_run_ceiling_usd()
  );

  if v_per_run_ceiling > 0 and v_estimate > v_per_run_ceiling then
    return jsonb_build_object(
      'allowed', false,
      'reservationId', null,
      'reasonCode', 'per_run_ceiling',
      'reason', format('Estimated %s USD exceeds the per-run ceiling of %s USD.', v_estimate, v_per_run_ceiling),
      'perRunCeilingUsd', v_per_run_ceiling
    );
  end if;

  select coalesce(sum(amount_usd), 0)
  into v_global_spend
  from public.spend_ledger
  where occurred_at >= v_window_start;

  if v_global_spend + v_estimate > v_global_ceiling then
    return jsonb_build_object(
      'allowed', false,
      'reservationId', null,
      'reasonCode', 'global_daily_ceiling',
      'reason', 'The platform-wide daily spend ceiling has been reached.',
      'dailyCeilingUsd', v_global_ceiling,
      'dailySpendUsd', v_global_spend
    );
  end if;

  if p_organization_id is not null and v_org.id is not null and coalesce(v_org.enabled, true) then
    v_org_ceiling := v_org.daily_ceiling_usd;

    select coalesce(sum(amount_usd), 0)
    into v_org_spend
    from public.spend_ledger
    where organization_id = p_organization_id
      and occurred_at >= v_window_start;

    if v_org_spend + v_estimate > v_org_ceiling then
      return jsonb_build_object(
        'allowed', false,
        'reservationId', null,
        'reasonCode', 'org_daily_ceiling',
        'reason', 'This workspace has reached its daily spend ceiling.',
        'dailyCeilingUsd', v_org_ceiling,
        'dailySpendUsd', v_org_spend
      );
    end if;
  end if;

  insert into public.spend_ledger (
    organization_id, category, amount_usd, settled,
    job_id, part_id, quote_run_id, task_id, provider, model_name, metadata
  )
  values (
    p_organization_id,
    p_category,
    v_estimate,
    false,
    nullif(p_context ->> 'jobId', '')::uuid,
    nullif(p_context ->> 'partId', '')::uuid,
    nullif(p_context ->> 'quoteRunId', '')::uuid,
    nullif(p_context ->> 'taskId', '')::uuid,
    nullif(p_context ->> 'provider', ''),
    nullif(p_context ->> 'modelName', ''),
    coalesce(p_context, '{}'::jsonb)
  )
  returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed', true,
    'reservationId', v_reservation_id,
    'reasonCode', null,
    'dailyCeilingUsd', v_global_ceiling,
    'dailySpendUsd', v_global_spend + v_estimate
  );
end;
$$;

/**
 * Replaces a reservation's estimate with the amount actually spent.
 *
 * Settling to zero is the correct outcome for a call that failed before
 * incurring cost; the reservation must still be settled so the estimate does
 * not hold budget for the rest of the window.
 */
create or replace function public.api_settle_spend(
  p_reservation_id uuid,
  p_actual_usd numeric,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.spend_ledger%rowtype;
begin
  update public.spend_ledger
  set
    amount_usd = greatest(coalesce(p_actual_usd, 0), 0),
    settled = true,
    settled_at = timezone('utc', now()),
    metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where id = p_reservation_id
    and not settled
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('settled', false, 'reasonCode', 'unknown_or_already_settled');
  end if;

  return jsonb_build_object('settled', true, 'amountUsd', v_row.amount_usd);
end;
$$;

/** Rolling-window spend totals for the admin surface. */
/**
 * Spend totals for the admin surface.
 *
 * Measures the same UTC calendar day that `api_reserve_spend` enforces against.
 * A rolling window would disagree with the ceiling near midnight, so an operator
 * asking "why was this refused" would be reading a number that was never the one
 * doing the refusing.
 */
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
  if not public.is_platform_admin() and not public.is_internal_user_any_org() then
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

/** Platform-admin control over the global ceiling and kill switch. */
create or replace function public.api_set_global_spend_cap(
  p_daily_ceiling_usd numeric default null,
  p_per_run_ceiling_usd numeric default null,
  p_kill_switch boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.spend_caps%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorized';
  end if;

  -- Serialized against itself so a concurrent first-write cannot have both
  -- callers find no row and both attempt the insert.
  perform pg_advisory_xact_lock(hashtext('overdrafter.spend_cap_write'));

  update public.spend_caps
  set
    daily_ceiling_usd = coalesce(p_daily_ceiling_usd, daily_ceiling_usd),
    per_run_ceiling_usd = coalesce(p_per_run_ceiling_usd, per_run_ceiling_usd),
    kill_switch = coalesce(p_kill_switch, kill_switch),
    updated_by = auth.uid()
  where organization_id is null
  returning * into v_row;

  if v_row.id is null then
    insert into public.spend_caps (organization_id, daily_ceiling_usd, per_run_ceiling_usd, kill_switch, updated_by)
    values (
      null,
      coalesce(p_daily_ceiling_usd, public.spend_default_daily_ceiling_usd()),
      coalesce(p_per_run_ceiling_usd, public.spend_default_per_run_ceiling_usd()),
      coalesce(p_kill_switch, false),
      auth.uid()
    )
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'dailyCeilingUsd', v_row.daily_ceiling_usd,
    'perRunCeilingUsd', v_row.per_run_ceiling_usd,
    'killSwitch', v_row.kill_switch
  );
end;
$$;

-- Supabase grants EXECUTE on new public-schema functions to anon, authenticated
-- and service_role, so revoking from PUBLIC alone leaves client roles able to
-- call these. A client that could reach api_settle_spend could settle its own
-- reservations to zero and spend without bound, which would defeat the entire
-- mechanism. Only the worker's service_role retains access.
revoke all on function public.api_reserve_spend(uuid, text, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.api_settle_spend(uuid, numeric, jsonb) from public, anon, authenticated;

-- These two are client-callable by design and enforce authorization internally.
revoke all on function public.api_spend_summary() from public, anon;
revoke all on function public.api_set_global_spend_cap(numeric, numeric, boolean) from public, anon;
grant execute on function public.api_spend_summary() to authenticated;
grant execute on function public.api_set_global_spend_cap(numeric, numeric, boolean) to authenticated;
