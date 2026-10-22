-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- ovd: idempotent
-- OVD-815 / OVD-796 slice 4: fixture-heal ledger, DRAFT only.
-- Must not be copied into supabase/migrations/ or applied to any database
-- outside a Blaine-approved migration window. When approved, ship as ONE
-- migration using npm run migration:new and rename both pending files to
-- supabase/tests/ovd815_fixture_heal_a.sql and
-- supabase/tests/ovd815_fixture_heal_a_rollback.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-815-fixture-heal-a.rollback.sql.
-- Notes: docs/migration-drafts/ovd-815-notes.md.
-- Requires (already applied): auth.uid(), auth.jwt(), auth.role(),
-- public.require_verified_auth() (20260303133000),
-- public.current_user_has_aal2() (20260731015213),
-- public.is_platform_admin() (20260325120000; anon revoked by OVD-736),
-- quote tables and selection guard (20260303101500, 20260303191500,
-- 20261002041305, 20261002053133, 20261016004826).
-- No dependency on any other draft.
-- Transaction: no begin/commit here; the runner wraps this file.
-- By hand: psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
-- Expand only: new tables, functions and triggers. No existing function
-- body, signature, grant or policy changes. Three BEFORE triggers on
-- public.published_quote_options, public.client_selections and public.jobs
-- refuse fixture-heal marked sources; unmarked rows behave as today.
-- Access: five private tables, forced RLS, no policies or direct API grants.
-- Worker RPCs: service_role only, plus auth.role() defense in depth.
-- Admin RPCs: authenticated only, verified auth then AAL2 then platform admin.
-- Trigger functions: SECURITY INVOKER, executable by no API role.

-- Ledger tables. JSON payloads must contain sanitized structural data only.
create table if not exists private.fixture_heal_fingerprints (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9]{1,49}$'),
  page text not null check (page in ('login','upload','pricing','public')),
  source text not null check (source in ('daily_job','session_probe','live_quote','certification')),
  captured_at timestamptz not null default pg_catalog.clock_timestamp(),
  pack_revision text not null check (pack_revision ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'),
  classification text not null check (classification in ('ok','blocked','unreachable','auth_required')),
  diff_class text not null check (diff_class in ('none','cosmetic','label','selector','route','host','price_shape','blocked','baseline_missing')),
  skeleton_sha256 text not null check (skeleton_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 65536),
  vision_verdict jsonb check (vision_verdict is null or (pg_catalog.jsonb_typeof(vision_verdict) = 'object' and pg_catalog.octet_length(vision_verdict::text) <= 8192)),
  screenshot_path text check (screenshot_path is null or (screenshot_path ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$' and screenshot_path not like '%..%' and screenshot_path not like '%//%'))
);
create index if not exists fixture_heal_fingerprints_recent on private.fixture_heal_fingerprints (provider, page, captured_at desc);

create table if not exists private.fixture_heal_certifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9]{1,49}$'),
  trigger text not null check (trigger in ('rotation','sanity_hold','fingerprint','terminal_state','repair_validate','post_deploy','post_deploy_24h')),
  pack_revision text not null check (pack_revision ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'),
  golden_part text not null check (golden_part ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  quote_task_id uuid,
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  finished_at timestamptz,
  outcome text check (outcome in ('pass','fail_tolerance','fail_echo','fail_terminal','blocked','killed','error')),
  observed jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(observed) = 'object' and pg_catalog.octet_length(observed::text) <= 16384),
  deviation jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(deviation) = 'object' and pg_catalog.octet_length(deviation::text) <= 16384),
  cleanup_state text not null default 'pending' check (cleanup_state in ('pending','verified','orphan','manual','not_needed')),
  check ((finished_at is null) = (outcome is null)),
  check (finished_at is null or finished_at >= started_at),
  unique (id, provider)
);
create index if not exists fixture_heal_certifications_recent on private.fixture_heal_certifications (provider, started_at desc);

