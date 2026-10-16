-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-707 (PR 1 of 3, group a): providers as data. Provider definitions,
-- their append-only revisions and audit log, and the admin transition RPCs.
--
-- DRAFT. NOT APPLIED. Do not copy into supabase/migrations/ or run against any
-- database outside a Blaine-approved migration window. When approved, it ships
-- as ONE migration (next timestamp from `npm run migration:new`) together with
-- ovd-707-b-seed.sql, and supabase/tests/pending/ovd707_*.sql.pending are
-- renamed to supabase/tests/ovd707_*.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-707-a.rollback.sql (run the seed
-- rollback, ovd-707-b-seed.rollback.sql, first).
-- Design notes and open questions: docs/migration-drafts/ovd-707-notes.md.
--
-- Requires (applied): 20261013043100_ovd722_provider_kill_switch.sql
-- (private.provider_kill_switch_engaged_text) and the auth helpers
-- public.require_verified_auth(), public.is_platform_admin(),
-- public.current_user_has_aal2() and private.platform_admin_emails.
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Expand only: every object here is new. Nothing reads these tables yet. The
-- worker keeps resolving providers from provider-registry.v1.json until PR 2,
-- and the kill switches (OVD-722/771) stay separate and always win: the only
-- service read below excludes every provider whose switch, or the global
-- switch, is engaged.
--
-- Lifecycle (every transition is one SECURITY DEFINER RPC that writes exactly
-- one audit row in the same transaction):
--   create              -> draft
--   update draft        draft -> draft
--   submit              draft -> pending_review      (snapshots a revision)
--   approve             pending_review -> approved   (four-eyes, see below)
--   reject              pending_review -> draft
--   record dry run      approved -> approved         (records a check result)
--   activate            approved | suspended -> active
--   suspend             active -> suspended
--   reopen              approved | suspended -> draft
--   retire              draft | approved | active | suspended -> retired
-- Four-eyes: the approver must differ from the revision's proposer. The one
-- exception is the single-admin override: p_override = true, the caller's
-- email is in private.provider_definition_override_emails (Blaine), the
-- session is AAL2 (as for every RPC here) and the reason is at least 10
-- characters. The override is recorded on the revision and as audit action
-- approve_override.

-- =====================================================================
-- Types and validation helpers
-- =====================================================================
do $types$
begin
  if not exists (
    select 1 from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'private' and t.typname = 'provider_status'
  ) then
    create type private.provider_status as enum (
      'draft', 'pending_review', 'approved', 'active', 'suspended', 'retired'
    );
  end if;
end;
$types$;

