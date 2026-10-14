-- OVD-414: service-role admission read for the Xometry upload capability check.
--
-- DRAFT ONLY. Not a migration and not applied anywhere. The lead promotes it
-- to supabase/migrations in a migration window. Rollback:
-- docs/migration-drafts/ovd-414-service-admission-read.rollback.sql.
--
-- Problem. The worker's Xometry upload checkpoint (decideProviderUploadCapability)
-- needs the OVD-379 admission result from
-- private.resolve_quote_provider_admission_policy(text), but that resolver is
-- private and has no worker-callable api_ wrapper. Without one, production
-- dispatch can only fail closed with upload_capability_denied.
--
-- What changes: one read-only function. It takes no arguments and is fixed to
-- the xometry provider, so a caller cannot probe other providers. It returns
-- the resolver row unchanged (same column names the worker types mirror)
-- under a versioned schema key. It writes nothing and reads no task, org, or
-- customer data. No DROP statements.
--
-- Deploy ordering: apply BEFORE the worker build that calls it. Until then the
-- worker's checkpoint treats a missing RPC as a denial.

create or replace function public.api_worker_resolve_xometry_admission()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'xometry-admission-read.v1',
    'policy_present', admission.policy_present,
    'provider_admitted', admission.provider_admitted,
    'generically_dispatchable', admission.generically_dispatchable,
    'provider', admission.provider,
    'admission_state', admission.admission_state,
    'policy_revision', admission.policy_revision,
    'evidence_reference', admission.evidence_reference,
    'permission_basis', admission.permission_basis,
    'supported_processes', pg_catalog.to_jsonb(admission.supported_processes),
    'accepted_file_extensions', pg_catalog.to_jsonb(admission.accepted_file_extensions),
    'session_owner', admission.session_owner,
    'reviewed_at', admission.reviewed_at,
    'expires_at', admission.expires_at,
    'reason_code', admission.reason_code
  )
  from private.resolve_quote_provider_admission_policy('xometry') admission;
$$;

revoke all on function public.api_worker_resolve_xometry_admission()
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_resolve_xometry_admission()
  to service_role;
