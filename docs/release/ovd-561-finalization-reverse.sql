-- Source-only rollback; never delete completed native history.
begin;
set local lock_timeout='5s';
lock table engineering_private.native_receipt_key, engineering_private.native_finalizations in access exclusive mode;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or exists(select 1 from engineering_private.native_finalizations) then
    raise exception 'ovd561_reverse_requires_empty_history';
  end if;
end $preflight$;
drop function engineering_private.finalize_native_result(text,text,text,uuid);
drop table engineering_private.native_finalizations;
drop table engineering_private.native_receipt_key;
commit;
