begin;
create extension if not exists pgtap with schema extensions;
select plan(5);
select is((select state from private.sourcing_destination_history
  where organization_id='89000000-0000-4000-8000-000000000003'), 'inferred', 'preexisting address is backfilled as inferred'); -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
select is((select address->>'street' from private.sourcing_destination_history
  where organization_id='89000000-0000-4000-8000-000000000003'), '456 Earlier Ave', 'backfill preserves the preexisting address');
select is((select state from private.part_deadline_history
  where part_id='89000000-0000-4000-8000-000000000005'), 'inferred', 'preexisting requested date is backfilled as inferred');
select is(private.current_confirmed_sourcing_address('89000000-0000-4000-8000-000000000003'), null::jsonb,
  'migration never silently confirms an existing address');
select is(private.current_confirmed_part_deadline('89000000-0000-4000-8000-000000000005'), null::date,
  'migration never silently confirms an existing deadline');
select * from finish();
rollback;
