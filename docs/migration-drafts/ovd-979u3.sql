-- SUPERSEDED: historical OVD-979 U3 copy, already promoted as supabase/migrations/20261030164800_ovd979u3_extraction_attempt_identity.sql; api_claim_next_task was later replaced by U5 (20261030190000). Do not apply this draft.
-- OVD-979 U3: claim identity and extraction provenance. No legacy backfill.
ALTER TABLE public.work_queue ADD COLUMN IF NOT EXISTS attempt_id uuid;
ALTER TABLE public.drawing_extractions ADD COLUMN IF NOT EXISTS source_attempt_id uuid;

CREATE OR REPLACE FUNCTION public.api_claim_next_task(p_worker_name text)
RETURNS SETOF public.work_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.work_queue;
BEGIN
  SELECT *
    INTO v_task
    FROM public.work_queue
   WHERE status = 'queued'
     AND available_at <= now()
   ORDER BY created_at ASC
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.work_queue
     SET status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker_name,
         attempts   = attempts + 1,
         attempt_id = gen_random_uuid()
   WHERE id = v_task.id
  RETURNING * INTO v_task;

  RETURN NEXT v_task;
END;
$$;

REVOKE ALL ON FUNCTION public.api_claim_next_task(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_claim_next_task(text) TO service_role;
