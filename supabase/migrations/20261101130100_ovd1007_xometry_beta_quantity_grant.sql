-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-1007: a single-use, per-request quantity grant for the controlled
-- Xometry beta, so one named request can be quoted above quantity 1 while the
-- global controlled_beta_user_quantity switch (OVD-987) stays off.
--
-- Decision (Blaine, 2026-10-31 17:53): "Yes, build the single-use grant as a
-- migration (staging first) and use it for the OVD-1000 qty-10 internal run".
-- Staging first (docs/runbooks/staging.md). Production apply needs Blaine's
-- approval card. This file sorts after OVD-979 (20261020002127) and OVD-987
-- (20261031224054) and needs OVD-987 applied: the precondition refuses
-- otherwise.
--
-- Rollback: docs/migration-drafts/ovd-1007.rollback.sql. It restores the
-- OVD-987 bodies, drops the new functions, and drops the two grant tables only
-- while they are empty; with any grant history it keeps them (revoked from
-- every API role) so no audit row is deleted.
--
-- Transaction: no begin/commit of its own; apply it as one transaction
-- (psql --single-transaction -v ON_ERROR_STOP=1 -f <file>, or the Supabase
-- CLI). Every statement can be re-run. No enum value, no CONCURRENTLY, no
-- extension, no change to an existing table.
--
-- What changes:
--   1. private.xometry_beta_quantity_grants: one row per grant, bound to a
--      job (its one request), the quantity and the scope fingerprint the
--      operator granted, and, once used, the permit, approval reference and
--      quote request that consumed it. Single use: consumed_at is set once.
--      Revoked is set once and never cleared. Rows are never deleted: a
--      trigger rejects DELETE and TRUNCATE and every update other than the
--      consume and revoke transitions. At most one live (unconsumed,
--      unrevoked) grant per job. RLS on, no policy, no API-role privilege.
--   2. private.xometry_beta_quantity_grant_events: the immutable audit log
--      (grant, consume, revoke), one row per revision bump, with actor, role,
--      reason and idempotency key. RLS on, no policy, no API-role privilege.
--   3. public.api_grant_xometry_beta_quantity and
--      public.api_revoke_xometry_beta_quantity_grant: service_role only,
--      idempotent, audited, revisioned, after the
--      api_set_commercial_rollout_control pattern. Granting binds the job's
--      current single Xometry candidate (its quantity must be the granted one)
--      and its scope fingerprint. Revoking needs the expected revision.
--      Both take the exclusive advisory lock
--      xometry-beta-quantity-grant:<job>.
--   4. private.xometry_beta_quantity_grant_id: the one grant reader. A live
--      grant for a fresh request, or for a replay the grant its permit
--      consumed, never revoked, optionally matching fingerprint and quantity.
--   5. public.api_get_quantity_scope(p_job_id): the quantity-scope.v1 read the
--      client already calls (src/features/quotes/quantity-scope.ts). grant is
--      'request' while a live grant names the job, else 'participant' while
--      the global switch is on (it admits every eligible beta participant),
--      else null; state is multiple_allowed exactly when grant is not null.
--   6. Restated from their OVD-987 definitions, only the quantity gate changed:
--        S1 private.resolve_xometry_beta_dispatch_scope_with_access: a
--           quantity above 1 passes with the switch on, or with a grant for
--           this job that names this exact quantity and fingerprint.
--        S3 public.api_request_xometry_beta_dispatch: a lane above 1 takes
--           the matching live grant FOR UPDATE NOWAIT (xometry_beta_job_busy
--           if held, keeping the OVD-598 heavyweight-wait invariant) and
--           consumes it with the new permit. A matching live grant is
--           consumed even while the switch is on. A replay of the committed
--           request is admitted by the grant its permit consumed.
--        S4 public.api_authorize_xometry_beta_worker_dispatch: a lane above 1
--           also takes the shared advisory lock
--           xometry-beta-quantity-grant:<job> and passes with the switch on or
--           with the unrevoked grant its permit consumed, else
--           dispatch_quantity_not_admitted. So a revoke mid-flight behaves
--           like switching off: the next preflight refuses; a lane already
--           past S4 still launches.
--      S5 to S7 (the free-beta meter) are untouched and never read the switch
--      or the grant, so a permit issued at N settles after a revoke.
--   Security attributes, search_path, owner, revokes and grants of the
--   restated functions are unchanged and restated.
--
-- Locks: S3 takes no new heavyweight wait (NOWAIT row lock). S4 takes the
-- grant lock shared after the switch lock; the setters take only the grant
-- lock (exclusive) and then the grant row, and S3 never takes the advisory
-- lock, so no cycle: a revoke waits for an in-flight S4, a later S4 sees it.
--
-- Precondition: the block below refuses unless S1, S3 and S4 are the OVD-987
-- definitions or already this file's.
-- =====================================================================

set local lock_timeout = '5s';

do $ovd1007_precondition$
declare
  v_expected record;
  v_md5 text;
begin
  for v_expected in
    select * from (values
      ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)', '916594293cfc4e66053acf4c7414b2ba', '1d482bb5747127128e041549291eae6e'),
      ('public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', '28c932e1ccf964302ffed42d9ce4bc0b', 'be3fd395b4e84ddb118d643386a7bfde'),
      ('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', '0fef772880a4122f72475a9905b7ed19', '5d7e026241a0346a6624063e86a088f7')
    ) as expected(signature, previous_md5, applied_md5)
  loop
    select pg_catalog.md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure(v_expected.signature);
    if v_md5 is null or v_md5 not in (v_expected.previous_md5, v_expected.applied_md5) then
      raise exception 'OVD-1007 refused: % is not the definition this migration was reviewed against (md5 %)',
        v_expected.signature, coalesce(v_md5, 'missing')
        using errcode = 'P0001';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('private.xometry_beta_user_quantity_enabled()') is null then
    raise exception 'OVD-1007 refused: OVD-987 (controlled_beta_user_quantity) is not applied'
      using errcode = 'P0001';
  end if;
end;
$ovd1007_precondition$;

-- 1. Grants: never deleted; consume and revoke are one-way updates.
create or replace function private.reject_xometry_beta_quantity_grant_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Xometry beta quantity grants are never deleted; revoke them.';
end;
$$;

