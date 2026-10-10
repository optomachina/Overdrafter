-- DRAFT, NOT EXECUTED. candidate source-dependency control, NOT the old worker.
-- Caller is deliberately a verified internal authenticated user. The genuine
-- service-role/no-subject publication incompatibility is in service_role.sql.
-- Run ONLY at the designated source stage recorded in README.md.
begin;
set local search_path = public, extensions;
select no_plan();
create function pg_temp.publication_id(p_suffix integer) returns uuid language sql immutable as $$
  select ('ec420003-1200-4000-8000-' || lpad(p_suffix::text,12,'0'))::uuid;
$$;
grant execute on function pg_temp.publication_id(integer) to authenticated;
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data)
values(pg_temp.publication_id(1),'authenticated','authenticated','publication-control@example.test',now(),'{"provider":"email"}');
insert into public.organizations(id,name,slug) values(pg_temp.publication_id(2),'Publication dependency control','publication-control-ec420003');
insert into public.organization_memberships(organization_id,user_id,role)
values(pg_temp.publication_id(2),pg_temp.publication_id(1),'internal_estimator');
insert into public.pricing_policies(id,organization_id,version,markup_percent,currency_minor_unit)
values(pg_temp.publication_id(3),pg_temp.publication_id(2),'worker-control',20,0.01);
insert into public.jobs(id,organization_id,created_by,title,status,active_pricing_policy_id)
values(pg_temp.publication_id(10),pg_temp.publication_id(2),pg_temp.publication_id(1),'Prior published control','published',pg_temp.publication_id(3)),
(pg_temp.publication_id(11),pg_temp.publication_id(2),pg_temp.publication_id(1),'Current publication control','internal_review',pg_temp.publication_id(3));
insert into public.parts(id,job_id,organization_id,name,normalized_key,quantity)
values(pg_temp.publication_id(20),pg_temp.publication_id(10),pg_temp.publication_id(2),'Control part','control',1),
(pg_temp.publication_id(21),pg_temp.publication_id(11),pg_temp.publication_id(2),'Control part','control',1);
insert into public.approved_part_requirements(part_id,organization_id,approved_by,description,part_number,revision,material,finish,
  tightest_tolerance_inch,quantity,quote_quantities,requested_by_date,applicable_vendors,spec_snapshot)
select pg_temp.publication_id(n),pg_temp.publication_id(2),pg_temp.publication_id(1),'Control part','CONTROL','A','6061-T6 Aluminum','As machined',
  0.005,1,array[1],null,array['xometry','fictiv']::public.vendor_name[],'{}'::jsonb from unnest(array[20,21]) n;
