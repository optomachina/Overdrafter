-- OVD-879: staging environment marker. STAGING ONLY (ref ldmambwtksfvqdufhaam).
--
-- Run ONCE on the staging database only, through the OVD-839 URL guard: the
-- target must be proved to be staging first. Until that guard lands, use the
-- OVD-837 allowlist: node scripts/seed-staging.mjs --ref ldmambwtksfvqdufhaam
-- --check-target.
-- Never run it on production (ozuatdcakezjtevztjlr) or any other project, and
-- never copy it into supabase/migrations: migrations reach every environment,
-- and the marker must exist on staging alone.
--
-- This is the only file that creates or writes overdrafter.environment_marker.
-- supabase/seed/staging.sql only reads it, and refuses to write anything
-- (STAGING_SENTINEL_MISSING) unless the row env = 'staging' exists.
--
-- Idempotent: if not exists everywhere and on conflict do nothing, so a second
-- run changes nothing.

create schema if not exists overdrafter;

create table if not exists overdrafter.environment_marker (
  env text primary key check (env = 'staging'),
  created_at timestamptz not null default now()
);

insert into overdrafter.environment_marker (env)
values ('staging')
on conflict do nothing;

-- No API access: RLS on with no policies, and no grants to the API roles.
alter table overdrafter.environment_marker enable row level security;

revoke all on schema overdrafter from public;
revoke all on table overdrafter.environment_marker from public;

-- anon and authenticated exist on Supabase but may not on a plain Postgres.
do $revoke$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = api_role) then
      execute format('revoke all on schema overdrafter from %I', api_role);
      execute format('revoke all on table overdrafter.environment_marker from %I', api_role);
    end if;
  end loop;
end
$revoke$;
