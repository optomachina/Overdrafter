begin;

select plan(54);

create temporary table ovd262_context (
  billing_admin_user_id uuid not null,
  order_admin_user_id uuid not null,
  requester_user_id uuid not null,
  organization_id uuid not null,
  project_id uuid not null,
  first_job_id uuid not null,
  second_job_id uuid not null,
  third_job_id uuid not null,
  first_part_id uuid not null,
  second_part_id uuid not null,
  third_part_id uuid not null,
  first_request_id uuid not null,
  second_request_id uuid not null,
  third_request_id uuid not null,
  first_run_id uuid not null,
  second_run_id uuid not null,
  third_run_id uuid not null
) on commit drop;

insert into ovd262_context values (
  '00000000-0000-4000-8000-000000002621',
  '00000000-0000-4000-8000-000000002622',
  '00000000-0000-4000-8000-000000002623',
  '00000000-0000-4000-8000-000000002624',
  '00000000-0000-4000-8000-000000002625',
  '00000000-0000-4000-8000-000000002626',
  '00000000-0000-4000-8000-000000002627',
  '00000000-0000-4000-8000-000000002628',
  '00000000-0000-4000-8000-000000002629',
  '00000000-0000-4000-8000-000000002631',
  '00000000-0000-4000-8000-000000002632',
  '00000000-0000-4000-8000-000000002633',
  '00000000-0000-4000-8000-000000002641',
  '00000000-0000-4000-8000-000000002642',
  '00000000-0000-4000-8000-000000002643',
  '00000000-0000-4000-8000-000000002651',
  '00000000-0000-4000-8000-000000002652'
);

grant select on ovd262_context to authenticated;

create function public.ovd262_test_set_claims(
  p_user_id uuid,
  p_aal text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated',
      'aal', p_aal
    )::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    p_user_id::text,
    true
  );
end;
$$;

revoke all on function public.ovd262_test_set_claims(uuid, text)
  from public, anon;
grant execute on function public.ovd262_test_set_claims(uuid, text)
  to authenticated;

insert into auth.users (id, aud, role, email)
values
  (
    (select billing_admin_user_id from ovd262_context),
    'authenticated',
    'authenticated',
    'ovd262-billing@example.com'
  ),
  (
    (select order_admin_user_id from ovd262_context),
    'authenticated',
    'authenticated',
    'ovd262-order@example.com'
  ),
  (
    (select requester_user_id from ovd262_context),
    'authenticated',
    'authenticated',
    'ovd262-requester@example.com'
  );

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason
)
values
  (
    (select billing_admin_user_id from ovd262_context),
    'billing_admin',
    (select billing_admin_user_id from ovd262_context),
    'OVD-262 manual quote operations test'
  ),
  (
    (select order_admin_user_id from ovd262_context),
    'order_admin',
    (select order_admin_user_id from ovd262_context),
    'OVD-262 capability isolation test'
  );

insert into public.organizations (id, name, slug)
values (
  (select organization_id from ovd262_context),
  'OVD 262 Manufacturing',
  'ovd-262-manufacturing'
);

insert into public.organization_memberships (
  organization_id,
  user_id,
  role
)
values (
  (select organization_id from ovd262_context),
  (select requester_user_id from ovd262_context),
  'client'
);

insert into public.projects (
  id,
  organization_id,
  owner_user_id,
  name
)
values (
  (select project_id from ovd262_context),
  (select organization_id from ovd262_context),
  (select requester_user_id from ovd262_context),
  'Gearbox Launch'
);