insert into public.quote_runs(id,job_id,organization_id,initiated_by,status)
values(pg_temp.publication_id(30),pg_temp.publication_id(10),pg_temp.publication_id(2),pg_temp.publication_id(1),'published'),
(pg_temp.publication_id(31),pg_temp.publication_id(11),pg_temp.publication_id(2),pg_temp.publication_id(1),'completed');
-- Prior package is a synthetic setup record solely to satisfy the unchanged
-- auto-publication readiness rule; it makes no old-worker success claim.
insert into public.published_quote_packages(id,job_id,quote_run_id,organization_id,published_by,pricing_policy_id)
values(pg_temp.publication_id(40),pg_temp.publication_id(10),pg_temp.publication_id(30),pg_temp.publication_id(2),pg_temp.publication_id(1),pg_temp.publication_id(3));
insert into public.vendor_quote_results(id,quote_run_id,part_id,organization_id,vendor,requested_quantity,status,unit_price_usd,total_price_usd,lead_time_business_days)
values(pg_temp.publication_id(50),pg_temp.publication_id(31),pg_temp.publication_id(21),pg_temp.publication_id(2),'xometry',1,'instant_quote_received',100,100,7),
(pg_temp.publication_id(51),pg_temp.publication_id(31),pg_temp.publication_id(21),pg_temp.publication_id(2),'fictiv',1,'instant_quote_received',110,110,5);
select set_config('request.jwt.claim.sub',pg_temp.publication_id(1)::text,true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.publication_id(1),'role','authenticated','aal','aal1')::text,true);
set local role authenticated;
select is(current_user::text,'authenticated','control identity is authenticated, never claimed as old worker');
select is(public.api_get_quote_run_readiness(pg_temp.publication_id(31))->'ready','true'::jsonb,'complete control data qualifies for p_force=false');
select throws_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.publication_id(11),p_quote_run_id=>pg_temp.publication_id(31),p_client_summary=>null,p_force=>false)$$,'P0001','Publication requires one exact matching source offer.','candidate parent rejects source-less results');
select is((select count(*)::integer from public.published_quote_packages where quote_run_id=pg_temp.publication_id(31)),0,'candidate failed parent rolls back its package creation');
reset role;
insert into public.vendor_quote_offers(id,vendor_quote_result_id,organization_id,offer_key,supplier,lane_label,unit_price_usd,total_price_usd,lead_time_business_days,provenance_status)
values(pg_temp.publication_id(60),pg_temp.publication_id(50),pg_temp.publication_id(2),'sole-xometry','Synthetic supplier','Sole exact offer',100,100,7,'trusted_adapter'),
(pg_temp.publication_id(61),pg_temp.publication_id(51),pg_temp.publication_id(2),'sole-fictiv','Synthetic supplier','Sole exact offer',110,110,5,'trusted_adapter');
set local role authenticated;
select lives_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.publication_id(11),p_quote_run_id=>pg_temp.publication_id(31),p_client_summary=>null,p_force=>false)$$,'internally authorized control publishes unique exact sources with p_force=false and explicit null summary');
select is((select count(*)::integer from public.published_quote_options where source_vendor_quote_id in(pg_temp.publication_id(50),pg_temp.publication_id(51)) and source_vendor_quote_offer_id in(pg_temp.publication_id(60),pg_temp.publication_id(61))),2,'both published options retain exact source-offer links');
select is((select client_summary from public.published_quote_packages where quote_run_id=pg_temp.publication_id(31)),null::text,'explicit null client summary is retained');
select is((select auto_published from public.published_quote_packages where quote_run_id=pg_temp.publication_id(31)),true,'force false follows successful readiness');
select is((select status::text from public.jobs where id=pg_temp.publication_id(11)),'published','valid parent updates the job');
reset role;
insert into public.vendor_quote_offers(id,vendor_quote_result_id,organization_id,offer_key,supplier,lane_label,unit_price_usd,total_price_usd,lead_time_business_days,sort_rank,provenance_status)
values(pg_temp.publication_id(62),pg_temp.publication_id(50),pg_temp.publication_id(2),'second-variant','Synthetic supplier','Cheaper variant',99,99,7,-1,'trusted_adapter');
set local role authenticated;
select throws_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.publication_id(11),p_quote_run_id=>pg_temp.publication_id(31),p_client_summary=>null,p_force=>false)$$,'P0001','Publication requires one exact matching source offer.','candidate parent rejects ambiguous source variants without relaxing safety');
select is((select source_vendor_quote_offer_id from public.published_quote_options where source_vendor_quote_id=pg_temp.publication_id(50)),pg_temp.publication_id(60),'candidate rejected republication preserves the original exact source');
reset role;
-- Delete only this transaction's synthetic second variant.
delete from public.vendor_quote_offers where id=pg_temp.publication_id(62);
update public.vendor_quote_offers set quoted_at=now()-interval '8 days',valid_until=now()-interval '7 days'
where id=pg_temp.publication_id(60);
set local role authenticated;
select throws_ok($$select public.api_publish_quote_package(p_job_id=>pg_temp.publication_id(11),p_quote_run_id=>pg_temp.publication_id(31),p_client_summary=>null,p_force=>false)$$,'P0001','Quote offer has expired and cannot be published.','candidate parent propagates expired-source failure');
reset role;
select diag('BOUNDARY: authenticated dependency control does not resolve genuine service-role publication incompatibility or prove PostgREST transport.');
select * from finish();
rollback;