revoke all on function private.reject_xometry_beta_quantity_grant_truncate()
  from public, anon, authenticated, service_role;

create table if not exists private.xometry_beta_quantity_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  requested_quantity integer not null,
  scope_version integer not null,
  scope_fingerprint text not null,
  revision bigint not null default 1,
  grant_reason text not null,
  granted_at timestamptz not null default pg_catalog.now(),
  granted_by_user_id uuid,
  granted_by_actor text not null,
  granted_by_role text not null,
  revoked boolean not null default false,
  revoked_at timestamptz,
  revoke_reason text,
  revoked_by_actor text,
  consumed_at timestamptz,
  consumed_permit_id uuid,
  consumed_approval_reference uuid,
  consumed_quote_request_id uuid,
  constraint xometry_beta_quantity_grants_quantity_check check (requested_quantity > 1),
  constraint xometry_beta_quantity_grants_fingerprint_check check (
    pg_catalog.length(pg_catalog.btrim(scope_fingerprint)) > 0
  ),
  constraint xometry_beta_quantity_grants_revision_check check (revision >= 1),
  constraint xometry_beta_quantity_grants_reason_check check (
    pg_catalog.length(pg_catalog.btrim(grant_reason)) between 3 and 500
  ),
  constraint xometry_beta_quantity_grants_actor_check check (
    pg_catalog.length(pg_catalog.btrim(granted_by_actor)) between 3 and 200
  ),
  constraint xometry_beta_quantity_grants_revoked_check check (
    (not revoked and revoked_at is null and revoke_reason is null and revoked_by_actor is null)
    or (revoked and revoked_at is not null
      and pg_catalog.length(pg_catalog.btrim(revoke_reason)) between 3 and 500
      and pg_catalog.length(pg_catalog.btrim(revoked_by_actor)) between 3 and 200)
  ),
  constraint xometry_beta_quantity_grants_consumed_check check (
    (consumed_at is null and consumed_permit_id is null
      and consumed_approval_reference is null and consumed_quote_request_id is null)
    or (consumed_at is not null and consumed_permit_id is not null
      and consumed_approval_reference is not null and consumed_quote_request_id is not null)
  )
);

create unique index if not exists xometry_beta_quantity_grants_one_live_per_job
  on private.xometry_beta_quantity_grants (job_id)
  where not revoked and consumed_at is null;
create unique index if not exists xometry_beta_quantity_grants_consumed_permit
  on private.xometry_beta_quantity_grants (consumed_permit_id)
  where consumed_permit_id is not null;

alter table private.xometry_beta_quantity_grants enable row level security;
revoke all on private.xometry_beta_quantity_grants
  from public, anon, authenticated, service_role;

-- 2. Audit events: immutable.
create table if not exists private.xometry_beta_quantity_grant_events (
  id bigint generated always as identity primary key,
  grant_id uuid not null,
  job_id uuid not null,
  action text not null,
  idempotency_key text not null,
  previous_revision bigint not null,
  revision bigint not null,
  reason text not null,
  actor text not null,
  actor_user_id uuid,
  actor_role text not null,
  permit_id uuid,
  occurred_at timestamptz not null default pg_catalog.now(),
  constraint xometry_beta_quantity_grant_events_action_check check (
    action in ('grant', 'consume', 'revoke')
  ),
  constraint xometry_beta_quantity_grant_events_idempotency_check check (
    pg_catalog.length(pg_catalog.btrim(idempotency_key)) between 8 and 200
  ),
  constraint xometry_beta_quantity_grant_events_idempotency_key unique (idempotency_key),
  constraint xometry_beta_quantity_grant_events_revision_check check (
    previous_revision >= 0 and revision = previous_revision + 1
  ),
  constraint xometry_beta_quantity_grant_events_reason_check check (
    pg_catalog.length(pg_catalog.btrim(reason)) between 3 and 500
  ),
  constraint xometry_beta_quantity_grant_events_actor_check check (
    pg_catalog.length(pg_catalog.btrim(actor)) between 3 and 200
  ),
  constraint xometry_beta_quantity_grant_events_role_check check (
    pg_catalog.length(pg_catalog.btrim(actor_role)) > 0
  ),
  constraint xometry_beta_quantity_grant_events_permit_check check (
    (action = 'consume') = (permit_id is not null)
  )
);

create index if not exists xometry_beta_quantity_grant_events_grant_idx
  on private.xometry_beta_quantity_grant_events (grant_id, id);

alter table private.xometry_beta_quantity_grant_events enable row level security;
revoke all on private.xometry_beta_quantity_grant_events
  from public, anon, authenticated, service_role;

create or replace function private.reject_xometry_beta_quantity_grant_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Xometry beta quantity grant events are immutable.';
end;
$$;

revoke all on function private.reject_xometry_beta_quantity_grant_event_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists reject_xometry_beta_quantity_grant_event_mutation
  on private.xometry_beta_quantity_grant_events;
create trigger reject_xometry_beta_quantity_grant_event_mutation
before update or delete on private.xometry_beta_quantity_grant_events
for each row execute function private.reject_xometry_beta_quantity_grant_event_mutation();

drop trigger if exists reject_xometry_beta_quantity_grant_event_truncate
  on private.xometry_beta_quantity_grant_events;
create trigger reject_xometry_beta_quantity_grant_event_truncate
before truncate on private.xometry_beta_quantity_grant_events
for each statement execute function private.reject_xometry_beta_quantity_grant_event_mutation();

