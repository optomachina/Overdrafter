-- TODO-016: Add locked_at index to work_queue for reaper query performance
-- https://github.com/anthropics/claude-code/issues/???
--
-- The reapStaleTasks() function queries:
--   WHERE status='running' AND locked_at < cutoff
--
-- The current index idx_work_queue_dispatch(status, task_type, available_at)
-- doesn't cover locked_at, forcing a sequential scan of the running partition.
-- This partial index covers the reaper's access pattern efficiently.

create index idx_work_queue_reaper on public.work_queue(locked_at)
  where status = 'running';
