begin;
select plan(3);

-- deny: anon public.widgets
set local role anon;
select throws_ok($$select id from public.widgets$$, '42501', null, 'anon cannot read widgets');
reset role;

-- deny: other_user public.widgets
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222"}';
select is_empty($$select id from public.widgets$$, 'another user sees no widgets');
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
