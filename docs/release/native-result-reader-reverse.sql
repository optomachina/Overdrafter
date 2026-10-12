-- Disposable fixture reversal only; do not apply to a populated production DB.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- READ COMMITTED before any lock, then the shared window 2 reverse lock, so
-- the emptiness check reads a snapshot taken after the history lock and every
-- staged reverse runs one at a time.
do $isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'native_result_binding_reverse_requires_read_committed';
  end if;
end $isolation$;
select pg_advisory_xact_lock(510, 2);
lock table engineering_private.native_result_read_bindings in access exclusive mode;
do $preflight$
begin
  if current_user <> 'postgres' or current_setting('transaction_isolation') <> 'read committed'
    or exists (select 1 from engineering_private.native_result_read_bindings) then
    raise exception 'native_result_binding_reverse_requires_empty_history';
  end if;
end $preflight$;
drop function engineering_private.admit_native_result_read_binding(uuid,uuid,uuid,jsonb,text);
drop table engineering_private.native_result_read_bindings;
commit;