create table if not exists private.fixture_heal_cleanup_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  certification_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9]{1,49}$'),
  item_ref text not null check (item_ref ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$' and item_ref not like '%//%'),
  state text not null default 'intended' check (state in ('intended','created','removed','verified','orphan','manual')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (certification_id, provider) references private.fixture_heal_certifications (id, provider),
  unique (provider, item_ref)
);
create index if not exists fixture_heal_cleanup_certification on private.fixture_heal_cleanup_items (certification_id);
create index if not exists fixture_heal_cleanup_sweep on private.fixture_heal_cleanup_items (provider, updated_at)
  where state in ('intended','created','removed','orphan');

create table if not exists private.fixture_heal_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  provider text check (provider ~ '^[a-z][a-z0-9]{1,49}$'),
  kind text not null check (kind in ('sanity_hold','supplier_paused','supplier_released','cert_planned','repair_opened','repair_merged','backfill_flagged','orphan','standing_granted','standing_revoked')),
  ref_id uuid,
  actor uuid,
  actor_kind text not null check (actor_kind in ('worker','admin')),
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 10 and 500),
  detail jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(detail) = 'object' and pg_catalog.octet_length(detail::text) <= 16384),
  check ((actor_kind = 'admin') = (actor is not null)),
  check ((kind in ('standing_granted','standing_revoked')) = (provider is null)),
  check (kind not in ('standing_granted','standing_revoked') or actor_kind = 'admin')
);
create index if not exists fixture_heal_events_provider_at on private.fixture_heal_events (provider, at desc);
create index if not exists fixture_heal_events_kind_at on private.fixture_heal_events (kind, at desc);

create table if not exists private.fixture_heal_standing_approvals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  scope text not null check (scope = 'selector_only'),
  granted_by uuid not null,
  granted_at timestamptz not null default pg_catalog.clock_timestamp(),
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) between 10 and 500),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason is null or pg_catalog.char_length(pg_catalog.btrim(revoke_reason)) between 10 and 500),
  check ((revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null and revoke_reason is not null)),
  check (revoked_at is null or revoked_at >= granted_at)
);
create unique index if not exists fixture_heal_standing_one_active
  on private.fixture_heal_standing_approvals (scope) where revoked_at is null;

revoke all on table private.fixture_heal_fingerprints from public, anon, authenticated, service_role;
alter table private.fixture_heal_fingerprints enable row level security;
alter table private.fixture_heal_fingerprints force row level security;
comment on table private.fixture_heal_fingerprints is 'OVD-815: private fixture-heal fingerprints; RPC access only.';

revoke all on table private.fixture_heal_certifications from public, anon, authenticated, service_role;
alter table private.fixture_heal_certifications enable row level security;
alter table private.fixture_heal_certifications force row level security;
comment on table private.fixture_heal_certifications is 'OVD-815: private fixture-heal certifications; RPC access only.';

revoke all on table private.fixture_heal_cleanup_items from public, anon, authenticated, service_role;
alter table private.fixture_heal_cleanup_items enable row level security;
alter table private.fixture_heal_cleanup_items force row level security;
comment on table private.fixture_heal_cleanup_items is 'OVD-815: private fixture-heal cleanup items; RPC access only.';

revoke all on table private.fixture_heal_events from public, anon, authenticated, service_role;
alter table private.fixture_heal_events enable row level security;
alter table private.fixture_heal_events force row level security;
comment on table private.fixture_heal_events is 'OVD-815: private fixture-heal events; RPC access only.';

revoke all on table private.fixture_heal_standing_approvals from public, anon, authenticated, service_role;
alter table private.fixture_heal_standing_approvals enable row level security;
alter table private.fixture_heal_standing_approvals force row level security;
comment on table private.fixture_heal_standing_approvals is 'OVD-815: private fixture-heal standing approvals; RPC access only.';

-- Integrity triggers also protect owner writes.
create or replace function private.fixture_heal_events_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'fixture_heal_events is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.fixture_heal_events_immutable() from public, anon, authenticated, service_role;
drop trigger if exists fixture_heal_events_no_update_delete on private.fixture_heal_events;
create trigger fixture_heal_events_no_update_delete before update or delete on private.fixture_heal_events
  for each row execute function private.fixture_heal_events_immutable();
drop trigger if exists fixture_heal_events_no_truncate on private.fixture_heal_events;
create trigger fixture_heal_events_no_truncate before truncate on private.fixture_heal_events
  for each statement execute function private.fixture_heal_events_immutable();

create or replace function private.fixture_heal_standing_approvals_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.revoked_at is null and new.revoked_at is not null
      and new.revoked_by is not null and new.revoke_reason is not null
      and row(new.id, new.scope, new.granted_by, new.granted_at, new.reason)
        is not distinct from row(old.id, old.scope, old.granted_by, old.granted_at, old.reason) then
      return new;
    end if;
  end if;
  raise exception 'fixture_heal_standing_approvals is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.fixture_heal_standing_approvals_guard() from public, anon, authenticated, service_role;
