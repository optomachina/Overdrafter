-- Window 1 backup helper. Read only: one SELECT, no writes.
--
-- Prints SQL that recreates every RLS policy on the storage schema exactly as
-- production has it. A schema dump of the application schemas does not carry
-- these policies (they live on storage.objects), so the backup saves them
-- separately and the restore replays them.
--
-- Usage: psql "$DB_URL" -X -A -t -q -f scripts/window-1/storage-policies.sql > storage-policies.sql
set search_path = pg_catalog;
select coalesce(pg_catalog.string_agg(pg_catalog.format(
  E'drop policy if exists %I on %I.%I;\ncreate policy %I on %I.%I as %s for %s to %s%s%s;',
  p.policyname, p.schemaname, p.tablename,
  p.policyname, p.schemaname, p.tablename, p.permissive, p.cmd,
  (select pg_catalog.string_agg(pg_catalog.quote_ident(r), ', ' order by r) from pg_catalog.unnest(p.roles) r),
  case when p.qual is not null then ' using (' || p.qual || ')' else '' end,
  case when p.with_check is not null then ' with check (' || p.with_check || ')' else '' end),
  E'\n' order by p.tablename, p.policyname), '-- no storage policies')
from pg_catalog.pg_policies p
where p.schemaname = 'storage';
