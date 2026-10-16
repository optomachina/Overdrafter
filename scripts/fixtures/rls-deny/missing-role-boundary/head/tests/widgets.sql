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

select * from finish();
rollback;