-- A grant row changes only by one consume or one revoke, each one revision.
create or replace function private.guard_xometry_beta_quantity_grant_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'Xometry beta quantity grants are never deleted; revoke them.';
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.job_id is distinct from old.job_id
    or new.requested_quantity is distinct from old.requested_quantity
    or new.scope_version is distinct from old.scope_version
    or new.scope_fingerprint is distinct from old.scope_fingerprint
    or new.grant_reason is distinct from old.grant_reason
    or new.granted_at is distinct from old.granted_at
    or new.granted_by_user_id is distinct from old.granted_by_user_id
    or new.granted_by_actor is distinct from old.granted_by_actor
    or new.granted_by_role is distinct from old.granted_by_role
    or new.revision is distinct from old.revision + 1
    or (old.revoked and (
      not new.revoked
      or new.revoked_at is distinct from old.revoked_at
      or new.revoke_reason is distinct from old.revoke_reason
      or new.revoked_by_actor is distinct from old.revoked_by_actor))
    or (old.consumed_at is not null and (
      new.consumed_at is distinct from old.consumed_at
      or new.consumed_permit_id is distinct from old.consumed_permit_id
      or new.consumed_approval_reference is distinct from old.consumed_approval_reference
      or new.consumed_quote_request_id is distinct from old.consumed_quote_request_id))
    or (old.revoked and old.consumed_at is null and new.consumed_at is not null)
    or ((new.revoked and not old.revoked)
      = (new.consumed_at is not null and old.consumed_at is null)) then
    raise exception 'A Xometry beta quantity grant changes only by one consume or one revoke.';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_xometry_beta_quantity_grant_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_xometry_beta_quantity_grant_mutation
  on private.xometry_beta_quantity_grants;
create trigger guard_xometry_beta_quantity_grant_mutation
before update or delete on private.xometry_beta_quantity_grants
for each row execute function private.guard_xometry_beta_quantity_grant_mutation();

drop trigger if exists guard_xometry_beta_quantity_grant_truncate
  on private.xometry_beta_quantity_grants;
create trigger guard_xometry_beta_quantity_grant_truncate
before truncate on private.xometry_beta_quantity_grants
for each statement execute function private.reject_xometry_beta_quantity_grant_truncate();

-- 4. The one grant reader. p_permit_id null: a live grant (a fresh request).
-- p_permit_id set: the grant that permit consumed (a replay or the worker
-- preflight). Never a revoked grant.
create or replace function private.xometry_beta_quantity_grant_id(
  p_job_id uuid,
  p_permit_id uuid,
  p_scope_fingerprint text,
  p_requested_quantity integer
)
returns uuid
language sql
stable
set search_path = pg_catalog
as $$
  select grant_row.id
  from private.xometry_beta_quantity_grants grant_row
  where grant_row.job_id = p_job_id
    and not grant_row.revoked
    and case
      when p_permit_id is null then grant_row.consumed_at is null
      else grant_row.consumed_permit_id = p_permit_id
    end
    and (p_scope_fingerprint is null or grant_row.scope_fingerprint = p_scope_fingerprint)
    and (p_requested_quantity is null or grant_row.requested_quantity = p_requested_quantity)
  order by grant_row.granted_at desc, grant_row.id
  limit 1;
$$;

