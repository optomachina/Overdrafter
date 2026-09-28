-- OVD-582: record one RMFG identity in the private default-deny registry.
-- This public source envelope does not establish automation permission,
-- account access, provider evaluation, or customer routing.
-- Operational rollback keeps the enum and this admission row disabled.

insert into private.quote_provider_admission_policies (
  provider,
  admission_state,
  generic_dispatch_enabled,
  policy_revision,
  evidence_reference,
  permission_basis,
  supported_processes,
  accepted_file_extensions,
  session_owner,
  reviewed_by,
  reviewed_at,
  expires_at,
  change_reason
)
values (
  'rmfg'::public.vendor_name,
  'disabled',
  false,
  'rmfg-disabled-2026-09-28.v1',
  null,
  null,
  array[]::public.process_types[],
  array[]::text[],
  null,
  null,
  null,
  null,
  'initial_seed'
)
on conflict (provider) do nothing;
