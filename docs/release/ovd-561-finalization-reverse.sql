-- Source-only rollback; never delete completed native history.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- READ COMMITTED before any lock, then the shared window 2 reverse lock, so
-- the emptiness check reads a snapshot taken after the history lock and every
-- staged reverse runs one at a time.
do $isolation$
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'ovd561_reverse_requires_read_committed';
  end if;
end $isolation$;
select pg_advisory_xact_lock(510, 2);
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
