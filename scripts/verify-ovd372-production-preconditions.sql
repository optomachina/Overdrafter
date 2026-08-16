-- OVD-372 read-only production precondition.
-- Run with psql -v ON_ERROR_STOP=1 before any migration-history repair.
-- This inspects only the migration ledger and authorization catalog; it reads no
-- customer, file, quote, billing, or Storage rows.

do $ovd372$
declare
  v_count integer;
  v_head text;
  v_expected record;
  v_oid pg_catalog.oid;
  v_definition_md5 text;
  v_owner text;
  v_security_definer boolean;
  v_volatility "char";
  v_config text;
  v_acl text;
  v_rls boolean;
  v_force_rls boolean;
  v_columns text;
  v_constraints text;
  v_policies text;
  v_triggers text;
begin
  select pg_catalog.count(*), pg_catalog.max(version::text)
  into v_count, v_head
  from supabase_migrations.schema_migrations;

  if v_count <> 74 or v_head <> '20260813005020' then
    raise exception 'OVD-372 production migration ledger drifted: count %, head %.',
      v_count,
      v_head;
  end if;

  select pg_catalog.count(*)
  into v_count
  from supabase_migrations.schema_migrations
  where version::text = any(array[
    '20260402100000',
    '20260403103000',
    '20260406000000',
    '20260408193000',
    '20260731015400'
  ]);

  if v_count <> 0 then
    raise exception 'One or more OVD-372 reconciliation versions are already recorded.';
  end if;

  if pg_catalog.to_regclass('public.extraction_quality_alerts') is not null
    or pg_catalog.to_regprocedure(
      'public.evaluate_extraction_quality_alerts(date)'
    ) is not null then
    raise exception 'The deferred extraction-quality foundation is no longer absent.';
  end if;

  for v_expected in
    select *
    from (values
      ('public.api_request_quote(uuid,boolean)', 'postgres', -- NOSONAR: exact catalog signatures are intentionally explicit.
       '0d515533235ec8a93c95776dd7927acc', true, 'v', 'search_path=pg_catalog', -- NOSONAR: exact fingerprints and function properties are evidence.
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'), -- NOSONAR: exact ACL evidence must remain reviewable in place.
      ('public.api_request_quote_scoped(uuid,public.vendor_name[])', 'postgres',
       'ff4a98a5f55f7e91fb1df664eb31d234', true, 'v', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'),
      ('public.api_request_quotes(uuid[],boolean)', 'postgres',
       '2312e5fcb093cb5340e4b76c74428b0e', true, 'v', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'),
      ('public.api_list_client_quote_workspace(uuid[])', 'postgres',
       '4169ce28414b2b5f119d8fc858daa6df', true, 's', 'search_path=public',
       'PUBLIC:EXECUTE:false,anon:EXECUTE:false,authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('public.normalize_vendor_name_array(public.vendor_name[])', 'postgres',
       'af250991433ace227fbc1f786a6e7cd0', false, 'i', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'), -- NOSONAR: exact ACL evidence must remain reviewable in place.
      ('public.build_vendor_preferences_json(public.vendor_name[],public.vendor_name[],timestamp with time zone)', 'postgres',
       'ab6fd157f485ca6ea3c2c198cb6ec596', false, 'i', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('public.get_enabled_client_quote_vendors(uuid,uuid,uuid)', 'postgres',
       '72c64010590dfcaa04d89521a1ecc5a0', true, 's', 'search_path=pg_catalog',
       'postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('public.api_get_job_vendor_preferences(uuid)', 'postgres',
       '747b0596f777889a0e8fe030abc6e396', true, 's', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('public.api_set_project_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'postgres',
       'defd5e0edfdfb6650258250674f6b930', true, 'v', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('public.api_set_job_vendor_preferences(uuid,public.vendor_name[],public.vendor_name[])', 'postgres',
       '319c4286e01afee80bfb289570552c2c', true, 'v', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false,service_role:EXECUTE:false'),
      ('private.get_commercial_account_entitlement_state(uuid)', 'postgres',
       '8e0ad673020029d3cace13f28154ee6f', true, 's', 'search_path=pg_catalog',
       'postgres:EXECUTE:false'),
      ('public.api_admin_get_organization_entitlement_state(uuid)', 'postgres',
       'a3c58f94a8e363646646bacd0f7c54fa', true, 's', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'),
      ('public.api_admin_search_commercial_accounts(text,text,integer)', 'postgres',
       'b0bdfea072822fd994c44608df2d2e76', true, 's', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'),
      ('public.api_admin_get_commercial_account(uuid)', 'postgres',
       '40a6c63ebdac15e44b448f2d6239ccde', true, 's', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false'),
      ('public.api_admin_list_commercial_account_audit(uuid,text,integer)', 'postgres',
       '8ba695cdd48c1ca73dbd44bccc1a3b13', true, 's', 'search_path=pg_catalog',
       'authenticated:EXECUTE:false,postgres:EXECUTE:false')
    ) as expected(
      signature,
      owner,
      definition_md5,
      security_definer,
      volatility,
      config,
      acl
    )
  loop
    v_oid := pg_catalog.to_regprocedure(v_expected.signature);
    if v_oid is null then
      raise exception 'OVD-372 expected function is absent: %.', v_expected.signature;
    end if;

    select
      pg_catalog.md5(pg_catalog.pg_get_functiondef(proc.oid)),
      owner_role.rolname,
      proc.prosecdef,
      proc.provolatile,
      coalesce(pg_catalog.array_to_string(proc.proconfig, ','), ''),
      (
        select pg_catalog.string_agg(
          coalesce(grantee.rolname, 'PUBLIC') || ':' -- NOSONAR: the canonical PUBLIC role label is intentionally repeated.
            || acl.privilege_type || ':' || acl.is_grantable,
          ',' order by
            coalesce(grantee.rolname, 'PUBLIC'),
            acl.privilege_type,
            acl.is_grantable
        )
        from pg_catalog.aclexplode(
          coalesce(
            proc.proacl,
            pg_catalog.acldefault('f', proc.proowner)
          )
        ) acl
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
      )
    into
      v_definition_md5,
      v_owner,
      v_security_definer,
      v_volatility,
      v_config,
      v_acl
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_roles owner_role on owner_role.oid = proc.proowner
    where proc.oid = v_oid;

    if v_owner is distinct from v_expected.owner
      or v_definition_md5 is distinct from v_expected.definition_md5
      or v_security_definer is distinct from v_expected.security_definer
      or v_volatility is distinct from v_expected.volatility::"char"
      or v_config is distinct from v_expected.config
      or v_acl is distinct from v_expected.acl then
      raise exception 'OVD-372 function catalog drifted: %.', v_expected.signature;
    end if;
  end loop;

  for v_expected in
    select *
    from (values
      (
        'job_vendor_preferences',
        'job_id:1:pg_catalog.uuid:NO:|included_vendors:2:public._vendor_name:NO:''{}''::vendor_name[]|excluded_vendors:3:public._vendor_name:NO:''{}''::vendor_name[]|created_at:4:pg_catalog.timestamptz:NO:timezone(''utc''::text, now())|updated_at:5:pg_catalog.timestamptz:NO:timezone(''utc''::text, now())',
        'job_vendor_preferences_job_id_fkey:FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE|job_vendor_preferences_no_overlap:CHECK (NOT included_vendors && excluded_vendors)|job_vendor_preferences_pkey:PRIMARY KEY (job_id)',
        'job_vendor_preferences_select:{authenticated}:SELECT:user_can_access_job(job_id):',
        'touch_job_vendor_preferences_updated_at:CREATE TRIGGER touch_job_vendor_preferences_updated_at BEFORE UPDATE ON job_vendor_preferences FOR EACH ROW EXECUTE FUNCTION touch_updated_at()'
      ),
      (
        'project_vendor_preferences',
        'project_id:1:pg_catalog.uuid:NO:|included_vendors:2:public._vendor_name:NO:''{}''::vendor_name[]|excluded_vendors:3:public._vendor_name:NO:''{}''::vendor_name[]|created_at:4:pg_catalog.timestamptz:NO:timezone(''utc''::text, now())|updated_at:5:pg_catalog.timestamptz:NO:timezone(''utc''::text, now())',
        'project_vendor_preferences_no_overlap:CHECK (NOT included_vendors && excluded_vendors)|project_vendor_preferences_pkey:PRIMARY KEY (project_id)|project_vendor_preferences_project_id_fkey:FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE',
        'project_vendor_preferences_select:{authenticated}:SELECT:user_can_access_project(project_id):',
        'touch_project_vendor_preferences_updated_at:CREATE TRIGGER touch_project_vendor_preferences_updated_at BEFORE UPDATE ON project_vendor_preferences FOR EACH ROW EXECUTE FUNCTION touch_updated_at()'
      )
    ) as expected(table_name, columns, constraints, policies, triggers)
  loop
    select
      owner_role.rolname,
      table_row.relrowsecurity,
      table_row.relforcerowsecurity,
      (
        select pg_catalog.string_agg(
          coalesce(grantee.rolname, 'PUBLIC') || ':'
            || acl.privilege_type || ':' || acl.is_grantable,
          ',' order by
            coalesce(grantee.rolname, 'PUBLIC'),
            acl.privilege_type,
            acl.is_grantable
        )
        from pg_catalog.aclexplode(
          coalesce(
            table_row.relacl,
            pg_catalog.acldefault('r', table_row.relowner)
          )
        ) acl
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
      )
    into v_owner, v_rls, v_force_rls, v_acl
    from pg_catalog.pg_class table_row
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = table_row.relnamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid = table_row.relowner
    where namespace_row.nspname = 'public' -- NOSONAR: exact schema evidence is intentionally explicit.
      and table_row.relname = v_expected.table_name
      and table_row.relkind = 'r';

    if not found then
      raise exception 'OVD-372 expected preference table is absent: %.',
        v_expected.table_name;
    end if;

    if v_owner is distinct from 'postgres'
      or v_rls is distinct from true
      or v_force_rls is distinct from false
      or v_acl is distinct from
        'authenticated:SELECT:false,postgres:DELETE:false,postgres:INSERT:false,postgres:MAINTAIN:false,postgres:REFERENCES:false,postgres:SELECT:false,postgres:TRIGGER:false,postgres:TRUNCATE:false,postgres:UPDATE:false,service_role:DELETE:false,service_role:INSERT:false,service_role:MAINTAIN:false,service_role:REFERENCES:false,service_role:SELECT:false,service_role:TRIGGER:false,service_role:TRUNCATE:false,service_role:UPDATE:false' then
      raise exception 'OVD-372 preference table authorization drifted: %.',
        v_expected.table_name;
    end if;

    select pg_catalog.string_agg(
      column_row.column_name || ':' || column_row.ordinal_position || ':'
        || column_row.udt_schema || '.' || column_row.udt_name || ':'
        || column_row.is_nullable || ':' || coalesce(column_row.column_default, ''),
      '|' order by column_row.ordinal_position
    )
    into v_columns
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = v_expected.table_name;

    select pg_catalog.string_agg(
      constraint_row.conname || ':'
        || pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
      '|' order by constraint_row.conname
    )
    into v_constraints
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = pg_catalog.to_regclass(
      'public.' || v_expected.table_name
    );

    select pg_catalog.string_agg(
      policy_row.policyname || ':' || policy_row.roles::text || ':'
        || policy_row.cmd || ':' || coalesce(policy_row.qual, '') || ':'
        || coalesce(policy_row.with_check, ''),
      '|' order by policy_row.policyname
    )
    into v_policies
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'public'
      and policy_row.tablename = v_expected.table_name;

    select pg_catalog.string_agg(
      trigger_row.tgname || ':'
        || pg_catalog.pg_get_triggerdef(trigger_row.oid, true),
      '|' order by trigger_row.tgname
    )
    into v_triggers
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = pg_catalog.to_regclass(
      'public.' || v_expected.table_name
    )
      and not trigger_row.tgisinternal;

    if v_columns is distinct from v_expected.columns
      or v_constraints is distinct from v_expected.constraints
      or v_policies is distinct from v_expected.policies
      or v_triggers is distinct from v_expected.triggers then
      raise exception 'OVD-372 preference table catalog drifted: %.',
        v_expected.table_name;
    end if;
  end loop;
end;
$ovd372$;

select 'OVD-372 production preconditions passed.' as result;
