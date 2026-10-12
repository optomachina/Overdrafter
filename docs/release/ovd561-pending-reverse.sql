-- Staged source only. Never remove durable replay/history to recover an attempt.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- READ COMMITTED before any lock, then the shared window 2 reverse lock, so
-- the emptiness check reads a snapshot taken after the history lock and every
-- staged reverse runs one at a time.
do $isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd561_pending_reverse_requires_read_committed';
  end if;
end $isolation$;
select pg_advisory_xact_lock(510, 2);
lock table engineering_private.native_pending_finalizations in access exclusive mode;
do $preflight$
begin
  if current_user <> 'postgres' or current_setting('transaction_isolation') <> 'read committed'
    or exists (select 1 from engineering_private.native_pending_finalizations) then
    raise exception 'ovd561_pending_reverse_requires_empty_history';
  end if;
end $preflight$;
drop function engineering_private.persist_native_pending_finalization(uuid,uuid,text,text,text,uuid);
drop function engineering_private.load_native_pending_finalization(uuid,uuid);
drop table engineering_private.native_pending_finalizations;
commit;
