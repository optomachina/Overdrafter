-- Extend the pre-migration synthetic part into a controlled permit fixture.
-- No storage object, network call, or provider operation is performed.
begin;
insert into public.organization_file_blobs (id,organization_id,content_sha256,trusted_content_sha256,
  storage_bucket,storage_path,size_bytes,mime_type)
values ('89000000-0000-4000-8000-000000000007','89000000-0000-4000-8000-000000000003',repeat('a',64),repeat('a',64),
  'job-files','sourcing-parity/part.step',100,'application/step');
insert into public.job_files (id,job_id,organization_id,uploaded_by,blob_id,content_sha256,trusted_content_sha256,
  storage_bucket,storage_path,original_name,normalized_name,file_kind,mime_type,size_bytes)
values ('89000000-0000-4000-8000-000000000006','89000000-0000-4000-8000-000000000004',
  '89000000-0000-4000-8000-000000000003','89000000-0000-4000-8000-000000000001',
  '89000000-0000-4000-8000-000000000007',repeat('a',64),repeat('a',64),
  'job-files','sourcing-parity/part.step','part.step','part','cad','application/step',100);
update public.parts set cad_file_id='89000000-0000-4000-8000-000000000006',quantity=1
where id='89000000-0000-4000-8000-000000000005';
update public.jobs set status='ready_to_quote',requested_service_kinds=array['manufacturing_quote'],primary_service_kind='manufacturing_quote'
where id='89000000-0000-4000-8000-000000000004';
update public.approved_part_requirements set material='6061-T6 Aluminum',finish='As machined',tightest_tolerance_inch=0.0050,
  requested_by_date=null,
  quantity=1,quote_quantities=array[1],applicable_vendors=array['xometry']::public.vendor_name[],
  spec_snapshot=jsonb_build_object('process','CNC milling','requestedByDate',requested_by_date::text,
    'shipping',jsonb_build_object('requestedByDateOverride',requested_by_date::text))
where part_id='89000000-0000-4000-8000-000000000005';
insert into private.organization_entitlement_grants (organization_id,grant_type,starts_at,review_at,grant_reason,granted_by_user_id)
values ('89000000-0000-4000-8000-000000000003','complimentary',now()-interval '1 day',now()+interval '30 days',
  'Sourcing parity fixture','89000000-0000-4000-8000-000000000001');
insert into private.founding_beta_enrollment_events (organization_id,actor_user_id,action,reason,policy_revision,terms_path,privacy_path,idempotency_key)
values ('89000000-0000-4000-8000-000000000003','89000000-0000-4000-8000-000000000001','grant','Sourcing parity fixture',
  'founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy','ovd570-parity-grant');
insert into private.founding_beta_notice_acceptances (organization_id,user_id,policy_revision,terms_path,privacy_path)
values ('89000000-0000-4000-8000-000000000003','89000000-0000-4000-8000-000000000001',
  'founding-beta-2026-08-15','/legal/beta-terms','/legal/privacy');
insert into public.org_vendor_configs (organization_id,vendor,enabled_for_client_quote_requests)
values ('89000000-0000-4000-8000-000000000003','xometry',true);
update private.commercial_rollout_controls set enabled=true,revision=revision+1,change_reason='Sourcing parity fixture'
where capability='automatic_quote_collection';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"89000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select public.api_confirm_sourcing_destination('89000000-0000-4000-8000-000000000003',
  public.api_get_sourcing_destination('89000000-0000-4000-8000-000000000003')->'address');
select public.api_request_xometry_beta_dispatch('89000000-0000-4000-8000-000000000004','inch',
  public.api_get_xometry_beta_dispatch_scope('89000000-0000-4000-8000-000000000004','inch')->>'scopeFingerprint',
  'founding-beta-2026-08-15','89000000-0000-4000-8000-000000000008',true,true,true);
reset role;
update public.work_queue set status='running',locked_at=now(),locked_by='ovd570-parity'
where job_id='89000000-0000-4000-8000-000000000004' and task_type='run_vendor_quote';
update public.vendor_quote_results set status='running' where part_id='89000000-0000-4000-8000-000000000005';
commit;