-- Exact lowercase hostnames, the same shape as offHostAllowlist in
-- provider-integrations/provider-registry.v1.schema.json. No duplicates.
create or replace function private.provider_hosts_are_valid(p_hosts text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_hosts is not null
    and pg_catalog.array_position(p_hosts, null) is null
    and not exists (
      select 1 from pg_catalog.unnest(p_hosts) h(host)
      where h.host !~ '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    )
    and (select pg_catalog.count(distinct h.host) from pg_catalog.unnest(p_hosts) h(host))
      = pg_catalog.cardinality(p_hosts);
$$;

-- A credential reference is a secret NAME, never a value: the env-var name
-- convention the registry already uses for secretNameEnv. Anything else
-- (tokens, keys, JSON, URLs, lowercase strings) is refused.
create or replace function private.provider_credential_ref_is_name(p_ref text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ref ~ '^[A-Z][A-Z0-9_]{0,100}_SECRET_NAME$';
$$;

-- Structural check of the admission object. It mirrors the providerEntry and
-- sessionSecret shapes in provider-registry.v1.schema.json; the JSON schema
-- stays the reference and PR 2 validates against it in the API layer as well.
-- Checks run in order so a wrong type never reaches a function that would
-- raise on it.
create or replace function private.provider_admission_is_valid(p_admission jsonb, p_slug text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_secret jsonb;
  v_host jsonb;
  v_has_required boolean := false;
begin
  if p_admission is null or pg_catalog.jsonb_typeof(p_admission) <> 'object' then
    return false;
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_admission) k
    where k not in ('key', 'liveAdapter', 'sessionSecrets', 'egress', 'adapterKind',
                    'adoptedAdapter', 'sessionlessJustification', 'offHostAllowlist')
  ) then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p_admission -> 'key') is distinct from 'string'
    or p_admission ->> 'key' is distinct from p_slug
    or pg_catalog.jsonb_typeof(p_admission -> 'liveAdapter') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_admission -> 'sessionSecrets') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_admission -> 'egress') is distinct from 'string'
    or p_admission ->> 'egress' not in ('stable_nat', 'none') then
    return false;
  end if;
  if p_admission ? 'adapterKind' and p_admission -> 'adapterKind' <> '"api"'::jsonb then
    return false;
  end if;
  if p_admission ? 'sessionlessJustification'
    and (pg_catalog.jsonb_typeof(p_admission -> 'sessionlessJustification') <> 'string'
      or pg_catalog.char_length(p_admission ->> 'sessionlessJustification') < 20) then
    return false;
  end if;
  if p_admission ? 'adoptedAdapter' then
    if pg_catalog.jsonb_typeof(p_admission -> 'adoptedAdapter') <> 'object'
      or p_admission -> 'liveAdapter' <> 'true'::jsonb
      or exists (select 1 from pg_catalog.jsonb_object_keys(p_admission -> 'adoptedAdapter') k
                 where k not in ('module', 'defaultDenyTest'))
      or pg_catalog.jsonb_typeof(p_admission -> 'adoptedAdapter' -> 'module') is distinct from 'string'
      or (p_admission -> 'adoptedAdapter' ->> 'module') !~ '^worker/src/adapters/[A-Za-z][A-Za-z0-9]*\.ts$'
      or (p_admission -> 'adoptedAdapter' ? 'defaultDenyTest'
        and (pg_catalog.jsonb_typeof(p_admission -> 'adoptedAdapter' -> 'defaultDenyTest') <> 'string'
          or (p_admission -> 'adoptedAdapter' ->> 'defaultDenyTest')
            !~ '^worker/src/adapters/[A-Za-z][A-Za-z0-9]*\.test\.ts$')) then
      return false;
    end if;
  end if;
  if p_admission ? 'offHostAllowlist' then
    if pg_catalog.jsonb_typeof(p_admission -> 'offHostAllowlist') <> 'array' then
      return false;
    end if;
    for v_host in select h from pg_catalog.jsonb_array_elements(p_admission -> 'offHostAllowlist') h loop
      if pg_catalog.jsonb_typeof(v_host) <> 'string' then
        return false;
      end if;
    end loop;
    if not private.provider_hosts_are_valid(array(
      select h from pg_catalog.jsonb_array_elements_text(p_admission -> 'offHostAllowlist') h)) then
      return false;
    end if;
  end if;
  for v_secret in select s from pg_catalog.jsonb_array_elements(p_admission -> 'sessionSecrets') s loop
    if pg_catalog.jsonb_typeof(v_secret) <> 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(v_secret) k
                 where k not in ('secretNameEnv', 'mountEnv', 'mountPath', 'requiredWhenListed', 'manualDeploy'))
      or pg_catalog.jsonb_typeof(v_secret -> 'secretNameEnv') is distinct from 'string'
      or (v_secret ->> 'secretNameEnv') !~ '^[A-Z][A-Z0-9_]*_SECRET_NAME$'
      or pg_catalog.jsonb_typeof(v_secret -> 'requiredWhenListed') is distinct from 'boolean'
      or (v_secret ? 'mountEnv'
        and (pg_catalog.jsonb_typeof(v_secret -> 'mountEnv') <> 'string'
          or (v_secret ->> 'mountEnv') !~ '^[A-Z][A-Z0-9_]{1,80}$'))
      or (v_secret ? 'mountPath'
        and (pg_catalog.jsonb_typeof(v_secret -> 'mountPath') <> 'string'
          or (v_secret ->> 'mountPath') !~ '^/var/secrets/[a-z0-9-]+/storage-state\.json$'))
      or (v_secret ? 'manualDeploy'
        and (pg_catalog.jsonb_typeof(v_secret -> 'manualDeploy') <> 'boolean'
          or (v_secret -> 'manualDeploy' = 'true'::jsonb and p_slug <> 'xometry'))) then
      return false;
    end if;
    v_has_required := v_has_required or v_secret -> 'requiredWhenListed' = 'true'::jsonb;
  end loop;
  -- A live adapter needs a required secret or a written justification.
  if p_admission -> 'liveAdapter' = 'true'::jsonb
    and not v_has_required and not p_admission ? 'sessionlessJustification' then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function private.provider_hosts_are_valid(text[]) from public, anon, authenticated, service_role;
