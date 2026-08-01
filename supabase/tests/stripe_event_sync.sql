begin;

select plan(43);

create function public.ovd235_subscription_event(
  p_event_id text,
  p_event_type text,
  p_created bigint,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_livemode boolean default false,
  p_price_id text default 'price_OVD235Pro'
)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_event_id,
    'object', 'event',
    'api_version', '2024-11-20.acacia',
    'created', p_created,
    'livemode', p_livemode,
    'type', p_event_type,
    'data', pg_catalog.jsonb_build_object(
      'object', pg_catalog.jsonb_build_object(
        'id', p_subscription_id,
        'object', 'subscription',
        'customer', p_customer_id,
        'status', p_status,
        'current_period_end', 1798761600,
        'cancel_at_period_end', false,
        'items', pg_catalog.jsonb_build_object(
          'data', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'price', pg_catalog.jsonb_build_object(
                'id', p_price_id,
                'recurring', pg_catalog.jsonb_build_object(
                  'interval', 'month'
                )
              )
            )
          )
        )
      )
    )
  );
$$;

create function public.ovd235_invoice_event(
  p_event_id text,
  p_event_type text,
  p_created bigint,
  p_invoice_id text,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_livemode boolean default false
)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_event_id,
    'object', 'event',
    'api_version', '2024-11-20.acacia',
    'created', p_created,
    'livemode', p_livemode,
    'type', p_event_type,
    'data', pg_catalog.jsonb_build_object(
      'object', pg_catalog.jsonb_build_object(
        'id', p_invoice_id,
        'object', 'invoice',
        'customer', p_customer_id,
        'subscription', p_subscription_id,
        'status', p_status,
        'paid', p_status = 'paid',
        'amount_due', 4900,
        'amount_paid', case when p_status = 'paid' then 4900 else 0 end,
        'currency', 'usd',
        'hosted_invoice_url', 'https://invoice.stripe.test/ovd235'
      )
    )
  );
$$;

insert into public.organizations (id, name, slug)
values
  (
    '00000000-0000-4000-8000-000000002351',
    'OVD 235 Primary',
    'ovd-235-primary'
  ),
  (
    '00000000-0000-4000-8000-000000002352',
    'OVD 235 Recovery',
    'ovd-235-recovery'
  ),
  (
    '00000000-0000-4000-8000-000000002353',
    'OVD 235 Invoice First',
    'ovd-235-invoice-first'
  ),
  (
    '00000000-0000-4000-8000-000000002354',
    'OVD 235 Unapproved Price',
    'ovd-235-unapproved-price'
  );

insert into private.organization_billing_accounts (
  organization_id,
  stripe_customer_id
)
values
  (
    '00000000-0000-4000-8000-000000002351',
    'cus_OVD235Primary'
  ),
  (
    '00000000-0000-4000-8000-000000002353',
    'cus_OVD235InvoiceFirst'
  ),
  (
    '00000000-0000-4000-8000-000000002354',
    'cus_OVD235Unapproved'
  );

select public.api_configure_stripe_pro_price(
  'price_OVD235Pro',
  false
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.api_ingest_stripe_event(text,text,boolean,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_replay_stripe_event(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.api_configure_stripe_pro_price(text,boolean)',
    'EXECUTE'
  ),
  'authenticated users cannot configure, ingest, or replay Stripe events'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.stripe_event_inbox',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'private.stripe_event_inbox',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'private.stripe_pro_price_allowlist',
    'SELECT'
  ),
  'service role must use guarded functions instead of direct billing-table access'
);

select is(
  public.api_ingest_stripe_event(
    'evt_active1',
    'customer.subscription.updated',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469200),
    public.ovd235_subscription_event(
      'evt_active1',
      'customer.subscription.updated',
      1785469200,
      'cus_OVD235Primary',
      'sub_OVD235Primary',
      'active'
    )
  ) ->> 'state',
  'pending',
  'a verified event is durable before processing'
);