insert into public.jobs (
  id,
  organization_id,
  project_id,
  created_by,
  title,
  status,
  created_at
)
values
  (
    (select first_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select project_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'First bracket',
    'awaiting_vendor_manual_review',
    '2026-07-30T10:00:00Z'
  ),
  (
    (select second_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select project_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'Second bracket',
    'awaiting_vendor_manual_review',
    '2026-07-30T11:00:00Z'
  ),
  (
    (select third_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select project_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'Third bracket',
    'awaiting_vendor_manual_review',
    '2026-07-30T12:00:00Z'
  );

insert into public.parts (
  id,
  job_id,
  organization_id,
  name,
  normalized_key,
  quantity
)
values
  (
    (select first_part_id from ovd262_context),
    (select first_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    'First bracket',
    'first-bracket',
    10
  ),
  (
    (select second_part_id from ovd262_context),
    (select second_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    'Second bracket',
    'second-bracket',
    10
  ),
  (
    (select third_part_id from ovd262_context),
    (select third_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    'Third bracket',
    'third-bracket',
    10
  );

insert into public.quote_requests (
  id,
  organization_id,
  job_id,
  requested_by,
  requested_vendors,
  request_mode,
  status,
  created_at,
  updated_at
)
values
  (
    (select first_request_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select first_job_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    '{}'::public.vendor_name[],
    'manual',
    'queued',
    '2026-07-30T10:00:00Z',
    '2026-07-30T10:00:00Z'
  ),
  (
    (select second_request_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select second_job_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    '{}'::public.vendor_name[],
    'manual',
    'queued',
    '2026-07-30T11:00:00Z',
    '2026-07-30T11:00:00Z'
  ),
  (
    (select third_request_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select third_job_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    '{}'::public.vendor_name[],
    'manual',
    'requesting',
    '2026-07-30T12:00:00Z',
    '2026-07-30T12:00:00Z'
  );

insert into public.quote_runs (
  id,
  quote_request_id,
  job_id,
  organization_id,
  initiated_by,
  status,
  requested_auto_publish
)
values
  (
    (select first_run_id from ovd262_context),
    (select first_request_id from ovd262_context),
    (select first_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'queued',
    false
  ),
  (
    (select second_run_id from ovd262_context),
    (select second_request_id from ovd262_context),
    (select second_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'queued',
    false
  ),
  (
    (select third_run_id from ovd262_context),
    (select third_request_id from ovd262_context),
    (select third_job_id from ovd262_context),
    (select organization_id from ovd262_context),
    (select requester_user_id from ovd262_context),
    'completed',
    false
  );

select ok(
  pg_catalog.to_regprocedure(
    'public.api_admin_list_manual_quote_requests(text,integer)'
  ) is not null,
  'manual quote inbox RPC exists'
);

select ok(
  pg_catalog.to_regprocedure(
    'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)'
  ) is not null,
  'exact manual quote completion RPC exists'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_admin_list_manual_quote_requests(text,integer)',
    'EXECUTE'
  ),
  'authenticated callers may invoke the guarded inbox RPC'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.api_admin_complete_manual_quote_request(uuid,uuid,uuid,uuid,public.vendor_name,text,text,public.vendor_status,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke exact completion'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.api_record_manual_vendor_quote(uuid,uuid,public.vendor_name,public.vendor_status,text,text,text,jsonb,jsonb)'::regprocedure
  ) like '%public.is_internal_user(v_job.organization_id)%',
  'legacy same-organization manual intake authorization remains intact'
);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select order_admin_user_id from ovd262_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_list_manual_quote_requests(null, 25)
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot read the billing-admin manual quote inbox'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal1'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_list_manual_quote_requests(null, 2) -> 'items'
  ),
  2,
  'billing admins may read a bounded inbox page at AAL1'
);

select is(
  public.api_admin_list_manual_quote_requests(null, 2)
    #>> '{items,0,requestId}',
  (select first_request_id::text from ovd262_context),
  'the inbox is ordered oldest-first'
);

select ok(
  nullif(
    public.api_admin_list_manual_quote_requests(null, 2)
      ->> 'nextCursor',
    ''
  ) is not null,
  'a full page returns an opaque continuation cursor'
);

select is(
  pg_catalog.jsonb_array_length(
    public.api_admin_list_manual_quote_requests(
      public.api_admin_list_manual_quote_requests(null, 2)
        ->> 'nextCursor',
      2
    ) -> 'items'
  ),
  1,
  'the opaque cursor advances without duplicating the first page'
);

select is(
  public.api_admin_list_manual_quote_requests(
    public.api_admin_list_manual_quote_requests(null, 2)
      ->> 'nextCursor',
    2
  ) #>> '{items,0,requestId}',
  (select third_request_id::text from ovd262_context),
  'the second page returns the remaining exact request'
);

select is(
  public.api_admin_list_manual_quote_requests(null, 2)
    #>> '{items,0,quoteRunId}',
  (select first_run_id::text from ovd262_context),
  'inbox items expose the exact linked quote run'
);

select is(
  public.api_admin_list_manual_quote_requests(
    public.api_admin_list_manual_quote_requests(null, 2)
      ->> 'nextCursor',
    2
  )
    #>> '{items,0,staleReason}',
  'quote_run_not_active',
  'active requests with inconsistent linked lifecycles are explicit stale rows'
);

select is(
  public.api_admin_list_manual_quote_requests(null, 2)
    #>> '{items,0,projectId}',
  (select project_id::text from ovd262_context),
  'inbox items expose the exact project navigation target'
);

select throws_ok(
  $$
    select public.api_admin_list_manual_quote_requests('not-base64', 25)
  $$,
  'P0001',
  'Manual quote request cursor is invalid.',
  'malformed inbox cursors fail closed'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Record the manually sourced quote',
      'complete-first',
      'official_quote_received',
      null,
      null,
      null,
      '[{"offerId":"lane-1","unitPriceUsd":"12.50","totalPriceUsd":"125.00","leadTimeBusinessDays":"7","requestedQuantity":"10"}]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Multi-factor authentication is required for this commercial operation.',
  'AAL1 billing admins cannot complete manual quote requests'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select second_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Reject mismatched lineage',
      'wrong-run',
      'official_quote_received',
      null,
      null,
      null,
      '[{"offerId":"lane-1","totalPriceUsd":"125.00"}]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Quote run does not belong to the supplied manual quote request and job.',
  'completion rejects a run from another request'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/00000000-0000-4000-8000-000000009999/arbitrary.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'billing admins cannot upload evidence beneath an arbitrary job'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select second_run_id::text from ovd262_context)
        || '/'
        || (select first_job_id::text from ovd262_context)
        || '/wrong-lineage.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'billing admins cannot upload evidence with mismatched request and run lineage'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select third_request_id::text from ovd262_context)
        || '/'
        || (select third_run_id::text from ovd262_context)
        || '/'
        || (select third_job_id::text from ovd262_context)
        || '/stale-run.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'billing admins cannot upload evidence for a stale or completed run'
);

select lives_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/'
        || (select first_job_id::text from ovd262_context)
        || '/active-request.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  'AAL2 billing admins can upload evidence for one exact active manual lineage'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal1'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/'
        || (select first_job_id::text from ovd262_context)
        || '/aal1-denied.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'AAL1 billing admins cannot upload exact manual completion evidence'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Reject invalid secondary offer',
      'invalid-secondary-offer',
      'official_quote_received',
      null,
      null,
      null,
      '[
        {"offerId":"valid-lane","totalPriceUsd":"100.00","leadTimeBusinessDays":"5"},
        {"offerId":"missing-total","leadTimeBusinessDays":"7"}
      ]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Every manual quote offer requires a total price from 0 to 9999999999.99.',
  'a non-summary offer with invalid pricing rejects before writes'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Reject duplicate offer keys',
      'duplicate-offer-keys',
      'official_quote_received',
      null,
      null,
      null,
      '[
        {"offerId":"duplicate-lane","totalPriceUsd":"100.00"},
        {"offerId":"duplicate-lane","totalPriceUsd":"120.00"}
      ]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Manual quote offer keys must be unique.',
  'duplicate offer keys reject before writes'
);

reset role;

select is(
  (
    select pg_catalog.count(*)
    from public.vendor_quote_results result_row
    where result_row.quote_run_id =
      (select first_run_id from ovd262_context)
  ),
  0::bigint,
  'invalid multi-offer attempts create no vendor result'
);

select is(
  (
    select request_row.status::text
    from public.quote_requests request_row
    where request_row.id = (select first_request_id from ovd262_context)
  ),
  'queued',
  'invalid multi-offer attempts leave the request lifecycle unchanged'
);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select is(
  (
    public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Record the manually sourced quote',
      'complete-first',
      'official_quote_received',
      'Reviewed supplier PDF',
      'Supplier quote reference 262',
      'https://example.com/quote/262',
      '[{"offerId":"lane-1","supplier":"Xometry","unitPriceUsd":"12.50","totalPriceUsd":"125.00","leadTimeBusinessDays":"7","requestedQuantity":"10"}]'::jsonb,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'artifactType', 'uploaded_evidence',
          'storageBucket', 'quote-artifacts',
          'storagePath',
            'manual-completions/'
            || (select first_request_id::text from ovd262_context)
            || '/'
            || (select first_run_id::text from ovd262_context)
            || '/'
            || (select first_job_id::text from ovd262_context)
            || '/supplier-quote.pdf',
          'metadata',
            pg_catalog.jsonb_build_object(
              'originalName', 'supplier-quote.pdf'
            )
        )
      )
    ) ->> 'replayed'
  )::boolean,
  false,
  'AAL2 billing admins can complete one exact active request'
);

reset role;

select is(
  (
    select request_row.status::text
    from public.quote_requests request_row
    where request_row.id = (select first_request_id from ovd262_context)
  ),
  'received',
  'completion moves the exact request to received'
);

select is(
  (
    select quote_run.status::text
    from public.quote_runs quote_run
    where quote_run.id = (select first_run_id from ovd262_context)
  ),
  'completed',
  'completion moves the exact quote run to completed'
);

select is(
  (
    select job_row.status::text
    from public.jobs job_row
    where job_row.id = (select first_job_id from ovd262_context)
  ),
  'internal_review',
  'completion moves the exact job to internal review'
);

select is(
  (
    select pg_catalog.count(*)
    from public.vendor_quote_results result_row
    where result_row.quote_run_id =
      (select first_run_id from ovd262_context)
      and result_row.part_id =
        (select first_part_id from ovd262_context)
      and result_row.vendor = 'xometry'
      and result_row.requested_quantity = 10
  ),
  1::bigint,
  'completion records one vendor result on the exact run and part'
);

select is(
  (
    select pg_catalog.count(*)
    from public.vendor_quote_artifacts artifact_row
    join public.vendor_quote_results result_row
      on result_row.id = artifact_row.vendor_quote_result_id
    where result_row.quote_run_id =
      (select first_run_id from ovd262_context)
      and artifact_row.storage_path =
        'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/'
        || (select first_job_id::text from ovd262_context)
        || '/supplier-quote.pdf'
  ),
  1::bigint,
  'completion attaches validated evidence to the exact result'
);

select ok(
  (
    select
      event_row.actor_user_id =
        (select billing_admin_user_id from ovd262_context)
      and event_row.required_capability = 'billing_admin'
      and event_row.action = 'commercial.manual_quote.complete'
      and event_row.target_id =
        (select first_request_id::text from ovd262_context)
      and event_row.reason = 'Record the manually sourced quote'
      and event_row.request_metadata ? 'payloadFingerprint'
      and not (event_row.request_metadata ? 'sourceText')
    from public.commercial_admin_audit_events event_row
    where event_row.idempotency_key = 'complete-first'
  ),
  'completion writes a safe append-only commercial audit record'
);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select is(
  (
    public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Record the manually sourced quote',
      'complete-first',
      'official_quote_received',
      'Reviewed supplier PDF',
      'Supplier quote reference 262',
      'https://example.com/quote/262',
      '[{"offerId":"lane-1","supplier":"Xometry","unitPriceUsd":"12.50","totalPriceUsd":"125.00","leadTimeBusinessDays":"7","requestedQuantity":"10"}]'::jsonb,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'artifactType', 'uploaded_evidence',
          'storageBucket', 'quote-artifacts',
          'storagePath',
            'manual-completions/'
            || (select first_request_id::text from ovd262_context)
            || '/'
            || (select first_run_id::text from ovd262_context)
            || '/'
            || (select first_job_id::text from ovd262_context)
            || '/supplier-quote.pdf',
          'metadata',
            pg_catalog.jsonb_build_object(
              'originalName', 'supplier-quote.pdf'
            )
        )
      )
    ) ->> 'replayed'
  )::boolean,
  true,
  'an exact retry returns the original completion result'
);

