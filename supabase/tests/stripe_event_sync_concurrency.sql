-- This test commits fixed fixtures so two independent dblink sessions can
-- exercise the real Stripe Event ID and inbox-row locks. It removes only those
-- fixed fixtures before returning.

create extension if not exists dblink with schema extensions;

select plan(4);

do $$
begin
  if current_database() <> 'postgres'
    or session_user <> 'postgres'
  then
    raise exception
      'OVD-235 concurrency tests require the disposable local test database';
  end if;

end;
$$;

begin;

delete from private.stripe_event_inbox
where stripe_event_id = 'evt_concurrent235';

delete from private.organization_subscription_projections
where stripe_subscription_id = 'sub_OVD235Concurrent';

delete from private.organization_billing_accounts
where organization_id = '00000000-0000-4000-8000-000000002359';

delete from public.organizations
where id = '00000000-0000-4000-8000-000000002359';

delete from private.stripe_pro_price_allowlist
where stripe_price_id = 'price_OVD235Concurrent';

drop function if exists public.ovd235_concurrent_delivery();

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000002359',
  'OVD 235 Concurrency',
  'ovd-235-concurrency'
);

insert into private.organization_billing_accounts (
  organization_id,
  stripe_customer_id,
  stripe_livemode
)
values (
  '00000000-0000-4000-8000-000000002359',
  'cus_OVD235Concurrent',
  false
);

do $$
begin
  perform public.api_configure_stripe_pro_price(
    'price_OVD235Concurrent',
    false
  );
end;
$$;

create function public.ovd235_concurrent_delivery()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_payload jsonb;
begin
  v_payload := pg_catalog.jsonb_build_object(
    'id', 'evt_concurrent235',
    'object', 'event',
    'api_version', '2024-11-20.acacia',
    'created', 1785470000,
    'livemode', false,
    'type', 'customer.subscription.updated',
    'data', pg_catalog.jsonb_build_object(
      'object', pg_catalog.jsonb_build_object(
        'id', 'sub_OVD235Concurrent',
        'object', 'subscription',
        'customer', 'cus_OVD235Concurrent',
        'status', 'active',
        'current_period_end', 1798761600,
        'cancel_at_period_end', false,
        'items', pg_catalog.jsonb_build_object(
          'data', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'price', pg_catalog.jsonb_build_object(
                'id', 'price_OVD235Concurrent',
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

  perform public.api_ingest_stripe_event(
    'evt_concurrent235',
    'customer.subscription.updated',
    false,
    '2024-11-20.acacia',
    pg_catalog.to_timestamp(1785470000),
    v_payload
  );

  return public.api_process_stripe_event('evt_concurrent235');
end;
$$;

revoke all on function public.ovd235_concurrent_delivery()
  from public, anon, authenticated, service_role;

commit;

select extensions.dblink_connect(
  'ovd235_a',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
select extensions.dblink_connect(
  'ovd235_b',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

select extensions.dblink_send_query(
  'ovd235_a',
  'select public.ovd235_concurrent_delivery()'
);
select extensions.dblink_send_query(
  'ovd235_b',
  'select public.ovd235_concurrent_delivery()'
);

create temporary table ovd235_concurrent_results (
  result jsonb not null
);

insert into ovd235_concurrent_results
select result
from extensions.dblink_get_result('ovd235_a') as response(result jsonb);

insert into ovd235_concurrent_results
select result
from extensions.dblink_get_result('ovd235_b') as response(result jsonb);

select is(
  (
    select count(*)
    from ovd235_concurrent_results
    where (result ->> 'replayed')::boolean
  ),
  1::bigint,
  'two concurrent deliveries return one replay'
);

select is(
  (
    select count(*)
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_concurrent235'
  ),
  1::bigint,
  'two concurrent deliveries retain one inbox row'
);

select ok(
  (
    select receipt_count = 2
      and attempt_count = 1
      and processing_state = 'processed'
    from private.stripe_event_inbox
    where stripe_event_id = 'evt_concurrent235'
  ),
  'concurrent delivery applies one processing attempt'
);

select is(
  (
    select count(*)
    from private.organization_subscription_projections
    where stripe_subscription_id = 'sub_OVD235Concurrent'
  ),
  1::bigint,
  'concurrent delivery creates one subscription projection'
);

select extensions.dblink_disconnect('ovd235_a');
select extensions.dblink_disconnect('ovd235_b');

begin;

delete from private.stripe_event_inbox
where stripe_event_id = 'evt_concurrent235';

delete from private.organization_subscription_projections
where stripe_subscription_id = 'sub_OVD235Concurrent';

delete from private.organization_billing_accounts
where organization_id = '00000000-0000-4000-8000-000000002359';

delete from public.organizations
where id = '00000000-0000-4000-8000-000000002359';

delete from private.stripe_pro_price_allowlist
where stripe_price_id = 'price_OVD235Concurrent';

drop function public.ovd235_concurrent_delivery();

commit;

select * from finish();
