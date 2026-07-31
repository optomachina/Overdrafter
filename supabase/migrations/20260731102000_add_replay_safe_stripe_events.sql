-- OVD-235: durable, replay-safe Stripe subscription synchronization.
--
-- This is intentionally separate from the contained legacy project-payment
-- webhook. Stripe Event IDs are the idempotency boundary, and commercial
-- projections are mutated only while the inbox row is locked.

alter table private.organization_billing_accounts
  add column if not exists stripe_livemode boolean;

alter table private.organization_subscription_projections
  add column if not exists stripe_event_id text,
  add column if not exists stripe_livemode boolean,
  add column if not exists stripe_price_id text;

alter table private.organization_subscription_projections
  drop constraint if exists organization_subscription_event_id_check;

alter table private.organization_subscription_projections
  add constraint organization_subscription_event_id_check
  check (
    stripe_event_id is null
    or stripe_event_id ~ '^evt_[A-Za-z0-9]+$'
  );

alter table private.organization_subscription_projections
  drop constraint if exists organization_subscription_price_id_check;

alter table private.organization_subscription_projections
  add constraint organization_subscription_price_id_check
  check (
    stripe_price_id is null
    or stripe_price_id ~ '^price_[A-Za-z0-9]+$'
  );

create table private.stripe_pro_price_allowlist (
  stripe_price_id text primary key,
  livemode boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_pro_price_allowlist_id_check
    check (stripe_price_id ~ '^price_[A-Za-z0-9]+$')
);

revoke all on private.stripe_pro_price_allowlist
  from public, anon, authenticated, service_role;

create table private.organization_invoice_projections (
  stripe_invoice_id text primary key,
  organization_id uuid not null
    references private.organization_billing_accounts(organization_id)
    on delete cascade,
  stripe_subscription_id text,
  stripe_event_id text not null,
  stripe_livemode boolean not null,
  status text not null,
  paid boolean not null default false,
  amount_due_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0,
  currency text not null,
  hosted_invoice_url text,
  stripe_event_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_invoice_id_check
    check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  constraint organization_invoice_subscription_id_check
    check (
      stripe_subscription_id is null
      or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
    ),
  constraint organization_invoice_event_id_check
    check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  constraint organization_invoice_status_check
    check (status in ('draft', 'open', 'paid', 'uncollectible', 'void')),
  constraint organization_invoice_amount_check
    check (amount_due_cents >= 0 and amount_paid_cents >= 0),
  constraint organization_invoice_currency_check
    check (currency ~ '^[a-z]{3}$'),
  constraint organization_invoice_url_check
    check (
      hosted_invoice_url is null
      or hosted_invoice_url ~ '^https://'
    )
);

create index organization_invoice_org_event_idx
  on private.organization_invoice_projections (
    organization_id,
    stripe_event_created_at desc
  );

revoke all on private.organization_invoice_projections
  from public, anon, authenticated, service_role;

create table private.stripe_event_inbox (
  stripe_event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  api_version text not null,
  event_created_at timestamptz not null,
  payload jsonb not null,
  processing_state text not null default 'pending',
  receipt_count integer not null default 1,
  attempt_count integer not null default 0,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  processed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_event_inbox_id_check
    check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  constraint stripe_event_inbox_type_check
    check (length(trim(event_type)) between 1 and 200),
  constraint stripe_event_inbox_api_version_check
    check (length(trim(api_version)) between 1 and 100),
  constraint stripe_event_inbox_payload_check
    check (
      payload ->> 'id' = stripe_event_id
      and payload ->> 'type' = event_type
      and (payload ->> 'livemode')::boolean = livemode
    ),
  constraint stripe_event_inbox_state_check
    check (
      processing_state in (
        'pending',
        'processing',
        'processed',
        'failed',
        'ignored'
      )
    ),
  constraint stripe_event_inbox_receipt_count_check
    check (receipt_count >= 1),
  constraint stripe_event_inbox_attempt_count_check
    check (attempt_count >= 0),
  constraint stripe_event_inbox_error_check
    check (
      (
        processing_state <> 'failed'
        and last_error_code is null
        and last_error_message is null
      )
      or (
        processing_state = 'failed'
        and length(trim(last_error_code)) between 1 and 100
        and length(trim(last_error_message)) between 1 and 1000
      )
    )
);