select is(
  (
    select pg_catalog.count(*)
    from public.commercial_admin_audit_events event_row
    where event_row.idempotency_key = 'complete-first'
  ),
  1::bigint,
  'an exact retry creates no duplicate commercial audit event'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select first_request_id from ovd262_context),
      (select first_run_id from ovd262_context),
      (select first_job_id from ovd262_context),
      (select first_part_id from ovd262_context),
      'xometry',
      'Record the manually sourced quote',
      'complete-first',
      'official_quote_received',
      'Changed intent',
      null,
      null,
      '[{"offerId":"lane-1","totalPriceUsd":"999.00"}]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Idempotency key has already been used for a different manual quote completion.',
  'idempotency-key reuse with changed intent is rejected'
);

reset role;

update public.quote_requests request_row
set status = 'canceled'
where request_row.id = (select second_request_id from ovd262_context);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select throws_ok(
  $$
    select public.api_admin_complete_manual_quote_request(
      (select second_request_id from ovd262_context),
      (select second_run_id from ovd262_context),
      (select second_job_id from ovd262_context),
      (select second_part_id from ovd262_context),
      'xometry',
      'Attempt stale completion',
      'stale-request',
      'official_quote_received',
      null,
      null,
      null,
      '[{"offerId":"lane-1","totalPriceUsd":"125.00"}]'::jsonb,
      '[]'::jsonb
    )
  $$,
  'P0001',
  'Manual quote request is no longer active.',
  'canceled requests fail as an explicit stale lifecycle state'
);

