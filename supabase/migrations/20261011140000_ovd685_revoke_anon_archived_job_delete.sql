-- OVD-685: revoke default EXECUTE on SECURITY DEFINER archived job deletion RPCs
-- from public and anon
--
-- Context: api_delete_archived_jobs and api_delete_archived_job are SECURITY
-- DEFINER functions. The CREATE FUNCTION statements only granted EXECUTE to
-- authenticated, but never explicitly revoked from public/anon. PostgreSQL
-- grants EXECUTE on functions to PUBLIC by default, so anon kept the default
-- permission.
--
-- This migration explicitly revokes EXECUTE from public and anon, then grants
-- only to authenticated, ensuring only authenticated users can delete archived
-- jobs.
--
-- Rollback: grant execute on function public.api_delete_archived_jobs(uuid[]) to public, anon;
-- grant execute on function public.api_delete_archived_job(uuid) to public, anon;

revoke all on function public.api_delete_archived_jobs(uuid[]) from public, anon;
revoke all on function public.api_delete_archived_job(uuid) from public, anon;

grant execute on function public.api_delete_archived_jobs(uuid[]) to authenticated;
grant execute on function public.api_delete_archived_job(uuid) to authenticated;
