-- OVD-537: these one-argument SECURITY DEFINER readers are implementation
-- details of guarded parent RPCs, not standalone client endpoints. Revoke the
-- inherited PUBLIC default and the explicit client-role grants while retaining
-- service-role and function-owner execution. The three-argument vendor helper
-- has a separate access contract and is intentionally unchanged.
--
-- Forward-only recovery: grant an exact, qualified privileged role if an
-- internal caller unexpectedly fails. Do not restore PUBLIC, anon, or
-- authenticated direct access without a separately guarded redesign.

revoke all on function public.get_active_pricing_policy_id(uuid)
  from public, anon, authenticated;
grant execute on function public.get_active_pricing_policy_id(uuid)
  to service_role;

revoke all on function public.get_enabled_client_quote_vendors(uuid)
  from public, anon, authenticated;
grant execute on function public.get_enabled_client_quote_vendors(uuid)
  to service_role;

revoke all on function public.get_quote_request_guardrails(uuid)
  from public, anon, authenticated;
grant execute on function public.get_quote_request_guardrails(uuid)
  to service_role;

revoke all on function public.get_quote_request_pending_estimated_cost_usd(uuid)
  from public, anon, authenticated;
grant execute on function public.get_quote_request_pending_estimated_cost_usd(uuid)
  to service_role;

revoke all on function public.get_self_service_membership_role(uuid)
  from public, anon, authenticated;
grant execute on function public.get_self_service_membership_role(uuid)
  to service_role;
