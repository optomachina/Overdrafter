begin;

\set vendor_quote_offers_relation '''public.vendor_quote_offers''::pg_catalog.regclass'
\set geographic_origin_column '''geographic_origin'''
\set reconciliation_procedure '''public.reconcile_vendor_quote_offers(uuid,jsonb,jsonb)'''
\set execute_privilege '''execute'''

select plan(15);

select is(
  (
    select pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    from pg_catalog.pg_attrdef default_row
    join pg_catalog.pg_attribute attribute_row
      on attribute_row.attrelid = default_row.adrelid
     and attribute_row.attnum = default_row.adnum
    where default_row.adrelid = :vendor_quote_offers_relation
      and attribute_row.attname = :geographic_origin_column
      and not attribute_row.attisdropped
  ),
  '''unknown''::text',
  'vendor quote offer geographic origin defaults to unknown'
);

select ok(
  (
    select attribute_row.attnotnull
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = :vendor_quote_offers_relation
      and attribute_row.attname = :geographic_origin_column
      and not attribute_row.attisdropped
  ),
  'vendor quote offer geographic origin is required'
);

select is(
  (
    select pg_catalog.pg_get_constraintdef(constraint_row.oid)
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = :vendor_quote_offers_relation
      and constraint_row.conname = 'vendor_quote_offers_geographic_origin_check'
  ),
  'CHECK ((geographic_origin = ANY (ARRAY[''domestic''::text, ''foreign''::text, ''unknown''::text])))',
  'vendor quote offer geographic origin accepts only the supported provenance values'
);

select is(
  pg_catalog.col_description(
    :vendor_quote_offers_relation,
    (
      select attribute_row.attnum
      from pg_catalog.pg_attribute attribute_row
      where attribute_row.attrelid = :vendor_quote_offers_relation
        and attribute_row.attname = :geographic_origin_column
        and not attribute_row.attisdropped
    )
  ),
  'Evidence-backed manufacturing origin. Unknown is required when provider provenance is absent or ambiguous; legacy sourcing text is never used to infer this value.',
  'vendor quote offer geographic origin documents its evidence boundary'
);

select is(
  (
    select count(*)::integer
    from public.vendor_quote_offers
    where geographic_origin is null
  ),
  0,
  'legacy vendor quote offers have no null geographic origins after backfill'
);

select ok(
  pg_catalog.to_regprocedure(:reconciliation_procedure) is not null,
  'vendor quote offer reconciliation RPC retains its exact signature'
);

select ok(
  (
    select procedure_row.prosecdef
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = :reconciliation_procedure::pg_catalog.regprocedure
  ),
  'vendor quote offer reconciliation RPC is security definer'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=pg_catalog']::text[]
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = :reconciliation_procedure::pg_catalog.regprocedure
  ),
  'vendor quote offer reconciliation RPC has a hardened search path'
);

select ok(
  pg_catalog.has_function_privilege(
    'service_role',
    :reconciliation_procedure,
    :execute_privilege
  ),
  'service role can execute vendor quote offer reconciliation'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) acl_row
    where procedure_row.oid =
      :reconciliation_procedure::pg_catalog.regprocedure
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  'public cannot execute vendor quote offer reconciliation'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    :reconciliation_procedure,
    :execute_privilege
  ),
  'anonymous callers cannot execute vendor quote offer reconciliation'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    :reconciliation_procedure,
    :execute_privilege
  ),
  'authenticated callers cannot execute vendor quote offer reconciliation'
);

select ok(
  pg_catalog.pg_get_functiondef(
    :reconciliation_procedure::pg_catalog.regprocedure
  ) like '%offer.geographic_origin%',
  'vendor quote reconciliation consumes the caller-supplied geographic origin'
);

select ok(
  pg_catalog.pg_get_functiondef(
    :reconciliation_procedure::pg_catalog.regprocedure
  ) not like '%coalesce(offer.geographic_origin%',
  'vendor quote reconciliation does not replace absent provenance with inferred data'
);

select ok(
  pg_catalog.pg_get_functiondef(
    :reconciliation_procedure::pg_catalog.regprocedure
  ) not like '%geographic_origin = excluded.sourcing%',
  'vendor quote reconciliation never derives geographic origin from legacy sourcing text'
);

select * from finish();

rollback;
