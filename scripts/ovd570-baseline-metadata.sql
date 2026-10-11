begin read only;
set local statement_timeout='5s';
with funcs as (
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,
pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.proconfig,
md5(pg_get_functiondef(p.oid)) as definition_md5,p.proacl::text as acl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='private' and p.proname in ('build_quote_lane_scope_snapshot','quote_lane_candidates','quote_scope_fingerprint'))
or (n.nspname='public' and p.proname in ('require_verified_auth','user_can_access_org','is_org_admin','user_can_edit_job','get_enabled_client_quote_vendors','normalize_positive_integer_array','api_register_quote_request_lane','api_authorize_xometry_beta_worker_dispatch'))
), rels as (
select c.relname,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity,c.relforcerowsecurity,
(select md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''),'|' order by a.attnum)) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as column_contract_md5
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('organizations','parts','approved_part_requirements','job_files','jobs'))
select jsonb_build_object('functions',(select jsonb_agg(to_jsonb(f) order by nspname,proname,args) from funcs f),'relations',(select jsonb_agg(to_jsonb(r) order by relname) from rels r))::text;
commit;
