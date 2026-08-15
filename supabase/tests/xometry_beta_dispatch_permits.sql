begin;

select plan(46);

create function pg_temp.set_ovd367_identity(p_user_id uuid)
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

create temporary table ovd367_context (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  approval_reference uuid not null,
  scope_fingerprint text,
  rollback_scope_fingerprint text,
  quote_run_id uuid
) on commit drop;

insert into ovd367_context values (
  '00000000-0000-4000-8000-000000003671',
  '00000000-0000-4000-8000-000000003672',
  '00000000-0000-4000-8000-000000003673',
  '00000000-0000-4000-8000-000000003674',
  '00000000-0000-4000-8000-000000003675',
  null,
  null,
  null
);

grant select, update on ovd367_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (
  (select user_id from ovd367_context),
  'authenticated',
  'authenticated',
  'ovd367-member@example.test',
  timezone('utc', now())
);

insert into public.organizations (id, name, slug)
values (
  (select organization_id from ovd367_context),
  'OVD 367 Dispatch',
  'ovd-367-dispatch'
);

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client'
from ovd367_context;

insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason,
  granted_by_user_id
)
select organization_id, 'complimentary', now() - (interval '1 day'),
  now() + (interval '30 days'), 'Controlled beta fixture', user_id
from ovd367_context;

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'OVD-367 local pgTAP fixture'
where capability = 'automatic_quote_collection';

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select job_id, organization_id, user_id, 'OVD-367 validation part',
  'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote' -- NOSONAR: deterministic quote-envelope fixture
from ovd367_context;

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
)
select '00000000-0000-4000-8000-000000003681', organization_id, user_id, -- NOSONAR: deterministic fixture identifier
  'OVD-367 rollback part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote'
from ovd367_context;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select
  '00000000-0000-4000-8000-000000003676', organization_id,
  repeat('a', 64), repeat('a', 64), 'job-files', -- NOSONAR: deterministic trusted-file hash and bucket fixture
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step', -- NOSONAR: deterministic trusted storage path
  100, 'application/step' -- NOSONAR: canonical STEP MIME fixture
from ovd367_context;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select
  '00000000-0000-4000-8000-000000003677', job_id, organization_id, -- NOSONAR: deterministic fixture identifier
  user_id, '00000000-0000-4000-8000-000000003676', repeat('a', 64),
  repeat('a', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('a', 64) || '/part.step',
  'part.step', 'part', 'cad', 'application/step', 100
from ovd367_context;

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
)
select part_id, job_id, organization_id, 'Validation part', 'validation-part',
  '00000000-0000-4000-8000-000000003677', 1
from ovd367_context;

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select part_id, organization_id, user_id, '6061-T6 Aluminum', 'As machined', -- NOSONAR: canonical controlled-beta material and finish fixture
  0.005, 1, array[1], array['xometry']::public.vendor_name[], -- NOSONAR: canonical tolerance, quantity, and provider fixture
  '{"process":"CNC milling"}'::jsonb -- NOSONAR: canonical controlled-beta process fixture
from ovd367_context;

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));

select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)
  ),
  'P0001', -- NOSONAR: repeated asserted PostgreSQL exception code
  'Founding Beta access and current notice acceptance are required.', -- NOSONAR: stable enrollment denial assertion
  'membership and entitlement do not replace Founding Beta enrollment'
);

reset role;
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
)
select organization_id, user_id, 'grant', 'OVD-367 local fixture',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', -- NOSONAR: canonical notice contract fixture
  'ovd367-grant'
from ovd367_context;

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)
  ),
  'P0001',
  'Founding Beta access and current notice acceptance are required.',
  'current notice acceptance is independently required'
);

reset role;
insert into private.founding_beta_notice_acceptances (
  organization_id, user_id, policy_revision, terms_path, privacy_path
)
select organization_id, user_id, 'founding-beta-2026-08-15',
  '/legal/beta-terms', '/legal/privacy'
