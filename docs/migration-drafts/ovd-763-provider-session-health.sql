-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-763 slice 1: provider session health status.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window. When approved it
-- ships as ONE migration (next timestamp from `npm run migration:new`).
--
-- Persists worker/src/providerSessionHealth.ts ProviderHealthRecord, one row per
-- provider. The row holds the provider, a status, a fixed reason code,
-- timestamps and a count. It never holds storage state, cookies, keys, URLs,
-- page content or error text. The check constraints enforce that shape.
--
-- Access: service role only (the worker). No grant to anon or authenticated.
-- An admin read surface is a later slice and would add its own RPC.

create table if not exists private.provider_session_health (
  provider text primary key
    check (provider in ('fictiv', 'quickparts', 'xometry', 'rmfg')),
  status text not null
    check (status in ('healthy', 'logged_out', 'blocked', 'error', 'unknown')),
  reason text not null
    check (reason ~ '^[a-z0-9_]{1,64}$'),
  checked_at timestamptz not null,
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  last_healthy_at timestamptz,
  changed boolean not null default false
);

alter table private.provider_session_health enable row level security;

revoke all on private.provider_session_health from public, anon, authenticated;
grant select, insert, update on private.provider_session_health to service_role;
