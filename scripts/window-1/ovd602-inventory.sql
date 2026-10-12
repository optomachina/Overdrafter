-- OVD-602 privilege inventory. Read only: one SELECT, no writes, no temp objects.
--
-- Prints one JSON document describing what the API roles (PUBLIC, anon,
-- authenticated, service_role) can reach in application schemas:
--   * every SECURITY DEFINER function, plus every other function that anon or
--     authenticated can execute, with its pinned search_path and EXECUTE grantees
--   * every table, view and materialized view: RLS flags and grants per role
--   * every RLS policy (roles, command, and an md5 of its USING / WITH CHECK)
--   * schema USAGE grants
-- Platform schemas (auth, storage, extensions, realtime, vault and similar) and
-- extension members are excluded, so the same query runs on the hosted project
-- and on the disposable rehearsal database.
--
-- Usage: psql "$DB_URL" -X -A -t -q -f scripts/window-1/ovd602-inventory.sql > inventory.json
-- The session search_path is pinned so every signature prints schema qualified.
set search_path = pg_catalog;
with
app_schema as (
  select n.oid, n.nspname, n.nspacl, n.nspowner
  from pg_catalog.pg_namespace n
  where n.nspname not in (
      'pg_catalog', 'information_schema', 'auth', 'storage', 'extensions',
      'graphql', 'graphql_public', 'realtime', '_realtime', 'vault', 'pgsodium',
      'pgsodium_masks', 'supabase_functions', 'supabase_migrations', 'cron', 'net',
      'pgbouncer', '_analytics', 'pgtle', 'topology', 'tiger', 'tiger_data')
    and n.nspname !~ '^pg_(toast|temp)'
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_namespace'::regclass and d.objid = n.oid and d.deptype = 'e')
),
api_role(grantee_oid, grantee) as (
  select 0::oid, 'PUBLIC'
  union all
  select r.oid, r.rolname from pg_catalog.pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
),
fn as (
  select
    p.oid::regprocedure::text as signature,
    p.prosecdef as definer,
    (select pg_catalog.substr(c, 13) from pg_catalog.unnest(p.proconfig) c where c like 'search_path=%') as search_path,
    coalesce((
      select pg_catalog.jsonb_agg(ar.grantee order by ar.grantee)
      from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      join api_role ar on ar.grantee_oid = a.grantee
      where a.privilege_type = 'EXECUTE'), '[]'::jsonb) as execute
  from pg_catalog.pg_proc p
  join app_schema s on s.oid = p.pronamespace
  where not exists (
    select 1 from pg_catalog.pg_depend d
    where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
rel as (
  select
    pg_catalog.format('%I.%I', s.nspname, c.relname) as name,
    c.relkind::text as kind,
    c.relrowsecurity as rls,
    c.relforcerowsecurity as force_rls,
    (
      select coalesce(pg_catalog.jsonb_object_agg(g.grantee, g.privileges), '{}'::jsonb)
      from (
        select ar.grantee, pg_catalog.jsonb_agg(a.privilege_type order by a.privilege_type) as privileges
        from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
        join api_role ar on ar.grantee_oid = a.grantee
        group by ar.grantee
      ) g
    ) as grants
  from pg_catalog.pg_class c
  join app_schema s on s.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
pol as (
  select
    pg_catalog.format('%I.%I', p.schemaname, p.tablename) as "table",
    p.policyname::text as name,
    p.cmd::text as cmd,
    p.permissive::text as permissive,
    pg_catalog.to_jsonb(p.roles::text[]) as roles,
    pg_catalog.md5(coalesce(p.qual, '')) as using_md5,
    pg_catalog.md5(coalesce(p.with_check, '')) as check_md5
  from pg_catalog.pg_policies p
  where p.schemaname in (select nspname from app_schema) or p.schemaname = 'storage'
),
sch as (
  select
    s.nspname::text as name,
    coalesce((
      select pg_catalog.jsonb_agg(ar.grantee order by ar.grantee)
      from pg_catalog.aclexplode(coalesce(s.nspacl, pg_catalog.acldefault('n', s.nspowner))) a
      join api_role ar on ar.grantee_oid = a.grantee
      where a.privilege_type = 'USAGE'), '[]'::jsonb) as usage
  from app_schema s
)
select pg_catalog.jsonb_build_object(
  'format', 'ovd602.inventory.v1',
  'schemas', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(sch) order by name), '[]') from sch),
  'functions', (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fn) order by signature), '[]') from fn
    where definer or execute ?| array['PUBLIC', 'anon', 'authenticated']),
  'relations', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rel) order by name), '[]') from rel),
  'policies', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pol) order by "table", name), '[]') from pol)
)::text;
