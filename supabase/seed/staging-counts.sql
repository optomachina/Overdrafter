-- OVD-837 row counts, read only. Run before and after supabase/seed/staging.sql
-- (twice): the second seed run must leave every count unchanged.
-- total_rows is the whole table (or the rows matching row_filter); fixture_rows
-- only the seed's own rows (fixed 83700000-5eed- ids in fixture_column) or, for
-- trigger-derived tables, rows hanging off them. A null fixture_column counts
-- every row as a fixture row. Each count is one select count(*) run through
-- query_to_xml, so the table list below drives every row.
select counted.table_name,
  (xpath('/row/n/text()', query_to_xml(
    format('select count(*) as n from %s where %s', counted.relation, counted.row_filter),
    false, true, '')))[1]::text::bigint as total_rows,
  (xpath('/row/n/text()', query_to_xml(
    format('select count(*) as n from %s where %s and %s', counted.relation, counted.row_filter,
      case when counted.fixture_column is null then 'true'
        else format('%I::text like %L', counted.fixture_column, '83700000-5eed-%') end),
    false, true, '')))[1]::text::bigint as fixture_rows
from (values
  (1, 'auth.users', 'auth.users', 'true', 'id'),
  (2, 'public.organizations', 'public.organizations', 'true', 'id'),
  (3, 'public.organization_memberships', 'public.organization_memberships', 'true', 'id'),
  (4, 'public.jobs', 'public.jobs', 'true', 'id'),
  (5, 'public.organization_file_blobs', 'public.organization_file_blobs', 'true', 'id'),
  (6, 'public.job_files', 'public.job_files', 'true', 'id'),
  (7, 'public.parts', 'public.parts', 'true', 'id'),
  (8, 'public.approved_part_requirements', 'public.approved_part_requirements', 'true', 'id'),
  (9, 'public.quote_requests', 'public.quote_requests', 'true', 'id'),
  (10, 'public.quote_runs', 'public.quote_runs', 'true', 'id'),
  (11, 'public.vendor_quote_results', 'public.vendor_quote_results', 'true', 'id'),
  (12, 'vendor_quote_results with fixtureSanity', 'public.vendor_quote_results', 'raw_payload ? ''fixtureSanity''', 'id'),
  (13, 'private.provider_kill_switches', 'private.provider_kill_switches', 'true', null),
  (14, 'private.provider_kill_switches engaged', 'private.provider_kill_switches', 'engaged', null),
  (15, 'private.provider_global_kill_switch', 'private.provider_global_kill_switch', 'true', null),
  -- Written by insert triggers on the tables above (first run only).
  (16, 'public.canonical_parts (trigger)', 'public.canonical_parts', 'true', 'organization_id'),
  (17, 'public.part_versions (trigger)', 'public.part_versions', 'true', 'organization_id'),
  (18, 'private.part_fingerprint_observations (trigger)', 'private.part_fingerprint_observations', 'true', 'organization_id'),
  (19, 'private.part_deadline_history (trigger)', 'private.part_deadline_history', 'true', 'part_id'),
  (20, 'private.sourcing_destination_history (trigger)', 'private.sourcing_destination_history', 'true', 'organization_id')
) as counted(ord, table_name, relation, row_filter, fixture_column)
order by counted.ord;