create index stripe_event_inbox_recovery_idx
  on private.stripe_event_inbox (
    processing_state,
    last_received_at,
    stripe_event_id
  )
  where processing_state in ('pending', 'failed');

revoke all on private.stripe_event_inbox
  from public, anon, authenticated, service_role;

create or replace function private.stripe_subscription_status_rank(
  p_status text
)
returns integer
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case p_status
    when 'incomplete' then 10
    when 'trialing' then 20
    when 'active' then 30
    when 'paused' then 40
    when 'past_due' then 50
    when 'unpaid' then 60
    when 'canceled' then 70
    when 'incomplete_expired' then 80
    else 0
  end;
$$;

create or replace function private.stripe_invoice_status_rank(
  p_status text
)
returns integer
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case p_status
    when 'draft' then 10
    when 'open' then 20
    when 'paid' then 30
    when 'void' then 40
    when 'uncollectible' then 50
    else 0
  end;
$$;

create or replace function public.api_ingest_stripe_event(
  p_stripe_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_api_version text,
  p_event_created_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_event private.stripe_event_inbox%rowtype;
begin
  if p_payload is null
    or p_payload ->> 'id' is distinct from p_stripe_event_id
    or p_payload ->> 'type' is distinct from p_event_type
    or (p_payload ->> 'livemode')::boolean is distinct from p_livemode
  then
    raise exception using
      errcode = '22023',
      message = 'Stripe event envelope does not match the verified payload.';
  end if;

  insert into private.stripe_event_inbox (
    stripe_event_id,
    event_type,
    livemode,
    api_version,
    event_created_at,
    payload
  )
  values (
    trim(p_stripe_event_id),
    trim(p_event_type),
    p_livemode,
    trim(p_api_version),
    p_event_created_at,
    p_payload
  )
  on conflict (stripe_event_id) do update
    set receipt_count =
          private.stripe_event_inbox.receipt_count + 1,
        last_received_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where private.stripe_event_inbox.event_type = excluded.event_type
      and private.stripe_event_inbox.livemode = excluded.livemode
      and private.stripe_event_inbox.api_version = excluded.api_version
      and private.stripe_event_inbox.event_created_at =
        excluded.event_created_at
      and private.stripe_event_inbox.payload = excluded.payload
  returning * into v_event;

  if v_event.stripe_event_id is null then
    raise exception using
      errcode = '23505',
      message = 'Stripe Event ID was reused with a different payload.';
  end if;

  return pg_catalog.jsonb_build_object(
    'eventId', v_event.stripe_event_id,
    'state', v_event.processing_state,
    'duplicate', v_event.receipt_count > 1,
    'receiptCount', v_event.receipt_count
  );
end;
$$;

create or replace function public.api_configure_stripe_pro_price(
  p_stripe_price_id text,
  p_livemode boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_price_id text := trim(p_stripe_price_id);
begin
  if v_price_id !~ '^price_[A-Za-z0-9]+$'
    or p_livemode is null
  then
    raise exception using
      errcode = '22023',
      message = 'A valid Stripe Price ID and mode are required.';
  end if;

  insert into private.stripe_pro_price_allowlist (
    stripe_price_id,
    livemode
  )
  values (
    v_price_id,
    p_livemode
  )
  on conflict (stripe_price_id) do update
    set livemode = excluded.livemode,
        updated_at = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'stripePriceId', v_price_id,
    'livemode', p_livemode
  );
end;
$$;

create or replace function public.api_process_stripe_event(
  p_stripe_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_event private.stripe_event_inbox%rowtype;
  v_object jsonb;
  v_organization_id uuid;
  v_billing_livemode boolean;
  v_subscription_id text;
  v_customer_id text;
  v_status text;
  v_interval text;
  v_price_id text;
  v_current_period_end timestamptz;
  v_past_due_since timestamptz;
  v_existing_subscription
    private.organization_subscription_projections%rowtype;
  v_invoice_id text;
  v_existing_invoice private.organization_invoice_projections%rowtype;
  v_amount_due bigint;
  v_amount_paid bigint;
  v_currency text;
  v_hosted_invoice_url text;
  v_outcome text := 'processed';
  v_error_code text;
  v_error_message text;
begin
  select event_row.*
  into v_event
  from private.stripe_event_inbox event_row
  where event_row.stripe_event_id = trim(p_stripe_event_id)
  for update;

  if v_event.stripe_event_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Stripe event was not found.';
  end if;

  if v_event.processing_state in ('processed', 'ignored') then
    return pg_catalog.jsonb_build_object(
      'eventId', v_event.stripe_event_id,
      'state', v_event.processing_state,
      'replayed', true,
      'attemptCount', v_event.attempt_count
    );
  end if;

  update private.stripe_event_inbox event_row
  set processing_state = 'processing',
      attempt_count = event_row.attempt_count + 1,
      last_attempt_at = pg_catalog.now(),
      processed_at = null,
      last_error_code = null,
      last_error_message = null,
      updated_at = pg_catalog.now()
  where event_row.stripe_event_id = v_event.stripe_event_id
  returning * into v_event;

  begin
    if v_event.api_version <> '2024-11-20.acacia' then
      raise exception using
        errcode = '22023',
        message = 'Stripe event API version does not match the pinned contract.';
    end if;

    v_object := v_event.payload #> '{data,object}';

    if v_event.event_type in (
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted'
    ) then
      v_subscription_id := v_object ->> 'id';
      v_customer_id := v_object ->> 'customer';
      v_status := v_object ->> 'status';

      if v_event.event_type = 'customer.subscription.deleted' then
        v_status := 'canceled';
      end if;

      if v_subscription_id is null
        or v_subscription_id !~ '^sub_[A-Za-z0-9]+$'
        or v_customer_id is null
        or v_customer_id !~ '^cus_[A-Za-z0-9]+$'
        or coalesce(
          private.stripe_subscription_status_rank(v_status),
          0
        ) = 0
      then
        raise exception using
          errcode = '22023',
          message = 'Stripe subscription event is missing required fields.';
      end if;

      select account_row.organization_id, account_row.stripe_livemode
      into v_organization_id, v_billing_livemode
      from private.organization_billing_accounts account_row
      where account_row.stripe_customer_id = v_customer_id
      for update;

      if v_organization_id is null then
        raise exception using
          errcode = 'P0002',
          message = 'Stripe customer is not mapped to an organization.';
      end if;

      if v_billing_livemode is not null
        and v_billing_livemode <> v_event.livemode
      then
        raise exception using
          errcode = '22023',
          message = 'Stripe event mode does not match the billing account.';
      end if;

      if v_billing_livemode is null then
        update private.organization_billing_accounts account_row
        set stripe_livemode = v_event.livemode,
            updated_at = pg_catalog.now()
        where account_row.organization_id = v_organization_id;
      end if;

      select subscription_row.*
      into v_existing_subscription
      from private.organization_subscription_projections subscription_row
      where subscription_row.stripe_subscription_id = v_subscription_id
      for update;

      if v_existing_subscription.id is not null
        and v_existing_subscription.organization_id <> v_organization_id
      then
        raise exception using
          errcode = '23514',
          message = 'Stripe subscription is mapped to another organization.';
      end if;

      if v_existing_subscription.id is not null
        and (
          v_event.event_created_at <
            v_existing_subscription.stripe_event_created_at
          or (
            v_event.event_created_at =
              v_existing_subscription.stripe_event_created_at
            and (
              private.stripe_subscription_status_rank(v_status) <
                private.stripe_subscription_status_rank(
                  v_existing_subscription.status
                )
              or (
                private.stripe_subscription_status_rank(v_status) =
                  private.stripe_subscription_status_rank(
                    v_existing_subscription.status
                  )
                and v_event.stripe_event_id <=
                  coalesce(
                    v_existing_subscription.stripe_event_id,
                    v_event.stripe_event_id
                  )
              )
            )
          )
        )
      then
        v_outcome := 'stale';
      else
        v_interval :=
          v_object #>> '{items,data,0,price,recurring,interval}';
        v_price_id := v_object #>> '{items,data,0,price,id}';

        if v_price_id is null
          or v_price_id !~ '^price_[A-Za-z0-9]+$'
          or not exists (
            select 1
            from private.stripe_pro_price_allowlist price_row
            where price_row.stripe_price_id = v_price_id
              and price_row.livemode = v_event.livemode
          )
        then
          raise exception using
            errcode = '22023',
            message = 'Stripe subscription is not for an allowlisted Pro price.';
        end if;

        v_current_period_end := case
          when nullif(v_object ->> 'current_period_end', '') is null
            then null
          else pg_catalog.to_timestamp(
            (v_object ->> 'current_period_end')::double precision
          )
        end;

        if v_status = 'past_due' then
          if v_existing_subscription.status = 'past_due'
            and v_existing_subscription.past_due_since is not null
          then
            v_past_due_since := v_existing_subscription.past_due_since;
          else
            v_past_due_since := v_event.event_created_at;
          end if;
        else
          v_past_due_since := null;
        end if;

        insert into private.organization_subscription_projections (
          organization_id,
          stripe_subscription_id,
          status,
          billing_interval,
          current_period_end,
          past_due_since,
          cancel_at_period_end,
          stripe_event_created_at,
          stripe_event_id,
          stripe_livemode,
          stripe_price_id
        )
        values (
          v_organization_id,
          v_subscription_id,
          v_status,
          v_interval,
          v_current_period_end,
          v_past_due_since,
          coalesce(
            (v_object ->> 'cancel_at_period_end')::boolean,
            false
          ),
          v_event.event_created_at,
          v_event.stripe_event_id,
          v_event.livemode,
          v_price_id
        )
        on conflict (stripe_subscription_id) do update
          set status = excluded.status,
              billing_interval = excluded.billing_interval,
              current_period_end = excluded.current_period_end,
              past_due_since = excluded.past_due_since,
              cancel_at_period_end = excluded.cancel_at_period_end,
              stripe_event_created_at = excluded.stripe_event_created_at,
              stripe_event_id = excluded.stripe_event_id,
              stripe_livemode = excluded.stripe_livemode,
              stripe_price_id = excluded.stripe_price_id,
              updated_at = pg_catalog.now();
      end if;
    elsif v_event.event_type in (
      'invoice.finalized',
      'invoice.paid',
      'invoice.payment_failed',
      'invoice.marked_uncollectible',
      'invoice.voided'
    ) then
      v_invoice_id := v_object ->> 'id';
      v_customer_id := v_object ->> 'customer';
      v_subscription_id := v_object ->> 'subscription';
      v_status := v_object ->> 'status';

      if v_event.event_type = 'invoice.paid' then
        v_status := 'paid';
      elsif v_event.event_type = 'invoice.marked_uncollectible' then
        v_status := 'uncollectible';
      elsif v_event.event_type = 'invoice.voided' then
        v_status := 'void';
      end if;

      if v_invoice_id is null
        or v_invoice_id !~ '^in_[A-Za-z0-9]+$'
        or v_customer_id is null
        or v_customer_id !~ '^cus_[A-Za-z0-9]+$'
        or coalesce(
          private.stripe_invoice_status_rank(v_status),
          0
        ) = 0
      then
        raise exception using
          errcode = '22023',
          message = 'Stripe invoice event is missing required fields.';
      end if;

      select account_row.organization_id, account_row.stripe_livemode
      into v_organization_id, v_billing_livemode
      from private.organization_billing_accounts account_row
      where account_row.stripe_customer_id = v_customer_id
      for update;

      if v_organization_id is null then
        raise exception using
          errcode = 'P0002',
          message = 'Stripe customer is not mapped to an organization.';
      end if;

      if v_billing_livemode is not null
        and v_billing_livemode <> v_event.livemode
      then
        raise exception using
          errcode = '22023',
          message = 'Stripe event mode does not match the billing account.';
      end if;

      if v_billing_livemode is null then
        update private.organization_billing_accounts account_row
        set stripe_livemode = v_event.livemode,
            updated_at = pg_catalog.now()
        where account_row.organization_id = v_organization_id;
      end if;

      select invoice_row.*
      into v_existing_invoice
      from private.organization_invoice_projections invoice_row
      where invoice_row.stripe_invoice_id = v_invoice_id
      for update;

      if v_existing_invoice.stripe_invoice_id is not null
        and v_existing_invoice.organization_id <> v_organization_id
      then
        raise exception using
          errcode = '23514',
          message = 'Stripe invoice is mapped to another organization.';
      end if;

      if v_existing_invoice.stripe_invoice_id is not null
        and (
          v_event.event_created_at <
            v_existing_invoice.stripe_event_created_at
          or (
            v_event.event_created_at =
              v_existing_invoice.stripe_event_created_at
            and (
              private.stripe_invoice_status_rank(v_status) <
                private.stripe_invoice_status_rank(
                  v_existing_invoice.status
                )
              or (
                private.stripe_invoice_status_rank(v_status) =
                  private.stripe_invoice_status_rank(
                    v_existing_invoice.status
                  )
                and v_event.stripe_event_id <=
                  v_existing_invoice.stripe_event_id
              )
            )
          )
        )
      then
        v_outcome := 'stale';
      else
        v_amount_due := coalesce(
          (v_object ->> 'amount_due')::bigint,
          0
        );
        v_amount_paid := coalesce(
          (v_object ->> 'amount_paid')::bigint,
          0
        );
        v_currency := lower(v_object ->> 'currency');
        v_hosted_invoice_url := nullif(
          v_object ->> 'hosted_invoice_url',
          ''
        );

        insert into private.organization_invoice_projections (
          stripe_invoice_id,
          organization_id,
          stripe_subscription_id,
          stripe_event_id,
          stripe_livemode,
          status,
          paid,
          amount_due_cents,
          amount_paid_cents,
          currency,
          hosted_invoice_url,
          stripe_event_created_at
        )
        values (
          v_invoice_id,
          v_organization_id,
          nullif(v_subscription_id, ''),
          v_event.stripe_event_id,
          v_event.livemode,
          v_status,
          v_status = 'paid',
          v_amount_due,
          v_amount_paid,
          v_currency,
          v_hosted_invoice_url,
          v_event.event_created_at
        )
        on conflict (stripe_invoice_id) do update
          set stripe_subscription_id = excluded.stripe_subscription_id,
              stripe_event_id = excluded.stripe_event_id,
              stripe_livemode = excluded.stripe_livemode,
              status = excluded.status,
              paid = excluded.paid,
              amount_due_cents = excluded.amount_due_cents,
              amount_paid_cents = excluded.amount_paid_cents,
              currency = excluded.currency,
              hosted_invoice_url = excluded.hosted_invoice_url,
              stripe_event_created_at = excluded.stripe_event_created_at,
              updated_at = pg_catalog.now();
      end if;
    else
      update private.stripe_event_inbox event_row
      set processing_state = 'ignored',
          processed_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      where event_row.stripe_event_id = v_event.stripe_event_id;

      return pg_catalog.jsonb_build_object(
        'eventId', v_event.stripe_event_id,
        'state', 'ignored',
        'replayed', false,
        'attemptCount', v_event.attempt_count
      );
    end if;

    update private.stripe_event_inbox event_row
    set processing_state = 'processed',
        processed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where event_row.stripe_event_id = v_event.stripe_event_id;

    return pg_catalog.jsonb_build_object(
      'eventId', v_event.stripe_event_id,
      'state', 'processed',
      'outcome', v_outcome,
      'replayed', false,
      'attemptCount', v_event.attempt_count
    );
  exception
    when others then
      get stacked diagnostics
        v_error_code = returned_sqlstate,
        v_error_message = message_text;

      update private.stripe_event_inbox event_row
      set processing_state = 'failed',
          last_error_code = left(
            coalesce(nullif(trim(v_error_code), ''), 'XX000'),
            100
          ),
          last_error_message = left(
            coalesce(
              nullif(trim(v_error_message), ''),
              'Stripe event processing failed.'
            ),
            1000
          ),
          updated_at = pg_catalog.now()
      where event_row.stripe_event_id = v_event.stripe_event_id;

      return pg_catalog.jsonb_build_object(
        'eventId', v_event.stripe_event_id,
        'state', 'failed',
        'errorCode', coalesce(v_error_code, 'XX000'),
        'replayed', false,
        'attemptCount', v_event.attempt_count
      );
  end;
end;
$$;

create or replace function private.resolve_organization_entitlements_at(
  p_organization_id uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_grant private.organization_entitlement_grants%rowtype;
  v_subscription private.organization_subscription_projections%rowtype;
  v_grace_ends_at timestamptz;
begin
  if p_organization_id is null
    or p_as_of is null
    or not exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = p_organization_id
    )
  then
    return pg_catalog.jsonb_build_object(
      'plan', 'free',
      'source', 'default',
      'automaticQuoteCollection', false,
      'organizationExists', false
    );
  end if;

  select grant_row.*
  into v_grant
  from private.organization_entitlement_grants grant_row
  where grant_row.organization_id = p_organization_id
    and grant_row.entitlement_key = 'automatic_quote_collection'
    and grant_row.revoked_at is null
    and grant_row.starts_at <= p_as_of
    and (
      grant_row.expires_at is null
      or grant_row.expires_at > p_as_of
    )
  order by
    case grant_row.grant_type
      when 'complimentary' then 0
      else 1
    end,
    grant_row.starts_at desc,
    grant_row.created_at desc,
    grant_row.id desc
  limit 1;

  if v_grant.id is not null then
    return pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'plan', 'pro',
        'source', 'manual_' || v_grant.grant_type,
        'sourceId', v_grant.id,
        'automaticQuoteCollection', true,
        'validUntil', v_grant.expires_at,
        'reviewAt', v_grant.review_at,
        'reviewDue',
          v_grant.review_at is not null and v_grant.review_at <= p_as_of,
        'organizationExists', true
      )
    );
  end if;

  select subscription_row.*
  into v_subscription
  from private.organization_subscription_projections subscription_row
  where subscription_row.organization_id = p_organization_id
    and exists (
      select 1
      from private.stripe_pro_price_allowlist price_row
      where price_row.stripe_price_id = subscription_row.stripe_price_id
        and price_row.livemode = subscription_row.stripe_livemode
    )
    and (
      (
        subscription_row.status = 'active'
        and subscription_row.current_period_end > p_as_of
      )
      or (
        subscription_row.status = 'past_due'
        and p_as_of <
          subscription_row.past_due_since + interval '7 days'
      )
    )
  order by
    subscription_row.stripe_event_created_at desc,
    subscription_row.updated_at desc,
    subscription_row.id desc
  limit 1;

  if v_subscription.id is not null then
    if v_subscription.status = 'past_due' then
      v_grace_ends_at :=
        v_subscription.past_due_since + interval '7 days';
    end if;

    return pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'plan', 'pro',
        'source',
          case v_subscription.status
            when 'past_due' then 'subscription_past_due_grace'
            else 'subscription_active'
          end,
        'sourceId', v_subscription.id,
        'automaticQuoteCollection', true,
        'validUntil', v_subscription.current_period_end,
        'graceEndsAt', v_grace_ends_at,
        'organizationExists', true
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'plan', 'free',
    'source', 'default',
    'automaticQuoteCollection', false,
    'organizationExists', true
  );