reset role;

select ok(
  exists (
    select 1
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.policyname =
        'quote_artifacts_storage_insert_billing_admin'
      and policy_row.with_check like
        '%current_user_can_access_manual_quote_artifact%'
  )
  and pg_catalog.pg_get_functiondef(
    'public.current_user_can_access_manual_quote_artifact(uuid,text,text,boolean,boolean)'::regprocedure
  ) like '%public.current_user_has_aal2()%',
  'billing-admin evidence uploads require AAL2'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.policyname =
        'quote_artifacts_storage_read_billing_admin'
  ),
  'billing admins can read only registered quote evidence'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.policyname =
        'quote_artifacts_storage_delete_billing_admin_unregistered'
      and policy_row.qual like
        '%current_user_can_delete_unregistered_manual_quote_upload%'
  ),
  'billing-admin cleanup uses the narrow unregistered-upload helper'
);

insert into storage.objects (
  bucket_id,
  name,
  owner_id
)
values (
  'quote-artifacts',
  'manual-completions/'
    || (select first_request_id::text from ovd262_context)
    || '/'
    || (select first_run_id::text from ovd262_context)
    || '/'
    || (select first_job_id::text from ovd262_context)
    || '/supplier-quote.pdf',
  (select billing_admin_user_id::text from ovd262_context)
);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/supplier-quote.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'registered manual quote evidence is never eligible for failed-upload cleanup'
);

