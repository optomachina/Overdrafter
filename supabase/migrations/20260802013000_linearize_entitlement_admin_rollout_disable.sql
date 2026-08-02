-- OVD-315 follow-up: linearize entitlement-admin mutations with audited
-- rollout changes. The OVD-315 wrappers already fail closed while
-- commercial_admin_mutations is off, but a check without a shared lock allows
-- an operator disable to commit while an earlier mutation is still writing.
--
-- These wrappers take a shared transaction advisory lock on the exact key that
-- api_set_commercial_rollout_control takes exclusively. A disable therefore
-- waits for already-authorized mutations to finish; new mutations wait for the
-- disable to commit and then observe the off state. Capability and AAL2 checks
-- remain first so unauthorized callers cannot inspect rollout state.
--
-- Operational rollback: leave these wrappers installed and set
-- commercial_admin_mutations off through the audited rollout-control API.
-- Existing grants, entitlement reads, organization cleanup, and immutable
-- audit history remain available.
--
-- Schema rollback: restore both public wrapper definitions from
-- 20260802011500_gate_entitlement_admin_mutations.sql, including their exact
-- revoke/grant statements. Removing the shared lock restores the check/write
-- race, so schema rollback is a reviewed release action, not incident response.

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
  perform private.require_commercial_admin_capability('billing_admin');

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commercial-rollout:commercial_admin_mutations',
      0
    )
  );

  if not private.commercial_rollout_enabled(
    'commercial_admin_mutations'
  ) then
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
  perform private.require_commercial_admin_capability('billing_admin');

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commercial-rollout:commercial_admin_mutations',
      0
    )
  );

  if not private.commercial_rollout_enabled(
    'commercial_admin_mutations'
  ) then
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
