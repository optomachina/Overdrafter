-- OVD-486: persist one platform-admin notification when a reviewed migration
-- adds a new disabled provider identity.
--
-- This notification is descriptive only. It does not admit the provider,
-- enable generic dispatch, authorize evaluation, or permit any provider
-- interaction. Existing provider policies are intentionally not backfilled.
--
-- Rollback:
-- 1. Drop the admission-policy notification trigger.
-- 2. Revoke and drop public.api_admin_list_platform_notifications(integer).
-- 3. Drop the private trigger helpers and append-only guard.
-- 4. Export notification records if operational history must be retained,
--    then drop private.platform_admin_notifications.

create table private.platform_admin_notifications (
  event_key text primary key,
  notification_type text not null,
  provider public.vendor_name not null,
  policy_revision text not null,
  admission_state text not null,
  generic_dispatch_enabled boolean not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint platform_admin_notification_event_key_check check (
    event_key = 'provider.integration_added:' || provider::text || ':' || policy_revision
  ),
  constraint platform_admin_notification_type_check check (
    notification_type = 'provider.integration_added'
  ),
  constraint platform_admin_notification_policy_revision_check check (
    policy_revision = pg_catalog.btrim(policy_revision)
    and policy_revision ~ '^[a-z0-9][a-z0-9._-]{2,199}$'
  ),
  constraint platform_admin_notification_provider_disabled_check check (
    admission_state = 'disabled'
    and generic_dispatch_enabled is false
  )
);

alter table private.platform_admin_notifications enable row level security;
alter table private.platform_admin_notifications force row level security;

revoke all on table private.platform_admin_notifications
  from public, anon, authenticated, service_role;

create or replace function private.reject_platform_admin_notification_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Platform admin notifications are append-only.';
end;
$$;

revoke all on function private.reject_platform_admin_notification_mutation()
  from public, anon, authenticated, service_role;

create trigger reject_platform_admin_notification_mutation
before update or delete on private.platform_admin_notifications
for each row execute function private.reject_platform_admin_notification_mutation();

create or replace function private.capture_provider_added_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.admission_state <> 'disabled'
    or new.generic_dispatch_enabled is not false
  then
    return new;
  end if;

  insert into private.platform_admin_notifications (
    event_key,
    notification_type,
    provider,
    policy_revision,
    admission_state,
    generic_dispatch_enabled
  )
  values (
    'provider.integration_added:' || new.provider::text || ':' || new.policy_revision,
    'provider.integration_added',
    new.provider,
    new.policy_revision,
    new.admission_state,
    new.generic_dispatch_enabled
  )
  on conflict (event_key) do nothing;

  return new;
end;
$$;

revoke all on function private.capture_provider_added_notification()
  from public, anon, authenticated, service_role;

create trigger capture_provider_added_notification
after insert on private.quote_provider_admission_policies
for each row execute function private.capture_provider_added_notification();

create or replace function public.api_admin_list_platform_notifications(
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_limit integer;
  v_rows jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  v_limit := pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_limit, 20), 1), 100);

  select pg_catalog.coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', notification.event_key,
        'eventType', notification.notification_type,
        'providerKey', notification.provider::text,
        'policyRevision', notification.policy_revision,
        'admissionState', notification.admission_state,
        'genericDispatchEnabled', notification.generic_dispatch_enabled,
        'occurredAt', notification.created_at
      )
      order by notification.created_at desc, notification.event_key desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from (
    select source_notification.*
    from private.platform_admin_notifications source_notification
    order by source_notification.created_at desc, source_notification.event_key desc
    limit v_limit
  ) notification;

  return v_rows;
end;
$$;

revoke all on function public.api_admin_list_platform_notifications(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_platform_notifications(integer)
  to authenticated;
