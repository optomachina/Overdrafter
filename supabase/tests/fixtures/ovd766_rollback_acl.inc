-- OVD-949: the 12 post-rollback ACL assertions, shared by both rollback passes.
select ok(
  not has_function_privilege('anon', 'public.api_admin_list_all_jobs()', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_admin_list_all_jobs()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_admin_list_all_jobs: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.api_admin_list_all_jobs()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_admin_list_all_jobs()', 'EXECUTE'),
  'api_admin_list_all_jobs: authenticated and service_role keep EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.api_admin_list_all_projects()', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_admin_list_all_projects()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_admin_list_all_projects: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.api_admin_list_all_projects()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_admin_list_all_projects()', 'EXECUTE'),
  'api_admin_list_all_projects: authenticated and service_role keep EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.api_admin_list_all_users()', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_admin_list_all_users()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_admin_list_all_users: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.api_admin_list_all_users()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_admin_list_all_users()', 'EXECUTE'),
  'api_admin_list_all_users: authenticated and service_role keep EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.api_admin_list_organizations()', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_admin_list_organizations()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_admin_list_organizations: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.api_admin_list_organizations()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_admin_list_organizations()', 'EXECUTE'),
  'api_admin_list_organizations: authenticated and service_role keep EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.api_reconcile_job_parts(uuid)', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_reconcile_job_parts(uuid)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'api_reconcile_job_parts: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.api_reconcile_job_parts(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_reconcile_job_parts(uuid)', 'EXECUTE'),
  'api_reconcile_job_parts: authenticated and service_role keep EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.user_can_edit_job(uuid)', 'EXECUTE') and not exists (
    select 1 from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.user_can_edit_job(uuid)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'user_can_edit_job: no EXECUTE for anon or PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.user_can_edit_job(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.user_can_edit_job(uuid)', 'EXECUTE'),
  'user_can_edit_job: authenticated and service_role keep EXECUTE'
);

