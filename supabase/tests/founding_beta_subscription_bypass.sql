begin;

-- Founding Beta enrollment is independent from billing. An organization that
-- holds an active Pro subscription, with rollout enabled and a complete
-- Xometry-envelope job, is still denied every draft, file and dispatch entry
-- point until it is enrolled and the acting member accepted the current
-- notice. Cases (a)-(d) stack one commercial signal at a time on top of the
-- subscription; the positive control proves enrollment is the only missing
-- piece. Synthetic fixture only; the whole suite is rolled back.

select plan(44);

create function pg_temp.set_fb_sub_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated', -- NOSONAR: repeated authenticated JWT fixture claim
      'aal', 'aal1'
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

-- Exact fixture-only permission, rolled back with this suite.
grant execute on function pg_temp.set_fb_sub_identity(uuid) to authenticated;

create temporary table fb_sub_context (
  user_id uuid not null,
  organization_id uuid not null,
  quote_job_id uuid not null,
  upload_job_id uuid not null,
  part_id uuid not null,
  blob_id uuid not null,
  cad_file_id uuid not null,
  approval_reference uuid not null,
  cad_hash text not null,
  cad_name text not null,
  finalize_hash text not null,
  finalize_name text not null,
  file_bucket text not null,
  model_units text not null,
  stripe_price_id text not null,
  free_policy_revision text not null,
  notice_revision text,
  finalize_path text,
  scope_fingerprint text
) on commit drop;

insert into fb_sub_context (
  user_id, organization_id, quote_job_id, upload_job_id, part_id, blob_id,
  cad_file_id, approval_reference, cad_hash, cad_name, finalize_hash,
  finalize_name, file_bucket, model_units, stripe_price_id,
  free_policy_revision
)
values (
  '00000000-0000-4000-8000-0000fb5c0001',
  '00000000-0000-4000-8000-0000fb5c0002',
  '00000000-0000-4000-8000-0000fb5c0003',
  '00000000-0000-4000-8000-0000fb5c0004',
  '00000000-0000-4000-8000-0000fb5c0005',
  '00000000-0000-4000-8000-0000fb5c0006',
  '00000000-0000-4000-8000-0000fb5c0007',
  '00000000-0000-4000-8000-0000fb5c0008',
  repeat('a', 64),
  'part.step',
  repeat('c', 64),
  'finalize.step',
  'job-files',
  'inch',
  'price_FoundingBetaSubscriptionPro',
  'founding-beta-subscription-bypass-allowance'
);

grant select on fb_sub_context to authenticated;

update fb_sub_context
set notice_revision = private.current_founding_beta_notice() ->> 'policyRevision', -- NOSONAR: canonical notice contract key
    finalize_path = public.build_org_file_blob_storage_path(
      organization_id,
      finalize_hash,
      finalize_name
    );

insert into auth.users (id, aud, role, email, email_confirmed_at)
select user_id, 'authenticated', 'authenticated',
  'founding-beta-subscription@example.test', timezone('utc', now())
from fb_sub_context;

insert into public.organizations (id, name, slug)
select organization_id, 'Founding Beta Subscription Bypass',
  'founding-beta-subscription-bypass'
from fb_sub_context;

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client'
from fb_sub_context;

-- This dispatch fixture starts after an administrator confirmed its destination.
update public.organizations set shipping_same_as_billing=false, shipping_street='123 Fixture Ave',
  shipping_city='Tucson', shipping_state='AZ', shipping_zip='85701', shipping_country='US'
where id=(select organization_id from fb_sub_context);
insert into private.sourcing_destination_history (organization_id, state, address)
select organization_id, 'confirmed', private.effective_sourcing_address(organization_id) from fb_sub_context;

-- Active Pro subscription with the configured price, following
-- organization_entitlements.sql; the period ends after now().
insert into private.organization_billing_accounts (
  organization_id, stripe_customer_id, stripe_livemode
)
select organization_id, 'cus_FoundingBetaSubscription', false
from fb_sub_context;

do $$
begin
  perform public.api_configure_stripe_pro_price(
    (select stripe_price_id from fb_sub_context),
    false
  );
end;
$$;

