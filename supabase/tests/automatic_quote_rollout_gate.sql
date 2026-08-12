begin;

select plan(8);

create temporary table ovd314_test_constants (
  automatic_wrapper regprocedure,
  automatic_wrapper_definition text,
  rollout_guard regprocedure,
  rollout_guard_definition_needle text not null,
  authenticated_role text not null,
  anonymous_role text not null,
  service_role_name text not null,
  execute_privilege text not null
) on commit drop;

insert into ovd314_test_constants values (
  pg_catalog.to_regprocedure('public.api_request_quote_scoped(uuid,public.vendor_name[])'),
  null,
  pg_catalog.to_regprocedure(
    'private.automatic_quote_rollout_enabled_with_lock()'
  ),
  'private.automatic_quote_rollout_enabled_with_lock()',
  'authenticated',
  'anon',
  'service_role',
  'EXECUTE'
);

update ovd314_test_constants
set automatic_wrapper_definition = pg_catalog.pg_get_functiondef(
  automatic_wrapper
)
where automatic_wrapper is not null;

select ok(
  (select automatic_wrapper from ovd314_test_constants) is not null
  and (select rollout_guard from ovd314_test_constants) is not null,
  'the public wrapper and owner-only automatic quote rollout guard exist'
);

select ok(
  pg_catalog.has_function_privilege(
    (select authenticated_role from ovd314_test_constants),
    (select automatic_wrapper from ovd314_test_constants),
    (select execute_privilege from ovd314_test_constants)
  ),
  'authenticated callers retain the public automatic quote RPC'
);

select ok(
  not pg_catalog.has_function_privilege(
    (select anonymous_role from ovd314_test_constants),
    (select automatic_wrapper from ovd314_test_constants),
    (select execute_privilege from ovd314_test_constants)
  ),
  'anonymous callers cannot execute the automatic quote RPC'
);

select ok(
  not exists (
    select 1
    from ovd314_test_constants
    cross join lateral (
      values
        (anonymous_role),
        (authenticated_role),
        (service_role_name)
    ) as application_role(role_name)
    where pg_catalog.has_function_privilege(
      application_role.role_name,
      rollout_guard,
      execute_privilege
    )
  )
  and not exists (
    select 1
    from pg_catalog.pg_proc function_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) function_acl
    where function_row.oid = (
      select rollout_guard::oid
      from ovd314_test_constants
    )
      and function_acl.grantee = 0
      and function_acl.privilege_type = (
        select execute_privilege
        from ovd314_test_constants
      )
  ),
  'application roles and PUBLIC cannot bypass the automatic quote boundary'
);

select ok(
  pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'perform public.require_verified_auth()'
  ) > 0
  and pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'public.user_can_edit_job(v_job.id)'
  ) > pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'perform public.require_verified_auth()'
  ),
  'verified authentication precedes job authorization'
);

select ok(
  pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'private.resolve_organization_entitlements_at'
  ) > 0
  and pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    (select rollout_guard_definition_needle from ovd314_test_constants)
  ) > pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'private.resolve_organization_entitlements_at'
  ),
  'the Pro entitlement decision precedes rollout inspection'
);

select ok(
  pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    (select rollout_guard_definition_needle from ovd314_test_constants)
  ) > 0
  and pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    'private.request_scoped_automatic_quote_impl'
  ) > pg_catalog.strpos(
    (select automatic_wrapper_definition from ovd314_test_constants),
    (select rollout_guard_definition_needle from ovd314_test_constants)
  ),
  'the rollout decision precedes vendor resolution and lifecycle writes'
);

select ok(
  (select automatic_wrapper_definition from ovd314_test_constants)
    like '%automatic_quote_disabled%manual quote%',
  'the disabled Pro result has a stable reason code and manual fallback'
);

select * from finish();

rollback;