select is(
  public.api_process_stripe_event('evt_active1') ->> 'state',
  'processed',
  'a subscription event processes transactionally'
);

select is(
  (
    select status
    from private.organization_subscription_projections
    where stripe_subscription_id = 'sub_OVD235Primary'
  ),
  'active',
  'the active subscription projection is persisted'
);

select is(
  private.resolve_organization_entitlements_at(
    '00000000-0000-4000-8000-000000002351',
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'pro',
  'the synchronized active subscription grants Pro server-side'
);

select ok(
  (
    select api_version = '2024-11-20.acacia'
      and not livemode
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_active1'
  ),
  'the inbox records Stripe API version and test/live mode'
);

select is(
  (
    public.api_ingest_stripe_event(
      'evt_active1',
      'customer.subscription.updated',
      false,
      '2024-11-20.acacia',
      pg_catalog.to_timestamp(1785469200),
      public.ovd235_subscription_event(
        'evt_active1',
        'customer.subscription.updated',
        1785469200,
        'cus_OVD235Primary',
        'sub_OVD235Primary',
        'active'
      )
    ) ->> 'duplicate'
  )::boolean,
  true,
  'a duplicate Stripe Event ID is detected durably'
);

select is(
  (
    public.api_process_stripe_event('evt_active1') ->> 'replayed'
  )::boolean,
  true,
  'a processed duplicate returns a replay without applying effects again'
);

select ok(
  (
    select receipt_count = 2
      and attempt_count = 1
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_active1'
  ),
  'duplicate delivery increments receipts without duplicating attempts'
);

select is(
  public.api_ingest_stripe_event(
    'evt_oldcancel',
    'customer.subscription.deleted',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469100),
    public.ovd235_subscription_event(
      'evt_oldcancel',
      'customer.subscription.deleted',
      1785469100,
      'cus_OVD235Primary',
      'sub_OVD235Primary',
      'canceled'
    )
  ) ->> 'state',
  'pending',
  'an out-of-order event is still retained in the inbox'
);

select is(
  public.api_process_stripe_event('evt_oldcancel') ->> 'outcome',
  'stale',
  'an older subscription event is classified as stale'
);

select is(
  (
    select status
    from private.organization_subscription_projections
    where stripe_subscription_id = 'sub_OVD235Primary'
  ),
  'active',
  'an out-of-order cancellation cannot downgrade current state'
);

select is(
  public.api_ingest_stripe_event(
    'evt_newcancel',
    'customer.subscription.deleted',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469300),
    public.ovd235_subscription_event(
      'evt_newcancel',
      'customer.subscription.deleted',
      1785469300,
      'cus_OVD235Primary',
      'sub_OVD235Primary',
      'canceled'
    )
  ) ->> 'state',
  'pending',
  'a newer cancellation is retained for processing'
);

select is(
  public.api_process_stripe_event('evt_newcancel') ->> 'state',
  'processed',
  'a newer cancellation processes'
);

select is(
  (
    select status
    from private.organization_subscription_projections
    where stripe_subscription_id = 'sub_OVD235Primary'
  ),
  'canceled',
  'the newer cancellation becomes the current projection'
);

select is(
  private.resolve_organization_entitlements_at(
    '00000000-0000-4000-8000-000000002351',
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'free',
  'a synchronized cancellation removes subscription-derived Pro access'
);

select is(
  public.api_ingest_stripe_event(
    'evt_recovery',
    'customer.subscription.updated',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469400),
    public.ovd235_subscription_event(
      'evt_recovery',
      'customer.subscription.updated',
      1785469400,
      'cus_OVD235Recovery',
      'sub_OVD235Recovery',
      'trialing'
    )
  ) ->> 'state',
  'pending',
  'an event can be durably stored before its customer mapping is ready'
);

select is(
  public.api_process_stripe_event('evt_recovery') ->> 'state',
  'failed',
  'a processing failure remains retryable'
);

