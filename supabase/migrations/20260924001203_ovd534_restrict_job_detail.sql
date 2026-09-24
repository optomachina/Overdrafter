-- OVD-534: this SECURITY DEFINER helper reads job-scoped service notes but
-- performs no caller authorization. It is an implementation detail of the
-- guarded quote-request functions, not a direct Data API endpoint.
--
-- Revoke the exact overload only. PostgreSQL functions otherwise grant
-- EXECUTE to PUBLIC by default, which anon and authenticated inherit.
-- The existing SECURITY DEFINER parents continue to invoke it as their owner;
-- service_role retains explicit access for internal callers.
--
-- Forward-only recovery: if an internal caller unexpectedly lacks EXECUTE,
-- qualify a new, exact-signature grant for that role. Do not restore PUBLIC,
-- anon, or authenticated access to resolve a quote-path failure.

revoke execute on function public.build_manufacturing_quote_service_detail(uuid)
from public, anon, authenticated;

grant execute on function public.build_manufacturing_quote_service_detail(uuid)
to service_role;
