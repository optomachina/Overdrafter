-- Source-only reverse. Retain immutable review evidence if any row exists.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- The lock blocks new writers, but an older REPEATABLE READ or SERIALIZABLE
-- snapshot could still read committed review evidence as absent. Refuse before
-- any lock, then take the shared window 2 reverse lock so staged reverses run
-- one at a time.
do $isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd563_reverse_requires_read_committed';
  end if;
end $isolation$;
select pg_advisory_xact_lock(510, 2);
lock table engineering_private.native_step_reviews in access exclusive mode;
select engineering_private.assert_empty_native_step_reviews();
drop function public.api_read_native_step_review(uuid,uuid,uuid);
drop function engineering_private.associate_native_step_review(
  uuid,uuid,uuid,text,text,uuid,text,text,text,bytea);
drop table engineering_private.native_step_reviews;
drop function engineering_private.assert_empty_native_step_reviews();
drop function engineering_private.step_review_owner();
drop function engineering_private.sha256_hex(bytea);
drop function engineering_private.valid_sha256(text);
commit;