select ok(
  (
    select processing_state = 'failed'
      and attempt_count = 1
      and last_error_code = 'P0002'
      and last_error_message <> ''
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_recovery'
  ),
  'a failed attempt retains bounded diagnostic context'
);

insert into private.organization_billing_accounts (
  organization_id,
  stripe_customer_id,
  stripe_livemode
)
values (
  '00000000-0000-4000-8000-000000002352',
  'cus_OVD235Recovery',
  false
);

select is(
  public.api_replay_stripe_event('evt_recovery') ->> 'state',
  'processed',
  'a failed event replays successfully after its dependency is repaired'
);

select is(
  private.resolve_organization_entitlements_at(
    '00000000-0000-4000-8000-000000002352',
    '2026-08-01T00:00:00Z'
  ) ->> 'source',
  'subscription_trialing',
  'a replayed signed trialing event grants Pro through the local projection'
);

select ok(
  (
    select processing_state = 'processed'
      and attempt_count = 2
      and last_error_code is null
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_recovery'
  ),
  'successful replay clears the prior error without duplicating the event'
);

select is(
  public.api_ingest_stripe_event(
    'evt_unknown1',
    'product.updated',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469500),
    pg_catalog.jsonb_build_object(
      'id', 'evt_unknown1',
      'object', 'event',
      'api_version', '2024-11-20.acacia',
      'created', 1785469500,
      'livemode', false,
      'type', 'product.updated',
      'data', pg_catalog.jsonb_build_object(
        'object', pg_catalog.jsonb_build_object('id', 'prod_OVD235')
      )
    )
  ) ->> 'state',
  'pending',
  'unknown verified event types are retained before acknowledgement'
);

select is(
  public.api_process_stripe_event('evt_unknown1') ->> 'state',
  'ignored',
  'unknown verified event types are acknowledged without side effects'
);

select is(
  public.api_ingest_stripe_event(
    'evt_invoicepaid',
    'invoice.paid',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469600),
    public.ovd235_invoice_event(
      'evt_invoicepaid',
      'invoice.paid',
      1785469600,
      'in_OVD235Paid',
      'cus_OVD235Primary',
      'sub_OVD235Primary',
      'paid'
    )
  ) ->> 'state',
  'pending',
  'invoice facts use the same durable inbox'
);

select is(
  public.api_process_stripe_event('evt_invoicepaid') ->> 'state',
  'processed',
  'a paid invoice event processes'
);

select ok(
  (
    select status = 'paid'
      and paid
      and amount_due_cents = 4900
      and amount_paid_cents = 4900
      and currency = 'usd'
      and stripe_event_id = 'evt_invoicepaid'
    from private.organization_invoice_projections
    where stripe_invoice_id = 'in_OVD235Paid'
  ),
  'the invoice projection retains economic facts and provenance'
);

select public.api_ingest_stripe_event(
  'evt_reconcile1',
  'invoice.finalized',
  false,
  '2024-11-20.acacia',
  pg_catalog.to_timestamp(1785469700),
  public.ovd235_invoice_event(
    'evt_reconcile1',
    'invoice.finalized',
    1785469700,
    'in_OVD235Open',
    'cus_OVD235Primary',
    'sub_OVD235Primary',
    'open'
  )
);

select is(
  (
    public.api_reconcile_stripe_events(1) ->> 'processedCount'
  )::integer,
  1,
  'reconciliation processes a bounded batch of pending events'
);

select is(
  (
    select processing_state
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_reconcile1'
  ),
  'processed',
  'reconciliation leaves the recovered event terminal'
);

select public.api_ingest_stripe_event(
  'evt_wrongversion',
  'product.updated',
  false,
  '2025-01-27.acacia',
  pg_catalog.to_timestamp(1785469800),
  pg_catalog.jsonb_build_object(
    'id', 'evt_wrongversion',
    'object', 'event',
    'api_version', '2025-01-27.acacia',
    'created', 1785469800,
    'livemode', false,
    'type', 'product.updated',
    'data', pg_catalog.jsonb_build_object(
      'object', pg_catalog.jsonb_build_object('id', 'prod_OVD235')
    )
  )
);

