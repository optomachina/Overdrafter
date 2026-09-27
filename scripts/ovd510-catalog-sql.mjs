/** Shared exact catalog snapshot for the pinned disposable authority fixture. */
export const catalogSql = `begin read only;
with selected_roles(role_name) as (
  select rolname from pg_roles where rolname not like 'pg_%'
), functions as (
  select n.nspname as schema_name, p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
    p.prokind as kind, p.proacl::text as acl, p.proconfig as configuration,
    md5(p.prosrc) as body_md5,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'grantor', pg_get_userbyid(a.grantor),
      'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege', a.privilege_type, 'grantable', a.is_grantable)
      order by a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
      from aclexplode(p.proacl) a) as explicit_grants,
    exists (select 1 from pg_depend dep where dep.classid = 'pg_proc'::regclass
      and dep.objid = p.oid and dep.deptype = 'e') as extension_owned,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'schemaUsage', has_schema_privilege(r.role_name, n.oid, 'USAGE'),
      'functionExecute', has_function_privilege(r.role_name, p.oid, 'EXECUTE')))
      from selected_roles r) as callers
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), defaults as (
  select pg_get_userbyid(d.defaclrole) as owner,
    coalesce(n.nspname, '*') as schema_name, d.defaclobjtype as object_type,
    d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
), schemas as (
  select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner,
    n.nspacl::text as acl,
    exists (select 1 from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where a.grantee = 0 and a.privilege_type = 'USAGE') as public_usage,
    (select jsonb_object_agg(r.role_name,
      has_schema_privilege(r.role_name, n.oid, 'USAGE')) from selected_roles r) as usage
    , (select jsonb_object_agg(o.role_name, jsonb_build_object(
      'usage', has_schema_privilege(o.role_name, n.oid, 'USAGE'),
      'create', has_schema_privilege(o.role_name, n.oid, 'CREATE')))
      from (values ('postgres'), ('supabase_storage_admin')) o(role_name)) as owner_capabilities
  from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
), roles as (
  select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls from pg_roles
  where rolname not like 'pg_%'
), memberships as (
  select parent.rolname as granted_role, member.rolname as member_role,
    m.admin_option, m.inherit_option, m.set_option
  from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
    join pg_roles member on member.oid = m.member
  where parent.rolname not like 'pg_%' or member.rolname not like 'pg_%'
), policies as (
  select schemaname as schema_name, tablename as table_name, policyname as policy_name,
    permissive, roles, cmd, qual, with_check from pg_policies
  where schemaname not like 'pg_%' and schemaname <> 'information_schema'
), relations as (
  select n.nspname as schema_name, c.relname as relation_name, c.relkind as kind,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'select', has_table_privilege(r.role_name, c.oid, 'SELECT'),
      'insert', has_table_privilege(r.role_name, c.oid, 'INSERT'),
      'update', has_table_privilege(r.role_name, c.oid, 'UPDATE'),
      'delete', has_table_privilege(r.role_name, c.oid, 'DELETE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind in ('r','p','v','m')
), sequences as (
  select n.nspname as schema_name, c.relname as sequence_name,
    pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl,
    (select jsonb_object_agg(r.role_name, jsonb_build_object(
      'usage', has_sequence_privilege(r.role_name, c.oid, 'USAGE'),
      'select', has_sequence_privilege(r.role_name, c.oid, 'SELECT'),
      'update', has_sequence_privilege(r.role_name, c.oid, 'UPDATE')))
      from selected_roles r) as callers
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
    and c.relkind = 'S'
)
select jsonb_build_object(
  'databaseVersion', current_setting('server_version'),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by schema_name,function_name,identity_arguments), '[]'::jsonb) from functions f),
  'defaults', (select coalesce(jsonb_agg(to_jsonb(d) order by owner,schema_name,object_type), '[]'::jsonb) from defaults d),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name), '[]'::jsonb) from schemas s),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by rolname), '[]'::jsonb) from roles r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by granted_role,member_role), '[]'::jsonb) from memberships m),
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by schema_name,table_name,policy_name), '[]'::jsonb) from policies p),
  'relations', (select coalesce(jsonb_agg(to_jsonb(t) order by schema_name,relation_name), '[]'::jsonb) from relations t),
  'sequences', (select coalesce(jsonb_agg(to_jsonb(s) order by schema_name,sequence_name), '[]'::jsonb) from sequences s)
)::text;
commit;`;
