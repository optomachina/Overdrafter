-- Window 1 restore smoke check. Read only: one SELECT, no writes.
--
-- Prints one JSON object of exact row counts for key tables. A table that does
-- not exist prints null. Run it against production right after the dump and
-- against the local restore; the two outputs must be identical.
--
-- Usage: psql "$DB_URL" -X -A -t -q -f scripts/window-1/smoke-counts.sql > counts.json
set search_path = pg_catalog;
select coalesce(pg_catalog.jsonb_object_agg(t.name, (
  case when pg_catalog.to_regclass(t.name) is null then null
  else (pg_catalog.xpath('/row/c/text()',
          pg_catalog.query_to_xml(pg_catalog.format('select count(*) as c from %s', t.name), false, true, '')))[1]::text::bigint
  end)), '{}'::jsonb)::text
from (values
  ('auth.users'),
  ('storage.objects'),
  ('public.organizations'),
  ('public.organization_memberships'),
  ('public.projects'),
  ('public.jobs'),
  ('public.job_files'),
  ('public.parts'),
  ('public.quote_runs'),
  ('public.vendor_quote_results'),
  ('public.vendor_quote_offers'),
  ('public.client_selections'),
  ('public.work_queue'),
  ('public.audit_events'),
  ('public.payments')
) as t(name);