insert into private.organization_subscription_projections (
  organization_id, stripe_subscription_id, status, billing_interval,
  current_period_end, stripe_event_created_at, stripe_event_id,
  stripe_livemode, stripe_price_id
)
select organization_id, 'sub_FoundingBetaSubscription', 'active', 'month',
  now() + interval '30 days', now() - interval '1 day',
  'evt_FoundingBetaSubscription', false, stripe_price_id
from fb_sub_context;

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'Founding Beta subscription bypass pgTAP fixture'
where capability = 'automatic_quote_collection'; -- NOSONAR: canonical rollout capability fixture

insert into public.org_vendor_configs (
  organization_id, vendor, enabled_for_client_quote_requests
)
select organization_id, 'xometry'::public.vendor_name, true -- NOSONAR: canonical controlled-beta provider fixture
from fb_sub_context;

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select quote_job_id, organization_id, user_id,
  'Founding Beta subscription quote part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote'
from fb_sub_context;

insert into public.jobs (id, organization_id, created_by, title)
select upload_job_id, organization_id, user_id,
  'Founding Beta subscription upload'
from fb_sub_context;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select blob_id, organization_id, cad_hash, cad_hash, file_bucket,
  public.build_org_file_blob_storage_path(organization_id, cad_hash, cad_name),
  100, 'application/step' -- NOSONAR: canonical STEP MIME fixture
from fb_sub_context;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select cad_file_id, quote_job_id, organization_id, user_id, blob_id,
  cad_hash, cad_hash, file_bucket,
  public.build_org_file_blob_storage_path(organization_id, cad_hash, cad_name),
  cad_name, 'part', 'cad', 'application/step', 100
from fb_sub_context;

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
)
select part_id, quote_job_id, organization_id, 'Subscription bypass part',
  'subscription-bypass-part', cad_file_id, 1
from fb_sub_context;

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select part_id, organization_id, user_id, '6061-T6 Aluminum', 'As machined',
  0.0050, 1, array[1], array['xometry']::public.vendor_name[],
  '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb
from fb_sub_context;

-- A stored object at the canonical path, so finalize would attach a file if
-- the enrollment boundary were bypassed. The prepare call reuses the CAD blob
-- hash on the upload job, so it too would attach a file on a bypass.
insert into storage.buckets (id, name, public)
select file_bucket, file_bucket, false from fb_sub_context
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner)
select gen_random_uuid(), file_bucket, finalize_path, user_id
from fb_sub_context;

update fb_sub_context
set scope_fingerprint = (
  select candidate.scope_fingerprint
  from private.quote_lane_candidates(
    fb_sub_context.quote_job_id,
    array['xometry']::public.vendor_name[]
  ) candidate
);

-- Every call uses inputs that would otherwise succeed: the positive control
-- admits the same scope, dispatch and draft calls once enrolled, and the
-- fixture blob and stored object above let prepare and finalize attach a file.
-- Each denial is therefore attributable to enrollment alone.
create function pg_temp.fb_sub_assert_enrollment_denials(p_case text)
returns setof text
language plpgsql
as $$
declare
  v_errcode constant char(5) := 'P0001';
  v_enrollment_denial constant text :=
    'Founding Beta access and current notice acceptance are required.';
  v_file_denial constant text := 'founding_beta_not_enrolled';
  v_file_kind constant text := 'cad';
  v_context fb_sub_context%rowtype;
begin
  select * into strict v_context from fb_sub_context;

  return next throws_ok(
    format(
      'select public.api_get_xometry_beta_dispatch_scope(%L::uuid, %L)',
      v_context.quote_job_id, v_context.model_units
    ),
    v_errcode, v_enrollment_denial,
    p_case || ': api_get_xometry_beta_dispatch_scope raises the enrollment denial'
  );

  return next throws_ok(
    format(
      'select public.api_request_xometry_beta_dispatch(%L::uuid, %L, %L, %L, %L::uuid, true, true, true)',
      v_context.quote_job_id, v_context.model_units,
      v_context.scope_fingerprint, v_context.notice_revision,
      v_context.approval_reference
    ),
    v_errcode, v_enrollment_denial,
    p_case || ': api_request_xometry_beta_dispatch raises the enrollment denial'
  );

  return next throws_ok(
    format(
      'select public.api_create_client_draft(%L)',
      p_case || ' draft'
    ),
    v_errcode, v_enrollment_denial,
    p_case || ': api_create_client_draft raises the enrollment denial'
  );

  return next throws_ok(
    format(
      'select public.api_create_job(%L::uuid, %L)',
      v_context.organization_id, p_case || ' job'
    ),
    v_errcode, v_enrollment_denial,
    p_case || ': api_create_job raises the enrollment denial'
  );

  return next throws_ok(
    format(
      'select public.api_prepare_job_file_upload(%L::uuid, %L, %L, null, 100, %L)',
      v_context.upload_job_id, v_context.cad_name, v_file_kind,
      v_context.cad_hash
    ),
    v_errcode, v_file_denial,
    p_case || ': api_prepare_job_file_upload raises the not-enrolled file denial'
  );

  return next throws_ok(
    format(
      'select public.api_finalize_job_file_upload(%L::uuid, %L, %L, %L, %L, null, 100, %L)',
      v_context.upload_job_id, v_context.file_bucket, v_context.finalize_path,
      v_context.finalize_name, v_file_kind, v_context.finalize_hash
    ),
    v_errcode, v_file_denial,
    p_case || ': api_finalize_job_file_upload raises the not-enrolled file denial'
  );
