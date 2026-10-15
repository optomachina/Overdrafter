-- OVD-641: allow an owner-approved permission basis for approved admission.
--
-- The repository owner dropped the written vendor-permission requirement
-- (OVD-640). This adds 'owner_approved' to the bounded permission-basis
-- vocabulary and lets it satisfy approved admission. Nothing else changes:
-- 'existing_controlled_beta_path' stays limited to Xometry controlled_beta_only,
-- and the evidence, envelope, session-owner, reviewer, expiry, append-only
-- history, and service-role-only resolver rules are untouched. No policy row is
-- changed, so no provider becomes admitted or dispatchable by this migration.
--
-- Rollback: first move every policy whose permission_basis is 'owner_approved'
-- to a new revision whose permission_basis is null or one of the three original
-- values (for example a disabled revision with permission_basis cleared), then
-- restore both constraints to their 20260817133902 definitions. The restored
-- vocabulary check applies in every admission state, so a disabled revision
-- that keeps 'owner_approved' would block the restore.

alter table private.quote_provider_admission_policies
  drop constraint quote_provider_permission_basis_check,
  drop constraint quote_provider_approved_permission_check,
  add constraint quote_provider_permission_basis_check check (
    permission_basis is null
    or permission_basis in (
      'provider_terms_allow_automation',
      'written_provider_authorization',
      'owner_approved',
      'existing_controlled_beta_path' -- NOSONAR: explicit permission vocabulary shared with resolver validation
    )
  ),
  add constraint quote_provider_approved_permission_check check (
    admission_state <> 'approved'
    or permission_basis in (
      'provider_terms_allow_automation',
      'written_provider_authorization',
      'owner_approved'
    )
  );