exception
  when others then
    return pg_catalog.jsonb_build_object(
      'plan', 'free',
      'source', 'resolver_error',
      'automaticQuoteCollection', false,
      'organizationExists', true
    );
end;
$$;

create or replace function public.api_replay_stripe_event(
  p_stripe_event_id text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select public.api_process_stripe_event(p_stripe_event_id);
$$;

create or replace function public.api_reconcile_stripe_events(
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_event record;
  v_results jsonb := '[]'::jsonb;
begin
  for v_event in
    select event_row.stripe_event_id
    from private.stripe_event_inbox event_row
    where event_row.processing_state in ('pending', 'failed')
    order by event_row.last_received_at, event_row.stripe_event_id
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  loop
    v_results := v_results || pg_catalog.jsonb_build_array(
      public.api_process_stripe_event(v_event.stripe_event_id)
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'processedCount', pg_catalog.jsonb_array_length(v_results),
    'results', v_results
  );
end;
$$;

create or replace function public.api_get_stripe_event_status(
  p_stripe_event_id text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'eventId', event_row.stripe_event_id,
      'eventType', event_row.event_type,
      'livemode', event_row.livemode,
      'apiVersion', event_row.api_version,
      'eventCreatedAt', event_row.event_created_at,
      'state', event_row.processing_state,
      'receiptCount', event_row.receipt_count,
      'attemptCount', event_row.attempt_count,
      'lastReceivedAt', event_row.last_received_at,
      'lastAttemptAt', event_row.last_attempt_at,
      'processedAt', event_row.processed_at,
      'lastErrorCode', event_row.last_error_code
    )
  )
  from private.stripe_event_inbox event_row
  where event_row.stripe_event_id = trim(p_stripe_event_id);
$$;

revoke all on function public.api_ingest_stripe_event(
  text,
  text,
  boolean,
  text,
  timestamptz,
  jsonb
) from public, anon, authenticated;
revoke all on function public.api_configure_stripe_pro_price(text, boolean)
  from public, anon, authenticated;
revoke all on function public.api_process_stripe_event(text)
  from public, anon, authenticated;
revoke all on function public.api_replay_stripe_event(text)
  from public, anon, authenticated;
revoke all on function public.api_reconcile_stripe_events(integer)
  from public, anon, authenticated;
revoke all on function public.api_get_stripe_event_status(text)
  from public, anon, authenticated;

grant execute on function public.api_ingest_stripe_event(
  text,
  text,
  boolean,
  text,
  timestamptz,
  jsonb
) to service_role;
grant execute on function public.api_configure_stripe_pro_price(text, boolean)
  to service_role;
grant execute on function public.api_process_stripe_event(text)
  to service_role;
grant execute on function public.api_replay_stripe_event(text)
  to service_role;
grant execute on function public.api_reconcile_stripe_events(integer)
  to service_role;
grant execute on function public.api_get_stripe_event_status(text)
  to service_role;

-- Rollback:
-- 1. Stop the stripe-events function and replay tooling.
-- 2. Revoke/drop the six public service-role functions and restore the prior
--    entitlement resolver before removing the Pro price allowlist.
-- 3. Drop stripe_event_inbox, organization_invoice_projections, and
--    stripe_pro_price_allowlist.
-- 4. Drop the nullable Stripe event/mode/price columns only after confirming
--    no newer migration depends on them, then drop the two ranking helpers.