end;
$$;

grant execute on function pg_temp.fb_sub_assert_enrollment_denials(text)
  to authenticated;

-- Fixture sanity: the organization really is a rollout-enabled Pro subscriber
-- with a dispatchable job and no Founding Beta enrollment.
select is(
  private.resolve_organization_entitlements_at(organization_id, now()) ->> 'source', -- NOSONAR: stable entitlement resolver key
  'subscription_active',
  'fixture: the active Pro subscription projection is the entitlement source'
)
from fb_sub_context;

select ok(
  (
    select control.enabled
    from private.commercial_rollout_controls control
    where control.capability = 'automatic_quote_collection'
  ),
  'fixture: the automatic quote collection rollout is enabled'
);

select matches(
  (select scope_fingerprint from fb_sub_context),
  '^[a-f0-9]{64}$',
  'fixture: the job has a single Xometry lane candidate'
);

select is(
  private.resolve_founding_beta_access_state(organization_id, user_id) ->> 'state', -- NOSONAR: stable beta access state key
  'not_enrolled', -- NOSONAR: stable beta access state
  'fixture: the organization has no Founding Beta enrollment'
)
from fb_sub_context;

-- (a) Subscription only.
set local role authenticated;
select pg_temp.set_fb_sub_identity((select user_id from fb_sub_context));
select * from pg_temp.fb_sub_assert_enrollment_denials(
  '(a) subscription only'
);
reset role;

-- (b) Subscription plus the configured free-quote allowance.
insert into private.free_quote_policies (
  revision, enabled, subject_kind, completed_limit, window_start, window_end
)
select free_policy_revision, true, 'organization', 1,
  clock_timestamp() - interval '1 hour', clock_timestamp() + interval '2 hours'
from fb_sub_context;

select is(
  private.resolve_free_quote_policy(quote_job_id, user_id) ->> 'configured',
  'true',
  '(b) fixture: the free-quote allowance is configured for this organization'
)
from fb_sub_context;

set local role authenticated;
select pg_temp.set_fb_sub_identity((select user_id from fb_sub_context));
select * from pg_temp.fb_sub_assert_enrollment_denials(
  '(b) subscription plus free allowance'
);
reset role;

update private.free_quote_policies
set enabled = false
where revision = (select free_policy_revision from fb_sub_context);

-- (c) Subscription plus a complimentary grant.
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason,
  granted_by_user_id
)
select organization_id, 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'Founding Beta subscription bypass fixture',
  user_id
from fb_sub_context;

select is(
  private.resolve_organization_entitlements_at(organization_id, now()) ->> 'source',
  'manual_complimentary',
  '(c) fixture: the complimentary grant is the active entitlement source'
)
from fb_sub_context;

set local role authenticated;
select pg_temp.set_fb_sub_identity((select user_id from fb_sub_context));
select * from pg_temp.fb_sub_assert_enrollment_denials(
  '(c) subscription plus complimentary grant'
);
reset role;

update private.organization_entitlement_grants
set revoked_at = now(),
    revoked_by_user_id = (select user_id from fb_sub_context),
    revocation_reason = 'Isolate the next subscription case'
where organization_id = (select organization_id from fb_sub_context);

