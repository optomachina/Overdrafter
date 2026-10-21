-- Pending pgTAP for ovd-766-e (runs once the draft is applied).
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select ok(
  (select p.prosecdef from pg_proc p where p.oid = 'public.user_can_edit_job(uuid)'::regprocedure),
  'user_can_edit_job is security definer'
);
select ok(
  not has_function_privilege('anon', 'public.user_can_edit_job(uuid)', 'EXECUTE'),
  'anon cannot execute user_can_edit_job'
);
select ok(
  position('user_can_access_org' in pg_get_functiondef('public.user_can_edit_job(uuid)'::regprocedure)) = 0,
  'plain org membership no longer grants job edit'
);
select ok(
  position('created_by' in pg_get_functiondef('public.user_can_edit_job(uuid)'::regprocedure)) > 0,
  'job owner can still edit'
);

select * from finish();
rollback;