select is(
  public.api_process_stripe_event('evt_wrongversion') ->> 'state',
  'failed',
  'an unpinned API version fails closed instead of mutating projections'
);

select is(
  (
    select api_version
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_wrongversion'
  ),
  '2025-01-27.acacia',
  'the actual incompatible API version remains available for reconciliation'
);

select throws_ok(
  $$
    select public.api_ingest_stripe_event(
      'evt_active1',
      'customer.subscription.updated',
      false,
      '2024-11-20.acacia',
      pg_catalog.to_timestamp(1785469200),
      public.ovd235_subscription_event(
        'evt_active1',
        'customer.subscription.updated',
        1785469200,
        'cus_OVD235Primary',
        'sub_OVD235Primary',
        'past_due'
      )
    )
  $$,
  '23505',
  'Stripe Event ID was reused with a different payload.',
  'a Stripe Event ID cannot be reused with mutated intent'
);

select ok(
  (
    select stripe_livemode is false
    from private.organization_billing_accounts
    where organization_id = '00000000-0000-4000-8000-000000002351'
  ),
  'the first trusted event binds the billing account to test/live mode'
);

select is(
  public.api_ingest_stripe_event(
    'evt_invoicefirst',
    'invoice.finalized',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469900),
    public.ovd235_invoice_event(
      'evt_invoicefirst',
      'invoice.finalized',
      1785469900,
      'in_OVD235InvoiceFirst',
      'cus_OVD235InvoiceFirst',
      'sub_OVD235InvoiceFirst',
      'open'
    )
  ) ->> 'state',
  'pending',
  'an invoice can be the first trusted billing event'
);

select is(
  public.api_process_stripe_event('evt_invoicefirst') ->> 'state',
  'processed',
  'an invoice-first event processes'
);

select ok(
  (
    select stripe_livemode is false
    from private.organization_billing_accounts
    where organization_id = '00000000-0000-4000-8000-000000002353'
  ),
  'an invoice-first event binds the billing account mode'
);

select is(
  public.api_ingest_stripe_event(
    'evt_oppositemode',
    'customer.subscription.updated',
    true,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469910),
    public.ovd235_subscription_event(
      'evt_oppositemode',
      'customer.subscription.updated',
      1785469910,
      'cus_OVD235InvoiceFirst',
      'sub_OVD235InvoiceFirst',
      'active',
      true
    )
  ) ->> 'state',
  'pending',
  'an opposite-mode event is retained before validation'
);

select is(
  public.api_process_stripe_event('evt_oppositemode') ->> 'state',
  'failed',
  'an opposite-mode event cannot mix test and live projections'
);

select is(
  (
    select last_error_message
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_oppositemode'
  ),
  'Stripe event mode does not match the billing account.',
  'the opposite-mode event is rejected by the account mode check'
);

select is(
  public.api_ingest_stripe_event(
    'evt_unapprovedprice',
    'customer.subscription.updated',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785469920),
    public.ovd235_subscription_event(
      'evt_unapprovedprice',
      'customer.subscription.updated',
      1785469920,
      'cus_OVD235Unapproved',
      'sub_OVD235Unapproved',
      'active',
      false,
      'price_OVD235Other'
    )
  ) ->> 'state',
  'pending',
  'a subscription for another Stripe price is retained before validation'
);

select is(
  public.api_process_stripe_event('evt_unapprovedprice') ->> 'state',
  'failed',
  'a subscription for another Stripe price cannot project Pro access'
);

select is(
  private.resolve_organization_entitlements_at(
    '00000000-0000-4000-8000-000000002354',
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'free',
  'an unrelated active Stripe subscription remains Free'
);

select * from finish();

rollback;
