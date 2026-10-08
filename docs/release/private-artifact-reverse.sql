-- SOURCE ONLY. Refuse rollback if any immutable mapping has been admitted.
begin;
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Private artifact rollback requires READ COMMITTED.';
  end if;
end $$;
-- Freeze both admission sets before checking emptiness; otherwise a concurrent
-- trusted insert could commit after the check and be deleted by DROP.
lock table engineering_private.native_artifact_inputs,
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
