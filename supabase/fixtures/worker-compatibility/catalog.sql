-- DRAFT, NOT EXECUTED. Compare this identical suite on the admitted baseline and
-- candidate. See README.md: this catalog cannot qualify the live caller alone.
begin;
set local search_path = public, extensions;
select no_plan();

create temporary table worker_rpc_contract (
  signature text primary key, argument_names text[], default_count integer,
  result_type text, returns_set boolean
) on commit drop;
insert into worker_rpc_contract values
('public.api_claim_next_task(text)', array['p_worker_name'], 0, 'public.work_queue', true),
('public.api_auto_approve_job_requirements(uuid)', array['p_job_id'], 0, 'integer', false),
('public.api_reserve_spend(uuid,text,numeric,jsonb)', array['p_organization_id','p_category','p_estimated_usd','p_context'], 1, 'jsonb', false),
('public.api_settle_spend(uuid,numeric,jsonb)', array['p_reservation_id','p_actual_usd','p_metadata'], 1, 'jsonb', false),
('public.api_register_trusted_file_hash(uuid,text)', array['p_job_file_id','p_content_sha256'], 0, 'void', false),
('public.api_resolve_trusted_part_intake(uuid)', array['p_part_id'], 0, 'jsonb', false),
('public.api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)', array['p_target_part_id','p_source_part_id','p_part_version_id'], 0, 'jsonb', false),
('public.api_register_quote_request_lane(uuid,jsonb)', array['p_vendor_quote_result_id','p_scope_snapshot'], 0, 'void', false),
('public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)', array['p_work_queue_task_id','p_vendor_quote_result_id','p_scope_snapshot','p_expected_worker_name','p_expected_claimed_at'], 0, 'jsonb', false),
('public.api_publish_quote_package(uuid,uuid,text,boolean)', array['p_job_id','p_quote_run_id','p_client_summary','p_force'], 2, 'uuid', false);

select is(count(*)::integer, 10, 'all ten mandatory RPC contracts are enumerated') from worker_rpc_contract;
select ok(to_regprocedure(signature) is not null, signature || ': exact identity exists') from worker_rpc_contract order by signature;
select is(p.proargnames, c.argument_names, c.signature || ': named arguments are unchanged')
from worker_rpc_contract c left join pg_proc p on p.oid = to_regprocedure(c.signature) order by c.signature;
select is(p.pronargdefaults::integer, c.default_count, c.signature || ': SQL default count is unchanged')
from worker_rpc_contract c left join pg_proc p on p.oid = to_regprocedure(c.signature) order by c.signature;
select is(p.prorettype, to_regtype(c.result_type)::oid, c.signature || ': exact result type is unchanged')
from worker_rpc_contract c left join pg_proc p on p.oid = to_regprocedure(c.signature) order by c.signature;
select is(p.proretset, c.returns_set, c.signature || ': set/scalar cardinality is unchanged')
from worker_rpc_contract c left join pg_proc p on p.oid = to_regprocedure(c.signature) order by c.signature;
select ok(has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE'), signature || ': actual service role has EXECUTE')
from worker_rpc_contract order by signature;
-- Count every overload, not just a favorable one. The inspected migration trees
-- define exactly one public overload for each of these names. Actual named
-- calls, including untyped NULL, are in service_role.sql.
select is((select count(*)::integer from pg_proc other
  join pg_namespace n on n.oid = other.pronamespace
  where n.nspname = 'public' and other.proname = split_part(split_part(c.signature, '.', 2), '(', 1)),
  1, c.signature || ': no additional overload can create named/NULL ambiguity')
from worker_rpc_contract c order by signature;
select diag(jsonb_build_object('signature', c.signature,
  'arguments', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid),
  'definitionMd5', md5(pg_get_functiondef(p.oid)), 'owner', pg_get_userbyid(p.proowner),
  'securityDefiner', p.prosecdef, 'acl', p.proacl, 'configuration', p.proconfig)::text)
