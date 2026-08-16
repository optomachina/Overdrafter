-- OVD-313: Add the service-only, default-off registry used to stage commercial
-- capabilities. Enforcement is added separately by OVD-315 and OVD-314.
-- Billing self-service remains independently controlled by the server-only
-- BILLING_SELF_SERVICE_ENABLED Edge Function secret.
--
-- Operational rollback: leave this schema installed and set affected controls
-- off. Schema rollback is not incident containment. Before dropping this
-- registry, first roll back every dependent enforcement migration. Then revoke
-- and drop public.api_set_commercial_rollout_control(text, boolean, text, text,
-- bigint, text), public.api_get_commercial_rollout_controls(), and
-- private.commercial_rollout_enabled(text); export the immutable event table;
-- drop private.commercial_rollout_control_events and
-- private.reject_commercial_rollout_control_event_mutation(); and finally drop
-- private.commercial_rollout_controls.

create table private.commercial_rollout_controls (
  capability text primary key,
  enabled boolean not null default false,
  revision bigint not null default 0,
  change_reason text not null,
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by_user_id uuid references auth.users(id) on delete set null,
  updated_by_actor text,
  constraint commercial_rollout_controls_capability_check check (
    capability in (
      'commercial_admin_mutations',
      'automatic_quote_collection',
      'promotion_codes',
      'order_administration'
    )
  ),
  constraint commercial_rollout_controls_reason_check check (
    pg_catalog.length(pg_catalog.btrim(change_reason)) between 3 and 500
  ),
  constraint commercial_rollout_controls_actor_check check (
    updated_by_actor is null
    or pg_catalog.length(pg_catalog.btrim(updated_by_actor)) between 3 and 200
  ),
  constraint commercial_rollout_controls_revision_check check (revision >= 0)
);

create table private.commercial_rollout_control_events (
  id bigint generated always as identity primary key,
  capability text not null,
  idempotency_key text not null,
  previous_enabled boolean not null,
  enabled boolean not null,
  changed boolean not null,
  previous_revision bigint not null,
  revision bigint not null,
  change_reason text not null,
  changed_at timestamptz not null default pg_catalog.now(),
  changed_by_user_id uuid,
  changed_by_actor text not null,
  changed_by_role text not null,
  constraint commercial_rollout_control_events_capability_check check (
    capability in (
      'commercial_admin_mutations',
      'automatic_quote_collection',
      'promotion_codes',
      'order_administration'
    )
  ),
  constraint commercial_rollout_control_events_idempotency_check check (
    pg_catalog.length(pg_catalog.btrim(idempotency_key)) between 8 and 200
  ),
  constraint commercial_rollout_control_events_reason_check check (
    pg_catalog.length(pg_catalog.btrim(change_reason)) between 3 and 500
  ),
  constraint commercial_rollout_control_events_actor_check check (
    pg_catalog.length(pg_catalog.btrim(changed_by_actor)) between 3 and 200
  ),
  constraint commercial_rollout_control_events_role_check check (
    pg_catalog.length(pg_catalog.btrim(changed_by_role)) > 0
  ),
  constraint commercial_rollout_control_events_revision_check check (
    previous_revision >= 0
    and revision >= previous_revision
    and (
      (changed and revision = previous_revision + 1)
      or (not changed and revision = previous_revision)
    )
  ),
  constraint commercial_rollout_control_events_state_check check (
    (changed and previous_enabled <> enabled)
    or (not changed and previous_enabled = enabled)
  ),
  constraint commercial_rollout_control_events_idempotency_key unique (
    idempotency_key
  )
);

create index commercial_rollout_control_events_capability_changed_at_idx
  on private.commercial_rollout_control_events (capability, changed_at desc);

revoke all on private.commercial_rollout_controls
from public, anon, authenticated, service_role;

revoke all on private.commercial_rollout_control_events
from public, anon, authenticated, service_role;

insert into private.commercial_rollout_controls (
  capability,
  enabled,
  revision,
  change_reason
)
values
  (
    'commercial_admin_mutations',
    false,
    0,
    'Default-off commercial operations rollout'
  ),
  (
    'automatic_quote_collection',
    false,
    0,
    'Default-off automatic quote rollout'
  ),
  (
    'promotion_codes',
    false,
    0,
    'Reserved default-off promotion rollout'
  ),
  (
    'order_administration',
    false,
    0,
    'Reserved default-off order administration rollout'
  );

create or replace function private.reject_commercial_rollout_control_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Commercial rollout control events are immutable.';
end;
$$;

create trigger reject_commercial_rollout_control_event_mutation
before update or delete on private.commercial_rollout_control_events
for each row execute function private.reject_commercial_rollout_control_event_mutation();

revoke all on function private.reject_commercial_rollout_control_event_mutation()
from public, anon, authenticated, service_role;

create or replace function private.commercial_rollout_enabled(
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (
      select control.enabled
      from private.commercial_rollout_controls control
      where control.capability = p_capability
    ),
    false
  );
$$;

revoke all on function private.commercial_rollout_enabled(text)
from public, anon, authenticated, service_role;

