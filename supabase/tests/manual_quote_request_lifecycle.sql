begin;

select plan(15);

select ok(
  exists (
    select 1
    from pg_catalog.pg_type type_row
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'quote_request_mode'
  ),
  'quote request mode enum exists'
);

select is(
  (
    select pg_catalog.array_agg(enum_row.enumlabel order by enum_row.enumsortorder)::text
    from pg_catalog.pg_enum enum_row
    join pg_catalog.pg_type type_row on type_row.oid = enum_row.enumtypid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'quote_request_mode'
  ),
  '{manual,automatic}',
  'quote request mode enum has stable labels'
);

select is(
  (
    select pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod)
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = 'public.quote_requests'::regclass
      and attribute_row.attname = 'request_mode'
      and not attribute_row.attisdropped
  ),
  'quote_request_mode',
  'quote_requests persists request mode'
);

select ok(
  (
    select attribute_row.attnotnull
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = 'public.quote_requests'::regclass
      and attribute_row.attname = 'request_mode'
  ),
  'request mode is required'
);

select ok(
  (
    select pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    from pg_catalog.pg_attrdef default_row
    join pg_catalog.pg_attribute attribute_row
      on attribute_row.attrelid = default_row.adrelid
     and attribute_row.attnum = default_row.adnum
    where default_row.adrelid = 'public.quote_requests'::regclass
      and attribute_row.attname = 'request_mode'
  ) like '%automatic%',
  'historical and omitted request modes default to automatic'
);

select ok(
  pg_catalog.to_regprocedure('public.api_request_manual_quote(uuid,boolean)') is not null,
  'single manual quote RPC exists'
);

select ok(
  pg_catalog.to_regprocedure('public.api_request_manual_quotes(uuid[],boolean)') is not null,
  'bulk manual quote RPC exists'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_request_manual_quote(uuid,boolean)',
    'EXECUTE'
  ),
  'authenticated callers can execute the single manual RPC'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.api_request_manual_quote(uuid,boolean)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the single manual RPC'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'private.request_automatic_quote_impl(uuid,boolean)',
    'EXECUTE'
  ),
  'authenticated callers cannot bypass the public automatic wrapper'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_request_quote(uuid,boolean)',
    'EXECUTE'
  ),
  'authenticated callers retain the automatic quote RPC'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.quote_requests'::regclass
      and trigger_row.tgname = 'reset_job_after_manual_quote_cancellation'
      and not trigger_row.tgisinternal
  ),
  'manual cancellation reset trigger exists'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.api_request_quote(uuid,boolean)'::regprocedure
  ) like '%private.resolve_organization_entitlements_at%',
  'automatic quote wrapper uses the server-authoritative entitlement resolver'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.api_request_quote(uuid,boolean)'::regprocedure
  ) like '%pro_required%',
  'automatic quote wrapper returns the stable Pro-required denial'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.api_request_quote(uuid,boolean)'::regprocedure
    ),
    'private.resolve_organization_entitlements_at'
  ) < pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.api_request_quote(uuid,boolean)'::regprocedure
    ),
    'private.request_automatic_quote_impl'
  ),
  'entitlement gate runs before the automatic implementation'
);

select * from finish();

rollback;
