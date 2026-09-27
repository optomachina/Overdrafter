-- Source-only reverse. Retain immutable review evidence if any row exists.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table engineering_private.native_step_reviews in access exclusive mode;
do $guard$
begin
  if current_user <> 'postgres'
    or exists(select 1 from engineering_private.native_step_reviews) then
    raise exception 'ovd563_review_history_present';
  end if;
end $guard$;
drop function public.api_read_native_step_review(uuid,uuid,uuid);
drop function engineering_private.associate_native_step_review(
  uuid,uuid,uuid,text,text,uuid,text,text,text,bytea);
drop table engineering_private.native_step_reviews;
commit;
