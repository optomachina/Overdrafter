-- OVD-414: ROLLBACK for docs/migration-drafts/ovd-414-service-admission-read.sql.
--
-- DRAFT ONLY. Removes the read-only wrapper. The worker then fails closed on
-- every Xometry upload (upload_capability_denied, decision_unavailable), the
-- same state as before the draft. Nothing else depends on the function.

revoke all on function public.api_worker_resolve_xometry_admission()
  from public, anon, authenticated, service_role;
drop function if exists public.api_worker_resolve_xometry_admission();