drop trigger if exists fixture_heal_standing_approvals_no_update_delete on private.fixture_heal_standing_approvals;
create trigger fixture_heal_standing_approvals_no_update_delete before update or delete on private.fixture_heal_standing_approvals
  for each row execute function private.fixture_heal_standing_approvals_guard();
drop trigger if exists fixture_heal_standing_approvals_no_truncate on private.fixture_heal_standing_approvals;
create trigger fixture_heal_standing_approvals_no_truncate before truncate on private.fixture_heal_standing_approvals
  for each statement execute function private.fixture_heal_standing_approvals_guard();

-- Worker RPCs. Unknown-key diagnostics contain key names, never values.
create or replace function public.api_worker_fixture_heal_record_fingerprint(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_unknown text;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['provider','page','source','packRevision','classification','diffClass','skeletonSha256','payload','visionVerdict','screenshotPath']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['provider','page','source','packRevision','classification','diffClass','skeletonSha256','payload']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  insert into private.fixture_heal_fingerprints
    (provider, page, source, pack_revision, classification, diff_class, skeleton_sha256, payload, vision_verdict, screenshot_path)
  values (p->>'provider', p->>'page', p->>'source', p->>'packRevision', p->>'classification',
    p->>'diffClass', p->>'skeletonSha256', p->'payload', p->'visionVerdict', p->>'screenshotPath')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.api_worker_fixture_heal_record_fingerprint(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.api_worker_fixture_heal_record_fingerprint(jsonb) to service_role;

create or replace function public.api_worker_fixture_heal_record_certification(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_unknown text;
  v_id uuid;
  v_row private.fixture_heal_certifications%rowtype;
  v_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not (p ? 'id') then
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['provider','trigger','packRevision','goldenPart','quoteTaskId']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['provider','trigger','packRevision','goldenPart']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
    insert into private.fixture_heal_certifications (provider, trigger, pack_revision, golden_part, quote_task_id)
    values (p->>'provider', p->>'trigger', p->>'packRevision', p->>'goldenPart', (p->>'quoteTaskId')::uuid)
    returning id into v_id;
    return v_id;
  end if;
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['id','outcome','observed','deviation','cleanupState']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['id']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if (p ? 'observed' or p ? 'deviation') and not (p ? 'outcome') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select c.* into v_row from private.fixture_heal_certifications c where c.id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'certification_not_found' using errcode = 'P0002';
  end if;
  if p ? 'outcome' then
    if v_row.finished_at is not null then
      raise exception 'certification_already_finished' using errcode = 'P0001';
    end if;
    update private.fixture_heal_certifications set outcome = p->>'outcome', finished_at = pg_catalog.clock_timestamp(),
      observed = case when p ? 'observed' then p->'observed' else observed end,
      deviation = case when p ? 'deviation' then p->'deviation' else deviation end
    where id = v_row.id;
  end if;
  if p ? 'cleanupState' then
    v_state := p->>'cleanupState';
    if v_state is distinct from v_row.cleanup_state then
      if not coalesce((v_row.cleanup_state = 'pending' and v_state in ('verified','orphan','manual','not_needed'))
        or (v_row.cleanup_state = 'orphan' and v_state in ('verified','manual'))
        or (v_row.cleanup_state = 'manual' and v_state = 'verified'), false) then
        raise exception 'invalid_cleanup_state_transition' using errcode = '22023';
      end if;
      update private.fixture_heal_certifications set cleanup_state = v_state where id = v_row.id;
    end if;
  end if;
  return v_row.id;
end;
$$;
revoke all on function public.api_worker_fixture_heal_record_certification(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.api_worker_fixture_heal_record_certification(jsonb) to service_role;

create or replace function public.api_worker_fixture_heal_record_cleanup_item(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_unknown text;
  v_id uuid;
  v_row private.fixture_heal_cleanup_items%rowtype;
  v_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not (p ? 'id') then
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['certificationId','provider','itemRef','state']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['certificationId','provider','itemRef']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
    if p ? 'state' and (p->>'state') is distinct from 'intended' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    insert into private.fixture_heal_cleanup_items (certification_id, provider, item_ref)
    values ((p->>'certificationId')::uuid, p->>'provider', p->>'itemRef') returning id into v_id;
    return v_id;
  end if;
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['id','state','itemRef']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['id','state']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select c.* into v_row from private.fixture_heal_cleanup_items c where c.id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'cleanup_item_not_found' using errcode = 'P0002';
  end if;
  v_state := p->>'state';
  if p ? 'itemRef' and not (v_row.state = 'intended' and v_state = 'created') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if v_state = v_row.state then return v_row.id; end if;
  if not coalesce((v_row.state = 'intended' and v_state in ('created','verified','orphan','manual'))
    or (v_row.state = 'created' and v_state in ('removed','verified','orphan','manual'))
    or (v_row.state = 'removed' and v_state in ('verified','orphan','manual'))
    or (v_row.state = 'orphan' and v_state in ('removed','verified','manual'))
    or (v_row.state = 'manual' and v_state = 'verified'), false) then
    raise exception 'invalid_cleanup_transition' using errcode = '22023';
  end if;
  update private.fixture_heal_cleanup_items set state = v_state,
    item_ref = case when p ? 'itemRef' then p->>'itemRef' else item_ref end,
    attempts = attempts + case when v_state = 'removed' then 1 else 0 end,
    updated_at = pg_catalog.clock_timestamp()
  where id = v_row.id;
  return v_row.id;
end;
$$;
revoke all on function public.api_worker_fixture_heal_record_cleanup_item(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.api_worker_fixture_heal_record_cleanup_item(jsonb) to service_role;

create or replace function public.api_worker_fixture_heal_record_event(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_unknown text;
  v_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select pg_catalog.string_agg(k, ', ' order by k) into v_unknown
  from pg_catalog.jsonb_object_keys(p) as keys(k) where not (k = any(array['provider','kind','reason','refId','detail']::text[]));
  if v_unknown is not null then
    raise exception 'invalid_payload' using errcode = '22023', detail = v_unknown;
  end if;
  if not (p ?& array['provider','kind','reason']::text[]) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if p->>'kind' in ('standing_granted','standing_revoked') then
    raise exception 'kind_reserved_for_admin' using errcode = '42501';
  end if;
  insert into private.fixture_heal_events (provider, kind, reason, ref_id, detail, actor, actor_kind)
  values (p->>'provider', p->>'kind', p->>'reason', (p->>'refId')::uuid,
    case when p ? 'detail' then p->'detail' else '{}'::jsonb end, null, 'worker')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.api_worker_fixture_heal_record_event(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.api_worker_fixture_heal_record_event(jsonb) to service_role;

create or replace function public.api_worker_fixture_heal_active_standing_approval()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_approval jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select pg_catalog.jsonb_build_object('id', a.id, 'scope', a.scope, 'grantedBy', a.granted_by, 'grantedAt', a.granted_at)
  into v_approval from private.fixture_heal_standing_approvals a
  where a.scope = 'selector_only' and a.revoked_at is null;
  return v_approval;
end;
$$;
revoke all on function public.api_worker_fixture_heal_active_standing_approval() from public, anon, authenticated, service_role;
grant execute on function public.api_worker_fixture_heal_active_standing_approval() to service_role;

-- OVD-602: at promotion add exactly two api_priv_definer_allowlist rows,
-- guard class admin-aal2, issue OVD-815 (exact rows in ovd-815-notes.md).
-- Worker RPCs are service_role only: PUBLIC/anon/authenticated inventory is
-- otherwise unchanged. No pre-existing object's ACL is altered here.
create or replace function public.api_admin_grant_fixture_heal_standing_approval(p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_reason text;
begin
  perform public.require_verified_auth();
  if not coalesce(public.current_user_has_aal2(), false) then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  v_reason := pg_catalog.btrim(p_reason);
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  begin
    insert into private.fixture_heal_standing_approvals (scope, granted_by, reason)
    values ('selector_only', auth.uid(), v_reason) returning id into v_id;
  exception when unique_violation then
    raise exception 'standing_approval_already_active' using errcode = '23505';
  end;
  insert into private.fixture_heal_events (provider, kind, ref_id, actor, actor_kind, reason)
  values (null, 'standing_granted', v_id, auth.uid(), 'admin', v_reason);
  return v_id;
end;
$$;
revoke all on function public.api_admin_grant_fixture_heal_standing_approval(text) from public, anon, authenticated, service_role;
grant execute on function public.api_admin_grant_fixture_heal_standing_approval(text) to authenticated;

create or replace function public.api_admin_revoke_fixture_heal_standing_approval(p_approval_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_reason text;
begin
  perform public.require_verified_auth();
  if not coalesce(public.current_user_has_aal2(), false) then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  v_reason := pg_catalog.btrim(p_reason);
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  update private.fixture_heal_standing_approvals
  set revoked_at = pg_catalog.clock_timestamp(), revoked_by = auth.uid(), revoke_reason = v_reason
  where id = p_approval_id and revoked_at is null returning id into v_id;
  if not found then
    raise exception 'standing_approval_not_active' using errcode = 'P0002';
  end if;
  insert into private.fixture_heal_events (provider, kind, ref_id, actor, actor_kind, reason)
  values (null, 'standing_revoked', v_id, auth.uid(), 'admin', v_reason);
  return v_id;
end;
$$;
revoke all on function public.api_admin_revoke_fixture_heal_standing_approval(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.api_admin_revoke_fixture_heal_standing_approval(uuid, text) to authenticated;

-- Commitment guards are INVOKER: service_role spreadsheet import tools
-- insert options directly; definer RPCs execute as the owner and see all rows.
-- API roles cannot write client_selections; guard_direct_job_offer_selection
-- sorts first on jobs and refuses direct API-role selection with its old error.
-- No private helper call: invoking API roles lack private EXECUTE/USAGE.
create or replace function private.fixture_heal_guard_quote_commitment()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_result_id uuid;
  v_offer_id uuid;
  v_offer_result_id uuid;
  v_sources uuid[] := array[]::uuid[];
  v_payload jsonb;
  v_reason text;
begin
  if tg_table_name = 'published_quote_options' then
    v_result_id := new.source_vendor_quote_id;
    v_offer_id := new.source_vendor_quote_offer_id;
  elsif tg_table_name = 'client_selections' then
    if tg_op = 'UPDATE' then
      if new.option_id is not distinct from old.option_id then return new; end if;
    end if;
    select o.source_vendor_quote_id, o.source_vendor_quote_offer_id into v_result_id, v_offer_id
    from public.published_quote_options o where o.id = new.option_id;
    if not found then
      raise exception 'fixture_heal_source_unreadable' using errcode = 'P0001';
    end if;
  elsif tg_table_name = 'jobs' then
    if tg_op = 'UPDATE' then
      if new.selected_vendor_quote_offer_id is not distinct from old.selected_vendor_quote_offer_id then return new; end if;
    end if;
    v_offer_id := new.selected_vendor_quote_offer_id;
  end if;
  if v_result_id is not null then v_sources := pg_catalog.array_append(v_sources, v_result_id); end if;
  if v_offer_id is not null then
    select o.vendor_quote_result_id into v_offer_result_id from public.vendor_quote_offers o where o.id = v_offer_id;
    if not found or v_offer_result_id is null then
      raise exception 'fixture_heal_source_unreadable' using errcode = 'P0001';
    end if;
    v_sources := pg_catalog.array_append(v_sources, v_offer_result_id);
  end if;
  foreach v_result_id in array v_sources loop
    select r.raw_payload into v_payload from public.vendor_quote_results r where r.id = v_result_id;
    if not found then
      raise exception 'fixture_heal_source_unreadable' using errcode = 'P0001';
    end if;
    v_reason := null;
    -- Only an explicit internal:false exempts a fixtureHeal marker.
    if v_payload ? 'fixtureHeal' and (pg_catalog.jsonb_typeof(v_payload->'fixtureHeal') <> 'object'
      or (v_payload->'fixtureHeal'->'internal') is distinct from 'false'::jsonb) then
      v_reason := 'internal_test_quote';
    elsif (v_payload->'fixtureSanity'->'held') = 'true'::jsonb then
      v_reason := 'sanity_hold';
    end if;
    if v_reason is not null then
      if tg_table_name = 'published_quote_options' then
        raise exception 'fixture_heal_result_not_publishable' using errcode = 'P0001', detail = 'reason=' || v_reason;
      else
        raise exception 'fixture_heal_offer_not_selectable' using errcode = 'P0001', detail = 'reason=' || v_reason;
      end if;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.fixture_heal_guard_quote_commitment() from public, anon, authenticated, service_role;
drop trigger if exists guard_fixture_heal_published_option on public.published_quote_options;
create trigger guard_fixture_heal_published_option
  before insert or update of source_vendor_quote_id, source_vendor_quote_offer_id on public.published_quote_options
  for each row execute function private.fixture_heal_guard_quote_commitment();
drop trigger if exists guard_fixture_heal_client_selection on public.client_selections;
create trigger guard_fixture_heal_client_selection before insert or update of option_id on public.client_selections
  for each row execute function private.fixture_heal_guard_quote_commitment();
drop trigger if exists guard_fixture_heal_job_offer_selection on public.jobs;
create trigger guard_fixture_heal_job_offer_selection before insert or update of selected_vendor_quote_offer_id on public.jobs
  for each row when (new.selected_vendor_quote_offer_id is not null)
  execute function private.fixture_heal_guard_quote_commitment();
