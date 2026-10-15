-- SOURCE ONLY. Refuse rollback if any immutable mapping has been admitted.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Private artifact rollback requires READ COMMITTED.';
  end if;
end $$;
-- The shared window 2 reverse lock: staged reverses run one at a time.
select pg_advisory_xact_lock(510, 2);
-- Freeze both admission sets before checking emptiness; otherwise a concurrent
-- trusted insert could commit after the check and be deleted by DROP. The
-- window 2 relation order: the attempt and admission parents (mapping
-- preparation locks the admission FOR UPDATE first), then storage, then the
-- mapping tables. The drops remove foreign keys to all four parents and take
-- ACCESS EXCLUSIVE on them anyway; taking them first avoids a deadlock.
lock table public.engineering_execution_attempts,
  engineering_private.native_input_admissions,
  storage.objects, storage.buckets,
  engineering_private.native_artifact_inputs,
  engineering_private.native_artifact_outputs in access exclusive mode;
do $$ begin
  if exists (select 1 from engineering_private.native_artifact_inputs)
    or exists (select 1 from engineering_private.native_artifact_outputs) then
    raise exception 'Cannot remove retained native artifact mappings.';
  end if;
end $$;
drop table engineering_private.native_artifact_outputs;
drop table engineering_private.native_artifact_inputs;
drop function engineering_private.preserve_native_artifact_mapping();
commit;
