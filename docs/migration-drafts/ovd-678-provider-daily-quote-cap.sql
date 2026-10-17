-- OVD-678 durable per provider daily quote cap: DRAFT ONLY. Not a migration.
--
-- SUPERSEDED by docs/migration-drafts/ovd-828-s1.sql (OVD-829): the cap is
-- per-supplier data with no default (null = unlimited), and the RMFG
-- in-process cap of 20 described below has been removed from the worker. Do
-- not apply this draft; it is kept as history only.
--
-- Do not copy into supabase/migrations/ or apply to any hosted project without
-- its own review and Blaine's approval. No CI test runs this draft yet.
--
-- Today the RMFG cap (20 quote attempts per UTC day) lives in the worker
-- process (worker/src/adapters/rmfgHttpTransport.ts). Two workers, or one
-- restart, could each spend 20. This draft moves the count into the database
-- so every worker shares it. The worker would call the reserve function once
-- per quote attempt, before the analyze upload, and refuse the attempt with
-- provider_daily_cap_reached when it returns false. Nothing is refunded: a
-- reserved attempt counts even if the provider call then fails.
--
-- Not wired: the worker change that calls this RPC is a follow up once this is
-- applied. Until then the process cap is the only cap.

-- ===================== FORWARD =====================
begin;

create table private.provider_daily_quote_counters (
  provider public.vendor_name not null,
  utc_day date not null,
  attempts integer not null default 0 check (attempts >= 0),
  primary key (provider, utc_day)
);

alter table private.provider_daily_quote_counters enable row level security;
revoke all on private.provider_daily_quote_counters from public, anon, authenticated;

-- Atomic reserve: increments only while below the cap. Returns true when one
-- attempt was reserved for today (UTC), false when the cap is spent.
create or replace function public.api_worker_reserve_provider_quote_attempt(
  p_provider public.vendor_name,
  p_daily_cap integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved integer;
begin
  if p_daily_cap is null or p_daily_cap < 1 or p_daily_cap > 1000 then
    raise exception 'invalid daily cap' using errcode = '22023';
  end if;
  insert into private.provider_daily_quote_counters as c (provider, utc_day, attempts)
  values (p_provider, (now() at time zone 'utc')::date, 1)
  on conflict (provider, utc_day) do update
    set attempts = c.attempts + 1
    where c.attempts < p_daily_cap
  returning attempts into v_reserved;
  return v_reserved is not null;
end;
$$;

revoke all on function public.api_worker_reserve_provider_quote_attempt(public.vendor_name, integer)
  from public, anon, authenticated;
grant execute on function public.api_worker_reserve_provider_quote_attempt(public.vendor_name, integer)
  to service_role;

commit;

-- ===================== ROLLBACK =====================
-- begin;
-- drop function if exists public.api_worker_reserve_provider_quote_attempt(public.vendor_name, integer);
-- drop table if exists private.provider_daily_quote_counters;
-- commit;
