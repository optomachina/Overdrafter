-- OVD-414: ROLLBACK for supabase/migrations/20261014191541_ovd414_xometry_admission_read.sql
--
-- Applied to production 2026-10-14; run only with explicit approval. Removes the read-only wrapper. The worker then fails closed on
-- every Xometry upload (upload_capability_denied, decision_unavailable), the
-- same state as before the draft. Nothing else depends on the function.

revoke all on function public.api_worker_resolve_xometry_admission()
  from public, anon, authenticated, service_role;
drop function if exists public.api_worker_resolve_xometry_admission();
