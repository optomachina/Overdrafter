-- Atomic task claiming for multi-worker deployments.
-- Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent race conditions where two
-- workers claim the same task simultaneously.
CREATE OR REPLACE FUNCTION public.api_claim_next_task(p_worker_name text)
RETURNS SETOF public.work_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
         attempts   = attempts + 1
   WHERE id = v_task.id
  RETURNING * INTO v_task;

  RETURN NEXT v_task;
END;
$$;

REVOKE ALL ON FUNCTION public.api_claim_next_task(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.api_claim_next_task(text) TO service_role;
