-- Disposable fixture reversal only; do not apply to a populated production DB.
begin;
drop function engineering_private.admit_native_result_read_binding(uuid,uuid,uuid,jsonb,text);
drop table engineering_private.native_result_read_bindings;
commit;