-- (d) Subscription plus a current notice acceptance, but no enrollment grant.
insert into private.founding_beta_notice_acceptances (
  organization_id, user_id, policy_revision, terms_path, privacy_path
)
select context.organization_id, context.user_id,
  notice ->> 'policyRevision', notice ->> 'termsPath', -- NOSONAR: canonical notice contract keys
  notice ->> 'privacyPath' -- NOSONAR: canonical notice contract key
from fb_sub_context context,
  private.current_founding_beta_notice() notice;

select is(
  private.resolve_founding_beta_access_state(organization_id, user_id) ->> 'state',
  'not_enrolled',
  '(d) fixture: a current notice acceptance does not enroll the organization'
)
from fb_sub_context;

set local role authenticated;
select pg_temp.set_fb_sub_identity((select user_id from fb_sub_context));
select * from pg_temp.fb_sub_assert_enrollment_denials(
  '(d) subscription plus accepted notice without enrollment'
);
reset role;

-- No denied call left a row behind beyond the fixture.
select is(
  (
    select count(*)::integer
    from private.xometry_beta_dispatch_permits permit
    where permit.organization_id = (select organization_id from fb_sub_context)
  ),
  0,
  'no Xometry beta dispatch permit was created'
);

select is(
  (
    select count(*)::integer
    from public.quote_requests request
    where request.organization_id = (select organization_id from fb_sub_context)
  ),
  0,
  'no quote request was created'
);

select is(
  (
    select count(*)::integer
    from public.work_queue task
    where task.organization_id = (select organization_id from fb_sub_context)
  ),
  0,
  'no work queue task was created'
);

select is(
  (
    select count(*)::integer
    from private.quote_access_admissions admission
    where admission.organization_id = (select organization_id from fb_sub_context)
  ),
  0,
  'no quote access admission was recorded'
);

select is(
  (
    select count(*)::integer
    from private.free_quote_buckets bucket
    join private.free_quote_policies policy on policy.id = bucket.policy_id
    where policy.revision = (select free_policy_revision from fb_sub_context)
  ),
  0,
  'no free-quote capacity bucket was persisted'
);

select is(
  (
    select count(*)::integer
    from public.jobs job
    where job.organization_id = (select organization_id from fb_sub_context)
  ),
  2,
  'only the two fixture jobs exist'
);

select is(
  (
    select count(*)::integer
    from public.job_files file
    where file.organization_id = (select organization_id from fb_sub_context)
  ),
  1,
  'only the fixture CAD file exists'
);

select is(
  (
    select count(*)::integer
    from public.organization_file_blobs blob
    where blob.organization_id = (select organization_id from fb_sub_context)
  ),
  1,
  'only the fixture file blob exists'
);

-- Positive control: an enrollment grant, together with the notice accepted in
-- case (d), admits the same subscriber with the same inputs.
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
)
select context.organization_id, context.user_id, 'grant',
  'Founding Beta subscription bypass positive control',
  notice ->> 'policyRevision', notice ->> 'termsPath', notice ->> 'privacyPath',
  'founding-beta-subscription-bypass-grant'
from fb_sub_context context,
  private.current_founding_beta_notice() notice;

select is(
  private.resolve_organization_entitlements_at(organization_id, now()) ->> 'source',
  'subscription_active',
  'positive control: the subscription is again the entitlement source'
)
from fb_sub_context;

set local role authenticated;
select pg_temp.set_fb_sub_identity((select user_id from fb_sub_context));

select is(
  public.api_get_xometry_beta_dispatch_scope(quote_job_id, model_units)
    ->> 'scopeFingerprint',
  scope_fingerprint,
  'positive control: the enrolled subscriber receives the dispatch scope'
)
from fb_sub_context;

select is(
  public.api_request_xometry_beta_dispatch(
    quote_job_id, model_units, scope_fingerprint, notice_revision,
    approval_reference, true, true, true
  ) ->> 'accepted',
  'true',
  'positive control: the same dispatch request is admitted once enrolled'
)
from fb_sub_context;

select ok(
  public.api_create_client_draft('Founding Beta subscription enrolled draft')
    is not null,
  'positive control: the client draft RPC creates a draft once enrolled'
);

reset role;

select is(
  (
    select admission.admission_source
    from private.quote_access_admissions admission
    where admission.organization_id = (select organization_id from fb_sub_context)
  ),
  'commercial_entitlement',
  'positive control: the admission is recorded against the subscription entitlement'
);

select * from finish();
rollback;