create or replace function public.api_get_commercial_rollout_controls()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'controls',
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'capability', control.capability,
            'enabled', control.enabled,
            'revision', control.revision,
            'changeReason', control.change_reason,
            'updatedAt', control.updated_at,
            'updatedByUserId', control.updated_by_user_id,
            'updatedByActor', control.updated_by_actor
          )
          order by control.capability
        )
        from private.commercial_rollout_controls control
      ),
      '[]'::jsonb
    ),
    'recentEvents',
    coalesce(
      (
        select pg_catalog.jsonb_agg(event_payload.payload order by event_payload.id desc)
        from (
          select
            event.id,
            pg_catalog.jsonb_build_object(
              'id', event.id,
              'capability', event.capability,
              'idempotencyKey', event.idempotency_key,
              'previousEnabled', event.previous_enabled,
              'enabled', event.enabled,
              'changed', event.changed,
              'previousRevision', event.previous_revision,
              'revision', event.revision,
              'changeReason', event.change_reason,
              'changedAt', event.changed_at,
              'changedByUserId', event.changed_by_user_id,
              'changedByActor', event.changed_by_actor,
              'changedByRole', event.changed_by_role
            ) as payload
          from private.commercial_rollout_control_events event
          order by event.id desc
          limit 100
        ) event_payload
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.api_get_commercial_rollout_controls()
from public, anon, authenticated, service_role;

grant execute on function public.api_get_commercial_rollout_controls()
to service_role;

create or replace function public.api_set_commercial_rollout_control(
  p_capability text,
  p_enabled boolean,
  p_change_reason text,
  p_operator text,
  p_expected_revision bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_control private.commercial_rollout_controls%rowtype;
  v_existing_event private.commercial_rollout_control_events%rowtype;
  v_event private.commercial_rollout_control_events%rowtype;
  v_actor_user_id uuid := auth.uid();
  v_actor_role text := coalesce(auth.role(), current_user);
  v_reason text := pg_catalog.btrim(p_change_reason);
  v_operator text := pg_catalog.btrim(p_operator);
  v_idempotency_key text := pg_catalog.btrim(p_idempotency_key);
begin
  if p_capability is null or p_capability not in (
    'commercial_admin_mutations',
    'automatic_quote_collection',
    'promotion_codes',
    'order_administration'
  ) then
    raise exception 'Unknown commercial rollout capability.';
  end if;

  if p_enabled is null then
    raise exception 'Commercial rollout state is required.';
  end if;

  if v_reason is null or pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'A change reason between 3 and 500 characters is required.';
  end if;

  if v_operator is null or pg_catalog.length(v_operator) not between 3 and 200 then
    raise exception 'An operator identity between 3 and 200 characters is required.';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A non-negative expected revision is required.';
  end if;

  if v_idempotency_key is null
     or pg_catalog.length(v_idempotency_key) not between 8 and 200 then
    raise exception 'An idempotency key between 8 and 200 characters is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commercial-rollout:' || p_capability, 0)
  );

  select event.*
  into v_existing_event
  from private.commercial_rollout_control_events event
  where event.idempotency_key = v_idempotency_key;

  if v_existing_event.id is not null then
    if v_existing_event.capability is distinct from p_capability
       or v_existing_event.enabled is distinct from p_enabled
       or v_existing_event.change_reason is distinct from v_reason
       or v_existing_event.changed_by_actor is distinct from v_operator
       or v_existing_event.previous_revision is distinct from p_expected_revision
    then
      raise exception 'Idempotency key has already been used for a different rollout-control action.';
    end if;

    return pg_catalog.jsonb_build_object(
      'eventId', v_existing_event.id,
      'capability', v_existing_event.capability,
      'enabled', v_existing_event.enabled,
      'changed', v_existing_event.changed,
      'revision', v_existing_event.revision,
      'changeReason', v_existing_event.change_reason,
      'operator', v_existing_event.changed_by_actor,
      'idempotencyKey', v_existing_event.idempotency_key,
      'replayed', true
    );
  end if;

  select control.*
  into strict v_control
  from private.commercial_rollout_controls control
  where control.capability = p_capability
  for update;

  if p_expected_revision <> v_control.revision then
    raise exception 'Commercial rollout control changed; refresh and retry.';
  end if;

  insert into private.commercial_rollout_control_events (
    capability,
    idempotency_key,
    previous_enabled,
    enabled,
    changed,
    previous_revision,
    revision,
    change_reason,
    changed_by_user_id,
    changed_by_actor,
    changed_by_role
  )
  values (
    v_control.capability,
    v_idempotency_key,
    v_control.enabled,
    p_enabled,
    v_control.enabled <> p_enabled,
    v_control.revision,
    case
      when v_control.enabled <> p_enabled then v_control.revision + 1
      else v_control.revision
    end,
    v_reason,
    v_actor_user_id,
    v_operator,
    v_actor_role
  )
  returning * into v_event;

  if v_event.changed then
    update private.commercial_rollout_controls
    set
      enabled = v_event.enabled,
      revision = v_event.revision,
      change_reason = v_event.change_reason,
      updated_at = v_event.changed_at,
      updated_by_user_id = v_event.changed_by_user_id,
      updated_by_actor = v_event.changed_by_actor
    where capability = v_event.capability;
  end if;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event.id,
    'capability', v_event.capability,
    'enabled', v_event.enabled,
    'changed', v_event.changed,
    'revision', v_event.revision,
    'changeReason', v_event.change_reason,
    'operator', v_event.changed_by_actor,
    'idempotencyKey', v_event.idempotency_key,
    'replayed', false
  );
end;
$$;

revoke all on function public.api_set_commercial_rollout_control(
  text,
  boolean,
  text,
  text,
  bigint,
  text
)
from public, anon, authenticated, service_role;

grant execute on function public.api_set_commercial_rollout_control(
  text,
  boolean,
  text,
  text,
  bigint,
  text
)
to service_role;