revoke all on function private.xometry_beta_quantity_grant_id(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;

-- Consumption, called only by S3 after it inserted the permit and while it
-- holds the grant row lock.
create or replace function private.consume_xometry_beta_quantity_grant(
  p_grant_id uuid,
  p_permit_id uuid,
  p_approval_reference uuid,
  p_quote_request_id uuid
)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_grant private.xometry_beta_quantity_grants%rowtype;
begin
  update private.xometry_beta_quantity_grants grant_row
  set
    consumed_at = pg_catalog.now(),
    consumed_permit_id = p_permit_id,
    consumed_approval_reference = p_approval_reference,
    consumed_quote_request_id = p_quote_request_id,
    revision = grant_row.revision + 1
  where grant_row.id = p_grant_id
    and not grant_row.revoked
    and grant_row.consumed_at is null
  returning grant_row.* into v_grant;
  if v_grant.id is null then
    raise exception 'xometry_beta_quantity_one_required';
  end if;

  insert into private.xometry_beta_quantity_grant_events (
    grant_id, job_id, action, idempotency_key, previous_revision, revision,
    reason, actor, actor_user_id, actor_role, permit_id
  ) values (
    v_grant.id, v_grant.job_id, 'consume', 'consume:' || p_permit_id::text,
    v_grant.revision - 1, v_grant.revision,
    'Consumed by quote request ' || p_quote_request_id::text,
    'api_request_xometry_beta_dispatch', auth.uid(),
    coalesce(auth.role(), current_user), p_permit_id
  );
end;
$$;

revoke all on function private.consume_xometry_beta_quantity_grant(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- 3. Setters (service_role only).
create or replace function public.api_grant_xometry_beta_quantity(
  p_job_id uuid,
  p_requested_quantity integer,
  p_change_reason text,
  p_operator text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_existing_event private.xometry_beta_quantity_grant_events%rowtype;
  v_grant private.xometry_beta_quantity_grants%rowtype;
  v_event private.xometry_beta_quantity_grant_events%rowtype;
  v_candidate record;
  v_candidate_count integer;
  v_reason text := pg_catalog.btrim(p_change_reason);
  v_operator text := pg_catalog.btrim(p_operator);
  v_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
begin
  if p_job_id is null then
    raise exception 'A job is required.';
  end if;
  if p_requested_quantity is null or p_requested_quantity <= 1 then
    raise exception 'A quantity grant is for a quantity above 1.';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'A change reason between 3 and 500 characters is required.';
  end if;
  if v_operator is null or pg_catalog.length(v_operator) not between 3 and 200 then
    raise exception 'An operator identity between 3 and 200 characters is required.';
  end if;
  if v_idempotency_key is null
     or pg_catalog.length(v_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || p_job_id::text, 0)
  );

  select event_row.* into v_existing_event
  from private.xometry_beta_quantity_grant_events event_row
  where event_row.idempotency_key = v_idempotency_key;

  if v_existing_event.id is not null then
    select grant_row.* into strict v_grant
    from private.xometry_beta_quantity_grants grant_row
    where grant_row.id = v_existing_event.grant_id;
    if v_existing_event.action <> 'grant'
      or v_grant.job_id is distinct from p_job_id
      or v_grant.requested_quantity is distinct from p_requested_quantity
      or v_existing_event.reason is distinct from v_reason
      or v_existing_event.actor is distinct from v_operator then
      raise exception 'Idempotency key has already been used for a different quantity-grant action.';
    end if;
    v_event := v_existing_event;
  else
    select job_row.* into v_job
    from public.jobs job_row
    where job_row.id = p_job_id;
    if v_job.id is null then
      raise exception 'Job % not found.', p_job_id;
    end if;

    if private.xometry_beta_quantity_grant_id(p_job_id, null, null, null) is not null then
      raise exception 'This job already has a live quantity grant; revoke it first.';
    end if;

    select count(*)::integer into v_candidate_count
    from private.quote_lane_candidates(p_job_id, array['xometry']::public.vendor_name[]);
    select candidate.* into v_candidate
    from private.quote_lane_candidates(p_job_id, array['xometry']::public.vendor_name[]) candidate;
    if v_candidate_count <> 1
      or v_candidate.organization_id is distinct from v_job.organization_id
      or v_candidate.requested_quantity is distinct from p_requested_quantity
      or v_candidate.scope_fingerprint is null then
      raise exception 'The job''s current Xometry scope is not one candidate at quantity %.', p_requested_quantity;
    end if;

    insert into private.xometry_beta_quantity_grants (
      organization_id, job_id, requested_quantity, scope_version,
      scope_fingerprint, revision, grant_reason, granted_by_user_id,
      granted_by_actor, granted_by_role
    ) values (
      v_job.organization_id, v_job.id, p_requested_quantity,
      v_candidate.scope_version, v_candidate.scope_fingerprint, 1, v_reason,
      auth.uid(), v_operator, coalesce(auth.role(), current_user)
    )
    returning * into v_grant;

    insert into private.xometry_beta_quantity_grant_events (
      grant_id, job_id, action, idempotency_key, previous_revision, revision,
      reason, actor, actor_user_id, actor_role
    ) values (
      v_grant.id, v_grant.job_id, 'grant', v_idempotency_key, 0, 1, v_reason,
      v_operator, auth.uid(), coalesce(auth.role(), current_user)
    )
    returning * into v_event;
  end if;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event.id,
    'grantId', v_grant.id,
    'organizationId', v_grant.organization_id,
    'jobId', v_grant.job_id,
    'requestedQuantity', v_grant.requested_quantity,
    'scopeVersion', v_grant.scope_version,
    'scopeFingerprint', v_grant.scope_fingerprint,
    'revision', v_event.revision,
    'changeReason', v_event.reason,
    'operator', v_event.actor,
    'idempotencyKey', v_event.idempotency_key,
    'replayed', v_existing_event.id is not null
  );
end;
$$;

revoke all on function public.api_grant_xometry_beta_quantity(uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_grant_xometry_beta_quantity(uuid, integer, text, text, text)
  to service_role;

create or replace function public.api_revoke_xometry_beta_quantity_grant(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_change_reason text,
  p_operator text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job_id uuid;
  v_existing_event private.xometry_beta_quantity_grant_events%rowtype;
  v_grant private.xometry_beta_quantity_grants%rowtype;
  v_event private.xometry_beta_quantity_grant_events%rowtype;
  v_reason text := pg_catalog.btrim(p_change_reason);
  v_operator text := pg_catalog.btrim(p_operator);
  v_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
begin
  if p_grant_id is null then
    raise exception 'A quantity grant is required.';
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'A positive expected revision is required.';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'A change reason between 3 and 500 characters is required.';
  end if;
  if v_operator is null or pg_catalog.length(v_operator) not between 3 and 200 then
    raise exception 'An operator identity between 3 and 200 characters is required.';
  end if;
  if v_idempotency_key is null
     or pg_catalog.length(v_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.';
  end if;

  select grant_row.job_id into v_job_id
  from private.xometry_beta_quantity_grants grant_row
  where grant_row.id = p_grant_id;
  if v_job_id is null then
    raise exception 'Quantity grant % not found.', p_grant_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || v_job_id::text, 0)
  );

  select event_row.* into v_existing_event
  from private.xometry_beta_quantity_grant_events event_row
  where event_row.idempotency_key = v_idempotency_key;

  if v_existing_event.id is not null then
    if v_existing_event.action <> 'revoke'
      or v_existing_event.grant_id is distinct from p_grant_id
      or v_existing_event.previous_revision is distinct from p_expected_revision
      or v_existing_event.reason is distinct from v_reason
      or v_existing_event.actor is distinct from v_operator then
      raise exception 'Idempotency key has already been used for a different quantity-grant action.';
    end if;
    select grant_row.* into strict v_grant
    from private.xometry_beta_quantity_grants grant_row
    where grant_row.id = p_grant_id;
    v_event := v_existing_event;
  else
    select grant_row.* into strict v_grant
    from private.xometry_beta_quantity_grants grant_row
    where grant_row.id = p_grant_id
    for update;

    if p_expected_revision <> v_grant.revision then
      raise exception 'Quantity grant changed; refresh and retry.';
    end if;
    if v_grant.revoked then
      raise exception 'Quantity grant is already revoked.';
    end if;

    update private.xometry_beta_quantity_grants grant_row
    set
      revoked = true,
      revoked_at = pg_catalog.now(),
      revoke_reason = v_reason,
      revoked_by_actor = v_operator,
      revision = grant_row.revision + 1
    where grant_row.id = p_grant_id
    returning grant_row.* into v_grant;

    insert into private.xometry_beta_quantity_grant_events (
      grant_id, job_id, action, idempotency_key, previous_revision, revision,
      reason, actor, actor_user_id, actor_role
    ) values (
      v_grant.id, v_grant.job_id, 'revoke', v_idempotency_key,
      v_grant.revision - 1, v_grant.revision, v_reason, v_operator,
      auth.uid(), coalesce(auth.role(), current_user)
    )
    returning * into v_event;
  end if;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event.id,
    'grantId', v_grant.id,
    'jobId', v_grant.job_id,
    'revoked', true,
    'consumed', v_grant.consumed_at is not null,
    'consumedPermitId', v_grant.consumed_permit_id,
    'revision', v_event.revision,
    'changeReason', v_event.reason,
    'operator', v_event.actor,
    'idempotencyKey', v_event.idempotency_key,
    'replayed', v_existing_event.id is not null
  );
end;
$$;

revoke all on function public.api_revoke_xometry_beta_quantity_grant(uuid, bigint, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_revoke_xometry_beta_quantity_grant(uuid, bigint, text, text, text)
  to service_role;

-- 5. The quantity-scope.v1 read (authenticated job editors).
create or replace function public.api_get_quantity_scope(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_grant text;
begin
  perform public.require_verified_auth();

  -- user_can_edit_job is false for an absent job, so an absent and a foreign
  -- id get the same answer before the job is read (the OVD-746 pattern).
  if not public.user_can_edit_job(p_job_id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if private.xometry_beta_quantity_grant_id(v_job.id, null, null, null) is not null then
    v_grant := 'request';
  elsif private.xometry_beta_user_quantity_enabled() then
    v_grant := 'participant';
  end if;

  return pg_catalog.jsonb_build_object(
    'schema', 'quantity-scope.v1',
    'jobId', v_job.id,
    'organizationId', v_job.organization_id,
    'actorUserId', auth.uid(),
    'state', case when v_grant is null then 'single_only' else 'multiple_allowed' end,
    'grant', v_grant
  );
end;
$$;

revoke all on function public.api_get_quantity_scope(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_get_quantity_scope(uuid) to authenticated;

-- 6. S1: resolver (latest OVD-987). Changed: the quantity gate also admits a grant.
create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(
  p_job_id uuid,
  p_declared_model_units text,
  p_existing_permit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_notice jsonb;
  v_beta_state jsonb;
  v_denial jsonb;
  v_effective_vendors public.vendor_name[];
  v_candidate record;
  v_special jsonb;
  v_process text;
  v_material text;
  v_finish text;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;
  if p_declared_model_units not in ('inch', 'millimeter') then
    raise exception 'Declared model units must be inch or millimeter.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_job.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_job.organization_id,
    auth.uid()
  );
  if v_beta_state ->> 'state' <> 'eligible' then
    raise exception 'Founding Beta access and current notice acceptance are required.';
  end if;

  v_denial := private.resolve_quote_access_for_permit(p_job_id, auth.uid(), p_existing_permit_id);
  if v_denial ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_denial ->> 'reasonCode', 'automatic_quote_unavailable'); -- NOSONAR: stable denial contract shared with the existing quote boundary
  end if;

  if not exists (
    select 1 from public.org_vendor_configs config
    where config.organization_id = v_job.organization_id
  ) then
    raise exception 'xometry_beta_explicit_vendor_config_required';
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_job.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors is distinct from array['xometry']::public.vendor_name[] then
    raise exception 'xometry_beta_exact_provider_set_required';
  end if;

  if (select count(*) from public.parts part where part.job_id = p_job_id) <> 1 then
    raise exception 'xometry_beta_exactly_one_part_required';
  end if;

  select part.* into v_part
  from public.parts part
  where part.job_id = p_job_id;
  if v_part.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_part_organization_mismatch';
  end if;

  select requirement.* into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_part.id;
  if v_requirement.id is null then
    raise exception 'xometry_beta_approved_requirements_required';
  end if;
  if v_requirement.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_requirement_organization_mismatch';
  end if;

  select file_row.* into v_cad
  from public.job_files file_row
  where file_row.id = v_part.cad_file_id;
  if v_cad.id is null
    or v_cad.job_id <> v_job.id
    or v_cad.organization_id <> v_job.organization_id
    or v_cad.file_kind <> 'cad'
    or lower(v_cad.original_name) !~ '\.(step|stp)$'
    or v_cad.trusted_content_sha256 is null
    or v_cad.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'xometry_beta_trusted_step_required';
  end if;

  if v_part.drawing_file_id is not null then
    select file_row.* into v_drawing
    from public.job_files file_row
    where file_row.id = v_part.drawing_file_id;
    if v_drawing.id is null
      or v_drawing.job_id <> v_job.id
      or v_drawing.organization_id <> v_job.organization_id
      or v_drawing.file_kind <> 'drawing'
      or lower(v_drawing.original_name) !~ '\.pdf$'
      or v_drawing.trusted_content_sha256 is null
      or v_drawing.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception 'xometry_beta_compatible_drawing_required';
    end if;
  end if;

  if public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  ) is distinct from array['manufacturing_quote']::text[] then
    raise exception 'xometry_beta_manufacturing_quote_only';
  end if;
  if public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  ) is distinct from array[1]::integer[]
    and not private.xometry_beta_user_quantity_enabled()
    -- OVD-1007: or a per-request grant for this job (its exact quantity and
    -- fingerprint are matched below, once the scope is known).
    and private.xometry_beta_quantity_grant_id(p_job_id, p_existing_permit_id, null, null) is null then
    raise exception 'xometry_beta_quantity_one_required';
  end if;
  -- OVD-987: while controlled_beta_user_quantity is on, one positive
  -- quantity of any size is admitted; several quantities (or none) are not.
  if pg_catalog.cardinality(public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  )) <> 1 then
    raise exception 'xometry_beta_single_quantity_required';
  end if;
  if v_requirement.applicable_vendors is null
    or coalesce(
      'xometry'::public.vendor_name = any(v_requirement.applicable_vendors),
      false
    ) is not true then
    raise exception 'xometry_beta_xometry_applicability_required';
  end if;

  v_process := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))),
    '[^a-z0-9]', '', 'g' -- NOSONAR: identical normalization is required for process, material, and finish
  );
  v_material := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(v_requirement.material)),
    '[^a-z0-9]', '', 'g'
  );
  v_finish := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.finish, ''))),
    '[^a-z0-9]', '', 'g'
  );
  if v_process not in ('cncmilling', 'cncmachining', 'milling') then
    raise exception 'xometry_beta_cnc_milling_required';
  end if;
  if v_material not in ('6061t6', '6061t6aluminum', 'aluminum6061t6') then
    raise exception 'xometry_beta_6061_t6_required';
  end if;
  if v_finish not in ('', 'asmachined') then
    raise exception 'xometry_beta_as_machined_required';
  end if;
  if v_requirement.tightest_tolerance_inch is null
    or v_requirement.tightest_tolerance_inch < 0.005 then
    raise exception 'xometry_beta_standard_tolerance_required';
  end if;
  if v_requirement.requested_by_date is not null then
    raise exception 'xometry_beta_special_delivery_date_not_supported';
  end if;

  v_special := coalesce(v_requirement.spec_snapshot, '{}'::jsonb);
  if nullif(pg_catalog.btrim(coalesce(v_special ->> 'threads', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'notes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'serviceNotes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,packagingNotes}', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,shippingNotes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{certifications,requiredCertifications}', '[]'::jsonb)) > 0
    or coalesce((v_special #>> '{certifications,materialCertificationRequired}')::boolean, false)
    or coalesce((v_special #>> '{certifications,certificateOfConformanceRequired}')::boolean, false)
    or coalesce(v_special #>> '{certifications,inspectionLevel}', 'standard') not in ('', 'standard')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{certifications,notes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{sourcing,preferredSuppliers}', '[]'::jsonb)) > 0
    or coalesce(v_special #>> '{sourcing,regionPreferenceOverride}', 'best_value') not in ('', 'best_value')
    or coalesce(v_special #>> '{sourcing,materialProvisioning}', 'supplier_to_source') not in ('', 'supplier_to_source')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{sourcing,notes}', '')), '') is not null
    or coalesce(v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{release,notes}', '')), '') is not null then
    raise exception 'xometry_beta_special_requirements_not_supported';
  end if;

  -- OVD-682: name the missing confirmed destination instead of letting the
  -- shared candidate path silently drop the Xometry lane.
  if private.current_confirmed_sourcing_address(v_job.organization_id) is null then
    raise exception 'xometry_beta_confirmed_sourcing_address_required';
  end if;

  select candidate.* into v_candidate
  from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  ) candidate;
  if not found then
    raise exception 'xometry_beta_exact_scope_required';
  end if;
  if (select count(*) from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  )) <> 1 then
    raise exception 'xometry_beta_exact_scope_required';
  end if;
  -- OVD-1007: without the switch, the grant must name this quantity and scope.
  if v_candidate.requested_quantity <> 1
    and not private.xometry_beta_user_quantity_enabled()
    and private.xometry_beta_quantity_grant_id(
      p_job_id,
      p_existing_permit_id,
      v_candidate.scope_fingerprint,
      v_candidate.requested_quantity
    ) is null then
    raise exception 'xometry_beta_quantity_one_required';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', v_job.organization_id, -- NOSONAR: stable public response key
    'jobId', v_job.id,
    'partId', v_candidate.part_id, -- NOSONAR: stable public response key
    'provider', v_candidate.vendor,
    'requestedQuantity', v_candidate.requested_quantity,
    'scopeVersion', v_candidate.scope_version,
    'scopeFingerprint', v_candidate.scope_fingerprint, -- NOSONAR: stable permit and preview contract key
    'scope', v_candidate.scope_snapshot,
    'declaredModelUnits', p_declared_model_units,
    'policyRevision', v_notice ->> 'policyRevision', -- NOSONAR: stable notice contract key
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid)
  from public, anon, authenticated, service_role;
-- Owner-only: callers are SECURITY DEFINER; no API role gets EXECUTE.
grant execute on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid) to postgres;

-- S3: legacy request (latest OVD-987). Changed: take and consume the grant.
create or replace function public.api_request_xometry_beta_dispatch(
  p_job_id uuid,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_policy_revision text,
  p_approval_reference uuid,
  p_authority_to_share boolean,
  p_non_export_controlled boolean,
  p_quote_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_scope jsonb;
  v_capacity jsonb;
  v_access jsonb;
  v_organization_id uuid;
  v_result jsonb;
  v_existing private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_task public.work_queue%rowtype;
  v_result_row public.vendor_quote_results%rowtype;
  v_permit_id uuid := gen_random_uuid();
  v_grant_id uuid;
begin
  perform public.require_verified_auth();
  v_capacity := private.lock_free_quote_capacity(p_job_id);
  select organization_id into strict v_organization_id from public.jobs where id=p_job_id;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-lane-submit:' || p_job_id::text, 0)
  );

  if p_authority_to_share is not true
    or p_non_export_controlled is not true
    or p_quote_only is not true then
    raise exception 'All Xometry beta dispatch affirmations are required.';
  end if;
  if p_approval_reference is null then
    raise exception 'A dispatch approval reference is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-approval:'
        || v_organization_id::text
        || ':'
        || p_approval_reference::text,
      0
    )
  );

  select permit.* into v_existing
  from private.xometry_beta_dispatch_permits permit
  where permit.organization_id = v_organization_id
    and permit.approval_reference = p_approval_reference;
  if v_existing.id is not null and (
    v_existing.actor_user_id <> auth.uid() or v_existing.job_id <> p_job_id
    or v_existing.scope_fingerprint is distinct from p_expected_scope_fingerprint
    or v_existing.declared_model_units is distinct from p_declared_model_units
    or v_existing.notice_revision is distinct from p_policy_revision
  ) then raise exception 'xometry_beta_approval_reference_reused'; end if;
  if v_existing.id is null then
    perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);
  end if;
  v_scope := private.resolve_xometry_beta_dispatch_scope_with_access(
    p_job_id,
    p_declared_model_units,
    v_existing.id
  );
  if p_expected_scope_fingerprint is null
    or p_expected_scope_fingerprint <> v_scope ->> 'scopeFingerprint' then
    raise exception 'xometry_beta_scope_changed';
  end if;
  if p_policy_revision is null
    or p_policy_revision <> v_scope ->> 'policyRevision' then
    raise exception 'xometry_beta_notice_changed';
  end if;

  if v_existing.id is not null then
    if v_existing.actor_user_id <> auth.uid()
      or v_existing.job_id <> p_job_id
      or v_existing.scope_fingerprint <> p_expected_scope_fingerprint
      or v_existing.declared_model_units <> p_declared_model_units
      or v_existing.notice_revision <> p_policy_revision then
      raise exception 'xometry_beta_approval_reference_reused';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true, -- NOSONAR: stable dispatch response key
      'created', false, -- NOSONAR: stable dispatch response key
      'deduplicated', true,
      'permitId', v_existing.id,
      'quoteRequestId', v_existing.quote_request_id, -- NOSONAR: stable dispatch response key
      'quoteRunId', v_existing.quote_run_id,
      'scopeFingerprint', v_existing.scope_fingerprint,
      'status', 'queued'
    );
  end if;

  v_access := private.resolve_quote_access(p_job_id,auth.uid());
  if v_access ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_access ->> 'reasonCode','free_policy_unavailable');
  end if;
  if v_access ->> 'source' = 'free_beta' and v_capacity ->> 'bucketId' is null then
    raise exception 'free_policy_unavailable';
  end if;

  v_result := private.request_scoped_automatic_quote_impl(
    p_job_id,
    array['xometry']::public.vendor_name[]
  );
  if coalesce((v_result ->> 'accepted')::boolean, false) is not true
    or coalesce((v_result ->> 'created')::boolean, false) is not true then
    raise exception 'xometry_beta_new_lane_required';
  end if;

  select lane.* into strict v_lane
  from public.quote_request_lanes lane
  where lane.quote_request_id = (v_result ->> 'quoteRequestId')::uuid;
  -- OVD-1007: a lane above 1 takes the live grant naming this job, quantity
  -- and fingerprint, without waiting (OVD-598 invariant); it is consumed
  -- with the permit below.
  if v_lane.requested_quantity <> 1 then
    v_grant_id := private.xometry_beta_quantity_grant_id(
      p_job_id, null, v_lane.scope_fingerprint, v_lane.requested_quantity
    );
    if v_grant_id is not null then
      begin
        perform 1
        from private.xometry_beta_quantity_grants grant_row
        where grant_row.id = v_grant_id
          and not grant_row.revoked
          and grant_row.consumed_at is null
        for update nowait;
        if not found then
          v_grant_id := null;
          -- Revoked or consumed since S1 read it: without the switch, deny
          -- with the quantity code, as S1 would now.
          if not private.xometry_beta_user_quantity_enabled() then
            raise exception 'xometry_beta_quantity_one_required';
          end if;
        end if;
      exception
        when lock_not_available then
          raise exception using errcode = 'P0001', message = 'xometry_beta_job_busy';
      end;
    end if;
  end if;
  if v_lane.vendor <> 'xometry'
    or v_lane.scope_fingerprint <> p_expected_scope_fingerprint
    or v_lane.part_id <> (v_scope ->> 'partId')::uuid
    -- OVD-987: the scope quantity while the switch is on, else 1.
    -- OVD-1007: or while a matching grant is held.
    or v_lane.requested_quantity is distinct from (case
      when private.xometry_beta_user_quantity_enabled() or v_grant_id is not null
        then (v_scope ->> 'requestedQuantity')::integer
      else 1
    end) then
    raise exception 'xometry_beta_created_lane_mismatch';
  end if;

  select result_row.* into strict v_result_row
  from public.vendor_quote_results result_row
  where result_row.id = v_lane.vendor_quote_result_id;

  select task.* into strict v_task
  from public.work_queue task
  where task.quote_run_id = v_lane.quote_run_id
    and task.part_id = v_lane.part_id
    and task.task_type = 'run_vendor_quote'
    and task.payload ->> 'vendor' = 'xometry';

  insert into private.xometry_beta_dispatch_permits (
    id, organization_id, job_id, part_id, quote_request_id, quote_run_id,
    vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
    actor_user_id, notice_revision, approval_reference, provider,
    scope_version, scope_fingerprint, declared_model_units,
    authority_to_share, non_export_controlled, quote_only
  ) values (
    v_permit_id, (v_scope ->> 'organizationId')::uuid, p_job_id,
    (v_scope ->> 'partId')::uuid, v_lane.quote_request_id, v_lane.quote_run_id,
    v_result_row.id, v_lane.id, v_task.id, auth.uid(), p_policy_revision,
    p_approval_reference, 'xometry', v_lane.scope_version,
    v_lane.scope_fingerprint, p_declared_model_units,
    p_authority_to_share, p_non_export_controlled, p_quote_only
  );

  if v_grant_id is not null then
    perform private.consume_xometry_beta_quantity_grant(
      v_grant_id, v_permit_id, p_approval_reference, v_lane.quote_request_id
    );
  end if;

  perform private.record_quote_access_admission(
    v_lane.quote_request_id, p_approval_reference, v_access ->> 'source',
    case when v_access ->> 'source' = 'free_beta' then (v_capacity ->> 'bucketId')::uuid else null end
  );

  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object(
    'xometryBetaDispatchPermitId', v_permit_id,
    'xometryBetaEnvelopeRevision', 'xometry-controlled-beta-envelope.v1',
    'quoteLaneScopeFingerprint', v_lane.scope_fingerprint
  )
  where id = v_task.id;

  return v_result || pg_catalog.jsonb_build_object(
    'permitId', v_permit_id,
    'scopeFingerprint', v_lane.scope_fingerprint,
    'declaredModelUnits', p_declared_model_units,
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) to authenticated;

