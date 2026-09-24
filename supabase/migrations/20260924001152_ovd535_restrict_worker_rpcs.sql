-- OVD-535: these SECURITY DEFINER RPCs are called only by the worker. Supabase's
-- per-role default grants can leave anon/authenticated with EXECUTE even when
-- the original function migration revoked EXECUTE from PUBLIC.
revoke execute on function public.api_claim_next_task(text) from public;
revoke execute on function public.api_claim_next_task(text) from anon, authenticated;
grant execute on function public.api_claim_next_task(text) to service_role;

revoke execute on function public.api_auto_approve_job_requirements(uuid) from public;
revoke execute on function public.api_auto_approve_job_requirements(uuid) from anon, authenticated;
grant execute on function public.api_auto_approve_job_requirements(uuid) to service_role;