revoke all on function private.provider_credential_ref_is_name(text) from public, anon, authenticated, service_role;
revoke all on function private.provider_admission_is_valid(jsonb, text) from public, anon, authenticated, service_role;

-- =====================================================================
-- Tables
-- =====================================================================

-- Who may use the single-admin four-eyes override. Same email allowlist
-- pattern as private.platform_admin_emails; see ovd-707-notes.md (Q1).
create table if not exists private.provider_definition_override_emails (
  email text primary key check (email = pg_catalog.lower(email)),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

insert into private.provider_definition_override_emails (email)
values ('blaineswilson@gmail.com')
on conflict (email) do nothing;

create table if not exists private.provider_definitions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9]{1,49}$'),
  display_name text not null
    check (pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 120),
  kind text not null check (kind in ('portal', 'api', 'email', 'manual')),
  quote_currency text not null default 'USD' check (quote_currency ~ '^[A-Z]{3}$'),
  host_allowlist text[] not null default '{}'
    check (private.provider_hosts_are_valid(host_allowlist)),
  admission jsonb not null check (private.provider_admission_is_valid(admission, slug)),
  status private.provider_status not null default 'draft',
  -- Version of the approved revision the row carries; 0 until first approval.
  version integer not null default 0 check (version >= 0),
  approved_revision_id uuid,
  credential_ref text check (credential_ref is null or private.provider_credential_ref_is_name(credential_ref)),
  -- OVD-723 export-control fields. 'us' / 'foreign' match
  -- private.export_control_provider_jurisdiction. A foreign provider may never
  -- receive export-controlled parts.
  export_jurisdiction text check (export_jurisdiction in ('us', 'foreign')),
  export_controlled_allowed boolean,
  -- Dry-run gate: the version whose offline dry-run check passed (no live
  -- dispatch). Activation needs it to equal version.
  dry_run_passed_version integer,
  dry_run_checked_at timestamptz,
  dry_run_evidence_ref text check (dry_run_evidence_ref is null
    or pg_catalog.char_length(pg_catalog.btrim(dry_run_evidence_ref)) between 1 and 500),
  created_by uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint provider_definitions_foreign_never_controlled
    check (not (export_jurisdiction = 'foreign' and export_controlled_allowed)),
  constraint provider_definitions_approved_has_revision
    check (status not in ('approved', 'active', 'suspended')
      or (approved_revision_id is not null and version >= 1)),
  constraint provider_definitions_active_gate
    check (status <> 'active' or (
      export_jurisdiction is not null
      and export_controlled_allowed is not null
      and dry_run_passed_version = version
      and (kind not in ('portal', 'api') or pg_catalog.cardinality(host_allowlist) > 0)))
);

create table if not exists private.provider_definition_revisions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  definition_id uuid not null references private.provider_definitions (id),
  version integer not null check (version >= 1),
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload) = 'object'),
  -- null only for the one-time registry seed (ovd-707-b-seed.sql).
  proposed_by uuid,
  proposed_at timestamptz not null default pg_catalog.clock_timestamp(),
  reviewed_by uuid,
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  reason text,
  four_eyes_override boolean not null default false,
  unique (definition_id, version),
  unique (id, definition_id),
  check ((decision = 'pending') = (decided_at is null)),
  check (not four_eyes_override or (decision = 'approved' and reviewed_by = proposed_by))
);

create unique index if not exists provider_definition_revisions_one_pending_idx
  on private.provider_definition_revisions (definition_id) where decision = 'pending';

-- The live row may only point at a revision of its own definition. That the
-- revision is approved is enforced by the RPCs and asserted by the pgTAP.
alter table private.provider_definitions
  drop constraint if exists provider_definitions_approved_revision_fk;
alter table private.provider_definitions
  add constraint provider_definitions_approved_revision_fk
  foreign key (approved_revision_id, id)
  references private.provider_definition_revisions (id, definition_id);

