-- OVD-1097 down path for the promoted migration
-- supabase/migrations/20261025194414_ovd1097_refresh_job_extraction_status.sql.
-- No forward draft or pending test family: the forward SQL lives only in migrations.
-- Restore the previous worker version before applying; existing job statuses and
-- audit history are preserved. A second DROP intentionally errors if absent.
drop function public.api_refresh_job_extraction_status(uuid);
