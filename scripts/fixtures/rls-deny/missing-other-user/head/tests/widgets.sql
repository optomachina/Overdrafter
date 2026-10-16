begin;
select plan(3);

-- deny: anon public.widgets
set local role anon;
select throws_ok($$select id from public.widgets$$, '42501', null, 'anon cannot read widgets');
reset role;

-- deny: role_boundary public.widgets
set local role authenticated;
select results_eq(
  $$select count(*)::int from public.widgets where owner_id <> auth.uid()$$,
  $$values (0)$$,
  'authenticated callers never see service-role-only rows'
);
reset role;
-- end deny

select * from finish();
rollback;