create table if not exists private.provider_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  actor text not null,
  actor_kind text not null check (actor_kind in ('user', 'service_role', 'cli')),
  -- No foreign key: the audit trail outlives any definition row.
  provider_id uuid,
  action text not null check (action in (
    'create', 'update_draft', 'submit', 'approve', 'approve_override', 'reject',
    'record_dry_run', 'activate', 'suspend', 'reopen', 'retire', 'seed', 'seed_rollback')),
  before jsonb,
  after jsonb,
  reason text,
  request_id text,
  check (actor_kind <> 'user'
    or actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

create index if not exists provider_audit_log_provider_at_idx
  on private.provider_audit_log (provider_id, at desc);

revoke all on table private.provider_definition_override_emails from public, anon, authenticated, service_role;
revoke all on table private.provider_definitions from public, anon, authenticated, service_role;
revoke all on table private.provider_definition_revisions from public, anon, authenticated, service_role;
revoke all on table private.provider_audit_log from public, anon, authenticated, service_role;

-- Defense in depth, as for the kill switch tables: no policies, so any role
-- other than the owner sees nothing even if a grant is added by mistake.
alter table private.provider_definition_override_emails enable row level security;
alter table private.provider_definition_override_emails force row level security;
alter table private.provider_definitions enable row level security;
alter table private.provider_definitions force row level security;
alter table private.provider_definition_revisions enable row level security;
alter table private.provider_definition_revisions force row level security;
alter table private.provider_audit_log enable row level security;
alter table private.provider_audit_log force row level security;

-- =====================================================================
-- Append-only guards
-- =====================================================================
-- Same guarantee as the kill switch audit: no application role, admin RPC or
-- worker can rewrite history. Not tamper proof against the owner or a
-- superuser, who can disable triggers or drop the table.
create or replace function private.provider_audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'provider_audit_log is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists provider_audit_log_no_update_delete on private.provider_audit_log;
create trigger provider_audit_log_no_update_delete
  before update or delete on private.provider_audit_log
  for each row execute function private.provider_audit_log_immutable();
drop trigger if exists provider_audit_log_no_truncate on private.provider_audit_log;
create trigger provider_audit_log_no_truncate
  before truncate on private.provider_audit_log
  for each statement execute function private.provider_audit_log_immutable();

-- A revision is decided once: only pending -> approved/rejected, and only the
-- decision columns change. Nothing deletes a revision.
create or replace function private.provider_definition_revisions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and old.decision = 'pending'
    and new.decision in ('approved', 'rejected')
    and (new.id, new.definition_id, new.version, new.payload, new.proposed_by, new.proposed_at)
      is not distinct from (old.id, old.definition_id, old.version, old.payload, old.proposed_by, old.proposed_at) then
    return new;
  end if;
  raise exception 'provider_definition_revisions is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists provider_definition_revisions_guard on private.provider_definition_revisions;
create trigger provider_definition_revisions_guard
  before update or delete on private.provider_definition_revisions
  for each row execute function private.provider_definition_revisions_guard();
drop trigger if exists provider_definition_revisions_no_truncate on private.provider_definition_revisions;
create trigger provider_definition_revisions_no_truncate
  before truncate on private.provider_definition_revisions
  for each statement execute function private.provider_definition_revisions_guard();

-- Definitions are retired, never deleted.
create or replace function private.provider_definitions_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'provider_definitions rows are retired, not deleted' using errcode = '42501';
end;
$$;

drop trigger if exists provider_definitions_no_delete on private.provider_definitions;
create trigger provider_definitions_no_delete
  before delete on private.provider_definitions
  for each row execute function private.provider_definitions_no_delete();
drop trigger if exists provider_definitions_no_truncate on private.provider_definitions;
create trigger provider_definitions_no_truncate
  before truncate on private.provider_definitions
  for each statement execute function private.provider_definitions_no_delete();

revoke all on function private.provider_audit_log_immutable() from public, anon, authenticated, service_role;
revoke all on function private.provider_definition_revisions_guard() from public, anon, authenticated, service_role;
revoke all on function private.provider_definitions_no_delete() from public, anon, authenticated, service_role;

-- =====================================================================
-- Internal helpers (owner only)
-- =====================================================================

-- The guard every admin RPC calls first: verified auth, platform admin, AAL2.
-- Returns the caller's user id.
-- Not SECURITY DEFINER itself: it only runs inside the definer RPCs below.
create or replace function private.require_provider_definition_admin()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider definition administration.'
      using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function private.provider_definition_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  return v_reason;
end;
$$;

-- The configuration a revision snapshots (everything a reviewer approves).
create or replace function private.provider_definition_payload(p_row private.provider_definitions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'slug', p_row.slug,
    'displayName', p_row.display_name,
    'kind', p_row.kind,
    'quoteCurrency', p_row.quote_currency,
    'hostAllowlist', pg_catalog.to_jsonb(p_row.host_allowlist),
    'admission', p_row.admission,
    'credentialRef', p_row.credential_ref,
    'exportJurisdiction', p_row.export_jurisdiction,
    'exportControlledAllowed', p_row.export_controlled_allowed
  );
$$;

-- The full row as audit before/after.
create or replace function private.provider_definition_state(p_row private.provider_definitions)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_row.id is null then null else
    private.provider_definition_payload(p_row) || pg_catalog.jsonb_build_object(
      'id', p_row.id,
      'status', p_row.status,
      'version', p_row.version,
      'approvedRevisionId', p_row.approved_revision_id,
      'dryRunPassedVersion', p_row.dry_run_passed_version,
      'dryRunCheckedAt', p_row.dry_run_checked_at,
      'dryRunEvidenceRef', p_row.dry_run_evidence_ref,
      'updatedAt', p_row.updated_at)
  end;
$$;

-- Reads the editable fields from an RPC payload. Unknown keys are refused so
-- a typo cannot silently drop a field. Table constraints do the rest.
create or replace function private.provider_definition_check_input(p_definition jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_definition is null or pg_catalog.jsonb_typeof(p_definition) <> 'object' then
    raise exception 'definition_object_required' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_definition) k
    where k not in ('displayName', 'kind', 'quoteCurrency', 'hostAllowlist', 'admission',
                    'credentialRef', 'exportJurisdiction', 'exportControlledAllowed')
  ) then
    raise exception 'definition_unknown_key' using errcode = '22023';
  end if;
  if p_definition ? 'hostAllowlist'
    and pg_catalog.jsonb_typeof(p_definition -> 'hostAllowlist') <> 'array' then
    raise exception 'host_allowlist_array_required' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.provider_request_id()
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.left(
    (nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb) ->> 'x-request-id', 200);
