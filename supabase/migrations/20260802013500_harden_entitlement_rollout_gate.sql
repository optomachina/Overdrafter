-- OVD-315 review follow-up: keep the capability and rollout checks in one
-- private, owner-only guard so the grant and revoke wrappers cannot drift.
--
-- Operational rollback remains commercial_admin_mutations=false. A schema
-- rollback must restore the wrapper definitions from 20260802011500 before
-- dropping this helper; grants and commercial audit rows remain untouched.

create function private.require_commercial_admin_mutation(
  p_capability text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid;
begin
  v_actor_user_id :=
    private.require_commercial_admin_capability(p_capability);

  if not private.commercial_rollout_enabled('commercial_admin_mutations') then
    raise exception 'Commercial admin mutations are temporarily disabled.';
  end if;

  return v_actor_user_id;
end;
$$;

revoke all on function private.require_commercial_admin_mutation(text)
  from public, anon, authenticated, service_role;

create or replace function public.api_admin_grant_organization_entitlement(
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
  perform private.require_commercial_admin_mutation('billing_admin');

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

create or replace function public.api_admin_revoke_organization_entitlement(
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
  perform private.require_commercial_admin_mutation('billing_admin');

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
