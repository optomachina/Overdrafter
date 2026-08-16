-- OVD-315 follow-up: linearize entitlement-admin mutations with audited
-- rollout changes after the review-hardening migration centralized the guard.
--
-- The guard takes a shared transaction advisory lock on the exact key that
-- api_set_commercial_rollout_control takes exclusively. A disable therefore
-- waits for already-authorized mutations to finish; new mutations wait for
-- the disable to commit and then observe the off state. Capability and AAL2
-- validation remain first so unauthorized callers cannot inspect rollout
-- state.
--
-- Operational rollback: leave this guard installed and set
-- commercial_admin_mutations off through the audited rollout-control API.
--
-- Schema rollback: restore private.require_commercial_admin_mutation(text)
-- from 20260802013500_harden_entitlement_rollout_gate.sql, including its exact
-- revoke statement. Removing the shared lock restores the check/write race,
-- so schema rollback is a reviewed release action, not incident response.

create or replace function private.require_commercial_admin_mutation(
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

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'commercial-rollout:commercial_admin_mutations',
      0
    )
  );

  if not private.commercial_rollout_enabled('commercial_admin_mutations') then
    raise exception 'Commercial admin mutations are temporarily disabled.';
  end if;

  return v_actor_user_id;
end;
$$;

revoke all on function private.require_commercial_admin_mutation(text)
  from public, anon, authenticated, service_role;
