-- OVD-979 U5: one active extraction per part, including drawing attachment.
-- ovd: idempotent
-- Apply after U4 in one transaction. No data cleanup or legacy backfill.

-- Freeze queue writers across audit/index creation: abort, never repair duplicates.
LOCK TABLE public.work_queue IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.work_queue
    WHERE task_type = 'extract_part' AND status IN ('queued', 'running')
      AND part_id IS NOT NULL
    GROUP BY part_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'OVD-979 U5: duplicate active extract tasks; operator reconciliation required';
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS work_queue_one_active_extract_per_part
  ON public.work_queue (part_id)
  WHERE task_type = 'extract_part' AND status IN ('queued', 'running');

CREATE OR REPLACE FUNCTION public.api_request_extraction(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job public.jobs%rowtype;
  v_task record;
  v_count integer := 0;
  v_new_part boolean;
BEGIN
  PERFORM public.require_verified_auth();
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;
  IF NOT public.user_can_edit_job(v_job.id) THEN
    RAISE EXCEPTION 'You do not have access to job %', p_job_id;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd979:job:' || p_job_id::text, 0));
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR NO KEY UPDATE;

  -- L1 writes precede reconciliation's L2 writes. Inspect the reconciled file
  -- set without writing it first. Auto approval cannot race this job lock.
  SELECT EXISTS (
    SELECT 1 FROM public.job_part_file_set(p_job_id) files
    LEFT JOIN public.parts part ON part.job_id = p_job_id
      AND part.normalized_key = files.normalized_name
    LEFT JOIN public.drawing_extractions extraction ON extraction.part_id = part.id
    WHERE extraction.id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.work_queue active
      WHERE active.part_id = part.id AND active.task_type = 'extract_part'
        AND active.status IN ('queued', 'running'))
  ) INTO v_new_part;
  UPDATE public.jobs SET status = 'extracting'
  WHERE id = p_job_id
    AND (v_new_part OR status IN ('uploaded', 'extracting', 'needs_spec_review', 'ready_to_quote'))
    AND EXISTS (
      SELECT 1 FROM public.job_part_file_set(p_job_id) files
      LEFT JOIN public.parts part ON part.job_id = p_job_id
        AND part.normalized_key = files.normalized_name
      LEFT JOIN public.drawing_extractions extraction ON extraction.part_id = part.id
      WHERE extraction.id IS NULL OR (
        files.drawing_file_id IS NOT NULL
        AND (extraction.extractor_version LIKE 'worker-sim-%' OR EXISTS (
          SELECT 1 FROM public.work_queue failed
          WHERE failed.part_id = part.id AND failed.task_type = 'extract_part'
            AND failed.status IN ('failed', 'cancelled')
            AND failed.payload->>'drawingFileId' = files.drawing_file_id::text))
        AND NOT EXISTS (
          SELECT 1 FROM public.work_queue done
          WHERE done.part_id = part.id AND done.task_type = 'extract_part'
            AND done.status = 'completed'
            AND done.payload->>'drawingFileId' = files.drawing_file_id::text)));

  PERFORM 1 FROM public.parts WHERE job_id = p_job_id ORDER BY id FOR UPDATE;
  PERFORM public.api_reconcile_job_parts(p_job_id);

  -- Include queued rows: a claim that wins first is re-read as running after
  -- this wait. A claim that loses skips our locked row until commit.
  PERFORM 1 FROM public.work_queue
  WHERE job_id = p_job_id AND task_type = 'extract_part'
    AND status IN ('queued', 'running')
  ORDER BY id FOR NO KEY UPDATE;

  FOR v_task IN
    SELECT queue.*, part.drawing_file_id
    FROM public.work_queue queue JOIN public.parts part ON part.id = queue.part_id
    WHERE part.job_id = p_job_id AND queue.task_type = 'extract_part'
      AND queue.status IN ('queued', 'running')
    ORDER BY queue.id
  LOOP
    IF v_task.status = 'queued' THEN
      -- The worker reads current part files; merge the same identity before
      -- claim. Also release obsolete/terminal legacy dependencies immediately.
      UPDATE public.work_queue SET
        payload = (payload - 'awaitingTaskId' - 'pendingDrawingFileId') ||
          jsonb_build_object('drawingFileId', v_task.drawing_file_id),
        available_at = CASE WHEN payload ? 'awaitingTaskId' THEN now() ELSE available_at END
      WHERE id = v_task.id;
    ELSIF v_task.drawing_file_id IS NOT NULL
      AND v_task.payload->>'drawingFileId' IS DISTINCT FROM v_task.drawing_file_id::text THEN
      -- One row represents both the running attempt and its requested successor.
      -- OLD.payload in the settlement trigger survives stale worker payloads.
      UPDATE public.work_queue SET
        payload = payload || jsonb_build_object('pendingDrawingFileId', v_task.drawing_file_id),
        -- This attempt cannot finish the newly requested drawing. U4 must keep
        -- treating it as pending even if the old CAD result has been stored.
        attempt_id = NULL,
        available_at = now() + interval '1 hour'
      WHERE id = v_task.id;
    END IF;
  END LOOP;

  WITH enqueued AS (
    INSERT INTO public.work_queue (organization_id, job_id, part_id, task_type, payload)
    SELECT v_job.organization_id, p_job_id, part.id, 'extract_part',
      jsonb_build_object('partId', part.id, 'jobId', p_job_id,
        'drawingFileId', part.drawing_file_id) ||
      CASE WHEN extraction.id IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('reason', 'drawing_attached') END
    FROM public.parts part
    LEFT JOIN public.drawing_extractions extraction ON extraction.part_id = part.id
    WHERE part.job_id = p_job_id
      AND (extraction.id IS NULL OR (
        part.drawing_file_id IS NOT NULL
        AND (extraction.extractor_version LIKE 'worker-sim-%' OR EXISTS (
          SELECT 1 FROM public.work_queue failed
          WHERE failed.part_id = part.id AND failed.task_type = 'extract_part'
            AND failed.status IN ('failed', 'cancelled')
            AND failed.payload->>'drawingFileId' = part.drawing_file_id::text))
        AND NOT EXISTS (
          SELECT 1 FROM public.work_queue done
          WHERE done.part_id = part.id AND done.task_type = 'extract_part'
            AND done.status = 'completed'
            AND done.payload->>'drawingFileId' = part.drawing_file_id::text)))
      AND NOT EXISTS (
        SELECT 1 FROM public.work_queue active
        WHERE active.part_id = part.id AND active.task_type = 'extract_part'
          AND active.status IN ('queued', 'running'))
    ORDER BY part.id
    ON CONFLICT DO NOTHING RETURNING id
  ) SELECT count(*)::integer INTO v_count FROM enqueued;

  PERFORM public.log_audit_event(v_job.organization_id, 'job.extraction_requested',
    jsonb_build_object('jobId', p_job_id, 'tasksQueued', v_count), p_job_id, null);
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.api_request_extraction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_request_extraction(uuid) TO authenticated, service_role;

