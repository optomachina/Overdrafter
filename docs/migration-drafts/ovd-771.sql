-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-771: service_role path for the provider kill switch (the CLI brake).
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window. When approved,
-- it ships as ONE migration (next timestamp from `npm run migration:new`), and
-- supabase/tests/pending/ovd771_service_kill_switch.sql.pending is renamed to
-- supabase/tests/ovd771_service_kill_switch.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-771.rollback.sql.
-- The rollback check is also covered by the ephemeral-db rollback stage (OVD-924), pending PR-2.
--
-- Requires: 20261013043100_ovd722_provider_kill_switch.sql (applied).
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Why: the admin UI now requires an AAL2 (MFA) session before it flips a
-- switch. The emergency CLI (scripts/provider-kill.mjs) must keep working when
-- no admin can complete MFA, so it moves off the admin user session onto the
-- service role. The admin RPCs are unchanged; these are new, service_role-only
-- RPCs that take the same locks, apply the same compare and set rule, and write
-- the same audit table. A service_role call has no auth.uid(), so the audit
-- row records actor 'cli:service_role' (fixed by the function; the caller
-- cannot choose it) and the required free-text operator name.
--
-- Expand only. Changes to existing objects:
--   * private.provider_kill_switch_audit.actor changes from uuid to text
--     (USING actor::text: every existing row keeps its user id, as text) and
--     stays NOT NULL. A new nullable `operator` column is added. A check
--     constraint allows exactly two shapes: a user id with no operator (admin
--     RPC rows) or 'cli:service_role' with a 2-120 character operator.
--     The column type change rewrites the table; a rewrite fires no row
--     triggers, so the append-only triggers are untouched.
--   * No existing function body changes: every OVD-722 prosrc pin holds. The
--     admin RPCs insert a uuid into the text column through the standard
--     assignment cast, and comparisons with a quoted uuid literal (as in
--     supabase/tests/ovd722_provider_kill_switch.sql) still match.
--
-- Interaction with the OVD-722 rollback: its dependency guard refuses while
-- any other function references the switch tables, so these functions must be
-- rolled back (this draft's rollback) before OVD-722 can be.

-- =====================================================================
-- Audit shape
-- =====================================================================
alter table private.provider_kill_switch_audit
  alter column actor type text using actor::text;

alter table private.provider_kill_switch_audit
  add column if not exists operator text;

alter table private.provider_kill_switch_audit
  drop constraint if exists provider_kill_switch_audit_actor_operator_check;
alter table private.provider_kill_switch_audit
  add constraint provider_kill_switch_audit_actor_operator_check check (
    (actor = 'cli:service_role'
      and operator is not null and pg_catalog.char_length(pg_catalog.btrim(operator)) between 2 and 120)
    or (actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and operator is null)
  );

-- =====================================================================
-- Service RPCs (service_role only)
-- =====================================================================

-- Same compare and set rule as public.api_admin_set_provider_kill_switch:
-- engage always wins; release must name the version it was decided on.
create or replace function public.api_service_set_provider_kill_switch(
  p_provider public.vendor_name,
  p_engaged boolean,
  p_reason text,
  p_operator text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_operator text;
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  v_reason := pg_catalog.btrim(p_reason);
  v_operator := pg_catalog.btrim(p_operator);
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  if v_operator is null or pg_catalog.char_length(v_operator) not between 2 and 120 then
    raise exception 'operator_required' using errcode = '22023';
  end if;

  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

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

  v_at := pg_catalog.clock_timestamp();

  -- engaged_by is a user id; a service flip has none. The operator is in the audit row.
  update private.provider_kill_switches s
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = null,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason, operator)
  values (v_at, 'cli:service_role', p_provider, p_engaged, v_reason, v_operator);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', 'cli:service_role',
    'operator', v_operator,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_service_set_provider_kill_switch(public.vendor_name, boolean, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_set_provider_kill_switch(public.vendor_name, boolean, text, text, bigint)
  to service_role;

create or replace function public.api_service_set_global_kill_switch(
  p_engaged boolean,
  p_reason text,
  p_operator text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_operator text;
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  v_reason := pg_catalog.btrim(p_reason);
  v_operator := pg_catalog.btrim(p_operator);
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  if v_operator is null or pg_catalog.char_length(v_operator) not between 2 and 120 then
    raise exception 'operator_required' using errcode = '22023';
  end if;

  insert into private.provider_global_kill_switch (singleton, engaged)
  values (true, true)
  on conflict (singleton) do nothing;

  select g.version into strict v_current_version
  from private.provider_global_kill_switch g
  where g.singleton
  for update;

  if not p_engaged
    and (p_expected_version is null or p_expected_version <> v_current_version) then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              coalesce(p_expected_version::text, 'none'), v_current_version);
  end if;

  v_at := pg_catalog.clock_timestamp();

  update private.provider_global_kill_switch g
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = null,
      engaged_at = v_at,
      version = g.version + 1
  where g.singleton
  returning g.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason, operator)
  values (v_at, 'cli:service_role', null, p_engaged, v_reason, v_operator);

  return pg_catalog.jsonb_build_object(
    'provider', null,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', 'cli:service_role',
    'operator', v_operator,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_service_set_global_kill_switch(boolean, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_set_global_kill_switch(boolean, text, text, bigint)
  to service_role;

-- CLI read (--list and the version read before a release). Same payload as
-- api_admin_list_provider_kill_switches, except that a CLI flip (no user id on
-- the switch row) reports changedBy 'cli:service_role' and its operator, read
-- from the audit row written in the same transaction.
create or replace function public.api_service_list_provider_kill_switches()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-kill-switch-service.v1',
    'global', (
      select pg_catalog.jsonb_build_object(
        'engaged', g.engaged, 'reason', g.reason,
        'changedBy', coalesce(g.engaged_by::text, cli.actor), 'operator', cli.operator,
        'changedAt', g.engaged_at, 'version', g.version)
      from private.provider_global_kill_switch g
      left join lateral (
        select a.actor, a.operator from private.provider_kill_switch_audit a
        where g.engaged_by is null and a.provider is null and a.at = g.engaged_at
          and a.actor = 'cli:service_role'
        order by a.id desc limit 1
      ) cli on true
      where g.singleton
    ),
    'providers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', s.provider, 'engaged', s.engaged, 'reason', s.reason,
        'changedBy', coalesce(s.engaged_by::text, cli.actor), 'operator', cli.operator,
        'changedAt', s.engaged_at, 'version', s.version) order by s.provider::text)
      from private.provider_kill_switches s
      left join lateral (
        select a.actor, a.operator from private.provider_kill_switch_audit a
        where s.engaged_by is null and a.provider = s.provider and a.at = s.engaged_at
          and a.actor = 'cli:service_role'
        order by a.id desc limit 1
      ) cli on true
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.api_service_list_provider_kill_switches()
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_list_provider_kill_switches()
  to service_role;