from ovd367_context;

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)
  ),
  'P0001',
  'xometry_beta_explicit_vendor_config_required',
  'legacy vendor fallback is rejected'
);

reset role;
insert into public.org_vendor_configs (
  organization_id, vendor, enabled_for_client_quote_requests
)
select organization_id, 'xometry'::public.vendor_name, true from ovd367_context
union all
select organization_id, 'fictiv'::public.vendor_name, true from ovd367_context; -- NOSONAR: explicit multi-provider denial fixture

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)
  ),
  'P0001',
  'xometry_beta_exact_provider_set_required',
  'multiple enabled providers are rejected'
);

reset role;
update public.org_vendor_configs
set enabled_for_client_quote_requests = false
where organization_id = (select organization_id from ovd367_context)
  and vendor = 'fictiv';

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'meter')$$,
    (select job_id from ovd367_context)
  ),
  'P0001',
  'Declared model units must be inch or millimeter.',
  'unsupported or unitless model declarations fail closed'
);

reset role;
update public.job_files
set trusted_content_sha256 = null
where id = '00000000-0000-4000-8000-000000003677';
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_trusted_step_required', -- NOSONAR: asserted exception and stable denial code
  'a CAD pointer without a trusted content hash fails closed'
);

reset role;
update public.job_files
set trusted_content_sha256 = repeat('a', 64), file_kind = 'drawing'
where id = '00000000-0000-4000-8000-000000003677';
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_trusted_step_required',
  'a non-CAD file cannot satisfy the CAD pointer'
);

reset role;
update public.job_files
set file_kind = 'cad', job_id = '00000000-0000-4000-8000-000000003681'
where id = '00000000-0000-4000-8000-000000003677';
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_trusted_step_required',
  'a CAD file owned by another job cannot satisfy the package'
);

reset role;
update public.job_files
set job_id = (select job_id from ovd367_context)
where id = '00000000-0000-4000-8000-000000003677';
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select '00000000-0000-4000-8000-000000003682', organization_id,
  repeat('b', 64), repeat('b', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('b', 64) || '/drawing.pdf',
  100, 'application/pdf'
from ovd367_context;
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select '00000000-0000-4000-8000-000000003683', job_id, organization_id,
  user_id, '00000000-0000-4000-8000-000000003682', repeat('b', 64),
  repeat('b', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('b', 64) || '/drawing.pdf',
  'drawing.pdf', 'drawing', 'cad', 'application/pdf', 100
from ovd367_context;
update public.parts
set drawing_file_id = '00000000-0000-4000-8000-000000003683'
where id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_compatible_drawing_required',
  'a drawing pointer must reference a trusted PDF drawing'
);

reset role;
update public.parts set drawing_file_id = null
where id = (select part_id from ovd367_context);
update public.jobs
set requested_service_kinds = array['manufacturing_quote', 'dfm_review']
where id = (select job_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_manufacturing_quote_only',
  'additional requested services are outside the 1.0 envelope'
);

reset role;
update public.jobs set requested_service_kinds = array['manufacturing_quote']
where id = (select job_id from ovd367_context);
update public.approved_part_requirements set quote_quantities = array[2]
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_quantity_one_required',
  'a quantity other than one is outside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements
set quote_quantities = array[1], applicable_vendors = array['fictiv']::public.vendor_name[]
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_xometry_applicability_required',
  'the approved requirements must explicitly allow Xometry'
);

reset role;
update public.approved_part_requirements
set applicable_vendors = array['xometry']::public.vendor_name[],
    spec_snapshot = '{"process":"laser cutting"}'::jsonb
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_cnc_milling_required',
  'only normalized CNC milling is inside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements
set spec_snapshot = '{"process":"CNC milling"}'::jsonb, material = '7075 Aluminum'
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_6061_t6_required',
  'only 6061-T6 aluminum is inside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements set material = '6061-T6 Aluminum', finish = 'Anodized'
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_as_machined_required',
  'non-as-machined finishes are outside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements
set finish = 'As machined', tightest_tolerance_inch = 0.001
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_standard_tolerance_required',
  'tolerances tighter than 0.005 inch are outside the envelope'
);

reset role;
update public.approved_part_requirements
set tightest_tolerance_inch = 0.005, requested_by_date = current_date + 10
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_special_delivery_date_not_supported',
  'a requested delivery date is outside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements
set requested_by_date = null,
    spec_snapshot = '{"process":"CNC milling","notes":"deburr carefully"}'::jsonb
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_special_requirements_not_supported',
  'special manufacturing requirements are outside the 1.0 envelope'
);

reset role;
update public.approved_part_requirements
set spec_snapshot = '{"process":"CNC milling"}'::jsonb
where part_id = (select part_id from ovd367_context);

savepoint ovd367_missing_requirements;
delete from public.approved_part_requirements
where part_id = (select part_id from ovd367_context);
set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001', 'xometry_beta_approved_requirements_required',
  'dispatch scope requires reviewed part requirements'
);
reset role;
rollback to savepoint ovd367_missing_requirements;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-000000003690', 'authenticated',
  'authenticated', 'ovd367-outsider@example.test', timezone('utc', now()));
set local role authenticated;
select pg_temp.set_ovd367_identity('00000000-0000-4000-8000-000000003690');
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)),
  'P0001',
  format('You do not have permission to request quotes for job %s.',
    (select job_id from ovd367_context)),
  'a verified user cannot preview another organization''s dispatch scope'
);

select pg_temp.set_ovd367_identity((select user_id from ovd367_context));

update ovd367_context
set scope_fingerprint = public.api_get_xometry_beta_dispatch_scope(
  job_id,
  'inch'
) ->> 'scopeFingerprint';

select matches(
  (select scope_fingerprint from ovd367_context),
  '^[a-f0-9]{64}$',
  'scope preview returns the server-computed lane fingerprint'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid,
      false, true, true
    )$$,
    (select job_id from ovd367_context),
    (select scope_fingerprint from ovd367_context),
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'All Xometry beta dispatch affirmations are required.', -- NOSONAR: stable affirmation denial assertion
  'each dispatch affirmation is required explicitly'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid,
      true, false, true
    )$$,
    (select job_id from ovd367_context),
    (select scope_fingerprint from ovd367_context),
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'All Xometry beta dispatch affirmations are required.',
  'the non-export-controlled affirmation is independently required'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid,
      true, true, false
    )$$,
    (select job_id from ovd367_context),
    (select scope_fingerprint from ovd367_context),
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'All Xometry beta dispatch affirmations are required.',
  'the quote-only affirmation is independently required'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid,
      true, true, true
    )$$,
    (select job_id from ovd367_context),
    repeat('f', 64),
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'xometry_beta_scope_changed',
  'a stale or substituted scope fingerprint fails closed'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'stale-notice', %L::uuid,
      true, true, true
    )$$,
    (select job_id from ovd367_context),
    (select scope_fingerprint from ovd367_context),
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'xometry_beta_notice_changed',
  'a stale notice revision fails closed'
);

select ok(
  (public.api_request_xometry_beta_dispatch(
    (select job_id from ovd367_context),
    'inch',
    (select scope_fingerprint from ovd367_context),
    'founding-beta-2026-08-15',
    (select approval_reference from ovd367_context),
    true, true, true
  ) ->> 'created')::boolean,
  'a valid exact-scope confirmation creates the atomic dispatch'
);

reset role;
update ovd367_context
set quote_run_id = (select quote_run_id from private.xometry_beta_dispatch_permits)
where job_id = (select job_id from ovd367_context);
select is((select count(*) from private.xometry_beta_dispatch_permits), 1::bigint,
  'exactly one immutable permit is recorded');
select is((select count(*) from public.quote_request_lanes), 1::bigint,
  'exactly one Xometry lane is reserved');