-- S4: worker preflight (latest OVD-987). Changed: the quantity gate also admits the consumed grant.
create or replace function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_provider constant public.vendor_name := 'xometry';
  v_envelope_revision constant text := 'xometry-controlled-beta-envelope.v1';
  v_authorized_key constant text := 'authorized';
  v_reason_key constant text := 'reasonCode';
  v_task public.work_queue%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_job public.jobs%rowtype;
  v_request_status text;
  v_notice jsonb;
  v_beta_state jsonb;
  v_entitlements jsonb;
  v_admission jsonb;
  v_effective_vendors public.vendor_name[];
  v_current_candidate record;
  v_current_candidate_count integer;
  v_task_permit_id_text text;
begin
  if p_work_queue_task_id is null
    or p_vendor_quote_result_id is null
    or p_scope_snapshot is null
    or nullif(pg_catalog.btrim(p_expected_worker_name), '') is null
    or p_expected_claimed_at is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' <> v_provider::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_preflight_invalid_input'
    );
  end if;

  select task_row.* into v_task
  from public.work_queue task_row
  where task_row.id = p_work_queue_task_id
  for update;

  if v_task.id is null
    or v_task.task_type <> 'run_vendor_quote'
    or v_task.status <> 'running'
    or v_task.locked_at is null
    or v_task.locked_by is distinct from p_expected_worker_name
    or v_task.locked_at is distinct from p_expected_claimed_at then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_not_running'
    );
  end if;

  if v_task.payload ->> 'vendor' is distinct from v_provider::text
    or v_task.payload ->> 'vendorQuoteResultId' is distinct from p_vendor_quote_result_id::text
    or v_task.payload ->> 'quoteRunId' is distinct from v_task.quote_run_id::text
    or v_task.payload ->> 'partId' is distinct from v_task.part_id::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_identity_mismatch'
    );
  end if;

  v_task_permit_id_text := v_task.payload ->> 'xometryBetaDispatchPermitId';
  if v_task_permit_id_text is null
    or v_task_permit_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_task.payload ->> 'xometryBetaEnvelopeRevision' is distinct from v_envelope_revision
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is null then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_binding_missing'
    );
  end if;

  select permit_row.* into v_permit
  from private.xometry_beta_dispatch_permits permit_row
  where permit_row.id = v_task_permit_id_text::uuid;

  select result_row.* into v_result
  from public.vendor_quote_results result_row
  where result_row.id = p_vendor_quote_result_id;

  if v_permit.id is null
    or v_result.id is null
    or v_result.status <> 'running'
    or v_permit.provider <> v_provider
    or v_permit.envelope_revision <> v_envelope_revision
    or v_permit.authority_to_share is not true
    or v_permit.non_export_controlled is not true
    or v_permit.quote_only is not true
    or v_permit.work_queue_task_id <> v_task.id
    or v_permit.vendor_quote_result_id <> v_result.id
    or v_permit.organization_id <> v_task.organization_id
    or v_permit.organization_id <> v_result.organization_id
    or v_permit.job_id <> v_task.job_id
    or v_permit.part_id <> v_task.part_id
    or v_permit.part_id <> v_result.part_id
    or v_permit.quote_run_id <> v_task.quote_run_id
    or v_permit.quote_run_id <> v_result.quote_run_id then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_identity_mismatch'
    );
  end if;

  select lane_row.* into v_lane
  from public.quote_request_lanes lane_row
  where lane_row.id = v_permit.quote_request_lane_id;

  if v_lane.id is null
    or v_lane.organization_id <> v_permit.organization_id
    or v_lane.quote_request_id <> v_permit.quote_request_id
    or v_lane.quote_run_id <> v_permit.quote_run_id
    or v_lane.vendor_quote_result_id <> v_permit.vendor_quote_result_id
    or v_lane.part_id <> v_permit.part_id
    or v_lane.vendor <> v_provider
    -- OVD-987: the lane quantity must be the one its own scope snapshot states,
    -- and the result and the task payload the worker reads must name it too.
    or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity')
    or v_result.requested_quantity is distinct from v_lane.requested_quantity
    or (v_task.payload ? 'requestedQuantity'
      and v_task.payload ->> 'requestedQuantity' is distinct from v_lane.requested_quantity::text)
    or v_lane.scope_version <> v_permit.scope_version
    or v_lane.scope_fingerprint <> v_permit.scope_fingerprint
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is distinct from v_permit.scope_fingerprint then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_lane_identity_mismatch'
    );
  end if;

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = v_permit.job_id;

  select request_row.status::text into v_request_status
  from public.quote_requests request_row
  where request_row.id = v_permit.quote_request_id;

  if v_job.id is null
    or v_job.organization_id <> v_permit.organization_id
    or v_request_status is null
    or v_request_status not in ('queued', 'requesting') then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_request_inactive'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_permit.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_permit.organization_id,
    v_permit.actor_user_id
  );
  if v_beta_state ->> 'state' <> 'eligible'
    or v_notice ->> 'policyRevision' is distinct from v_permit.notice_revision then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_beta_authorization_revoked'
    );
  end if;

  v_admission := private.validate_quote_access_admission(v_permit.quote_request_id,v_permit.id);
  if v_admission ->> 'source' = 'free_beta' then
    if v_admission -> 'valid' is distinct from 'true'::jsonb
      or v_admission ->> 'state' is distinct from 'reserved' then
      return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
    end if;
  elsif (v_admission -> 'valid' = 'true'::jsonb
      and v_admission ->> 'source' = 'commercial_entitlement'
      and v_admission ->> 'state' = 'unmetered')
    or v_admission ->> 'reasonCode' = 'legacy_unrecorded' then
  v_entitlements := private.resolve_organization_entitlements_at(
    v_permit.organization_id,
    pg_catalog.now()
  );
  if coalesce(
    v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb,
    false
  ) is not true then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_automatic_access_revoked'
    );
  end if;

  else
    return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
  end if;

  if not private.automatic_quote_rollout_enabled_with_lock() then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_rollout_disabled'
    );
  end if;

  -- OVD-987: a lane above quantity 1 dispatches only while the
  -- controlled_beta_user_quantity switch is on. The shared lock makes an
  -- audited disable wait for this check, like the rollout check above.
  if v_lane.requested_quantity <> 1 then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0)
    );
    -- OVD-1007: or the unrevoked grant this permit consumed. The shared lock
    -- makes an audited revoke wait for this check.
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || v_permit.job_id::text, 0)
    );
    if not private.xometry_beta_user_quantity_enabled()
      and private.xometry_beta_quantity_grant_id(
        v_permit.job_id,
        v_permit.id,
        v_permit.scope_fingerprint,
        v_lane.requested_quantity
      ) is null then
      return pg_catalog.jsonb_build_object(
        v_authorized_key, false,
        v_reason_key, 'dispatch_quantity_not_admitted'
      );
    end if;
  end if;

  if not exists (
    select 1
    from public.org_vendor_configs config_row
    where config_row.organization_id = v_permit.organization_id
  ) then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_permit.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors <> array[v_provider]::public.vendor_name[] then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  if p_scope_snapshot is distinct from v_lane.scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_staged_scope_changed'
    );
  end if;

  select candidate.* into v_current_candidate
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate
  where candidate.organization_id = v_permit.organization_id
    and candidate.part_id = v_permit.part_id
    and candidate.vendor = v_provider
    and candidate.requested_quantity = v_lane.requested_quantity; -- OVD-987

  select count(*)::integer into v_current_candidate_count
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate;

  if v_current_candidate_count <> 1
    or v_current_candidate.scope_fingerprint is null
    or v_current_candidate.scope_version <> v_permit.scope_version
    or v_current_candidate.scope_fingerprint <> v_permit.scope_fingerprint
    or v_current_candidate.scope_snapshot is distinct from p_scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_current_scope_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    v_authorized_key, true,
    v_reason_key, null,
    'permitId', v_permit.id,
    'provider', v_provider,
    'scopeFingerprint', v_permit.scope_fingerprint,
    'envelopeRevision', v_envelope_revision,
    'nonExportControlled', true
  );
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;
