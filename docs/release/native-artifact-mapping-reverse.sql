-- SOURCE ONLY reverse of native-artifact-mapping-forward.sql. Not an active
-- migration. It drops only the three mapping writer functions; the immutable
-- mapping tables belong to private-artifact-forward.sql and are reversed (on
-- empty history only) by private-artifact-reverse.sql, which runs after this.
-- Window 2 order: docs/release/window-2/README.md.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- READ COMMITTED, then the shared window 2 lock, so no staged forward or
-- reverse interleaves with this one.
do $isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'native_mapping_reverse_requires_read_committed' using errcode = '0A000';
  end if;
end $isolation$;
select pg_advisory_xact_lock(510, 2);
do $preflight$
begin
  if current_user <> 'postgres'
    or to_regprocedure('engineering_private.prepare_native_artifact_inputs(uuid,uuid,text)') is null
    or to_regprocedure('engineering_private.prepare_native_artifact_outputs(uuid,text)') is null
    or to_regprocedure('engineering_private.write_native_artifact_mappings(uuid,text,text)') is null then
    raise exception 'native_mapping_reverse_preflight_failed';
  end if;
end $preflight$;
drop function engineering_private.write_native_artifact_mappings(uuid,text,text) restrict;
drop function engineering_private.prepare_native_artifact_outputs(uuid,text) restrict;
drop function engineering_private.prepare_native_artifact_inputs(uuid,uuid,text) restrict;
commit;