select is((select count(*) from public.work_queue where task_type = 'run_vendor_quote'), 1::bigint, -- NOSONAR: canonical queue task assertion
  'exactly one provider task is queued');
select is(
  (select payload ->> 'xometryBetaDispatchPermitId' from public.work_queue
   where task_type = 'run_vendor_quote'),
  (select id::text from private.xometry_beta_dispatch_permits),
  'the queued task is bound to the immutable permit identifier'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name = 'xometry_beta_dispatch_permits'
      and column_name in ('payload', 'scope_snapshot', 'file_bytes', 'credentials', 'browser_state')
  ),
  'permit evidence has no raw payload, file bytes, credentials, or browser state columns'
);

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select ok(
  (public.api_request_xometry_beta_dispatch(
    (select job_id from ovd367_context),
    'inch',
    (select scope_fingerprint from ovd367_context),
    'founding-beta-2026-08-15',
    (select approval_reference from ovd367_context),
    true, true, true
  ) ->> 'deduplicated')::boolean,
  'an exact approval replay returns the original dispatch without new rows'
);

select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'millimeter', %L, 'founding-beta-2026-08-15', %L::uuid,
      true, true, true
    )$$,
    (select job_id from ovd367_context),
    (select scope_fingerprint from ovd367_context),
    (select approval_reference from ovd367_context)
  ),
  'P0001', 'xometry_beta_approval_reference_reused',
  'an approval reference cannot be reused with different confirmed inputs'
);

select is(
  public.api_enqueue_debug_vendor_quote(
    (select quote_run_id from ovd367_context),
    (select part_id from ovd367_context),
    'xometry', 1
  ) ->> 'reasonCode', -- NOSONAR: stable fail-closed response key
  'dispatch_confirmation_required', -- NOSONAR: stable fail-closed denial code
  'the historical debug enqueue endpoint is a no-write confirmation gate'
);

reset role;
select is(
  (select count(*) from public.work_queue where task_type = 'run_vendor_quote'),
  1::bigint,
  'the debug endpoint cannot create a second provider task'
);

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_like(
  format(
    $$insert into private.xometry_beta_dispatch_permits (
      organization_id, job_id, part_id, quote_request_id, quote_run_id,
      vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
      actor_user_id, notice_revision, approval_reference, provider,
      scope_version, scope_fingerprint, declared_model_units,
      authority_to_share, non_export_controlled, quote_only
    ) select organization_id, job_id, part_id, quote_request_id, quote_run_id,
      vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
      actor_user_id, notice_revision, %L::uuid, provider, scope_version,
      scope_fingerprint, declared_model_units, true, true, true
    from private.xometry_beta_dispatch_permits limit 1$$,
    '00000000-0000-4000-8000-000000003699'
  ),
  '%permission denied%',
  'authenticated callers cannot insert permit evidence directly'
);

reset role;
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select '00000000-0000-4000-8000-000000003684', organization_id,
  repeat('c', 64), repeat('c', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('c', 64) || '/rollback.step',
  100, 'application/step'
from ovd367_context;
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select '00000000-0000-4000-8000-000000003685',
  '00000000-0000-4000-8000-000000003681', organization_id, user_id,
  '00000000-0000-4000-8000-000000003684', repeat('c', 64), repeat('c', 64),
  'job-files',
  organization_id::text || '/sha256/' || repeat('c', 64) || '/rollback.step',
  'rollback.step', 'rollback', 'cad', 'application/step', 100
from ovd367_context;
insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
)
select '00000000-0000-4000-8000-000000003686',
  '00000000-0000-4000-8000-000000003681', organization_id,
  'Rollback validation part', 'rollback-validation-part',
  '00000000-0000-4000-8000-000000003685', 1
from ovd367_context;
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select '00000000-0000-4000-8000-000000003686', organization_id, user_id,
  '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
  array['xometry']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb
from ovd367_context;

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
update ovd367_context
set rollback_scope_fingerprint = public.api_get_xometry_beta_dispatch_scope(
  '00000000-0000-4000-8000-000000003681', 'inch'
) ->> 'scopeFingerprint';

reset role;
create temporary table ovd367_rollback_counts as
select
  (select count(*) from public.quote_requests) as requests,
  (select count(*) from public.quote_runs) as runs,
  (select count(*) from public.vendor_quote_results) as results,
  (select count(*) from public.quote_request_lanes) as lanes,
  (select count(*) from public.work_queue) as tasks,
  (select count(*) from private.xometry_beta_dispatch_permits) as permits;

create function pg_temp.reject_ovd367_permit()
returns trigger language plpgsql as $$
begin
  raise exception 'forced_xometry_permit_failure';
end;
$$;
create trigger reject_ovd367_permit
before insert on private.xometry_beta_dispatch_permits
for each row execute function pg_temp.reject_ovd367_permit();

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_request_xometry_beta_dispatch(
      %L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid,
      true, true, true
    )$$,
    '00000000-0000-4000-8000-000000003681',
    (select rollback_scope_fingerprint from ovd367_context),
    '00000000-0000-4000-8000-000000003687'
  ),
  'P0001', 'forced_xometry_permit_failure',
  'a permit evidence failure aborts the dispatch transaction'
);

reset role;
drop trigger reject_ovd367_permit on private.xometry_beta_dispatch_permits;
select ok(
  (select row(
    (select count(*) from public.quote_requests),
    (select count(*) from public.quote_runs),
    (select count(*) from public.vendor_quote_results),
    (select count(*) from public.quote_request_lanes),
    (select count(*) from public.work_queue),
    (select count(*) from private.xometry_beta_dispatch_permits)
  ) = row(requests, runs, results, lanes, tasks, permits)
  from ovd367_rollback_counts),
  'failed permit insertion rolls back every lifecycle and queue write'
);

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));

select is(
  public.api_request_quote_scoped(
    (select job_id from ovd367_context),
    array['xometry']::public.vendor_name[]
  ) ->> 'reasonCode',
  'dispatch_confirmation_required',
  'the legacy scoped request endpoint is a no-write confirmation gate'
);
select is(
  public.api_request_quote(
    (select job_id from ovd367_context),
    false
  ) ->> 'reasonCode',
  'dispatch_confirmation_required',
  'the legacy single request endpoint is a no-write confirmation gate'
);
select is(
  public.api_request_quotes(
    array[(select job_id from ovd367_context)],
    false
  ) -> 0 ->> 'reasonCode',
  'dispatch_confirmation_required',
  'the legacy batch request endpoint is a no-write confirmation gate'
);
select throws_ok(
  $$select public.api_request_quotes(
    array_fill('00000000-0000-4000-8000-000000003673'::uuid, array[101]),
    false
  )$$,
  'P0001',
  'At most 100 quote requests may be submitted at once.',
  'the legacy batch request endpoint rejects unbounded input'
);

reset role;
select throws_ok(
  format(
    $$update private.xometry_beta_dispatch_permits
      set notice_revision = 'mutated' where approval_reference = %L::uuid$$,
    (select approval_reference from ovd367_context)
  ),
  'P0001',
  'Founding Beta evidence is append-only.',
  'permit evidence cannot be updated'
);

insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
)
select organization_id, user_id, 'revoke', 'OVD-367 revocation fixture',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy',
  'ovd367-revoke'
from ovd367_context;

set local role authenticated;
select pg_temp.set_ovd367_identity((select user_id from ovd367_context));
select throws_ok(
  format(
    $$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$,
    (select job_id from ovd367_context)
  ),
  'P0001',
  'Founding Beta access and current notice acceptance are required.',
  'revocation immediately blocks new scope previews and dispatch attempts'
);

reset role;
select is((select count(*) from private.xometry_beta_dispatch_permits), 1::bigint,
  'denials, replay, and legacy endpoints create no additional permit');

select * from finish();
rollback;