$$;

create or replace function private.write_provider_audit(
  p_actor uuid,
  p_provider_id uuid,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_reason text
)
returns void
language sql
set search_path = ''
as $$
  insert into private.provider_audit_log (actor, actor_kind, provider_id, action, before, after, reason, request_id)
  values (p_actor::text, 'user', p_provider_id, p_action, p_before, p_after, p_reason, private.provider_request_id());
$$;

-- Locks and returns the definition; a missing id is refused.
create or replace function private.lock_provider_definition(p_id uuid)
returns private.provider_definitions
language plpgsql
set search_path = ''
as $$
declare
  v_row private.provider_definitions;
begin
  select d.* into v_row from private.provider_definitions d where d.id = p_id for update;
  if v_row.id is null then
    raise exception 'provider_definition_not_found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function private.require_provider_status(
  p_row private.provider_definitions,
  p_allowed private.provider_status[],
  p_action text
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not (p_row.status = any (p_allowed)) then
    raise exception 'invalid_provider_transition'
      using errcode = 'P0001',
            detail = pg_catalog.format('%s is not allowed from %s', p_action, p_row.status);
  end if;
end;
$$;

-- Shared body of the simple status moves (activate, suspend, reopen, retire).
create or replace function private.move_provider_definition(
  p_actor uuid,
  p_id uuid,
  p_action text,
  p_from private.provider_status[],
  p_to private.provider_status,
  p_reason text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
begin
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, p_from, p_action);

  if p_to = 'active' then
    if v_before.export_jurisdiction is null or v_before.export_controlled_allowed is null then
      raise exception 'export_control_fields_required' using errcode = 'P0001';
    end if;
    if v_before.dry_run_passed_version is distinct from v_before.version then
      raise exception 'dry_run_required' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from private.provider_definition_revisions r
      where r.id = v_before.approved_revision_id and r.decision = 'approved'
        and r.version = v_before.version
        and r.payload = private.provider_definition_payload(v_before)
    ) then
      raise exception 'approved_revision_mismatch' using errcode = 'P0001';
    end if;
  end if;

  update private.provider_definitions d
  set status = p_to,
      -- Going back to draft invalidates the dry run: a new version must earn its own.
      dry_run_passed_version = case when p_to = 'draft' then null else d.dry_run_passed_version end,
      updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(p_actor, p_id, p_action,
    private.provider_definition_state(v_before), private.provider_definition_state(v_after), v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

revoke all on function private.require_provider_definition_admin() from public, anon, authenticated, service_role;
revoke all on function private.provider_definition_reason(text) from public, anon, authenticated, service_role;
revoke all on function private.provider_definition_payload(private.provider_definitions) from public, anon, authenticated, service_role;
revoke all on function private.provider_definition_state(private.provider_definitions) from public, anon, authenticated, service_role;
revoke all on function private.provider_definition_check_input(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.provider_request_id() from public, anon, authenticated, service_role;
revoke all on function private.write_provider_audit(uuid, uuid, text, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.lock_provider_definition(uuid) from public, anon, authenticated, service_role;
revoke all on function private.require_provider_status(private.provider_definitions, private.provider_status[], text) from public, anon, authenticated, service_role;
revoke all on function private.move_provider_definition(uuid, uuid, text, private.provider_status[], private.provider_status, text) from public, anon, authenticated, service_role;

-- =====================================================================
-- Admin transition RPCs (authenticated; verified, platform admin, AAL2)
-- =====================================================================

create or replace function public.api_admin_create_provider_definition(
  p_slug text,
  p_definition jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_after private.provider_definitions;
begin
  perform private.provider_definition_check_input(p_definition);

  insert into private.provider_definitions (
    slug, display_name, kind, quote_currency, host_allowlist, admission,
    credential_ref, export_jurisdiction, export_controlled_allowed, created_by)
  values (
    p_slug,
    p_definition ->> 'displayName',
    p_definition ->> 'kind',
    coalesce(p_definition ->> 'quoteCurrency', 'USD'),
    coalesce(array(select pg_catalog.jsonb_array_elements_text(p_definition -> 'hostAllowlist')), '{}'),
    p_definition -> 'admission',
    p_definition ->> 'credentialRef',
    p_definition ->> 'exportJurisdiction',
    (p_definition ->> 'exportControlledAllowed')::boolean,
    v_actor)
  returning * into v_after;

  perform private.write_provider_audit(v_actor, v_after.id, 'create',
    null, private.provider_definition_state(v_after), v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

-- Replaces every editable field (a missing key clears it). Draft only; the
-- slug never changes.
create or replace function public.api_admin_update_provider_definition_draft(
  p_id uuid,
  p_definition jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
begin
  perform private.provider_definition_check_input(p_definition);
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, array['draft']::private.provider_status[], 'update_draft');

  update private.provider_definitions d
  set display_name = p_definition ->> 'displayName',
      kind = p_definition ->> 'kind',
      quote_currency = coalesce(p_definition ->> 'quoteCurrency', 'USD'),
      host_allowlist = coalesce(array(select pg_catalog.jsonb_array_elements_text(p_definition -> 'hostAllowlist')), '{}'),
      admission = p_definition -> 'admission',
      credential_ref = p_definition ->> 'credentialRef',
      export_jurisdiction = p_definition ->> 'exportJurisdiction',
      export_controlled_allowed = (p_definition ->> 'exportControlledAllowed')::boolean,
      updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(v_actor, p_id, 'update_draft',
    private.provider_definition_state(v_before), private.provider_definition_state(v_after), v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

-- Snapshots the draft as the next revision (decision pending).
create or replace function public.api_admin_submit_provider_definition(
  p_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
  v_revision_id uuid;
begin
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, array['draft']::private.provider_status[], 'submit');

  insert into private.provider_definition_revisions (definition_id, version, payload, proposed_by, reason)
  values (
    p_id,
    coalesce((select pg_catalog.max(r.version) from private.provider_definition_revisions r
              where r.definition_id = p_id), 0) + 1,
    private.provider_definition_payload(v_before),
    v_actor,
    v_reason)
  returning id into v_revision_id;

  update private.provider_definitions d
  set status = 'pending_review', updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(v_actor, p_id, 'submit',
    private.provider_definition_state(v_before),
    private.provider_definition_state(v_after) || pg_catalog.jsonb_build_object('revisionId', v_revision_id),
    v_reason);
  return private.provider_definition_state(v_after) || pg_catalog.jsonb_build_object('revisionId', v_revision_id);
end;
$$;

create or replace function public.api_admin_approve_provider_definition(
  p_id uuid,
  p_reason text,
  p_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
  v_revision private.provider_definition_revisions;
  v_override boolean := false;
begin
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, array['pending_review']::private.provider_status[], 'approve');

  select r.* into strict v_revision
  from private.provider_definition_revisions r
  where r.definition_id = p_id and r.decision = 'pending'
  for update;

  if v_revision.proposed_by is not distinct from v_actor then
    if not coalesce(p_override, false) then
      raise exception 'four_eyes_required' using errcode = '42501';
    end if;
    if not exists (
      select 1 from auth.users u
      join private.provider_definition_override_emails o on o.email = pg_catalog.lower(u.email)
      where u.id = v_actor
    ) then
      raise exception 'four_eyes_override_not_permitted' using errcode = '42501';
    end if;
    v_override := true;
  elsif coalesce(p_override, false) then
    -- Keep the record honest: an override is only ever a self-approval.
    raise exception 'four_eyes_override_not_needed' using errcode = '22023';
  end if;

  update private.provider_definition_revisions r
  set decision = 'approved',
      reviewed_by = v_actor,
      decided_at = pg_catalog.clock_timestamp(),
      reason = v_reason,
      four_eyes_override = v_override
  where r.id = v_revision.id;

  update private.provider_definitions d
  set status = 'approved',
      version = v_revision.version,
      approved_revision_id = v_revision.id,
      dry_run_passed_version = null,
      updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(v_actor, p_id,
    case when v_override then 'approve_override' else 'approve' end,
    private.provider_definition_state(v_before),
    private.provider_definition_state(v_after)
      || pg_catalog.jsonb_build_object('revisionId', v_revision.id, 'fourEyesOverride', v_override),
    v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

create or replace function public.api_admin_reject_provider_definition(
  p_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
  v_revision_id uuid;
begin
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, array['pending_review']::private.provider_status[], 'reject');

  update private.provider_definition_revisions r
  set decision = 'rejected', reviewed_by = v_actor,
      decided_at = pg_catalog.clock_timestamp(), reason = v_reason
  where r.definition_id = p_id and r.decision = 'pending'
  returning r.id into strict v_revision_id;

  update private.provider_definitions d
  set status = 'draft', updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(v_actor, p_id, 'reject',
    private.provider_definition_state(v_before),
    private.provider_definition_state(v_after) || pg_catalog.jsonb_build_object('revisionId', v_revision_id),
    v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

-- Records the result of the offline dry-run check for the approved version.
-- The database performs no dispatch; the caller supplies the evidence
-- reference (for example a qualification run id). A failing result clears
-- any earlier pass.
create or replace function public.api_admin_record_provider_dry_run(
  p_id uuid,
  p_passed boolean,
  p_evidence_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
  v_reason text := private.provider_definition_reason(p_reason);
  v_before private.provider_definitions;
  v_after private.provider_definitions;
begin
  if p_passed is null then
    raise exception 'dry_run_result_required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_evidence_ref, ''))) = 0 then
    raise exception 'dry_run_evidence_required' using errcode = '22023';
  end if;
  v_before := private.lock_provider_definition(p_id);
  perform private.require_provider_status(v_before, array['approved']::private.provider_status[], 'record_dry_run');

  update private.provider_definitions d
  set dry_run_passed_version = case when p_passed then d.version else null end,
      dry_run_checked_at = pg_catalog.clock_timestamp(),
      dry_run_evidence_ref = pg_catalog.btrim(p_evidence_ref),
      updated_at = pg_catalog.clock_timestamp()
  where d.id = p_id
  returning d.* into v_after;

  perform private.write_provider_audit(v_actor, p_id, 'record_dry_run',
    private.provider_definition_state(v_before),
    private.provider_definition_state(v_after) || pg_catalog.jsonb_build_object('dryRunPassed', p_passed),
    v_reason);
  return private.provider_definition_state(v_after);
end;
$$;

create or replace function public.api_admin_activate_provider_definition(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
begin
  return private.move_provider_definition(v_actor, p_id, 'activate',
    array['approved', 'suspended']::private.provider_status[], 'active', p_reason);
end;
$$;

create or replace function public.api_admin_suspend_provider_definition(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
begin
  return private.move_provider_definition(v_actor, p_id, 'suspend',
    array['active']::private.provider_status[], 'suspended', p_reason);
end;
$$;

create or replace function public.api_admin_reopen_provider_definition(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
begin
  return private.move_provider_definition(v_actor, p_id, 'reopen',
    array['approved', 'suspended']::private.provider_status[], 'draft', p_reason);
end;
$$;

create or replace function public.api_admin_retire_provider_definition(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_provider_definition_admin();
begin
  return private.move_provider_definition(v_actor, p_id, 'retire',
    array['draft', 'approved', 'active', 'suspended']::private.provider_status[], 'retired', p_reason);
end;
$$;

-- =====================================================================
-- Admin reads (authenticated; verified, platform admin, AAL2; no audit row)
-- =====================================================================

create or replace function public.api_admin_list_provider_definitions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_provider_definition_admin();
  return pg_catalog.jsonb_build_object(
    'schema', 'provider-definitions-admin.v1',
    'providers', coalesce((
      select pg_catalog.jsonb_agg(private.provider_definition_state(d) order by d.slug)
      from private.provider_definitions d
    ), '[]'::jsonb));
end;
$$;

create or replace function public.api_admin_list_provider_definition_history(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_provider_definition_admin();
  return pg_catalog.jsonb_build_object(
    'schema', 'provider-definition-history.v1',
    'revisions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'version', r.version, 'payload', r.payload,
        'proposedBy', r.proposed_by, 'proposedAt', r.proposed_at,
        'reviewedBy', r.reviewed_by, 'decision', r.decision, 'decidedAt', r.decided_at,
        'reason', r.reason, 'fourEyesOverride', r.four_eyes_override) order by r.version)
      from private.provider_definition_revisions r where r.definition_id = p_id
    ), '[]'::jsonb),
    'audit', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'at', a.at, 'actor', a.actor, 'actorKind', a.actor_kind,
        'action', a.action, 'before', a.before, 'after', a.after,
        'reason', a.reason, 'requestId', a.request_id) order by a.id)
      from private.provider_audit_log a where a.provider_id = p_id
    ), '[]'::jsonb));
end;
$$;

-- =====================================================================
-- Worker read (service_role only)
-- =====================================================================
-- Active definitions only. Kill switches win: a provider whose switch is
-- engaged, whose slug has no switch row (fail closed, including slugs that
-- are not yet a vendor_name value), or any provider while the global switch
-- is engaged, is left out.
create or replace function public.api_service_list_active_provider_definitions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-definitions-active.v1',
    'providers', coalesce((
      select pg_catalog.jsonb_agg(
        private.provider_definition_payload(d)
          || pg_catalog.jsonb_build_object('id', d.id, 'version', d.version,
               'approvedRevisionId', d.approved_revision_id)
        order by d.slug)
      from private.provider_definitions d
      where d.status = 'active'
        and not private.provider_kill_switch_engaged_text(d.slug)
    ), '[]'::jsonb));
$$;

-- =====================================================================
-- Grants
-- =====================================================================
revoke all on function public.api_admin_create_provider_definition(text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_update_provider_definition_draft(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_submit_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_approve_provider_definition(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_reject_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_record_provider_dry_run(uuid, boolean, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_activate_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_suspend_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_reopen_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_retire_provider_definition(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_admin_list_provider_definitions() from public, anon, authenticated, service_role;
revoke all on function public.api_admin_list_provider_definition_history(uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_service_list_active_provider_definitions() from public, anon, authenticated, service_role;

grant execute on function public.api_admin_create_provider_definition(text, jsonb, text) to authenticated;
grant execute on function public.api_admin_update_provider_definition_draft(uuid, jsonb, text) to authenticated;
grant execute on function public.api_admin_submit_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_approve_provider_definition(uuid, text, boolean) to authenticated;
grant execute on function public.api_admin_reject_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_record_provider_dry_run(uuid, boolean, text, text) to authenticated;
grant execute on function public.api_admin_activate_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_suspend_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_reopen_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_retire_provider_definition(uuid, text) to authenticated;
grant execute on function public.api_admin_list_provider_definitions() to authenticated;
grant execute on function public.api_admin_list_provider_definition_history(uuid) to authenticated;
grant execute on function public.api_service_list_active_provider_definitions() to service_role;