-- BEFORE, on this row only: no queue-to-job/part lock or second active row.
CREATE OR REPLACE FUNCTION private.merge_pending_drawing_extraction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.task_type = 'extract_part' AND OLD.status = 'running'
    AND NEW.status = 'running' AND OLD.payload ? 'pendingDrawingFileId' THEN
    NEW.payload := NEW.payload || jsonb_build_object(
      'pendingDrawingFileId', OLD.payload->'pendingDrawingFileId');
  END IF;
  IF OLD.task_type = 'extract_part' AND OLD.status = 'running'
    AND NEW.status IN ('queued', 'completed', 'failed', 'cancelled')
    AND OLD.payload ? 'pendingDrawingFileId' THEN
    NEW.status := 'queued';
    NEW.payload := (NEW.payload - 'pendingDrawingFileId' - 'awaitingTaskId') ||
      jsonb_build_object('drawingFileId', OLD.payload->'pendingDrawingFileId',
        'reason', 'drawing_attached');
    NEW.available_at := now();
    NEW.attempt_id := NULL;
    NEW.locked_at := NULL;
    NEW.locked_by := NULL;
    NEW.attempts := 0;
    NEW.last_error := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.merge_pending_drawing_extraction() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.merge_pending_drawing_extraction() TO service_role;
CREATE OR REPLACE TRIGGER merge_pending_drawing_extraction BEFORE UPDATE ON public.work_queue
FOR EACH ROW EXECUTE FUNCTION private.merge_pending_drawing_extraction();

CREATE OR REPLACE FUNCTION public.api_claim_next_task(p_worker_name text)
RETURNS SETOF public.work_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.work_queue;
BEGIN
  SELECT queue.* INTO v_task FROM public.work_queue queue
  WHERE queue.status = 'queued' AND (
    queue.available_at <= now() OR (
      queue.task_type = 'extract_part' AND queue.payload ? 'awaitingTaskId'
      AND NOT EXISTS (
        SELECT 1 FROM public.work_queue dependency
        WHERE dependency.id::text = queue.payload->>'awaitingTaskId'
          AND dependency.status IN ('queued', 'running'))))
  ORDER BY queue.created_at, queue.id LIMIT 1 FOR UPDATE OF queue SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.work_queue SET status = 'running', locked_at = now(),
    locked_by = p_worker_name, attempts = attempts + 1, attempt_id = gen_random_uuid(),
    payload = CASE WHEN task_type = 'extract_part' THEN
      (payload - 'awaitingTaskId' - 'pendingDrawingFileId') || jsonb_build_object(
        'drawingFileId', (SELECT drawing_file_id FROM public.parts WHERE id = v_task.part_id))
      ELSE payload END
  WHERE id = v_task.id RETURNING * INTO v_task;
  RETURN NEXT v_task;
END;
$$;
REVOKE ALL ON FUNCTION public.api_claim_next_task(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_claim_next_task(text) TO service_role;
