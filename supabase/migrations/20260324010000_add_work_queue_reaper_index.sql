-- TODO-016: Add locked_at index to work_queue for reaper query performance
--
-- The reapStaleTasks() function queries:
--   WHERE status='running' AND locked_at < cutoff
--
-- The current index idx_work_queue_dispatch(status, task_type, available_at)
-- doesn't cover locked_at, forcing a sequential scan of the running partition.
-- This standalone statement keeps the index build non-blocking for queue writes.

create index concurrently idx_work_queue_reaper on public.work_queue(locked_at)
  where status = 'running';
