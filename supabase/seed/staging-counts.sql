-- OVD-837 row counts, read only. Run before and after supabase/seed/staging.sql
-- (twice): the second seed run must leave every count unchanged.
-- total_rows is the whole table; fixture_rows only the seed's own rows (fixed
-- 83700000-5eed- ids) or, for trigger-derived tables, rows hanging off them.
select 'auth.users' as table_name, (select count(*) from auth.users) as total_rows,
  (select count(*) from auth.users where id::text like '83700000-5eed-%') as fixture_rows
union all select 'public.organizations', (select count(*) from public.organizations),
  (select count(*) from public.organizations where id::text like '83700000-5eed-%')
union all select 'public.organization_memberships', (select count(*) from public.organization_memberships),
  (select count(*) from public.organization_memberships where id::text like '83700000-5eed-%')
union all select 'public.jobs', (select count(*) from public.jobs),
  (select count(*) from public.jobs where id::text like '83700000-5eed-%')
union all select 'public.organization_file_blobs', (select count(*) from public.organization_file_blobs),
  (select count(*) from public.organization_file_blobs where id::text like '83700000-5eed-%')
union all select 'public.job_files', (select count(*) from public.job_files),
  (select count(*) from public.job_files where id::text like '83700000-5eed-%')
union all select 'public.parts', (select count(*) from public.parts),
  (select count(*) from public.parts where id::text like '83700000-5eed-%')
union all select 'public.approved_part_requirements', (select count(*) from public.approved_part_requirements),
  (select count(*) from public.approved_part_requirements where id::text like '83700000-5eed-%')
union all select 'public.quote_requests', (select count(*) from public.quote_requests),
  (select count(*) from public.quote_requests where id::text like '83700000-5eed-%')
union all select 'public.quote_runs', (select count(*) from public.quote_runs),
  (select count(*) from public.quote_runs where id::text like '83700000-5eed-%')
union all select 'public.vendor_quote_results', (select count(*) from public.vendor_quote_results),
  (select count(*) from public.vendor_quote_results where id::text like '83700000-5eed-%')
union all select 'vendor_quote_results with fixtureSanity', (select count(*) from public.vendor_quote_results where raw_payload ? 'fixtureSanity'),
  (select count(*) from public.vendor_quote_results where id::text like '83700000-5eed-%' and raw_payload ? 'fixtureSanity')
union all select 'private.provider_kill_switches', (select count(*) from private.provider_kill_switches),
  (select count(*) from private.provider_kill_switches)
union all select 'private.provider_global_kill_switch', (select count(*) from private.provider_global_kill_switch),
  (select count(*) from private.provider_global_kill_switch)
-- Written by insert triggers on the tables above (first run only).
union all select 'public.canonical_parts (trigger)', (select count(*) from public.canonical_parts),
  (select count(*) from public.canonical_parts where organization_id::text like '83700000-5eed-%')
union all select 'public.part_versions (trigger)', (select count(*) from public.part_versions),
  (select count(*) from public.part_versions where organization_id::text like '83700000-5eed-%')
union all select 'private.part_fingerprint_observations (trigger)', (select count(*) from private.part_fingerprint_observations),
  (select count(*) from private.part_fingerprint_observations where organization_id::text like '83700000-5eed-%')
union all select 'private.part_deadline_history (trigger)', (select count(*) from private.part_deadline_history),
  (select count(*) from private.part_deadline_history where part_id::text like '83700000-5eed-%')
union all select 'private.sourcing_destination_history (trigger)', (select count(*) from private.sourcing_destination_history),
  (select count(*) from private.sourcing_destination_history where organization_id::text like '83700000-5eed-%');
