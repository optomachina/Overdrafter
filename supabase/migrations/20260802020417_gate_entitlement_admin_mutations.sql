-- OVD-315: keep audited entitlement administration behind its own default-off
-- operational control without changing entitlement reads or grant-table
-- cascade behavior.
--
-- Operational rollback is to set commercial_admin_mutations=false. A schema
-- rollback requires a separate reviewed migration that drops these public
-- wrappers, moves the two private *_unguarded functions back to public under
-- their original names, and restores their authenticated EXECUTE grants. That
-- rollback preserves entitlement grants and commercial audit rows, but it also
-- removes this safety boundary and must not be used as incident response.

alter function public.api_admin_grant_organization_entitlement(
  uuid,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  text,
  text
)
  set schema private;

alter function private.api_admin_grant_organization_entitlement(
  uuid,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  text,
  text
)
  rename to api_admin_grant_organization_entitlement_unguarded;

revoke all on function private.api_admin_grant_organization_entitlement_unguarded(
  uuid,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  text,
  text
)
  from public, anon, authenticated, service_role;

create function public.api_admin_grant_organization_entitlement(
  p_organization_id uuid,
  p_grant_type text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_review_at timestamptz,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform private.require_commercial_admin_capability('billing_admin');

  if not private.commercial_rollout_enabled('commercial_admin_mutations') then
    raise exception 'Commercial admin mutations are temporarily disabled.';
  end if;

  return private.api_admin_grant_organization_entitlement_unguarded(
    p_organization_id,
    p_grant_type,
    p_starts_at,
    p_expires_at,
    p_review_at,
    p_reason,
    p_idempotency_key
  );
end;
$$;

revoke all on function public.api_admin_grant_organization_entitlement(
  uuid,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  text,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_grant_organization_entitlement(
  uuid,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  text,
  text
)
  to authenticated;

alter function public.api_admin_revoke_organization_entitlement(
  uuid,
  text,
  text
)
  set schema private;

alter function private.api_admin_revoke_organization_entitlement(
  uuid,
  text,
  text
)
  rename to api_admin_revoke_organization_entitlement_unguarded;

revoke all on function private.api_admin_revoke_organization_entitlement_unguarded(
  uuid,
  text,
  text
)
  from public, anon, authenticated, service_role;

create function public.api_admin_revoke_organization_entitlement(
  p_grant_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform private.require_commercial_admin_capability('billing_admin');

  if not private.commercial_rollout_enabled('commercial_admin_mutations') then
    raise exception 'Commercial admin mutations are temporarily disabled.';
  end if;

  return private.api_admin_revoke_organization_entitlement_unguarded(
    p_grant_id,
    p_reason,
    p_idempotency_key
  );
end;
$$;

revoke all on function public.api_admin_revoke_organization_entitlement(
  uuid,
  text,
  text
)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_revoke_organization_entitlement(
  uuid,
  text,
  text
)
  to authenticated;