from worker_rpc_contract c join pg_proc p on p.oid = to_regprocedure(c.signature) order by c.signature;
select is(pg_get_expr(p.proargdefaults, 0), '''{}''::jsonb', 'reserve context SQL default is an empty object')
from pg_proc p where p.oid = to_regprocedure('public.api_reserve_spend(uuid,text,numeric,jsonb)');
select is(pg_get_expr(p.proargdefaults, 0), '''{}''::jsonb', 'settle metadata SQL default is an empty object')
from pg_proc p where p.oid = to_regprocedure('public.api_settle_spend(uuid,numeric,jsonb)');
select is(pg_get_expr(p.proargdefaults, 0), 'NULL::text, false', 'publication SQL defaults remain null summary and false force')
from pg_proc p where p.oid = to_regprocedure('public.api_publish_quote_package(uuid,uuid,text,boolean)');

-- Exact compact archived receipt inventory. Additional touched tables remain
-- outside its full contract, and are documented in README.md.
create temporary table worker_column_contract (relation_name text, column_name text, sql_type text) on commit drop;
insert into worker_column_contract values
('work_queue','id','uuid'), ('work_queue','organization_id','uuid'), ('work_queue','job_id','uuid'),
('work_queue','part_id','uuid'), ('work_queue','quote_run_id','uuid'), ('work_queue','package_id','uuid'),
('work_queue','task_type','public.queue_task_type'), ('work_queue','status','public.queue_task_status'),
('work_queue','payload','jsonb'), ('work_queue','attempts','integer'),
('work_queue','available_at','timestamp with time zone'), ('work_queue','locked_at','timestamp with time zone'),
('work_queue','locked_by','text'), ('work_queue','last_error','text'),
('work_queue','created_at','timestamp with time zone'), ('work_queue','updated_at','timestamp with time zone'),
('vendor_quote_results','id','uuid'), ('vendor_quote_results','quote_run_id','uuid'),
('vendor_quote_results','part_id','uuid'), ('vendor_quote_results','organization_id','uuid'),
('vendor_quote_results','vendor','public.vendor_name'), ('vendor_quote_results','requested_quantity','integer'),
('vendor_quote_results','status','public.vendor_status'), ('vendor_quote_results','notes','jsonb'), ('vendor_quote_results','raw_payload','jsonb'),
('vendor_quote_offers','vendor_quote_result_id','uuid'), ('vendor_quote_offers','offer_key','text'),
('vendor_quote_offers','valid_until','timestamp with time zone'), ('vendor_quote_offers','geographic_origin','text'),
('vendor_quote_offers','provenance_status','text'), ('vendor_quote_offers','sourcing','text'), ('vendor_quote_offers','tier','text'),
('jobs','organization_id','uuid'), ('jobs','status','public.job_status'),
('quote_runs','status','public.quote_run_status'), ('quote_runs','quote_request_id','uuid'),
('quote_requests','status','public.quote_request_status'),
('parts','id','uuid'), ('parts','job_id','uuid'), ('parts','organization_id','uuid'),
('parts','cad_file_id','uuid'), ('parts','drawing_file_id','uuid'), ('parts','part_version_id','uuid'),
('job_files','id','uuid'), ('job_files','trusted_content_sha256','text'), ('job_files','storage_path','text'),
('approved_part_requirements','part_id','uuid'), ('approved_part_requirements','material','text'),
('approved_part_requirements','quantity','integer'), ('approved_part_requirements','quote_quantities','integer[]'),
('approved_part_requirements','applicable_vendors','public.vendor_name[]'), ('approved_part_requirements','spec_snapshot','jsonb'),
('audit_events','actor_user_id','uuid'), ('audit_events','package_id','uuid'), ('audit_events','payload','jsonb');
insert into worker_column_contract values
('vendor_quote_results','unit_price_usd','numeric'), ('vendor_quote_results','total_price_usd','numeric'),
('vendor_quote_results','lead_time_business_days','integer'), ('vendor_quote_results','quote_url','text'), ('vendor_quote_results','dfm_issues','jsonb'),
('vendor_quote_offers','organization_id','uuid'), ('vendor_quote_offers','supplier','text'), ('vendor_quote_offers','lane_label','text'),
('vendor_quote_offers','quoted_at','timestamp with time zone'), ('vendor_quote_offers','validity_duration_days','integer'),
('vendor_quote_offers','validity_source','text'), ('vendor_quote_offers','validity_terms','text'),
('vendor_quote_offers','unit_price_usd','numeric'), ('vendor_quote_offers','total_price_usd','numeric'),
('vendor_quote_offers','lead_time_business_days','integer'), ('vendor_quote_offers','process','text'), ('vendor_quote_offers','material','text'),
('vendor_quote_offers','finish','text'), ('vendor_quote_offers','tightest_tolerance','text'), ('vendor_quote_offers','notes','text'), ('vendor_quote_offers','raw_payload','jsonb'),
('parts','name','text'), ('parts','normalized_key','text'), ('parts','quantity','integer'),
('job_files','job_id','uuid'), ('job_files','storage_bucket','text'), ('job_files','original_name','text'), ('job_files','file_kind','public.job_file_kind'),
('job_files','content_sha256','text'), ('job_files','mime_type','text'), ('job_files','size_bytes','bigint'),
('approved_part_requirements','id','uuid'), ('approved_part_requirements','description','text'), ('approved_part_requirements','part_number','text'),
('approved_part_requirements','revision','text'), ('approved_part_requirements','finish','text'), ('approved_part_requirements','tightest_tolerance_inch','numeric'),
('approved_part_requirements','requested_by_date','date'), ('approved_part_requirements','updated_at','timestamp with time zone'),
('audit_events','organization_id','uuid'), ('audit_events','job_id','uuid'), ('audit_events','event_type','text');
select is(a.atttypid, to_regtype(c.sql_type)::oid, c.relation_name || '.' || c.column_name || ': matrix column type')
from worker_column_contract c left join pg_attribute a
  on a.attrelid = to_regclass('public.' || c.relation_name) and a.attname = c.column_name and not a.attisdropped
order by c.relation_name, c.column_name;
select ok(has_table_privilege('service_role', 'public.' || t.relation_name, p.privilege),
  t.relation_name || ': service role has ' || p.privilege)
from (select distinct relation_name from worker_column_contract) t
cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege)
order by t.relation_name, p.privilege;
select is(enum_range(null::public.queue_task_status)::text, '{queued,running,completed,failed,cancelled}', 'queue status spelling is cancelled');
select is(enum_range(null::public.quote_request_status)::text, '{queued,requesting,received,failed,canceled}', 'quote request status spelling is canceled');
select ok(exists (select 1 from pg_constraint c where c.conrelid='public.quote_runs'::regclass
  and c.contype='f' and c.confrelid='public.quote_requests'::regclass
  and c.conkey=array[(select attnum from pg_attribute where attrelid='public.quote_runs'::regclass and attname='quote_request_id')]::smallint[]),
  'quote_runs.quote_request_id has the exact relationship foreign key');
select ok(exists (select 1 from pg_index i where i.indrelid='public.quote_runs'::regclass and i.indisunique
  and i.indnkeyatts=1 and i.indkey[0]=(select attnum from pg_attribute where attrelid='public.quote_runs'::regclass and attname='quote_request_id')),
  'quote-request relationship has at-most-one run metadata');
select ok(exists (select 1 from pg_constraint c where c.conrelid='public.approved_part_requirements'::regclass
  and c.contype='u' and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='part_id')]::smallint[]),
  'approved requirements have one row per part for maybeSingle');
select ok(exists (select 1 from pg_constraint c where c.conrelid='public.vendor_quote_offers'::regclass
  and c.contype='u' and c.conkey=array[
    (select attnum from pg_attribute where attrelid=c.conrelid and attname='vendor_quote_result_id'),
    (select attnum from pg_attribute where attrelid=c.conrelid and attname='offer_key')]::smallint[]),
  'vendor offers preserve the worker upsert conflict target');
select diag('BOUNDARY: SQL relationship/cardinality is tested; embedded PostgREST object serialization is NOT tested.');
select * from finish();
rollback;