select ok(
  public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'an AAL2 billing admin may clean up their own recent unregistered upload'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select requester_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'billing admins cannot clean up another uploader owner id'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now() - interval '61 minutes'
  ),
  'expired unregistered uploads are not eligible for client cleanup'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now() + interval '1 minute'
  ),
  'future-dated uploads cannot extend the cleanup window'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'job-files',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'cleanup never applies outside the quote-artifacts bucket'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/not-a-request/not-a-run/not-a-job/file.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'malformed manual completion paths are not eligible for cleanup'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal1'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select billing_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'AAL1 billing admins cannot clean up failed uploads'
);

select public.ovd262_test_set_claims(
  (select order_admin_user_id from ovd262_context),
  'aal2'
);

select ok(
  not public.current_user_can_delete_unregistered_manual_quote_upload(
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/active-request.pdf',
    (select order_admin_user_id::text from ovd262_context),
    pg_catalog.now()
  ),
  'non-billing commercial admins cannot clean up failed uploads'
);

select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select ok(
  public.current_user_can_access_manual_quote_artifact(
    (
      select (
        event_row.after_state ->> 'vendorQuoteResultId'
      )::uuid
      from public.commercial_admin_audit_events event_row
      where event_row.idempotency_key = 'complete-first'
    ),
    'quote-artifacts',
    'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/supplier-quote.pdf',
    true,
    false
  ),
  'billing admins can read evidence registered to an exact manual request lineage'
);

select throws_ok(
  $$
    delete from storage.objects object_row
    where object_row.bucket_id = 'quote-artifacts'
      and object_row.name =
        'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/'
          || (select first_job_id::text from ovd262_context)
          || '/supplier-quote.pdf'
  $$,
  '42501',
  'Direct deletion from storage tables is not allowed. Use the Storage API instead.',
  'a registered evidence delete attempt is rejected'
);

reset role;

select ok(
  exists (
    select 1
    from storage.objects object_row
    where object_row.bucket_id = 'quote-artifacts'
      and object_row.name =
        'manual-completions/'
      || (select first_request_id::text from ovd262_context)
      || '/'
      || (select first_run_id::text from ovd262_context)
      || '/'
      || (select first_job_id::text from ovd262_context)
      || '/supplier-quote.pdf'
  ),
  'registered evidence remains after a billing-admin delete attempt'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policies policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.policyname =
        'quote_artifacts_storage_delete_internal'
      and policy_row.qual like '%manual-quotes%'
  ),
  'legacy same-organization manual quote cleanup policy remains unchanged'
);

set local role authenticated;
select public.ovd262_test_set_claims(
  (select billing_admin_user_id from ovd262_context),
  'aal2'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner_id)
    values (
      'quote-artifacts',
      'manual-completions/'
        || (select first_request_id::text from ovd262_context)
        || '/'
        || (select first_run_id::text from ovd262_context)
        || '/'
        || (select first_job_id::text from ovd262_context)
        || '/completed-request.pdf',
      (select billing_admin_user_id::text from ovd262_context)
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'completed or stale manual lineages remain ineligible for new uploads'
);

reset role;

select * from finish();

rollback;
