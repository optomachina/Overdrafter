-- Disposable fixture reversal only; do not apply to a populated production DB.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
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
