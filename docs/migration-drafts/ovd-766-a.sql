-- OVD-766 (group a) / OVD-767: verified auth + AAL2 on the platform admin
-- emergency controls.
--
-- DRAFT. NOT APPLIED. NEEDS A BLAINE-APPROVED MIGRATION WINDOW. Do not copy
-- into supabase/migrations/ or run against any database before that window.
-- Rollback: docs/migration-drafts/ovd-766-a.rollback.sql.
-- Test: supabase/tests/pending/ovd766_a_guards.sql.pending (rename to drop
-- .pending in the same change that promotes this draft).
--
-- Each function keeps its latest body unchanged for a legitimate caller (a
-- verified, AAL2 platform admin) and only adds, ahead of the existing
-- is_platform_admin() check, public.require_verified_auth(), and after it, the
-- public.current_user_has_aal2() check in the api_admin_set_founding_beta_enrollment
-- style. Latest current definitions:
--   api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
--   api_admin_set_global_kill_switch(boolean, text, bigint)
--     supabase/migrations/20261013043100_ovd722_provider_kill_switch.sql
--   api_set_global_spend_cap(numeric, numeric, boolean)
--     supabase/migrations/20260731010001_add_spend_caps_and_ledger.sql
--     (also moves search_path from public to '' with qualified references)
--   api_review_export_control_block(uuid, text, text)
--     supabase/migrations/20261013043000_ovd723_export_control_upload_block.sql
--     (already called require_verified_auth(); adds only the AAL2 check)
--
-- Grants: EXECUTE stays with authenticated only; PUBLIC and anon are revoked.
-- The anon revoke is idempotent with the OVD-736 anon revoke: either may run
-- first, and running both leaves the same ACL. service_role is left exactly as
-- it is today (the kill switches already revoke it; the spend cap and export
-- review keep whatever Supabase's default privileges gave it).
--
-- Every statement is create or replace / revoke / grant, so re-running the
-- whole file is a no-op.

-- ---------------------------------------------------------------------
-- Per-provider kill switch
-- ---------------------------------------------------------------------
create or replace function public.api_admin_set_provider_kill_switch(
  p_provider public.vendor_name,
  p_engaged boolean,
  p_reason text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  perform public.require_verified_auth();

  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider kill switch administration.';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  -- A missing row reads as engaged (fail closed). Materialize it that way so
  -- there is always a row to lock; a concurrent flip cannot slip in unlocked.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  -- Take the row lock first; the version check and timestamp are read after it.
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

  -- Captured after the lock wait so the recorded time orders with the commit.
  v_at := pg_catalog.clock_timestamp();

  update private.provider_kill_switches s
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = v_actor,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, p_provider, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  from public, anon, service_role;
grant execute on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  to authenticated;

-- ---------------------------------------------------------------------
-- Global kill switch
-- ---------------------------------------------------------------------
create or replace function public.api_admin_set_global_kill_switch(
  p_engaged boolean,
  p_reason text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  perform public.require_verified_auth();

  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider kill switch administration.';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
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
      engaged_by = v_actor,
      engaged_at = v_at,
      version = g.version + 1
  where g.singleton
  returning g.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, null, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', null,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_admin_set_global_kill_switch(boolean, text, bigint)
  from public, anon, service_role;
grant execute on function public.api_admin_set_global_kill_switch(boolean, text, bigint)
  to authenticated;

-- ---------------------------------------------------------------------
-- Global spend cap
-- ---------------------------------------------------------------------
/** Platform-admin control over the global ceiling and kill switch. */
create or replace function public.api_set_global_spend_cap(
  p_daily_ceiling_usd numeric default null,
  p_per_run_ceiling_usd numeric default null,
  p_kill_switch boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.spend_caps%rowtype;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Not authorized';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for spend cap administration.';
  end if;

  -- Serialized against itself so a concurrent first-write cannot have both
  -- callers find no row and both attempt the insert.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('overdrafter.spend_cap_write'));

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

  return pg_catalog.jsonb_build_object(
    'dailyCeilingUsd', v_row.daily_ceiling_usd,
    'perRunCeilingUsd', v_row.per_run_ceiling_usd,
    'killSwitch', v_row.kill_switch
  );
end;
$$;

revoke all on function public.api_set_global_spend_cap(numeric, numeric, boolean) from public, anon;
grant execute on function public.api_set_global_spend_cap(numeric, numeric, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Export-control marking block review
-- ---------------------------------------------------------------------
-- 1.12 Admin review. Users cannot clear a block; only platform admins can,
-- with a mandatory note, and every decision is an audit event. Clearing a
-- false positive also records the admin cleared scan of the reviewed bytes
-- (1.12a), so the part becomes dispatchable once nothing else holds it; a
-- later hit on the same bytes and patterns resolves to this clearance
-- (1.11), and a new hash or pattern opens a new block.
create or replace function public.api_review_export_control_block(
  p_block_id uuid,
  p_decision text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block private.job_export_marking_blocks%rowtype;
  v_scan_recorded boolean := false;
begin
  perform public.require_verified_auth();
  if not public.is_platform_admin() then
    raise exception using errcode = '42501', message = 'export_review_admin_required';
  end if;
  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for export-control review.';
  end if;
  if p_decision is null or p_decision not in ('cleared_by_admin', 'confirmed_controlled')
    or pg_catalog.length(pg_catalog.btrim(coalesce(p_note, ''))) = 0 then
    raise exception using errcode = 'P0001', message = 'export_review_invalid';
  end if;

  select block.* into v_block
  from private.job_export_marking_blocks block
  where block.id = p_block_id;
  if v_block.id is null then
    raise exception using errcode = 'P0001', message = 'export_review_invalid';
  end if;

  perform private.lock_job_export_state(v_block.job_id, true);

  update private.job_export_marking_blocks
  set state = p_decision,
      reviewed_by = auth.uid(),
      reviewed_at = pg_catalog.clock_timestamp(),
      review_note = pg_catalog.btrim(p_note)
  where id = v_block.id
    and state = 'blocked_pending_review'
  returning * into v_block;

  if not found then
    raise exception using errcode = 'P0001', message = 'export_review_not_pending';
  end if;

  insert into private.export_control_events (organization_id, job_id, part_id, actor, event, detail)
  values (
    v_block.organization_id, v_block.job_id, v_block.part_id, auth.uid(),
    case p_decision
      when 'cleared_by_admin' then 'marking_block_cleared'
      else 'marking_block_confirmed_controlled'
    end,
    pg_catalog.jsonb_build_object('blockId', v_block.id, 'note', v_block.review_note)
  );

  if p_decision = 'cleared_by_admin' then
    v_scan_recorded := private.record_admin_cleared_scan(v_block.id);
  end if;

  return pg_catalog.jsonb_build_object(
    'blockId', v_block.id,
    'state', v_block.state,
    'scanRecorded', v_scan_recorded
  );
end;
$$;

revoke all on function public.api_review_export_control_block(uuid, text, text) from public, anon;
grant execute on function public.api_review_export_control_block(uuid, text, text) to authenticated;
